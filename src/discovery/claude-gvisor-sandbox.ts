import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";
import {
  runNativeModelProcess,
  type NativeModelProcessResult,
} from "../infrastructure/native-model-process.js";
import { collectResearchArchive } from "./codex-gvisor-sandbox.js";
import type { ProviderCredentialEgressGrant } from "./provider-credential-egress-broker.js";

export const CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB = 2048;
const pinnedImage = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const host = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export interface ClaudeSandboxCommand {
  readonly grant: ProviderCredentialEgressGrant;
  readonly model: "claude-opus-5-5";
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly prompt: string;
  readonly outputSchema: object;
  readonly source: {
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  };
  readonly dependency?: {
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  };
  readonly labHost: { readonly name: string; readonly ipv4: string };
  readonly databaseHost?: { readonly name: string; readonly ipv4: string };
  readonly deadline: string;
}

export interface ClaudeSandboxResult {
  readonly kind: "exited" | "timed-out" | "output-limit-exceeded";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cliVersion: string;
  readonly image: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly research?: { readonly archive: Buffer; readonly truncated: boolean };
  readonly researchFailure?: "capture-failed";
  readonly isolation: {
    readonly backend: "gvisor";
    readonly runtime: "runsc";
    readonly fallbackUsed: false;
  };
}

export interface ClaudeSandbox {
  probe(): Promise<{
    readonly cliVersion: string;
    readonly bundledCatalogDigest: "unavailable";
  }>;
  execute(command: ClaudeSandboxCommand): Promise<ClaudeSandboxResult>;
}

export interface GvisorClaudeSandboxOptions {
  readonly dockerExecutablePath: string;
  readonly image: string;
  readonly scratchRootDirectory: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly clock?: () => Date;
  readonly runDocker?: (
    args: readonly string[],
    stdin: string | undefined,
    timeoutMs: number,
  ) => Promise<NativeModelProcessResult>;
}

function nonRootUser(): string {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() <= 0 ||
    process.getgid() <= 0
  )
    throw new Error("A non-root host user is required for the Claude sandbox");
  return `${process.getuid()}:${process.getgid()}`;
}

export class GvisorClaudeSandbox implements ClaudeSandbox {
  readonly #options: GvisorClaudeSandboxOptions;
  readonly #user: string;

  constructor(options: GvisorClaudeSandboxOptions) {
    pinnedImage.parse(options.image);
    if (
      !isAbsolute(options.dockerExecutablePath) ||
      !isAbsolute(options.scratchRootDirectory) ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0 ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 240 * 60_000
    )
      throw new Error("Claude sandbox options are invalid");
    this.#options = options;
    this.#user = nonRootUser();
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
      "--pids-limit=128",
      `--memory=${CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB}m`,
      "--cpus=1",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
    ];
  }

  #docker(secret?: string) {
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
          workingDirectory: this.#options.scratchRootDirectory,
          environment: {
            PATH: process.env.PATH,
            LANG: "C",
            LC_ALL: "C",
            TZ: "UTC",
          },
          timeoutMs,
          maxOutputBytes: this.#options.maxOutputBytes,
          redact: (value) =>
            secret === undefined
              ? value
              : value.split(secret).join("[REDACTED]"),
        }))
    );
  }

  async probe() {
    const result = await this.#docker()(
      [
        ...this.#base(),
        "--network=none",
        "--entrypoint=claude",
        this.#options.image,
        "--version",
      ],
      undefined,
      20_000,
    );
    const cliVersion =
      result.kind === "exited" && result.exitCode === 0
        ? /\b(\d+\.\d+\.\d+)\s+\(Claude Code\)/.exec(result.stdout)?.[1]
        : undefined;
    if (cliVersion === undefined)
      throw new Error("Claude CLI version is unavailable");
    return { cliVersion, bundledCatalogDigest: "unavailable" as const };
  }

  async execute(command: ClaudeSandboxCommand): Promise<ClaudeSandboxResult> {
    name.parse(command.grant.dockerNetworkName);
    host.parse(command.labHost.name);
    if (
      isIP(command.labHost.ipv4) !== 4 ||
      (command.databaseHost !== undefined &&
        (host.safeParse(command.databaseHost.name).success === false ||
          isIP(command.databaseHost.ipv4) !== 4))
    )
      throw new Error("Claude Lab host is invalid");
    if (
      command.grant.protocol !== "anthropic-messages" ||
      command.grant.model !== command.model ||
      command.grant.tls !== undefined ||
      !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(command.grant.baseUrl) ||
      !/^Bearer [A-Za-z0-9_-]{32,}$/.test(command.grant.authorization)
    )
      throw new Error("Claude provider grant is invalid");
    const mountOf = async (directory: string, tree: ExpectedSourceTree) => {
      const actual = await realpath(directory);
      const entry = await lstat(directory);
      if (
        !isAbsolute(directory) ||
        /[,:\n\0]/.test(actual) ||
        entry.isSymbolicLink() ||
        !(await stat(actual)).isDirectory() ||
        !(await verifyCanonicalSourceTree(actual, tree)).matches
      )
        throw new Error("Claude source differs from the fixed snapshot tree");
      return actual;
    };
    const source = await mountOf(command.source.directory, command.source.tree);
    const dependency =
      command.dependency === undefined
        ? undefined
        : await mountOf(command.dependency.directory, command.dependency.tree);
    const scratch = await realpath(this.#options.scratchRootDirectory);
    if (/[,:\n\0]/.test(scratch) || !(await stat(scratch)).isDirectory())
      throw new Error("Claude scratch root is unavailable");
    const cliVersion = (await this.probe()).cliVersion;
    const token = command.grant.authorization.slice("Bearer ".length);
    const runDocker = this.#docker(token);
    const clock = this.#options.clock ?? (() => new Date());
    const containerName = `claude-agent-${randomUUID()}`;
    const timeoutMs = Math.min(
      this.#options.timeoutMs,
      new Date(command.deadline).getTime() - clock().getTime(),
    );
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Claude Trial deadline has passed");
    const research = await mkdtemp(join(scratch, "claude-research-"));
    try {
      const startedAt = clock().toISOString();
      let result: NativeModelProcessResult;
      try {
        result = await runDocker(
          [
            ...this.#base(),
            `--name=${containerName}`,
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
            `--mount=type=bind,src=${research},dst=/workspace/research`,
            "--workdir=/workspace/main",
            "--env=HOME=/tmp",
            "--env=DISABLE_TELEMETRY=1",
            "--env=DISABLE_ERROR_REPORTING=1",
            "--env=DISABLE_AUTOUPDATER=1",
            "--env=CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1",
            `--env=ANTHROPIC_API_KEY=${token}`,
            `--env=ANTHROPIC_BASE_URL=${command.grant.baseUrl}`,
            "--entrypoint=node",
            this.#options.image,
            "/opt/claude-sdk/runner.mjs",
          ],
          JSON.stringify({
            prompt: command.prompt,
            model: command.model,
            effort: command.effort,
            outputSchema: command.outputSchema,
          }),
          timeoutMs,
        );
      } finally {
        await runDocker(
          ["rm", "--force", containerName],
          undefined,
          20_000,
        ).catch(() => undefined);
      }
      const collected = await collectResearchArchive(research).then(
        (value) => ({ research: value }),
        () => ({ researchFailure: "capture-failed" as const }),
      );
      return {
        kind: result.kind,
        exitCode: result.kind === "exited" ? result.exitCode : -1,
        stdout: result.stdout,
        stderr: result.stderr,
        cliVersion,
        image: this.#options.image,
        startedAt,
        completedAt: clock().toISOString(),
        ...collected,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      };
    } finally {
      await rm(research, { recursive: true, force: true });
    }
  }
}
