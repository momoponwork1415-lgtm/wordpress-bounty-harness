import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";
import {
  runNativeModelProcess,
  type NativeModelProcessResult,
} from "../infrastructure/native-model-process.js";
import { stopDockerContainer } from "../infrastructure/stop-docker-container.js";
import { CLAUDE_RUNNER_SOURCE } from "./claude-runner.js";
import {
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB,
  admittedResearchSeed,
  collectResearchArchive,
  seedResearch,
} from "./codex-gvisor-sandbox.js";
import {
  codexThreadIdSchema,
  isClaudeTranscriptPath,
} from "./native-run-receipts.js";
import type { ProviderCredentialEgressGrant } from "./provider-credential-egress-broker.js";
import {
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountPathsAreDisjoint,
  isDependencyMountPath,
} from "./sandbox-layout.js";

/** The same budget as a cooperative Codex Trial, so campaign memory math holds. */
export const CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB =
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB;
const CLAUDE_CONFIG_MOUNT = "/tmp/claude";
const MAX_TRANSCRIPT_FILES = 256;
const MAX_TRANSCRIPT_BYTES = 60 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 300 * 1024 * 1024;

/**
 * What an earlier segment left, restored before a resumed Root starts
 * (ADR 0036): every transcript at its `projects/`-relative path, the Root
 * session's among them, and the notes archive's complete files.
 */
export type ClaudeSandboxResumeSeed = {
  readonly sessionId: string;
  readonly transcripts: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly research: readonly {
    readonly path: string;
    readonly content: Buffer;
  }[];
};

type Mount = {
  readonly directory: string;
  readonly expectedTree: ExpectedSourceTree;
};

export interface ClaudeSandboxCommand {
  readonly grant: ProviderCredentialEgressGrant;
  /** What the runner reads on stdin; the prompt texts are the Codex path's, unchanged. */
  readonly input: {
    readonly prompt: string;
    readonly resumePrompt: string;
    readonly minimumActiveMs: number;
    /** The PreToolUse hook's ceiling on live children. */
    readonly maxChildren: number;
    readonly model: string;
    readonly effort: string;
    readonly outputSchema: object;
    /** Resume this restored session; the first turn is the pinned directive (ADR 0036). */
    readonly resumeSessionId?: string;
  };
  /**
   * The model every child runs on, from the profile's `subagent.modelId`
   * (#418). Claude Code reads it from the environment, not the runner's stdin.
   */
  readonly subagentModel: string;
  /** Present exactly when `input.resumeSessionId` is. */
  readonly resume?: ClaudeSandboxResumeSeed;
  readonly sourceMount: Mount;
  readonly dependencyMounts: readonly (Mount & { readonly path: string })[];
  readonly labHost?: { readonly name: string; readonly ipv4: string };
  readonly databaseHost?: { readonly name: string; readonly ipv4: string };
}

export interface ClaudeSandboxResult {
  readonly status: "exited" | "failed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly failureKind?: "timed-out" | "output-limit-exceeded" | "cancelled";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly image: string;
  readonly cliVersion: string;
  /** Session transcripts under the Claude config directory, by `projects/`-relative path. */
  readonly transcripts?: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly transcriptFailure?: "capture-failed";
  readonly research?: { readonly archive: Buffer; readonly truncated: boolean };
  readonly researchFailure?: "capture-failed";
  readonly isolation: {
    readonly backend: "gvisor";
    readonly runtime: "runsc";
    readonly fallbackUsed: false;
  };
}

/** The Lab module supplies this executor. There is no host execution fallback. */
export interface ClaudeSandbox {
  execute(
    command: ClaudeSandboxCommand,
    signal?: AbortSignal,
  ): Promise<ClaudeSandboxResult>;
}

type DockerRun = (
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  /** Values the docker client passes on by name, kept out of argv. */
  hostEnvironment?: Readonly<Record<string, string>>,
) => Promise<NativeModelProcessResult>;

export interface GvisorClaudeSandboxOptions {
  readonly dockerExecutablePath: string;
  readonly image: string;
  readonly scratchRootDirectory: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly clock?: () => Date;
  readonly runDocker?: DockerRun;
}

const host = /^[a-z0-9][a-z0-9-]{0,62}$/;

function admittedResumeSeed(
  seed: ClaudeSandboxResumeSeed,
  sessionId: string | undefined,
): boolean {
  if (
    seed.sessionId !== sessionId ||
    !codexThreadIdSchema.safeParse(seed.sessionId).success ||
    seed.transcripts.length === 0 ||
    seed.transcripts.length > MAX_TRANSCRIPT_FILES
  )
    return false;
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of seed.transcripts) {
    if (!isClaudeTranscriptPath(file.path) || paths.has(file.path))
      return false;
    paths.add(file.path);
    const size = Buffer.byteLength(file.content);
    if (size === 0 || size > MAX_TRANSCRIPT_BYTES) return false;
    bytes += size;
  }
  return (
    bytes <= MAX_CAPTURE_BYTES &&
    [...paths].some(
      (path) =>
        path.split("/").length === 2 &&
        path.endsWith(`/${seed.sessionId}.jsonl`),
    ) &&
    admittedResearchSeed(seed.research)
  );
}

/** Writes the seed into the fresh, empty config and notes directories; `wx` refuses any pre-existing file. */
async function seedResume(
  home: string,
  research: string,
  seed: ClaudeSandboxResumeSeed,
): Promise<void> {
  for (const file of seed.transcripts) {
    const target = join(home, "projects", ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
  }
  await seedResearch(research, seed.research);
}

/** Every `*.jsonl` below `projects/`, bounded; a link or an oversize tree fails the capture. */
async function collectTranscripts(
  home: string,
): Promise<{ path: string; content: string }[]> {
  const projects = join(home, "projects");
  if (!(await lstat(projects).catch(() => undefined))?.isDirectory()) return [];
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) throw new Error("Claude transcript tree is too deep");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Claude transcript link");
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(path);
    }
  };
  await visit(projects, 0);
  if (files.length > MAX_TRANSCRIPT_FILES)
    throw new Error("Claude transcript count limit exceeded");
  let bytes = 0;
  const transcripts: { path: string; content: string }[] = [];
  for (const file of files.sort()) {
    const size = (await stat(file)).size;
    bytes += size;
    if (size > MAX_TRANSCRIPT_BYTES || bytes > MAX_CAPTURE_BYTES)
      throw new Error("Claude transcript evidence limit exceeded");
    transcripts.push({
      path: relative(projects, file).split(sep).join("/"),
      content: await readFile(file, "utf8"),
    });
  }
  return transcripts;
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
    if (
      !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(options.image) ||
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

  #docker(secret?: string): DockerRun {
    return (
      this.#options.runDocker ??
      ((args, stdin, timeoutMs, signal, hostEnvironment) =>
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
            ...hostEnvironment,
          },
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
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
      "--pids-limit=256",
      `--memory=${CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB}m`,
      "--cpus=2",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
    ];
  }

  /** The Claude Code version the pinned image ships, with no network and no source. */
  async probe(): Promise<{ readonly cliVersion: string }> {
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
    return { cliVersion };
  }

  async execute(
    command: ClaudeSandboxCommand,
    signal?: AbortSignal,
  ): Promise<ClaudeSandboxResult> {
    const { grant } = command;
    if (
      grant.protocol !== "anthropic-messages" ||
      grant.tls !== undefined ||
      !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(grant.baseUrl) ||
      !/^Bearer [A-Za-z0-9_-]{32,}$/.test(grant.authorization) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(grant.dockerNetworkName) ||
      (command.labHost !== undefined &&
        (!host.test(command.labHost.name) ||
          isIP(command.labHost.ipv4) !== 4)) ||
      (command.databaseHost !== undefined &&
        (command.labHost === undefined ||
          !host.test(command.databaseHost.name) ||
          isIP(command.databaseHost.ipv4) !== 4)) ||
      command.dependencyMounts.length > 33 ||
      !command.dependencyMounts.every((mount) =>
        isDependencyMountPath(mount.path),
      ) ||
      !dependencyMountPathsAreDisjoint(
        command.dependencyMounts.map((mount) => mount.path),
      ) ||
      (command.resume === undefined
        ? command.input.resumeSessionId !== undefined
        : !admittedResumeSeed(command.resume, command.input.resumeSessionId))
    )
      throw new Error("Claude sandbox command is not admitted");
    const mountOf = async (mount: Mount): Promise<string> => {
      const directory = await realpath(mount.directory);
      if (
        !isAbsolute(mount.directory) ||
        /[,:\n\0]/.test(directory) ||
        (await lstat(mount.directory)).isSymbolicLink() ||
        !(await stat(directory)).isDirectory() ||
        !(await verifyCanonicalSourceTree(directory, mount.expectedTree))
          .matches
      )
        throw new Error("Claude source differs from the fixed snapshot tree");
      return directory;
    };
    const mounts = [
      { path: SANDBOX_SOURCE_MOUNT_PATH, ...command.sourceMount },
      ...command.dependencyMounts,
    ];
    const verified = await Promise.all(
      mounts.map(async (mount) => ({
        path: mount.path,
        directory: await mountOf(mount),
      })),
    );
    const scratch = await realpath(this.#options.scratchRootDirectory);
    if (/[,:\n\0]/.test(scratch) || !(await stat(scratch)).isDirectory())
      throw new Error("Claude scratch root is unavailable");
    const token = grant.authorization.slice("Bearer ".length);
    const runDocker = this.#docker(token);
    const clock = this.#options.clock ?? (() => new Date());
    const containerName = `claude-agent-${randomUUID()}`;
    const created: string[] = [];
    try {
      for (const prefix of ["claude-run-", "claude-home-", "claude-research-"])
        created.push(await mkdtemp(join(scratch, prefix)));
      const [staging, home, research] = created as [string, string, string];
      if (command.resume !== undefined)
        await seedResume(home, research, command.resume);
      await writeFile(join(staging, "runner.mjs"), CLAUDE_RUNNER_SOURCE, {
        flag: "wx",
        mode: 0o600,
      });
      const { cliVersion } = await this.probe();
      const model = command.input.model;
      const subagentModel = command.subagentModel;
      const args = [
        ...this.#base(),
        `--name=${containerName}`,
        "--interactive",
        `--network=${grant.dockerNetworkName}`,
        ...[command.labHost, command.databaseHost].flatMap((entry) =>
          entry === undefined ? [] : [`--add-host=${entry.name}:${entry.ipv4}`],
        ),
        ...verified.map(
          (mount) =>
            `--mount=type=bind,src=${mount.directory},dst=${mount.path},readonly`,
        ),
        `--mount=type=bind,src=${research},dst=${SANDBOX_RESEARCH_MOUNT_PATH}`,
        `--mount=type=bind,src=${staging},dst=/opt/claude-support,readonly`,
        `--mount=type=bind,src=${home},dst=${CLAUDE_CONFIG_MOUNT}`,
        `--workdir=${SANDBOX_SOURCE_MOUNT_PATH}`,
        "--env=HOME=/tmp",
        `--env=CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_MOUNT}`,
        `--env=ANTHROPIC_BASE_URL=${grant.baseUrl}`,
        // A Trial-scoped grant the broker swaps for the owner's token; the
        // docker client passes the value on by name so it stays out of argv.
        "--env=ANTHROPIC_AUTH_TOKEN",
        // The Root and its side requests name the Root model; every child
        // names the subagent model. The broker admits exactly these two.
        `--env=ANTHROPIC_MODEL=${model}`,
        `--env=ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
        `--env=ANTHROPIC_SMALL_FAST_MODEL=${model}`,
        `--env=CLAUDE_CODE_SUBAGENT_MODEL=${subagentModel}`,
        // Claude Code 2.1.257 and newer: a `model` the Root passes to the
        // Agent tool does not override the subagent model.
        "--env=CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1",
        "--env=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        "--env=DISABLE_AUTOUPDATER=1",
        // The advisor is a server tool the broker refuses; keep Claude Code from offering it.
        "--env=CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1",
        // On a refusal Claude Code would switch the session to another model;
        // the owner chose to stop there instead (2026-10-19). The broker still
        // refuses any other model with 403 model-not-admitted.
        "--env=CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1",
        "--env=CLAUDE_CODE_NO_MODEL_FALLBACK=1",
        // Claude Code's nested bubblewrap cannot run under runsc (owner, 2026-10-14).
        "--env=CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0",
        "--entrypoint=node",
        this.#options.image,
        "/opt/claude-support/runner.mjs",
      ];
      const controller = new AbortController();
      const onAbort = () =>
        controller.abort(signal?.reason === "operator" ? "operator" : "wall");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const wallTimer = setTimeout(
        () => controller.abort("wall"),
        this.#options.timeoutMs,
      );
      const startedAt = clock().toISOString();
      let result: NativeModelProcessResult;
      try {
        const client = runDocker(
          args,
          JSON.stringify(command.input),
          this.#options.timeoutMs,
          controller.signal,
          { ANTHROPIC_AUTH_TOKEN: token },
        );
        const aborted = new Promise<NativeModelProcessResult>((resolve) => {
          const finish = () =>
            resolve({ kind: "cancelled", stdout: "", stderr: "" });
          controller.signal.addEventListener("abort", finish, { once: true });
          if (controller.signal.aborted) finish();
        });
        result = await Promise.race([client, aborted]);
        if (controller.signal.aborted || result.kind !== "exited")
          await stopDockerContainer(async (stopArgs, timeoutMs) => {
            const stopped = await runDocker(stopArgs, undefined, timeoutMs);
            return {
              exitCode: stopped.kind === "exited" ? stopped.exitCode : -1,
            };
          }, containerName);
        if (controller.signal.aborted)
          result = {
            kind:
              controller.signal.reason === "operator"
                ? "cancelled"
                : "timed-out",
            stdout: result.stdout,
            stderr: result.stderr,
          };
      } finally {
        clearTimeout(wallTimer);
        signal?.removeEventListener("abort", onAbort);
        await runDocker(
          ["rm", "--force", containerName],
          undefined,
          20_000,
        ).catch(() => undefined);
      }
      const completedAt = clock().toISOString();
      const transcripts = await collectTranscripts(home).then(
        (value) => ({ transcripts: value }),
        () => ({ transcriptFailure: "capture-failed" as const }),
      );
      const notes = await collectResearchArchive(research).then(
        (value) => ({ research: value }),
        () => ({ researchFailure: "capture-failed" as const }),
      );
      return {
        status: result.kind === "exited" ? "exited" : "failed",
        exitCode: result.kind === "exited" ? result.exitCode : -1,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.kind === "exited" ? {} : { failureKind: result.kind }),
        startedAt,
        completedAt,
        image: this.#options.image,
        cliVersion,
        ...transcripts,
        ...notes,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      };
    } finally {
      for (const directory of created)
        await rm(directory, { recursive: true, force: true });
    }
  }
}
