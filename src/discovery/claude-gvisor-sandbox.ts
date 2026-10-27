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
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";
import type { NativeModelProcessResult } from "../infrastructure/native-model-process.js";
import { recordDiscoveryOwner } from "../infrastructure/lab-owner-record.js";
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
import {
  GVISOR_ISOLATION,
  admittedDockerName,
  admittedLabHosts,
  brokerGrantFault,
  gvisorDockerClient,
  gvisorRunArgs,
  nonRootContainerUser,
  type ContainerOption,
  type DockerRun,
  type GvisorContainer,
} from "./gvisor-container.js";
import type { ProviderCredentialEgressGrant } from "./provider-credential-egress-broker.js";
import {
  admittedOneShotFiles,
  ONE_SHOT_MAX_FILES,
  ONE_SHOT_MAX_INPUT_BYTES,
  ONE_SHOT_MAX_OUTPUT_BYTES,
  ONE_SHOT_MAX_TOOL_BYTES,
  ONE_SHOT_MAX_WALL_MS,
  type OneShotFile,
  type OneShotToolFile,
} from "./one-shot-run.js";
import {
  SANDBOX_INPUT_MOUNT_PATH,
  SANDBOX_OUTPUT_MOUNT_PATH,
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  SANDBOX_TOOLS_MOUNT_PATH,
  dependencyMountPathsAreDisjoint,
  isDependencyMountPath,
} from "./sandbox-layout.js";

/** The same budget as a cooperative Codex Trial, so campaign memory math holds. */
export const CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB =
  CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB;
/**
 * A one-shot role of a partitioned Trial (ADR 0042) starts no children, so
 * its sandbox is sized for one agent; the campaign memory budget admits
 * `budget / (this + broker)` tracers at once. Both roles run at this size.
 */
export const CLAUDE_ONE_SHOT_SANDBOX_MEMORY_MIB = 4096;
/** Two CPUs per Claude container, as before candidate 9; the Codex sandbox keeps one. */
const CLAUDE_SANDBOX_CPUS = 2;
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
    /** Required for a cooperative run; absent on a one-shot run, which has one turn. */
    readonly resumePrompt?: string;
    readonly minimumActiveMs: number;
    /** The PreToolUse hook's ceiling on live children; 0 on a one-shot run. */
    readonly maxChildren: number;
    readonly model: string;
    readonly effort: string;
    /** Absent only on a one-shot run whose role writes files instead of a report. */
    readonly outputSchema?: object;
    /** ADR 0042: one turn of one agent; `oneShot` below carries its files. */
    readonly oneShot?: true;
    /** Resume this restored session; the first turn is the pinned directive (ADR 0036). */
    readonly resumeSessionId?: string;
    /** With `resumeSessionId`: Harness-generated facts sent before the directive on the first turn. */
    readonly resumeNotice?: string;
  };
  /**
   * The model every child runs on, from the profile's `subagent.modelId`
   * (#418). Claude Code reads it from the environment, not the runner's stdin.
   */
  readonly subagentModel: string;
  /** Present exactly when `input.resumeSessionId` is. */
  readonly resume?: ClaudeSandboxResumeSeed;
  /**
   * Present exactly when `input.oneShot` is: the Harness's input files
   * (read-only at `/workspace/input`), the tool files (read-only at
   * `/workspace/tools`) and the run's own wall, which replaces the sandbox's
   * configured timeout for this run.
   */
  readonly oneShot?: {
    readonly inputFiles: readonly OneShotFile[];
    readonly toolFiles: readonly OneShotToolFile[];
    readonly wallMs: number;
  };
  readonly sourceMount: Mount;
  readonly dependencyMounts: readonly (Mount & { readonly path: string })[];
  readonly labHost?: { readonly name: string; readonly ipv4: string };
  readonly databaseHost?: { readonly name: string; readonly ipv4: string };
  /** The exploration Lab's control endpoint (ADR 0003, 2026-10-25 addendum). */
  readonly controlHost?: { readonly name: string; readonly ipv4: string };
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
  /** One-shot runs only: every `*.json` directly under `/workspace/output`, by name. */
  readonly outputFiles?: readonly OneShotFile[];
  readonly outputFailure?: "capture-failed";
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

export interface GvisorClaudeSandboxOptions {
  readonly dockerExecutablePath: string;
  readonly image: string;
  readonly scratchRootDirectory: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly clock?: () => Date;
  readonly runDocker?: DockerRun;
  /** Host-wide discovery owner records; tests isolate it (#550). */
  readonly ownerDirectory?: string;
}

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

/** The command's shape is outside what the sandbox runs; nothing was started. */
export class ClaudeSandboxNotAdmittedError extends Error {
  constructor() {
    super("Claude sandbox command is not admitted");
    this.name = "ClaudeSandboxNotAdmittedError";
  }
}

/**
 * The JSON files a one-shot run left directly under its output directory,
 * bounded; a link or an oversize file fails the capture, a subdirectory or a
 * file of another extension is left behind unread.
 */
async function collectOutputFiles(directory: string): Promise<OneShotFile[]> {
  const files: OneShotFile[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) throw new Error("Claude output link");
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).size > ONE_SHOT_MAX_OUTPUT_BYTES)
      throw new Error("Claude output evidence limit exceeded");
    files.push({ name: entry.name, content: await readFile(path, "utf8") });
    if (files.length > ONE_SHOT_MAX_FILES)
      throw new Error("Claude output count limit exceeded");
  }
  return files;
}

/** Writes a one-shot run's files into fresh directories; tool files are executable. */
async function stageOneShotFiles(
  input: string,
  tools: string,
  files: NonNullable<ClaudeSandboxCommand["oneShot"]>,
): Promise<void> {
  for (const file of files.inputFiles)
    await writeFile(join(input, file.name), file.content, {
      flag: "wx",
      mode: 0o400,
    });
  for (const file of files.toolFiles)
    await writeFile(join(tools, file.name), file.content, {
      flag: "wx",
      mode: 0o500,
    });
}

/** A one-shot command's own shape (ADR 0042); the cooperative shape is the other branch. */
function admittedOneShot(command: ClaudeSandboxCommand): boolean {
  const { input, oneShot } = command;
  if (oneShot === undefined) return input.oneShot === undefined;
  return (
    input.oneShot === true &&
    input.maxChildren === 0 &&
    input.minimumActiveMs === 0 &&
    input.resumePrompt === undefined &&
    input.resumeSessionId === undefined &&
    input.resumeNotice === undefined &&
    command.resume === undefined &&
    Number.isSafeInteger(oneShot.wallMs) &&
    oneShot.wallMs > 0 &&
    oneShot.wallMs <= ONE_SHOT_MAX_WALL_MS &&
    admittedOneShotFiles(oneShot.inputFiles, ONE_SHOT_MAX_INPUT_BYTES) &&
    admittedOneShotFiles(oneShot.toolFiles, ONE_SHOT_MAX_TOOL_BYTES)
  );
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
    this.#user = nonRootContainerUser("Claude sandbox");
  }

  #docker(secret?: string): DockerRun {
    return (
      this.#options.runDocker ??
      gvisorDockerClient({
        dockerExecutablePath: this.#options.dockerExecutablePath,
        workingDirectory: this.#options.scratchRootDirectory,
        maxOutputBytes: this.#options.maxOutputBytes,
        ...(secret === undefined ? {} : { secret }),
      })
    );
  }

  #runArgs(
    container: Pick<GvisorContainer, "entrypoint" | "command" | "agent">,
    memoryMiB = CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB,
  ): string[] {
    return gvisorRunArgs({
      user: this.#user,
      memoryMiB,
      cpus: CLAUDE_SANDBOX_CPUS,
      image: this.#options.image,
      ...container,
    });
  }

  /** The Claude Code version the pinned image ships, with no network and no source. */
  async probe(): Promise<{ readonly cliVersion: string }> {
    const result = await this.#docker()(
      this.#runArgs({ entrypoint: "claude", command: ["--version"] }),
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
      brokerGrantFault(grant) !== undefined ||
      !admittedDockerName(grant.dockerNetworkName) ||
      // Stricter than before candidate 9: a database host named like the Lab
      // host is refused, as the Codex sandbox always did.
      !admittedLabHosts(command) ||
      command.dependencyMounts.length > 33 ||
      !command.dependencyMounts.every((mount) =>
        isDependencyMountPath(mount.path),
      ) ||
      !dependencyMountPathsAreDisjoint(
        command.dependencyMounts.map((mount) => mount.path),
      ) ||
      (command.input.resumeNotice !== undefined &&
        (command.input.resumeSessionId === undefined ||
          command.input.resumeNotice.length === 0 ||
          command.input.resumeNotice.length > 4_096)) ||
      (command.resume === undefined
        ? command.input.resumeSessionId !== undefined
        : !admittedResumeSeed(command.resume, command.input.resumeSessionId)) ||
      !admittedOneShot(command) ||
      (command.oneShot === undefined &&
        (command.input.resumePrompt === undefined ||
          command.input.outputSchema === undefined ||
          command.input.maxChildren < 1))
    )
      throw new ClaudeSandboxNotAdmittedError();
    const oneShot = command.oneShot;
    const wallMs = oneShot?.wallMs ?? this.#options.timeoutMs;
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
      for (const prefix of [
        "claude-run-",
        "claude-home-",
        "claude-research-",
        ...(oneShot === undefined
          ? []
          : ["claude-input-", "claude-tools-", "claude-output-"]),
      ])
        created.push(await mkdtemp(join(scratch, prefix)));
      const [staging, home, research, input, tools, output] = created as [
        string,
        string,
        string,
        string | undefined,
        string | undefined,
        string | undefined,
      ];
      if (command.resume !== undefined)
        await seedResume(home, research, command.resume);
      if (oneShot !== undefined)
        await stageOneShotFiles(input!, tools!, oneShot);
      await writeFile(join(staging, "runner.mjs"), CLAUDE_RUNNER_SOURCE, {
        flag: "wx",
        mode: 0o600,
      });
      const { cliVersion } = await this.probe();
      const model = command.input.model;
      const subagentModel = command.subagentModel;
      const mount = (
        source: string,
        target: string,
        readonly: boolean,
      ): ContainerOption => ({ mount: { source, target, readonly } });
      const args = this.#runArgs(
        {
          agent: {
            name: containerName,
            network: grant.dockerNetworkName,
            hosts: command,
            options: [
              ...verified.map(({ directory, path }) =>
                mount(directory, path, true),
              ),
              mount(research, SANDBOX_RESEARCH_MOUNT_PATH, false),
              ...(oneShot === undefined
                ? []
                : [
                    mount(input!, SANDBOX_INPUT_MOUNT_PATH, true),
                    mount(tools!, SANDBOX_TOOLS_MOUNT_PATH, true),
                    mount(output!, SANDBOX_OUTPUT_MOUNT_PATH, false),
                  ]),
              mount(staging, "/opt/claude-support", true),
              mount(home, CLAUDE_CONFIG_MOUNT, false),
              { workdir: SANDBOX_SOURCE_MOUNT_PATH },
              { env: "HOME", value: "/tmp" },
              { env: "CLAUDE_CONFIG_DIR", value: CLAUDE_CONFIG_MOUNT },
              { env: "ANTHROPIC_BASE_URL", value: grant.baseUrl },
              // A Trial-scoped grant the broker swaps for the owner's token; the
              // docker client passes the value on by name so it stays out of argv.
              { env: "ANTHROPIC_AUTH_TOKEN" },
              // The Root and its side requests name the Root model; every child
              // names the subagent model. The broker admits exactly these two.
              { env: "ANTHROPIC_MODEL", value: model },
              { env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: model },
              { env: "ANTHROPIC_SMALL_FAST_MODEL", value: model },
              { env: "CLAUDE_CODE_SUBAGENT_MODEL", value: subagentModel },
              // Claude Code 2.1.257 and newer: a `model` the Root passes to the
              // Agent tool does not override the subagent model.
              { env: "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", value: "1" },
              { env: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", value: "1" },
              { env: "DISABLE_AUTOUPDATER", value: "1" },
              // The advisor is a server tool the broker refuses; keep Claude Code from offering it.
              { env: "CLAUDE_CODE_DISABLE_ADVISOR_TOOL", value: "1" },
              // On a refusal Claude Code would switch the session to another model;
              // the owner chose to stop there instead (2026-10-19). The broker still
              // refuses any other model with 403 model-not-admitted.
              { env: "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", value: "1" },
              { env: "CLAUDE_CODE_NO_MODEL_FALLBACK", value: "1" },
              // Claude Code's nested bubblewrap cannot run under runsc (owner, 2026-10-14).
              { env: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", value: "0" },
            ],
          },
          entrypoint: "node",
          command: ["/opt/claude-support/runner.mjs"],
        },
        oneShot === undefined
          ? CLAUDE_COOPERATIVE_SANDBOX_MEMORY_MIB
          : CLAUDE_ONE_SHOT_SANDBOX_MEMORY_MIB,
      );
      // Before the container exists, so another runner's sweep never names it (#550).
      const owner = await recordDiscoveryOwner({
        resource: containerName,
        ...(this.#options.ownerDirectory === undefined
          ? {}
          : { directory: this.#options.ownerDirectory }),
      });
      const controller = new AbortController();
      const onAbort = () =>
        controller.abort(signal?.reason === "operator" ? "operator" : "wall");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const wallTimer = setTimeout(() => controller.abort("wall"), wallMs);
      const startedAt = clock().toISOString();
      let result: NativeModelProcessResult;
      try {
        const client = runDocker(
          args,
          JSON.stringify(command.input),
          wallMs,
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
        await owner.release().catch(() => undefined);
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
      const outputs =
        output === undefined
          ? {}
          : await collectOutputFiles(output).then(
              (value) => ({ outputFiles: value }),
              () => ({ outputFailure: "capture-failed" as const }),
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
        ...outputs,
        isolation: GVISOR_ISOLATION,
      };
    } finally {
      for (const directory of created)
        await rm(directory, { recursive: true, force: true });
    }
  }
}
