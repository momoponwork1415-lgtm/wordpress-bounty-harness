import {
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isIP } from "node:net";

import { z } from "zod";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";

import {
  runNativeModelProcess,
  type NativeModelProcessResult,
} from "../infrastructure/native-model-process.js";
import {
  BROKER_TLS_HOSTNAME,
  CHATGPT_PLACEHOLDER_ACCOUNT_ID,
} from "./provider-credential-proxy.js";
import type {
  CodexSandbox,
  CodexSandboxCommand,
  CodexSandboxResult,
} from "./codex-native-agent-runtime.js";

/** Memory ceiling of one Codex sandbox container. */
export const CODEX_SANDBOX_MEMORY_MIB = 2048;

const imageSchema = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const networkSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

export interface GvisorCodexSandboxOptions {
  readonly dockerExecutablePath: string;
  readonly image: string;
  /** Path inside the pinned image to the CLI's bundled model catalog. */
  readonly bundledCatalogPath: string;
  readonly scratchRootDirectory: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly clock?: () => Date;
  readonly runDocker?: DockerRun;
}

type DockerRun = (
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
) => Promise<NativeModelProcessResult>;

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A Codex CLI login whose only secret is the grant token. The id token is
 * unsigned and carries just the placeholder account the broker expects; the
 * real login never leaves the broker.
 */
function grantLogin(grantToken: string, now: Date, expiresAt: string): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const idToken = [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      iss: "https://auth.openai.com",
      sub: "egress-grant",
      email: "egress-grant@example.invalid",
      iat: issuedAt,
      exp: Math.floor(new Date(expiresAt).getTime() / 1000),
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "pro",
        chatgpt_account_id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
        chatgpt_user_id: "egress-grant",
      },
    }),
    Buffer.from("unsigned").toString("base64url"),
  ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: grantToken,
      refresh_token: "",
      account_id: CHATGPT_PLACEHOLDER_ACCOUNT_ID,
    },
    last_refresh: now.toISOString(),
  });
}

function nonRootUser(): string {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() <= 0 ||
    process.getgid() <= 0
  ) {
    throw new Error("A non-root host user is required for the Codex sandbox");
  }
  return `${process.getuid()}:${process.getgid()}`;
}

export class GvisorCodexSandbox implements CodexSandbox {
  readonly #options: GvisorCodexSandboxOptions;
  readonly #user: string;

  constructor(options: GvisorCodexSandboxOptions) {
    if (
      !isAbsolute(options.dockerExecutablePath) ||
      !isAbsolute(options.scratchRootDirectory) ||
      !isAbsolute(options.bundledCatalogPath) ||
      options.bundledCatalogPath.includes("\0") ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 240 * 60_000
    ) {
      throw new Error("Codex sandbox options are invalid");
    }
    imageSchema.parse(options.image);
    this.#options = options;
    this.#user = nonRootUser();
  }

  /** Measures the image's CLI version and bundled catalog, with no network and no source. */
  async probe(): Promise<{
    readonly cliVersion: string;
    readonly bundledCatalogDigest: string;
  }> {
    return this.#probe(
      this.#docker(await realpath(this.#options.scratchRootDirectory)),
    );
  }

  async #probe(
    runDocker: DockerRun,
  ): Promise<{ cliVersion: string; bundledCatalogDigest: string }> {
    const base = this.#base();
    const versionResult = await runDocker(
      [
        ...base,
        "--network=none",
        "--entrypoint=codex",
        this.#options.image,
        "--version",
      ],
      undefined,
      20_000,
    );
    if (versionResult.kind !== "exited" || versionResult.exitCode !== 0)
      throw new Error("Codex CLI version is unavailable");
    const match =
      /\bcodex-cli\s+(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)\b/.exec(
        versionResult.stdout,
      );
    if (match?.[1] === undefined)
      throw new Error("Codex CLI version is invalid");
    const catalogResult = await runDocker(
      [
        ...base,
        "--network=none",
        "--entrypoint=sha256sum",
        this.#options.image,
        this.#options.bundledCatalogPath,
      ],
      undefined,
      20_000,
    );
    if (catalogResult.kind !== "exited" || catalogResult.exitCode !== 0)
      throw new Error("Codex model catalog is unavailable");
    const catalogHash = /^([a-f0-9]{64})\s/.exec(catalogResult.stdout)?.[1];
    if (catalogHash === undefined)
      throw new Error("Codex model catalog digest is invalid");
    return {
      cliVersion: match[1],
      bundledCatalogDigest: digestSchema.parse(`sha256:${catalogHash}`),
    };
  }

  #docker(workingDirectory: string, secret?: string): DockerRun {
    return (
      this.#options.runDocker ??
      ((
        args: readonly string[],
        stdin: string | undefined,
        timeoutMs: number,
      ) =>
        runNativeModelProcess({
          executablePath: this.#options.dockerExecutablePath,
          args,
          ...(stdin === undefined ? {} : { stdin }),
          workingDirectory,
          environment: {
            PATH: process.env.PATH,
            LANG: "C",
            LC_ALL: "C",
            TZ: "UTC",
          },
          timeoutMs,
          maxOutputBytes: this.#options.maxOutputBytes,
          redact: (text) =>
            secret === undefined ? text : text.split(secret).join("[REDACTED]"),
        }))
    );
  }

  #base(): string[] {
    return [
      "run",
      "--rm",
      "--pull=never",
      "--runtime=runsc",
      `--user=${this.#user}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      `--memory=${CODEX_SANDBOX_MEMORY_MIB}m`,
      "--cpus=1",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
    ];
  }

  async execute(command: CodexSandboxCommand): Promise<CodexSandboxResult> {
    networkSchema.parse(command.grant.dockerNetworkName);
    const tls = command.grant.tls;
    if (
      tls === undefined
        ? !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(command.grant.baseUrl)
        : tls.hostname !== BROKER_TLS_HOSTNAME ||
          command.grant.baseUrl !== `https://${BROKER_TLS_HOSTNAME}:8080` ||
          isIP(tls.address) !== 4 ||
          !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/.test(
            tls.caPem,
          )
    ) {
      throw new Error("Provider broker address is invalid");
    }
    if (!/^Bearer [A-Za-z0-9_-]{32,}$/.test(command.grant.authorization)) {
      throw new Error("Provider grant is invalid");
    }
    if (
      command.executable !== "codex" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(command.labHost.name) ||
      isIP(command.labHost.ipv4) !== 4 ||
      (command.databaseHost !== undefined &&
        (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(command.databaseHost.name) ||
          command.databaseHost.name === command.labHost.name ||
          isIP(command.databaseHost.ipv4) !== 4)) ||
      command.sourceMount.mode !== "ro" ||
      command.sourceMount.path !== "/workspace/main" ||
      !isAbsolute(command.sourceMount.directory) ||
      (command.dependencyMount !== undefined &&
        (command.dependencyMount.mode !== "ro" ||
          command.dependencyMount.path !== "/workspace/wordpress" ||
          !isAbsolute(command.dependencyMount.directory))) ||
      command.supportFiles.length !== 1 ||
      command.supportFiles[0]?.path !== "/opt/codex-support/report-schema.json"
    ) {
      throw new Error("Codex sandbox command is not admitted");
    }
    const mountOf = async (mount: {
      readonly directory: string;
      readonly expectedTree: ExpectedSourceTree;
    }): Promise<string> => {
      const directory = await realpath(mount.directory);
      const entry = await lstat(mount.directory);
      if (
        /[,:\n\0]/.test(directory) ||
        entry.isSymbolicLink() ||
        !(await stat(directory)).isDirectory()
      )
        throw new Error("Codex source mount is unavailable");
      const verified = await verifyCanonicalSourceTree(
        directory,
        mount.expectedTree,
      );
      if (!verified.matches)
        throw new Error("Codex source differs from the fixed snapshot tree");
      return directory;
    };
    const source = await mountOf(command.sourceMount);
    const dependency =
      command.dependencyMount === undefined
        ? undefined
        : await mountOf(command.dependencyMount);

    const scratchRoot = await realpath(this.#options.scratchRootDirectory);
    if (
      /[,:\n\0]/.test(scratchRoot) ||
      !(await stat(scratchRoot)).isDirectory()
    )
      throw new Error("Codex scratch root is unavailable");
    const staging = await mkdtemp(join(scratchRoot, "codex-run-"));
    // A login grant needs a writable CLI home holding the per-run login.
    const codexHome =
      tls === undefined
        ? undefined
        : await mkdtemp(join(scratchRoot, "codex-home-")).catch(
            async (error: unknown) => {
              await rm(staging, { recursive: true, force: true });
              throw error;
            },
          );
    const now = this.#options.clock ?? (() => new Date());
    const token = command.grant.authorization.replace(/^Bearer /, "");
    const runDocker = this.#docker(scratchRoot, token);
    const base = this.#base();
    try {
      await writeFile(
        join(staging, "report-schema.json"),
        command.supportFiles[0].content,
        { flag: "wx", mode: 0o600 },
      );
      if (tls !== undefined && codexHome !== undefined) {
        await writeFile(join(staging, "grant-ca.pem"), tls.caPem, {
          flag: "wx",
          mode: 0o600,
        });
        await writeFile(
          join(codexHome, "auth.json"),
          grantLogin(token, now(), command.grant.expiresAt),
          { flag: "wx", mode: 0o600 },
        );
      }
      const { cliVersion, bundledCatalogDigest } = await this.#probe(runDocker);
      const startedAt = now().toISOString();
      const args = [
        ...base,
        // The prompt arrives on stdin.
        "--interactive",
        `--network=${command.grant.dockerNetworkName}`,
        `--add-host=${command.labHost.name}:${command.labHost.ipv4}`,
        ...(command.databaseHost === undefined
          ? []
          : [
              `--add-host=${command.databaseHost.name}:${command.databaseHost.ipv4}`,
            ]),
        `--mount=type=bind,src=${source},dst=/workspace/main,readonly`,
        ...(dependency === undefined
          ? []
          : [
              `--mount=type=bind,src=${dependency},dst=/workspace/wordpress,readonly`,
            ]),

        `--mount=type=bind,src=${staging},dst=/opt/codex-support,readonly`,
        "--workdir=/workspace/main",
        "--env=HOME=/tmp",
        "--env=CODEX_HOME=/tmp/codex",
        ...(tls === undefined || codexHome === undefined
          ? [`--env=OPENAI_API_KEY=${token}`]
          : [
              `--add-host=${BROKER_TLS_HOSTNAME}:${tls.address}`,
              `--mount=type=bind,src=${codexHome},dst=/tmp/codex`,
              "--env=CODEX_CA_CERTIFICATE=/opt/codex-support/grant-ca.pem",
            ]),
        "--entrypoint=codex",
        this.#options.image,
        ...command.args,
      ];
      const result = await runDocker(
        args,
        command.stdin,
        this.#options.timeoutMs,
      );
      const completedAt = now().toISOString();
      return {
        status: result.kind === "exited" ? "exited" : "failed",
        exitCode: result.kind === "exited" ? result.exitCode : -1,
        stdout: result.stdout,
        startedAt,
        completedAt,
        image: this.#options.image,
        cliVersion,
        bundledCatalogDigest,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (codexHome !== undefined)
        await rm(codexHome, { recursive: true, force: true });
    }
  }
}
