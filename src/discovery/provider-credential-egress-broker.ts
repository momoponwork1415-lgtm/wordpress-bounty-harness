import { randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isIP } from "node:net";

import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";
import { createGrantTls } from "./grant-tls.js";
import type { ProviderApiProtocol } from "./provider-credential-proxy.js";
import {
  BROKER_TLS_HOSTNAME,
  CHATGPT_UPSTREAM_ORIGIN,
  PROVIDER_UPSTREAM_ORIGIN,
} from "./provider-credential-proxy.js";
import { runNativeModelProcess } from "../infrastructure/native-model-process.js";
import {
  readPrivateChatgptLogin,
  readPrivateProviderCredential,
} from "./provider-private-credential.js";

/** Names of the per-run broker container and the network it creates when none is given. */
export const EGRESS_BROKER_LEFTOVER_PATTERNS = {
  containers: [/^provider-egress-broker-[A-Za-z0-9_.-]+$/],
  networks: [/^provider-egress-(?!broker-)[A-Za-z0-9_.-]+$/],
} as const;

/** Memory ceiling of one per-run broker container. */
export const EGRESS_BROKER_MEMORY_MIB = 512;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const modelSchema = z.enum(["gpt-6.1-sol", "gpt-6-luna"]);
const dockerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const pinnedImageSchema = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9][^\s@]*@sha256:[a-f0-9]{64})$/u);

export const providerCredentialEgressGrantRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeProfileDigest: digestSchema,
    model: modelSchema,
    protocol: z.enum(["responses", "chat-completions"]),
    maxRequests: z.number().int().positive().max(10_000),
    maxRequestBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    agentNetworkName: dockerNameSchema.optional(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ProviderCredentialEgressGrantRequest = z.infer<
  typeof providerCredentialEgressGrantRequestSchema
>;

export interface ProviderCredentialEgressGrant {
  readonly baseUrl: string;
  /**
   * Present for a ChatGPT login grant: the broker speaks TLS under a fixed
   * name, which the sandbox maps to this address and trusts only through this
   * grant's CA.
   */
  readonly tls?: {
    readonly hostname: string;
    readonly address: string;
    readonly caPem: string;
  };
  readonly authorization: string;
  readonly dockerNetworkName: string;
  readonly model: string;
  readonly protocol: ProviderApiProtocol;
  readonly expiresAt: string;
}

export type ProviderCredentialEgressOperation<T> =
  | { readonly status: "not-started" }
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

const providerCredentialEgressSetupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready") }),
  z.strictObject({
    status: z.literal("failed"),
    stage: z.enum([
      "credential",
      "broker-preflight",
      "network-create",
      "network-admit",
      "broker-start",
      "provider-network-connect",
      "broker-address",
      "broker-health",
    ]),
    reason: z.enum([
      "credential-unavailable",
      "broker-bundle-unavailable",
      "docker-network-unavailable",
      "agent-network-not-internal",
      "broker-container-unavailable",
      "provider-network-unavailable",
      "broker-address-unavailable",
      "broker-not-ready",
    ]),
  }),
]);

const providerCredentialEgressCleanupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("completed") }),
  z.strictObject({ status: z.literal("not-required") }),
  z.strictObject({
    status: z.literal("failed"),
    failedSteps: z.array(
      z.enum(["broker-remove", "network-remove", "credential-staging-remove"]),
    ),
  }),
]);

const providerCredentialEgressReceiptBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  grantId: dockerNameSchema,
  runtimeProfileDigest: digestSchema,
  brokerImage: pinnedImageSchema,
  upstreamOrigin: z.enum([PROVIDER_UPSTREAM_ORIGIN, CHATGPT_UPSTREAM_ORIGIN]),
  model: modelSchema,
  protocol: z.enum(["responses", "chat-completions"]),
  maxRequests: z.number().int().positive().max(10_000),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  expiresAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  setup: providerCredentialEgressSetupSchema,
  cleanup: providerCredentialEgressCleanupSchema,
  isolation: z.strictObject({
    backend: z.literal("gvisor"),
    runtime: z.literal("runsc"),
    fallbackUsed: z.literal(false),
    agentNetworkInternal: z.literal(true),
  }),
});

export const providerCredentialEgressReceiptSchema =
  providerCredentialEgressReceiptBodySchema
    .extend({ digest: digestSchema })
    .superRefine((receipt, context) => {
      const { digest, ...body } = receipt;
      if (digest !== canonicalDigest(body)) {
        context.addIssue({
          code: "custom",
          path: ["digest"],
          message: "Credential egress receipt digest must bind its body",
        });
      }
    });

export type ProviderCredentialEgressSetup = z.infer<
  typeof providerCredentialEgressSetupSchema
>;
export type ProviderCredentialEgressCleanup = z.infer<
  typeof providerCredentialEgressCleanupSchema
>;
export type ProviderCredentialEgressReceipt = z.infer<
  typeof providerCredentialEgressReceiptSchema
>;

export interface ProviderCredentialEgressResult<T> {
  readonly operation: ProviderCredentialEgressOperation<T>;
  readonly receipt: ProviderCredentialEgressReceipt;
}

export interface ProviderCredentialEgressBroker {
  withGrant<T>(
    request: ProviderCredentialEgressGrantRequest,
    operation: (grant: ProviderCredentialEgressGrant) => Promise<T>,
  ): Promise<ProviderCredentialEgressResult<T>>;
}

export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProviderCredentialEgressBrokerOptions {
  readonly dockerExecutablePath: string;
  readonly brokerImage: string;
  readonly credentialFilePath: string;
  /** An API key file (the default) or a Codex CLI ChatGPT `auth.json`. */
  readonly credentialKind?: "api-key" | "chatgpt-login";
  readonly scratchRootDirectory: string;
  readonly proxyBundleDirectory: string;
  readonly providerNetworkName?: string;
  readonly clock?: () => Date;
  readonly randomUuid?: () => string;
  readonly randomGrantToken?: () => string;
  readonly resolveProviderAddresses?: (
    hostname: string,
  ) => Promise<readonly string[]>;
  readonly runDocker?: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<DockerCommandResult>;
}

const BROKER_ALIAS = "provider-egress";
const BROKER_PORT = 8080;
/** Plain-HTTP health port of a TLS broker; checked only from inside it. */
const BROKER_TLS_HEALTH_PORT = 8081;
const MAX_PROVIDER_ADDRESSES = 16;
/** Matches the largest admitted discovery wall time while keeping each grant bounded. */
const MAX_GRANT_DURATION_MS = 240 * 60_000;

async function resolveProviderAddresses(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function admittedProviderAddresses(addresses: readonly string[]): string[] {
  const admitted = [...new Set(addresses)].sort();
  if (
    admitted.length === 0 ||
    admitted.length > MAX_PROVIDER_ADDRESSES ||
    admitted.some((address) => isIP(address) === 0)
  ) {
    throw new Error("Provider provider addresses are unavailable");
  }
  return admitted;
}

function redactSecret(value: string, ...secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}

function receiptWithDigest(
  receipt: Omit<ProviderCredentialEgressReceipt, "digest">,
): ProviderCredentialEgressReceipt {
  return providerCredentialEgressReceiptSchema.parse({
    ...receipt,
    digest: canonicalDigest(receipt),
  });
}

async function defaultDockerCommand(
  executablePath: string,
  args: readonly string[],
  timeoutMs: number,
  secrets: readonly string[],
): Promise<DockerCommandResult> {
  const result = await runNativeModelProcess({
    executablePath,
    args,
    workingDirectory: process.cwd(),
    environment: {
      PATH: process.env.PATH,
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    timeoutMs,
    maxOutputBytes: 64 * 1024,
    redact: (text) => redactSecret(text, ...secrets),
  });
  if (result.kind !== "exited") {
    return {
      exitCode: -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return result;
}

function validateBrokerOptions(
  options: ProviderCredentialEgressBrokerOptions,
): void {
  if (
    !isAbsolute(options.dockerExecutablePath) ||
    !isAbsolute(options.credentialFilePath) ||
    !isAbsolute(options.scratchRootDirectory) ||
    !isAbsolute(options.proxyBundleDirectory)
  ) {
    throw new Error("Provider credential broker paths must be absolute");
  }
  pinnedImageSchema.parse(options.brokerImage);
  dockerNameSchema.parse(options.providerNetworkName ?? "bridge");
}

function nonRootHostUser(): string {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() <= 0 ||
    process.getgid() <= 0
  ) {
    throw new Error("Provider credential broker requires a non-root host user");
  }
  return `${process.getuid()}:${process.getgid()}`;
}

async function requireDirectory(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || path.includes(":")) {
    throw new Error("Provider credential broker directory is unavailable");
  }
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error("Provider credential broker directory is unavailable");
  }
  return resolved;
}

function validateGrantDeadline(
  request: ProviderCredentialEgressGrantRequest,
  now: Date,
): void {
  const deadline = new Date(request.expiresAt).getTime();
  const duration = deadline - now.getTime();
  if (duration <= 0 || duration > MAX_GRANT_DURATION_MS) {
    throw new Error(
      "Provider credential grant deadline is outside the admitted bound",
    );
  }
}

function dockerSucceeded(result: DockerCommandResult): boolean {
  return result.exitCode === 0;
}

async function waitForBrokerHealth(
  runDocker: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<DockerCommandResult>,
  containerName: string,
  port: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runDocker(
      [
        "exec",
        containerName,
        "node",
        "--input-type=module",
        "-e",
        `const r=await fetch('http://127.0.0.1:${port}/healthz');if(!r.ok)process.exit(1)`,
      ],
      5_000,
    );
    if (dockerSucceeded(result)) return true;
    if (
      result.stderr.includes("is not running") ||
      result.stderr.includes("No such container")
    ) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Owns one short-lived Provider egress grant. The raw provider credential is
 * mounted only into the gVisor broker sidecar; the operation receives a
 * network-scoped bearer token instead.
 */
export function createProviderCredentialEgressBroker(
  options: ProviderCredentialEgressBrokerOptions,
): ProviderCredentialEgressBroker {
  validateBrokerOptions(options);
  const clock = options.clock ?? (() => new Date());
  const nextUuid = options.randomUuid ?? randomUUID;
  const nextToken =
    options.randomGrantToken ?? (() => randomBytes(32).toString("base64url"));
  const resolveAddresses =
    options.resolveProviderAddresses ?? resolveProviderAddresses;
  const providerNetworkName = options.providerNetworkName ?? "bridge";
  const containerUser = nonRootHostUser();
  const chatgpt = options.credentialKind === "chatgpt-login";
  const upstreamOrigin = chatgpt
    ? CHATGPT_UPSTREAM_ORIGIN
    : PROVIDER_UPSTREAM_ORIGIN;
  const upstreamHostname = new URL(upstreamOrigin).hostname;

  return {
    async withGrant<T>(
      requestValue: ProviderCredentialEgressGrantRequest,
      operation: (grant: ProviderCredentialEgressGrant) => Promise<T>,
    ) {
      const request =
        providerCredentialEgressGrantRequestSchema.parse(requestValue);
      const startedAt = clock();
      validateGrantDeadline(request, startedAt);
      const grantId = nextUuid();
      dockerNameSchema.parse(grantId);
      const networkName =
        request.agentNetworkName ?? `provider-egress-${grantId}`;
      const containerName = `provider-egress-broker-${grantId}`;
      dockerNameSchema.parse(networkName);
      dockerNameSchema.parse(containerName);
      const grantToken = nextToken();
      if (grantToken.length < 32 || /[\s\0]/u.test(grantToken)) {
        throw new Error("Provider credential grant token is invalid");
      }

      let setup: ProviderCredentialEgressSetup;
      let cleanup: ProviderCredentialEgressCleanup = {
        status: "not-required",
      };
      let operationResult: ProviderCredentialEgressOperation<T> = {
        status: "not-started",
      };
      let networkCreated = false;
      let brokerCreated = false;
      let stagingDirectory: string | undefined;
      let secrets: readonly string[] = [];
      let pendingSetupFailure: Extract<
        ProviderCredentialEgressSetup,
        { readonly status: "failed" }
      > = {
        status: "failed",
        stage: "credential",
        reason: "credential-unavailable",
      };

      const complete = (): ProviderCredentialEgressResult<T> => ({
        operation: operationResult,
        receipt: receiptWithDigest({
          schemaVersion: 1,
          grantId,
          runtimeProfileDigest: request.runtimeProfileDigest,
          brokerImage: options.brokerImage,
          upstreamOrigin,
          model: request.model,
          protocol: request.protocol,
          maxRequests: request.maxRequests,
          maxRequestBytes: request.maxRequestBytes,
          maxResponseBytes: request.maxResponseBytes,
          expiresAt: request.expiresAt,
          startedAt: startedAt.toISOString(),
          completedAt: clock().toISOString(),
          setup,
          cleanup,
          isolation: {
            backend: "gvisor",
            runtime: "runsc",
            fallbackUsed: false,
            agentNetworkInternal: true,
          },
        }),
      });

      let runDocker:
        | ((
            args: readonly string[],
            timeoutMs: number,
          ) => Promise<DockerCommandResult>)
        | undefined;
      try {
        // Staged secret files, by their path inside the broker container.
        let stagedFiles: Readonly<Record<string, string>>;
        if (chatgpt) {
          const login = await readPrivateChatgptLogin(
            options.credentialFilePath,
            new Date(request.expiresAt),
          );
          secrets = [login.accessToken, login.accountId];
          stagedFiles = {
            "provider-chatgpt.json": JSON.stringify({
              accessToken: login.accessToken,
              accountId: login.accountId,
            }),
          };
        } else {
          const apiKey = await readPrivateProviderCredential(
            options.credentialFilePath,
          );
          secrets = [apiKey];
          stagedFiles = { "provider-api-key": `${apiKey}\n` };
        }
        const grantSecrets = secrets;
        runDocker = async (args, timeoutMs) => {
          const result =
            options.runDocker === undefined
              ? await defaultDockerCommand(
                  options.dockerExecutablePath,
                  args,
                  timeoutMs,
                  grantSecrets,
                )
              : await options.runDocker(args, timeoutMs);
          return {
            exitCode: result.exitCode,
            stdout: redactSecret(result.stdout, ...grantSecrets),
            stderr: redactSecret(result.stderr, ...grantSecrets),
          };
        };
        pendingSetupFailure = {
          status: "failed",
          stage: "broker-preflight",
          reason: "broker-bundle-unavailable",
        };
        const scratchRoot = await requireDirectory(
          options.scratchRootDirectory,
        );
        const proxyBundle = await requireDirectory(
          options.proxyBundleDirectory,
        );
        const proxyCli = join(proxyBundle, "provider-credential-proxy-cli.js");
        if (!(await stat(proxyCli)).isFile()) {
          throw new Error("Provider credential proxy bundle is unavailable");
        }
        stagingDirectory = await mkdtemp(join(scratchRoot, "provider-egress-"));
        const grantTls = chatgpt
          ? createGrantTls({
              hostname: BROKER_TLS_HOSTNAME,
              notAfter: new Date(request.expiresAt),
              now: startedAt,
            })
          : undefined;
        if (grantTls !== undefined)
          stagedFiles = {
            ...stagedFiles,
            "grant-tls-key.pem": grantTls.keyPem,
            "grant-tls-cert.pem": grantTls.certPem,
          };
        const secretMounts: string[] = [];
        for (const [name, content] of Object.entries(stagedFiles)) {
          const staged = join(stagingDirectory, name);
          await writeFile(staged, content, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          secretMounts.push("--volume", `${staged}:/run/secrets/${name}:ro`);
        }

        pendingSetupFailure = {
          status: "failed",
          stage: "provider-network-connect",
          reason: "provider-network-unavailable",
        };
        const providerAddresses = admittedProviderAddresses(
          await resolveAddresses(upstreamHostname),
        );

        pendingSetupFailure =
          request.agentNetworkName === undefined
            ? {
                status: "failed",
                stage: "network-create",
                reason: "docker-network-unavailable",
              }
            : {
                status: "failed",
                stage: "network-admit",
                reason: "agent-network-not-internal",
              };
        const executeDocker = runDocker;
        const network = await executeDocker(
          request.agentNetworkName === undefined
            ? ["network", "create", "--internal", networkName]
            : ["network", "inspect", "--format", "{{.Internal}}", networkName],
          20_000,
        );
        if (
          !dockerSucceeded(network) ||
          (request.agentNetworkName !== undefined &&
            network.stdout.trim() !== "true")
        ) {
          setup = pendingSetupFailure;
        } else {
          networkCreated = request.agentNetworkName === undefined;
          pendingSetupFailure = {
            status: "failed",
            stage: "broker-start",
            reason: "broker-container-unavailable",
          };
          const broker = await executeDocker(
            [
              "create",
              "--pull=never",
              "--runtime=runsc",
              `--user=${containerUser}`,
              "--name",
              containerName,
              "--network",
              networkName,
              `--network-alias=${BROKER_ALIAS}`,
              ...providerAddresses.map(
                (address) => `--add-host=${upstreamHostname}=${address}`,
              ),
              "--read-only",
              "--cap-drop=ALL",
              "--security-opt=no-new-privileges",
              "--pids-limit=64",
              `--memory=${EGRESS_BROKER_MEMORY_MIB}m`,
              "--cpus=1",
              "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m",
              "--volume",
              `${proxyBundle}:/opt/provider-egress:ro`,
              ...secretMounts,
              "--env",
              `PROVIDER_AUTHENTICATION=${chatgpt ? "chatgpt" : "api-key"}`,
              "--env",
              `PROVIDER_GRANT_TOKEN=${grantToken}`,
              "--env",
              `PROVIDER_MODEL=${request.model}`,
              "--env",
              `PROVIDER_PROTOCOL=${request.protocol}`,
              "--env",
              `PROVIDER_MAX_REQUESTS=${request.maxRequests}`,
              "--env",
              `PROVIDER_MAX_REQUEST_BYTES=${request.maxRequestBytes}`,
              "--env",
              `PROVIDER_MAX_RESPONSE_BYTES=${request.maxResponseBytes}`,
              "--env",
              `PROVIDER_GRANT_EXPIRES_AT=${request.expiresAt}`,
              options.brokerImage,
              "node",
              "/opt/provider-egress/provider-credential-proxy-cli.js",
            ],
            20_000,
          );
          if (!dockerSucceeded(broker)) {
            setup = {
              status: "failed",
              stage: "broker-start",
              reason: "broker-container-unavailable",
            };
          } else {
            brokerCreated = true;
            pendingSetupFailure = {
              status: "failed",
              stage: "provider-network-connect",
              reason: "provider-network-unavailable",
            };
            const providerNetwork = await executeDocker(
              ["network", "connect", providerNetworkName, containerName],
              20_000,
            );
            if (!dockerSucceeded(providerNetwork)) {
              setup = {
                status: "failed",
                stage: "provider-network-connect",
                reason: "provider-network-unavailable",
              };
            } else {
              pendingSetupFailure = {
                status: "failed",
                stage: "broker-start",
                reason: "broker-container-unavailable",
              };
              const started = await executeDocker(
                ["start", containerName],
                20_000,
              );
              if (!dockerSucceeded(started)) {
                setup = {
                  status: "failed",
                  stage: "broker-start",
                  reason: "broker-container-unavailable",
                };
              } else {
                pendingSetupFailure = {
                  status: "failed",
                  stage: "broker-address",
                  reason: "broker-address-unavailable",
                };
                const address = await executeDocker(
                  [
                    "inspect",
                    "--format",
                    `{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`,
                    containerName,
                  ],
                  20_000,
                );
                const brokerAddress = address.stdout.trim();
                if (!dockerSucceeded(address) || isIP(brokerAddress) !== 4) {
                  setup = {
                    status: "failed",
                    stage: "broker-address",
                    reason: "broker-address-unavailable",
                  };
                } else {
                  pendingSetupFailure = {
                    status: "failed",
                    stage: "broker-health",
                    reason: "broker-not-ready",
                  };
                  const healthy = await waitForBrokerHealth(
                    executeDocker,
                    containerName,
                    chatgpt ? BROKER_TLS_HEALTH_PORT : BROKER_PORT,
                  );
                  if (!healthy) {
                    setup = {
                      status: "failed",
                      stage: "broker-health",
                      reason: "broker-not-ready",
                    };
                  } else {
                    setup = { status: "ready" };
                    try {
                      const value = await operation({
                        ...(grantTls === undefined
                          ? {
                              baseUrl: `http://${brokerAddress}:${BROKER_PORT}`,
                            }
                          : {
                              baseUrl: `https://${BROKER_TLS_HOSTNAME}:${BROKER_PORT}`,
                              tls: {
                                hostname: BROKER_TLS_HOSTNAME,
                                address: brokerAddress,
                                caPem: grantTls.caPem,
                              },
                            }),
                        authorization: `Bearer ${grantToken}`,
                        dockerNetworkName: networkName,
                        model: request.model,
                        protocol: request.protocol,
                        expiresAt: request.expiresAt,
                      });
                      operationResult = { status: "completed", value };
                    } catch (error: unknown) {
                      operationResult = { status: "failed", error };
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        setup = pendingSetupFailure;
      } finally {
        const failedSteps: (
          "broker-remove" | "network-remove" | "credential-staging-remove"
        )[] = [];
        if (brokerCreated && runDocker !== undefined) {
          try {
            const stopped = await runDocker(
              ["rm", "--force", containerName],
              20_000,
            );
            if (!dockerSucceeded(stopped)) failedSteps.push("broker-remove");
          } catch {
            failedSteps.push("broker-remove");
          }
        }
        if (networkCreated && runDocker !== undefined) {
          try {
            const removed = await runDocker(
              ["network", "rm", networkName],
              20_000,
            );
            if (!dockerSucceeded(removed)) failedSteps.push("network-remove");
          } catch {
            failedSteps.push("network-remove");
          }
        }
        if (stagingDirectory !== undefined) {
          try {
            await rm(stagingDirectory, { recursive: true, force: true });
          } catch {
            failedSteps.push("credential-staging-remove");
          }
        }
        if (brokerCreated || networkCreated || stagingDirectory !== undefined) {
          cleanup =
            failedSteps.length === 0
              ? { status: "completed" }
              : { status: "failed", failedSteps };
        }
        secrets = [];
      }

      return complete();
    },
  };
}
