import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isIP } from "node:net";

import { z } from "zod";

import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";

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
/** A cooperative Trial keeps the Root and up to three CLI children in one sandbox. */
export const CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB = 8192;

const imageSchema = z
  .string()
  .regex(/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const networkSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const MAX_SESSION_FILES = 256;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 60 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 240 * 1024 * 1024;
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
  })}\n`;
}

/** Capture Root and the first three direct children, counting later children by metadata. */
async function collectRollouts(home: string): Promise<readonly string[]> {
  const sessions = join(home, "sessions");
  if (!(await lstat(sessions).catch(() => undefined))?.isDirectory()) return [];
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) throw new Error("Codex session tree is too deep");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Codex session tree contains a symlink");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (
        entry.isFile() &&
        /^rollout-[A-Za-z0-9_.-]+\.jsonl$/.test(entry.name)
      )
        files.push(path);
      if (files.length > MAX_SESSION_FILES)
        throw new Error("Codex session count exceeded");
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
  const capturedChildIds = new Set<string>();
  for (const child of children) {
    if (admittedIds.has(child.threadId)) continue;
    admittedIds.add(child.threadId);
    if (admittedIds.size <= 3) {
      admitted.add(child.file);
      capturedChildIds.add(child.threadId);
    }
  }
  const rollouts: string[] = [];
  let bytes = 0;
  for (const header of headers) {
    if (!admitted.has(header.file)) {
      if (
        header.kind === "child" &&
        rootIds.has(header.parentThreadId ?? "") &&
        !capturedChildIds.has(header.threadId)
      )
        rollouts.push(childMetadataOnly(header));
      continue;
    }
    const size = (await stat(header.file)).size;
    bytes += size;
    if (size > MAX_SESSION_BYTES || bytes > MAX_CAPTURE_BYTES)
      throw new Error("Codex session evidence limit exceeded");
    rollouts.push(await readSessionFile(header.file, MAX_SESSION_BYTES, true));
  }
  return rollouts;
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
async function collectResearchArchive(directory: string): Promise<{
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
      options.timeoutMs > 240 * 60_000 ||
      (options.memoryMiB !== undefined &&
        (!Number.isSafeInteger(options.memoryMiB) ||
          options.memoryMiB < CODEX_SANDBOX_MEMORY_MIB ||
          options.memoryMiB > CODEX_COOPERATIVE_SANDBOX_MEMORY_MIB))
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
      "--pids-limit=256",
      `--memory=${this.#options.memoryMiB ?? CODEX_SANDBOX_MEMORY_MIB}m`,
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
      (command.researchMount !== undefined &&
        (command.researchMount.mode !== "rw" ||
          command.researchMount.path !== "/workspace/research")) ||
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
    const base = this.#base();
    try {
      await writeFile(
        join(staging, "report-schema.json"),
        command.supportFiles[0].content,
        { flag: "wx", mode: 0o600 },
      );
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
      const args = [
        ...base,
        `--name=${containerName}`,
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
        ...(researchDirectory === undefined
          ? []
          : [
              `--mount=type=bind,src=${researchDirectory},dst=/workspace/research`,
            ]),

        `--mount=type=bind,src=${staging},dst=/opt/codex-support,readonly`,
        "--workdir=/workspace/main",
        "--env=HOME=/tmp",
        "--env=CODEX_HOME=/tmp/codex",
        `--mount=type=bind,src=${codexHome},dst=/tmp/codex`,
        ...(tls === undefined
          ? [`--env=OPENAI_API_KEY=${token}`]
          : [
              `--add-host=${BROKER_TLS_HOSTNAME}:${tls.address}`,
              "--env=CODEX_CA_CERTIFICATE=/opt/codex-support/grant-ca.pem",
            ]),
        "--entrypoint=codex",
        this.#options.image,
        ...command.args,
      ];
      let result: NativeModelProcessResult;
      try {
        result = await runDocker(args, command.stdin, this.#options.timeoutMs);
      } finally {
        // `--rm` is not sufficient when the Docker client is killed on timeout:
        // runsc may leave a stopped container behind (#176).
        await runDocker(
          ["rm", "--force", containerName],
          undefined,
          20_000,
        ).catch(() => undefined);
      }
      const completedAt = now().toISOString();
      const collected = await collectRollouts(codexHome).then(
        (rollouts) => ({ rollouts }),
        () => ({
          rollouts: [] as readonly string[],
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
        ...collected,
        ...researchCollected,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
      if (researchDirectory !== undefined)
        await rm(researchDirectory, { recursive: true, force: true });
    }
  }
}
