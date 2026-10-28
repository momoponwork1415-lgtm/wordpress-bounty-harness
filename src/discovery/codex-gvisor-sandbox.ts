import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import { recordDiscoveryOwner } from "../infrastructure/lab-owner-record.js";
import { stopDockerContainer } from "../infrastructure/stop-docker-container.js";

import type { NativeModelProcessResult } from "../infrastructure/native-model-process.js";
import {
  BROKER_TLS_HOSTNAME,
  CHATGPT_PLACEHOLDER_ACCOUNT_ID,
} from "./provider-credential-proxy.js";
import {
  GVISOR_ISOLATION,
  admittedDockerName,
  admittedLabHosts,
  brokerGrantFault,
  containerMount,
  gvisorDockerClient,
  gvisorRunArgs,
  nonRootContainerUser,
  type DockerRun,
  type GvisorContainer,
} from "./gvisor-container.js";
import type {
  CodexSandbox,
  CodexSandboxCommand,
  CodexSandboxLeftover,
  CodexSandboxResumeSeed,
  CodexSandboxResult,
} from "./codex-native-agent-runtime.js";
import {
  admittedOneShotFiles,
  collectOutputFiles,
  stageOneShotFiles,
  ONE_SHOT_SANDBOX_MEMORY_MIB,
  ONE_SHOT_MAX_INPUT_BYTES,
  ONE_SHOT_MAX_TOOL_BYTES,
  ONE_SHOT_MAX_WALL_MS,
} from "./one-shot-run.js";
import { MINIMUM_ACTIVE_RUNNER_SOURCE } from "./minimum-active-runner.js";
import { admittedOneShotLab, watchOneShotLab } from "./one-shot-lab.js";
import {
  codexThreadIdSchema,
  isCodexSessionPath,
} from "./native-run-receipts.js";
import {
  SANDBOX_INPUT_MOUNT_PATH,
  SANDBOX_OUTPUT_MOUNT_PATH,
  SANDBOX_TOOLS_MOUNT_PATH,
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountPathsAreDisjoint,
  isDependencyMountPath,
} from "./sandbox-layout.js";

/** Memory ceiling of one Codex sandbox container. */
export const CODEX_SANDBOX_MEMORY_MIB = 2048;
/** A cooperative Trial keeps the Root and up to four CLI children in one sandbox. */
export const CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB = 10240;
/** One CPU per Codex container, as before candidate 9; the Claude sandbox keeps two. */
const CODEX_SANDBOX_CPUS = 1;

const imageSchema = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const networkSchema = z
  .string()
  .refine(admittedDockerName, "Docker name is invalid");
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const MAX_SESSION_FILES = 256;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 60 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 300 * 1024 * 1024;
const MAX_RESEARCH_BYTES = 8 * 1024 * 1024;
const MAX_RESEARCH_ENTRIES = 256;
const MAX_RESEARCH_DEPTH = 16;
const MAX_RESEARCH_PATH_BYTES = 1024;

type SessionHeader = {
  readonly file: string;
  readonly order: number;
  readonly threadId: string;
  readonly startedAt: string;
  readonly kind: "root" | "child";
  readonly parentThreadId?: string;
  readonly agentPath?: string;
};

/** A positional read bounds memory even if a session file changes after stat. */
async function readSessionFile(
  file: string,
  maxBytes: number,
  requireWholeFile: boolean,
): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1)
      throw new Error("Codex session file is unsafe");
    if (requireWholeFile && entry.size > maxBytes)
      throw new Error("Codex session evidence limit exceeded");
    const length = Math.min(entry.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = await handle.read(buffer, offset, length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (requireWholeFile && offset !== length)
      throw new Error("Codex session file changed during capture");
    return buffer.toString("utf8", 0, offset);
  } finally {
    await handle.close();
  }
}

function sessionHeader(
  raw: string,
  file: string,
  order: number,
): SessionHeader | undefined {
  for (const line of raw.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event))
      continue;
    const record = event as Record<string, unknown>;
    if (record.type !== "session_meta") continue;
    const payload = record.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    )
      return undefined;
    const meta = payload as Record<string, unknown>;
    if (typeof meta.id !== "string") return undefined;
    const startedAt =
      typeof record.timestamp === "string"
        ? record.timestamp
        : new Date(0).toISOString();
    if (meta.source === "exec")
      return { file, order, threadId: meta.id, startedAt, kind: "root" };
    const source = meta.source;
    if (typeof source !== "object" || source === null || Array.isArray(source))
      return undefined;
    const subagent = (source as Record<string, unknown>).subagent;
    if (
      typeof subagent !== "object" ||
      subagent === null ||
      Array.isArray(subagent)
    )
      return undefined;
    const spawn = (subagent as Record<string, unknown>).thread_spawn;
    if (typeof spawn !== "object" || spawn === null || Array.isArray(spawn))
      return undefined;
    const child = spawn as Record<string, unknown>;
    if (
      typeof child.parent_thread_id !== "string" ||
      child.depth !== 1 ||
      typeof child.agent_path !== "string"
    )
      return undefined;
    return {
      file,
      order,
      threadId: meta.id,
      startedAt,
      kind: "child",
      parentThreadId: child.parent_thread_id,
      agentPath: child.agent_path,
    };
  }
  return undefined;
}

function childMetadataOnly(header: SessionHeader): string {
  return `${JSON.stringify({
    timestamp: header.startedAt,
    type: "session_meta",
    payload: {
      id: header.threadId,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: header.parentThreadId,
            depth: 1,
            agent_path: header.agentPath,
          },
        },
      },
    },
  })}\n${JSON.stringify({ type: "session_capture", payload: { truncated: true } })}\n`;
}

/**
 * Capture every direct child across waves; max_threads limits concurrency, not
 * total threads. `paths[i]` is the sessions-relative path of `rollouts[i]`, so
 * a later resume can restore each file where `codex exec resume` looks for it.
 */
async function collectRollouts(home: string): Promise<{
  readonly rollouts: readonly string[];
  readonly paths: readonly string[];
  readonly truncated: boolean;
}> {
  const sessions = join(home, "sessions");
  if (!(await lstat(sessions).catch(() => undefined))?.isDirectory())
    return { rollouts: [], paths: [], truncated: false };
  const files: string[] = [];
  let sessionCountTruncated = false;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) throw new Error("Codex session tree is too deep");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink())
        throw new Error("Codex session tree contains a symlink");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (
        entry.isFile() &&
        /^rollout-[A-Za-z0-9_.-]+\.jsonl$/.test(entry.name)
      ) {
        if (files.length < MAX_SESSION_FILES) files.push(path);
        else sessionCountTruncated = true;
      }
    }
  };
  await visit(sessions, 0);
  const headers: SessionHeader[] = [];
  for (const [order, file] of files.sort().entries()) {
    const header = sessionHeader(
      await readSessionFile(file, MAX_SESSION_HEADER_BYTES, false),
      file,
      order,
    );
    if (header !== undefined) headers.push(header);
  }
  const roots = headers.filter((header) => header.kind === "root");
  const rootIds = new Set(roots.map((header) => header.threadId));
  const children = headers
    .filter(
      (header) =>
        header.kind === "child" &&
        header.parentThreadId !== undefined &&
        rootIds.has(header.parentThreadId),
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.order - right.order,
    );
  const admitted = new Set(roots.map((header) => header.file));
  const admittedIds = new Set<string>();
  for (const child of children) {
    if (admittedIds.has(child.threadId)) continue;
    admittedIds.add(child.threadId);
    admitted.add(child.file);
  }
  const rollouts: string[] = [];
  const paths: string[] = [];
  let bytes = 0;
  let truncated = sessionCountTruncated;
  for (const header of headers) {
    if (!admitted.has(header.file)) continue;
    const path = relative(sessions, header.file).split(sep).join("/");
    const size = (await stat(header.file)).size;
    if (size > MAX_SESSION_BYTES || bytes + size > MAX_CAPTURE_BYTES) {
      truncated = true;
      if (header.kind === "child") {
        rollouts.push(childMetadataOnly(header));
        paths.push(path);
      }
      continue;
    }
    bytes += size;
    rollouts.push(await readSessionFile(header.file, MAX_SESSION_BYTES, true));
    paths.push(path);
  }
  return { rollouts, paths, truncated };
}

/** A relative path inside the restored notes directory: no absolute, `.`, `..` or empty segment. */
function isResearchRelativePath(path: string): boolean {
  if (path.length === 0 || Buffer.byteLength(path) > MAX_RESEARCH_PATH_BYTES)
    return false;
  const segments = path.split("/");
  return (
    segments.length <= MAX_RESEARCH_DEPTH + 1 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !/[\0\\]/.test(segment),
    )
  );
}

function admittedResumeSeed(seed: CodexSandboxResumeSeed): boolean {
  if (!codexThreadIdSchema.safeParse(seed.threadId).success) return false;
  if (seed.sessions.length === 0 || seed.sessions.length > MAX_SESSION_FILES)
    return false;
  const sessionPaths = new Set<string>();
  let sessionBytes = 0;
  for (const file of seed.sessions) {
    if (!isCodexSessionPath(file.path) || sessionPaths.has(file.path))
      return false;
    sessionPaths.add(file.path);
    const size = Buffer.byteLength(file.content);
    if (size === 0 || size > MAX_SESSION_BYTES) return false;
    sessionBytes += size;
  }
  if (sessionBytes > MAX_CAPTURE_BYTES) return false;
  return admittedResearchSeed(seed.research);
}

/** The notes a resume restores: relative paths, no duplicates, within the archive's own limits. */
export function admittedResearchSeed(
  research: CodexSandboxResumeSeed["research"],
): boolean {
  if (research.length > MAX_RESEARCH_ENTRIES) return false;
  const researchPaths = new Set<string>();
  let researchBytes = 0;
  for (const file of research) {
    if (!isResearchRelativePath(file.path) || researchPaths.has(file.path))
      return false;
    researchPaths.add(file.path);
    researchBytes += file.content.byteLength;
  }
  return researchBytes <= MAX_RESEARCH_BYTES;
}

/** Writes restored notes into the fresh, empty notes directory; `wx` refuses any pre-existing file. */
export async function seedResearch(
  researchDirectory: string,
  research: CodexSandboxResumeSeed["research"],
): Promise<void> {
  for (const file of research) {
    const target = join(researchDirectory, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
  }
}

/** Write the seed into the fresh, empty Codex home and notes directory; `wx` refuses any pre-existing file. */
async function seedResume(
  codexHome: string,
  researchDirectory: string,
  seed: CodexSandboxResumeSeed,
): Promise<void> {
  for (const file of seed.sessions) {
    const target = join(codexHome, "sessions", ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { flag: "wx", mode: 0o600 });
  }
  await seedResearch(researchDirectory, seed.research);
}

/**
 * Run markers sit beside the scratch directories, outside every container
 * mount, so an agent can neither read nor change them. One marker names the
 * directories of one cooperative run and the process that owns it (ADR 0036,
 * 2026-10-19 second addendum).
 */
const RUN_MARKER_DIRECTORY = "run-markers";
const runIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const runMarkerSchema = z.strictObject({
  kind: z.literal("codex-run-marker"),
  schemaVersion: z.literal(1),
  runId: z.string().regex(runIdPattern),
  runtimeProfileDigest: digestSchema,
  pid: z.number().int().positive(),
  bootId: z.string().min(1).max(128),
  startedAt: z.iso.datetime({ offset: true }),
  staging: z.string().regex(/^codex-run-[A-Za-z0-9]{6}$/),
  codexHome: z.string().regex(/^codex-home-[A-Za-z0-9]{6}$/),
  research: z.string().regex(/^codex-research-[A-Za-z0-9]{6}$/),
  /** Outlives a `kill -9` of its owner on the same boot; removed before reading back. */
  container: z
    .string()
    .regex(
      /^codex-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ),
  image: imageSchema,
  cliVersion: z.string().min(1).max(128),
  bundledCatalogDigest: digestSchema,
});

/** The process that runs a sandbox, and the host boot it runs on. */
export type SandboxOwner = { readonly pid: number; readonly bootId: string };

/** The kernel's boot id changes on every host, VM or WSL restart. */
async function currentOwner(): Promise<SandboxOwner> {
  const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then((text) => text.trim())
    .catch(() => "");
  return { pid: process.pid, bootId: bootId || "unavailable" };
}

/** Signal 0 probes without killing; EPERM means the pid exists under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The newest modification time below a directory, in ms; 0 when there is none. */
async function latestWrite(directory: string, depth = 0): Promise<number> {
  if (depth > MAX_RESEARCH_DEPTH) return 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  let latest = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      latest = Math.max(latest, await latestWrite(path, depth + 1));
    else if (entry.isFile())
      latest = Math.max(latest, (await lstat(path)).mtimeMs);
  }
  return latest;
}

/** Rollouts and notes as the sandbox hands them back after a run. */
async function captureRun(
  codexHome: string,
  researchDirectory: string | undefined,
): Promise<
  Pick<
    CodexSandboxResult,
    | "rollouts"
    | "rolloutPaths"
    | "rolloutFailure"
    | "research"
    | "researchFailure"
  >
> {
  const collected = await collectRollouts(codexHome).then(
    ({ rollouts, paths, truncated }) => ({
      rollouts,
      rolloutPaths: paths,
      ...(truncated ? { rolloutFailure: "capture-failed" as const } : {}),
    }),
    () => ({
      rollouts: [] as readonly string[],
      rolloutPaths: [] as readonly string[],
      rolloutFailure: "capture-failed" as const,
    }),
  );
  const researchCollected =
    researchDirectory === undefined
      ? {}
      : await collectResearchArchive(researchDirectory).then(
          (research) => ({ research }),
          () => ({ researchFailure: "capture-failed" as const }),
        );
  return { ...collected, ...researchCollected };
}

type ResearchArchiveEntry =
  | { readonly path: string; readonly type: "directory" }
  | {
      readonly path: string;
      readonly type: "file";
      readonly contentBase64: string;
      readonly truncated?: true;
    };

/** Copy a bounded, non-following view of the writable Trial notes into one canonical archive. */
export async function collectResearchArchive(directory: string): Promise<{
  readonly archive: Buffer;
  readonly truncated: boolean;
}> {
  const entries: ResearchArchiveEntry[] = [];
  let collectedBytes = 0;
  let truncated = false;
  const visit = async (
    currentDirectory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_RESEARCH_DEPTH) {
      truncated = true;
      return;
    }
    const children = await readdir(currentDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= MAX_RESEARCH_ENTRIES) {
        truncated = true;
        return;
      }
      const relativePath =
        relativeDirectory.length === 0
          ? child.name
          : `${relativeDirectory}/${child.name}`;
      if (Buffer.byteLength(relativePath) > MAX_RESEARCH_PATH_BYTES) {
        truncated = true;
        continue;
      }
      const path = join(currentDirectory, child.name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        truncated = true;
        continue;
      }
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.nlink !== 1) {
        truncated = true;
        continue;
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1) {
          truncated = true;
          continue;
        }
        const remaining = Math.max(0, MAX_RESEARCH_BYTES - collectedBytes);
        const length = Math.min(before.size, remaining);
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const read = await handle.read(
            buffer,
            offset,
            length - offset,
            offset,
          );
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          truncated = true;
          continue;
        }
        const complete = offset === before.size;
        collectedBytes += offset;
        entries.push({
          path: relativePath,
          type: "file",
          contentBase64: buffer.subarray(0, offset).toString("base64"),
          ...(complete ? {} : { truncated: true as const }),
        });
        if (!complete) truncated = true;
      } finally {
        await handle.close();
      }
    }
  };
  await visit(directory, "", 0);
  return {
    archive: Buffer.from(
      canonicalJson({
        kind: "research-directory-archive",
        schemaVersion: 1,
        truncated,
        collectedBytes,
        entries,
      }),
    ),
    truncated,
  };
}

export interface GvisorCodexSandboxOptions {
  readonly dockerExecutablePath: string;
  readonly image: string;
  /** Path inside the pinned image to the CLI's bundled model catalog. */
  readonly bundledCatalogPath: string;
  readonly scratchRootDirectory: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly memoryMiB?: number;
  readonly clock?: () => Date;
  readonly runDocker?: DockerRun;
  readonly randomUuid?: () => string;
  /** This process and boot, recorded in each run marker; tests substitute another host. */
  readonly owner?: () => Promise<SandboxOwner>;
  readonly ownerAlive?: (pid: number) => boolean;
  /** Host-wide discovery owner records; tests isolate it (#550). */
  readonly ownerDirectory?: string;
}

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

export class GvisorCodexSandbox implements CodexSandbox {
  readonly #options: GvisorCodexSandboxOptions;
  readonly #user: string;
  /** Marked runs that ended in this process, kept until `release` (#512). */
  readonly #ended = new Map<string, readonly string[]>();

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
    if (
      options.memoryMiB !== undefined &&
      (!Number.isSafeInteger(options.memoryMiB) ||
        options.memoryMiB < CODEX_SANDBOX_MEMORY_MIB ||
        options.memoryMiB > CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB)
    )
      throw new Error("Codex sandbox options are invalid");
    this.#options = options;
    this.#user = nonRootContainerUser("Codex sandbox");
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
    const versionResult = await runDocker(
      this.#runArgs({ entrypoint: "codex", command: ["--version"] }),
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
      this.#runArgs({
        entrypoint: "sha256sum",
        command: [this.#options.bundledCatalogPath],
      }),
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
      gvisorDockerClient({
        dockerExecutablePath: this.#options.dockerExecutablePath,
        workingDirectory,
        maxOutputBytes: this.#options.maxOutputBytes,
        ...(secret === undefined ? {} : { secret }),
      })
    );
  }

  #runArgs(
    container: Pick<GvisorContainer, "entrypoint" | "command" | "agent"> &
      Partial<Pick<GvisorContainer, "memoryMiB">>,
  ): string[] {
    return gvisorRunArgs({
      user: this.#user,
      memoryMiB: this.#options.memoryMiB ?? CODEX_SANDBOX_MEMORY_MIB,
      cpus: CODEX_SANDBOX_CPUS,
      image: this.#options.image,
      ...container,
    });
  }

  async execute(
    command: CodexSandboxCommand,
    signal?: AbortSignal,
  ): Promise<CodexSandboxResult> {
    networkSchema.parse(command.grant.dockerNetworkName);
    const tls = command.grant.tls;
    const grantFault = brokerGrantFault(command.grant);
    if (grantFault === "address")
      throw new Error("Provider broker address is invalid");
    if (grantFault === "authorization")
      throw new Error("Provider grant is invalid");
    if (
      command.executable !== "codex" ||
      (command.oneShot !== undefined &&
        (!admittedOneShotLab(command.oneShot, Date.now()) ||
          (command.oneShot.lab !== undefined &&
            (command.grant.dockerNetworkName !==
              command.oneShot.lab.networkName ||
              command.labHost?.name !==
                new URL(command.oneShot.lab.endpoint).hostname ||
              command.labHost?.ipv4 !== command.oneShot.lab.internalIp ||
              command.databaseHost !== undefined ||
              command.controlHost !== undefined)) ||
          command.minimumActiveMs !== undefined ||
          command.resume !== undefined ||
          command.runMarker !== undefined ||
          !command.args.includes("features.multi_agent=false") ||
          !Number.isSafeInteger(command.oneShot.wallMs) ||
          command.oneShot.wallMs <= 0 ||
          command.oneShot.wallMs > ONE_SHOT_MAX_WALL_MS ||
          !admittedOneShotFiles(
            command.oneShot.inputFiles,
            ONE_SHOT_MAX_INPUT_BYTES,
          ) ||
          !admittedOneShotFiles(
            command.oneShot.toolFiles,
            ONE_SHOT_MAX_TOOL_BYTES,
          ))) ||
      !admittedLabHosts(command) ||
      command.sourceMount.mode !== "ro" ||
      command.sourceMount.path !== SANDBOX_SOURCE_MOUNT_PATH ||
      !isAbsolute(command.sourceMount.directory) ||
      (command.dependencyMount !== undefined &&
        (command.dependencyMount.mode !== "ro" ||
          !isDependencyMountPath(command.dependencyMount.path) ||
          !isAbsolute(command.dependencyMount.directory))) ||
      (command.additionalDependencyMounts !== undefined &&
        (command.additionalDependencyMounts.length > 32 ||
          command.additionalDependencyMounts.some(
            (mount) =>
              mount.mode !== "ro" ||
              !isDependencyMountPath(mount.path) ||
              !isAbsolute(mount.directory),
          ))) ||
      // Every dependency tree sits beside the others under the workspace root.
      !dependencyMountPathsAreDisjoint([
        ...(command.dependencyMount === undefined
          ? []
          : [command.dependencyMount.path]),
        ...(command.additionalDependencyMounts ?? []).map(
          (mount) => mount.path,
        ),
      ]) ||
      (command.researchMount !== undefined &&
        (command.researchMount.mode !== "rw" ||
          command.researchMount.path !== SANDBOX_RESEARCH_MOUNT_PATH)) ||
      command.supportFiles.length !== 1 ||
      command.supportFiles[0]?.path !==
        "/opt/codex-support/report-schema.json" ||
      (command.minimumActiveMs === undefined
        ? command.resumeArgs !== undefined || command.resumePrompt !== undefined
        : !Number.isSafeInteger(command.minimumActiveMs) ||
          command.minimumActiveMs < 0 ||
          command.minimumActiveMs > this.#options.timeoutMs ||
          command.researchMount === undefined ||
          command.resumeArgs?.[0] !== "exec" ||
          command.resumeArgs?.[1] !== "resume" ||
          typeof command.resumePrompt !== "string" ||
          command.resumePrompt.length === 0 ||
          command.resumePrompt.length > 2_048) ||
      (command.resume !== undefined &&
        (command.minimumActiveMs === undefined ||
          !admittedResumeSeed(command.resume))) ||
      (command.resumeNotice !== undefined &&
        (command.resume === undefined ||
          command.resumeNotice.length === 0 ||
          command.resumeNotice.length > 4_096)) ||
      (command.runMarker !== undefined &&
        (command.researchMount === undefined ||
          !runIdPattern.test(command.runMarker.runId) ||
          !digestSchema.safeParse(command.runMarker.runtimeProfileDigest)
            .success))
    ) {
      throw new Error("Codex sandbox command is not admitted");
    }
    const wallMs = command.oneShot?.wallMs ?? this.#options.timeoutMs;
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
        : {
            path: command.dependencyMount.path,
            directory: await mountOf(command.dependencyMount),
          };
    const additionalDependencies = await Promise.all(
      (command.additionalDependencyMounts ?? []).map(async (mount) => ({
        path: mount.path,
        directory: await mountOf(mount),
      })),
    );

    const scratchRoot = await realpath(this.#options.scratchRootDirectory);
    if (
      /[,:\n\0]/.test(scratchRoot) ||
      !(await stat(scratchRoot)).isDirectory()
    )
      throw new Error("Codex scratch root is unavailable");
    const staging = await mkdtemp(join(scratchRoot, "codex-run-"));
    // The isolated CLI home holds child rollouts until Harness captures them.
    const codexHome = await mkdtemp(join(scratchRoot, "codex-home-")).catch(
      async (error: unknown) => {
        await rm(staging, { recursive: true, force: true });
        throw error;
      },
    );
    const researchDirectory =
      command.researchMount === undefined
        ? undefined
        : await mkdtemp(join(scratchRoot, "codex-research-")).catch(
            async (error: unknown) => {
              await rm(staging, { recursive: true, force: true });
              await rm(codexHome, { recursive: true, force: true });
              throw error;
            },
          );
    const now = this.#options.clock ?? (() => new Date());
    const containerName = `codex-agent-${uuidSchema.parse(
      (this.#options.randomUuid ?? randomUUID)(),
    )}`;
    networkSchema.parse(containerName);
    const token = command.grant.authorization.replace(/^Bearer /, "");
    const runDocker = this.#docker(scratchRoot, token);
    let markerPath: string | undefined;
    const oneShotDirectories: string[] = [];
    let input: string | undefined,
      tools: string | undefined,
      output: string | undefined;
    try {
      if (command.oneShot !== undefined) {
        for (const name of ["input", "tools", "output"])
          oneShotDirectories.push(
            await mkdtemp(join(scratchRoot, `codex-${name}-`)),
          );
        [input, tools, output] = oneShotDirectories;
        await stageOneShotFiles(input!, tools!, command.oneShot);
        if (command.oneShot.lab !== undefined)
          await writeFile(
            join(input!, "lab.json"),
            command.oneShot.lab.labJson,
            { flag: "wx", mode: 0o600 },
          );
      }
      await writeFile(
        join(staging, "report-schema.json"),
        command.supportFiles[0].content,
        { flag: "wx", mode: 0o600 },
      );
      if (command.minimumActiveMs !== undefined)
        await writeFile(
          join(staging, "minimum-active-runner.mjs"),
          MINIMUM_ACTIVE_RUNNER_SOURCE,
          { flag: "wx", mode: 0o600 },
        );
      // Restore an earlier segment's thread before the fresh container starts;
      // the same digest-verified source mounts and a new grant apply as always.
      if (command.resume !== undefined && researchDirectory !== undefined)
        await seedResume(codexHome, researchDirectory, command.resume);
      if (tls !== undefined) {
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
      if (command.runMarker !== undefined && researchDirectory !== undefined) {
        const owner = await (this.#options.owner ?? currentOwner)();
        const directory = join(scratchRoot, RUN_MARKER_DIRECTORY);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${command.runMarker.runId}.json`);
        await writeFile(
          path,
          canonicalJson(
            runMarkerSchema.parse({
              kind: "codex-run-marker",
              schemaVersion: 1,
              ...command.runMarker,
              pid: owner.pid,
              bootId: owner.bootId,
              startedAt,
              staging: relative(scratchRoot, staging),
              codexHome: relative(scratchRoot, codexHome),
              research: relative(scratchRoot, researchDirectory),
              container: containerName,
              image: this.#options.image,
              cliVersion,
              bundledCatalogDigest,
            }),
          ),
          { flag: "wx", mode: 0o600 },
        );
        markerPath = path;
      }
      const args = this.#runArgs({
        ...(command.oneShot === undefined
          ? {}
          : { memoryMiB: ONE_SHOT_SANDBOX_MEMORY_MIB }),
        agent: {
          name: containerName,
          network: command.grant.dockerNetworkName,
          hosts: command,
          options: [
            containerMount(source, SANDBOX_SOURCE_MOUNT_PATH, true),
            ...(dependency === undefined
              ? []
              : [containerMount(dependency.directory, dependency.path, true)]),
            ...additionalDependencies.map((mount) =>
              containerMount(mount.directory, mount.path, true),
            ),
            ...(researchDirectory === undefined
              ? []
              : [
                  containerMount(
                    researchDirectory,
                    SANDBOX_RESEARCH_MOUNT_PATH,
                    false,
                  ),
                ]),
            ...(command.oneShot === undefined
              ? []
              : [
                  containerMount(input!, SANDBOX_INPUT_MOUNT_PATH, true),
                  containerMount(tools!, SANDBOX_TOOLS_MOUNT_PATH, true),
                  containerMount(output!, SANDBOX_OUTPUT_MOUNT_PATH, false),
                ]),
            containerMount(staging, "/opt/codex-support", true),
            { workdir: SANDBOX_SOURCE_MOUNT_PATH },
            { env: "HOME", value: "/tmp" },
            { env: "CODEX_HOME", value: "/tmp/codex" },
            containerMount(codexHome, "/tmp/codex", false),
            ...(tls === undefined
              ? [{ env: "OPENAI_API_KEY", value: token }]
              : [
                  { host: { name: BROKER_TLS_HOSTNAME, ipv4: tls.address } },
                  {
                    env: "CODEX_CA_CERTIFICATE",
                    value: "/opt/codex-support/grant-ca.pem",
                  },
                ]),
          ],
        },
        entrypoint: command.minimumActiveMs === undefined ? "codex" : "node",
        command:
          command.minimumActiveMs === undefined
            ? command.args
            : [
                "/opt/codex-support/minimum-active-runner.mjs",
                String(command.minimumActiveMs),
                JSON.stringify(command.args),
                JSON.stringify(command.resumeArgs),
                command.resumePrompt!,
                ...(command.resume === undefined
                  ? []
                  : [
                      command.resume.threadId,
                      ...(command.resumeNotice === undefined
                        ? []
                        : [
                            Buffer.from(command.resumeNotice).toString(
                              "base64",
                            ),
                          ]),
                    ]),
              ],
      });
      let result: NativeModelProcessResult;
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
      const handoff =
        command.oneShot?.lab === undefined
          ? undefined
          : watchOneShotLab(
              input!,
              output!,
              command.oneShot.lab,
              () => controller.abort("lab"),
              controller.signal,
            );
      try {
        const client = runDocker(
          args,
          command.stdin,
          wallMs,
          controller.signal,
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
        if (controller.signal.aborted) {
          // Let the SIGTERM/SIGKILL process-tree path reap the attached client.
          await Promise.race([
            client.then(
              () => undefined,
              () => undefined,
            ),
            new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
          ]);
          result = {
            kind:
              controller.signal.reason === "operator"
                ? "cancelled"
                : "timed-out",
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }
      } finally {
        clearTimeout(wallTimer);
        signal?.removeEventListener("abort", onAbort);
        // `--rm` is not sufficient when the Docker client is killed on timeout:
        // runsc may leave a stopped container behind (#176).
        await runDocker(
          ["rm", "--force", containerName],
          undefined,
          20_000,
        ).catch(() => undefined);
        await handoff?.stop();
        await owner.release().catch(() => undefined);
      }
      const completedAt = now().toISOString();
      const captured = await captureRun(codexHome, researchDirectory);
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
        bundledCatalogDigest,
        ...captured,
        ...(handoff === undefined ? {} : { labHandoff: handoff.state }),
        ...(output === undefined
          ? {}
          : await collectOutputFiles(
              output,
              command.oneShot?.lab?.outputFileNames,
            ).then(
              (outputFiles) => ({ outputFiles }),
              () => ({ outputFailure: "capture-failed" as const }),
            )),
        isolation: GVISOR_ISOLATION,
      };
    } finally {
      for (const directory of oneShotDirectories)
        await rm(directory, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      // A marked run keeps its marker, sessions and notes until its finish is
      // in the ledger; a crash before that leaves them for `leftover` (#512).
      if (markerPath !== undefined && researchDirectory !== undefined)
        this.#ended.set(command.runMarker!.runId, [
          markerPath,
          codexHome,
          researchDirectory,
        ]);
      else {
        await rm(codexHome, { recursive: true, force: true });
        if (researchDirectory !== undefined)
          await rm(researchDirectory, { recursive: true, force: true });
      }
    }
  }

  /**
   * Removes the marker, then the directories, of a marked run that ended in
   * this process. The Trial executor calls it once the run's finish is
   * appended (#512); any other run id is left alone.
   */
  async release(runId: string): Promise<void> {
    const paths = this.#ended.get(runId);
    if (paths === undefined) return;
    this.#ended.delete(runId);
    for (const path of paths) await rm(path, { recursive: true, force: true });
  }
  /**
   * The directories a dead run left behind, read back as a failed result. A
   * run is dead when its marker names another boot, or a pid that no longer
   * runs on this boot; a live owner is never second-guessed. `completedAt` is
   * the last write below the run's sessions and notes (ADR 0036).
   */
  async leftover(runId: string): Promise<CodexSandboxLeftover> {
    if (!runIdPattern.test(runId)) return { status: "absent" };
    const scratchRoot = await realpath(this.#options.scratchRootDirectory);
    const markerPath = join(scratchRoot, RUN_MARKER_DIRECTORY, `${runId}.json`);
    let marker: z.infer<typeof runMarkerSchema>;
    try {
      marker = runMarkerSchema.parse(
        JSON.parse(await readFile(markerPath, "utf8")) as unknown,
      );
    } catch {
      return { status: "absent" };
    }
    if (marker.runId !== runId) return { status: "absent" };
    const owner = await (this.#options.owner ?? currentOwner)();
    if (
      marker.bootId === owner.bootId &&
      (marker.pid === owner.pid ||
        (this.#options.ownerAlive ?? processAlive)(marker.pid))
    )
      return { status: "alive" };
    const directories = [marker.staging, marker.codexHome, marker.research].map(
      (name) => join(scratchRoot, name),
    );
    const [, codexHome, research] = directories as [string, string, string];
    // A killed owner's container may still be writing; stop it before reading.
    await this.#docker(scratchRoot)(
      ["rm", "--force", marker.container],
      undefined,
      20_000,
    ).catch(() => undefined);
    const captured = await captureRun(codexHome, research);
    const lastWrite = Math.max(
      Date.parse(marker.startedAt),
      await latestWrite(join(codexHome, "sessions")),
      await latestWrite(research),
    );
    return {
      status: "found",
      runtimeProfileDigest: marker.runtimeProfileDigest,
      result: {
        status: "failed",
        exitCode: -1,
        stdout: "",
        stderr: "interrupted: the process that owned this run is gone",
        startedAt: marker.startedAt,
        completedAt: new Date(lastWrite).toISOString(),
        image: marker.image,
        cliVersion: marker.cliVersion,
        bundledCatalogDigest: marker.bundledCatalogDigest,
        ...captured,
        isolation: GVISOR_ISOLATION,
      },
      discard: async () => {
        for (const directory of directories)
          await rm(directory, { recursive: true, force: true });
        await rm(markerPath, { force: true });
      },
    };
  }
}
