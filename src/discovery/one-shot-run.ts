import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import type { AgentRuntimeProfile } from "./agent-runtime-profile.js";
import type { NativeRunReceipt } from "./native-run-receipts.js";
import type { ProviderAttachmentRef } from "./provider-research-report.js";
import { SANDBOX_TOOLS_MOUNT_PATH } from "./sandbox-layout.js";

/**
 * A one-shot run is one agent turn in a disposable sandbox with no children
 * (ADR 0042): the roles of a partitioned Trial. The Harness mounts the fixed
 * sources as for a cooperative run, its own input files read-only under
 * `/workspace/input`, the tool files read-only under `/workspace/tools`, and
 * reads what the run wrote under `/workspace/output` or, for a run that
 * answers under the report schema, the final message.
 */
const ONE_SHOT_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** One agent without children, plus a separately accounted broker. */
export const ONE_SHOT_SANDBOX_MEMORY_MIB = 4096;
export const ONE_SHOT_MAX_FILES = 16;
export const ONE_SHOT_MAX_TOOL_BYTES = 1024 * 1024;
export const ONE_SHOT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/**
 * A sent-back enumerator reads its previous inventory and proposal as one
 * file, so an input file may hold two output files; the executor still
 * checks the send-back before it starts a run.
 */
export const ONE_SHOT_MAX_INPUT_BYTES = 2 * ONE_SHOT_MAX_OUTPUT_BYTES;
/** A role run is one sandbox under the same ceiling as a whole target. */
export const ONE_SHOT_MAX_WALL_MS = 240 * 60_000;

export type OneShotFile = {
  readonly name: string;
  readonly content: string;
};
export type OneShotToolFile = {
  readonly name: string;
  readonly content: Uint8Array;
};

/** A profile supplies the Lab data and the same setup boundary as its handoff. */
export interface OneShotLab {
  readonly endpoint: string;
  readonly networkName: string;
  readonly internalIp: string;
  readonly labJson: string;
  readonly administratorExpiresAt: string;
  /** Extra output names, including non-JSON evidence, under the existing limits. */
  readonly outputFileNames: readonly string[];
  /** Revoke setup credentials and restart observation; only then return attack.json. */
  closeSetup(signal: AbortSignal): Promise<string | undefined>;
}

export interface OneShotRun {
  readonly lab?: OneShotLab;
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
  readonly prompt: string;
  /** Mounted read-only at `/workspace/input/<name>`. */
  readonly inputFiles: readonly OneShotFile[];
  /** Mounted read-only at `/workspace/tools/<name>`; the agent runs them itself. */
  readonly toolFiles: readonly OneShotToolFile[];
  /**
   * `files`: every `*.json` under `/workspace/output`, plus the Lab's named files.
   * `report`: the final message under the Finding / Lead report schema, as a
   * cooperative Root's.
   */
  readonly output: "files" | "report";
  /** The sandbox wall of this run; the executor also races it. */
  readonly wallMs: number;
  readonly expiresAt: string;
  readonly sourceDirectory: string;
  readonly sourceTree: ExpectedSourceTree;
  readonly dependencySource?: {
    readonly path: string;
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  };
  readonly dependencySources?: readonly {
    readonly path: string;
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  }[];
}

export interface OneShotResult {
  readonly receipt: NativeRunReceipt;
  /** `output: "report"`: the sealed report when the final message held one. */
  readonly attachment?: ProviderAttachmentRef;
  /** `output: "files"`: what the run left under `/workspace/output`, by name. */
  readonly outputFiles?: readonly OneShotFile[];
  /** Whether an observed shell tool call named a mounted tool file. */
  readonly scriptRan: boolean;
}

/** The transport of a one-shot run; the Lab module supplies it, never host execution. */
export interface OneShotExecutor {
  execute(run: OneShotRun, signal?: AbortSignal): Promise<OneShotResult>;
}

export function admittedOneShotFiles(
  files: readonly { readonly name: string; readonly content: unknown }[],
  maxBytes: number,
): boolean {
  if (files.length > ONE_SHOT_MAX_FILES) return false;
  const names = new Set<string>();
  for (const file of files) {
    if (!ONE_SHOT_FILE_NAME.test(file.name) || names.has(file.name))
      return false;
    names.add(file.name);
    const size =
      typeof file.content === "string"
        ? Buffer.byteLength(file.content)
        : file.content instanceof Uint8Array
          ? file.content.byteLength
          : -1;
    if (size < 0 || size > maxBytes) return false;
  }
  return true;
}

type ToolUse = { readonly name?: unknown; readonly input?: unknown };

/**
 * Observed, not claimed: whether any Claude Bash or Codex command call in the events
 * (runner stdout or a transcript) named a file under the tools mount. The
 * agent's prose is never read for this.
 */
export function scriptRanIn(
  events: readonly Record<string, unknown>[],
): boolean {
  const prefix = `${SANDBOX_TOOLS_MOUNT_PATH}/`;
  for (const event of events) {
    if (event.type === "item.completed") {
      const item = event.item as
        { type?: unknown; command?: unknown } | undefined;
      if (
        item?.type === "command_execution" &&
        typeof item.command === "string" &&
        item.command.includes(prefix)
      )
        return true;
    }
    if (event.type !== "assistant") continue;
    const message = event.message;
    const content =
      typeof message === "object" && message !== null
        ? (message as { content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content as ToolUse[]) {
      if (typeof block !== "object" || block === null) continue;
      const input = block.input as { command?: unknown } | undefined;
      if (
        (block as { type?: unknown }).type === "tool_use" &&
        block.name === "Bash" &&
        typeof input?.command === "string" &&
        input.command.includes(prefix)
      )
        return true;
    }
  }
  return false;
}

/**
 * The JSON files a one-shot run left directly under its output directory,
 * bounded; a link or an oversize file fails the capture, a subdirectory or a
 * file of another extension is left behind unread.
 */
export async function collectOutputFiles(
  directory: string,
  names: readonly string[] = [],
): Promise<OneShotFile[]> {
  const files: OneShotFile[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) throw new Error("One-shot output link");
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".json") && !names.includes(entry.name))
    )
      continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).size > ONE_SHOT_MAX_OUTPUT_BYTES)
      throw new Error("One-shot output evidence limit exceeded");
    files.push({ name: entry.name, content: await readFile(path, "utf8") });
    if (files.length > ONE_SHOT_MAX_FILES)
      throw new Error("One-shot output count limit exceeded");
  }
  return files;
}

/** Writes a one-shot run's files into fresh directories; tool files are executable. */
export async function stageOneShotFiles(
  input: string,
  tools: string,
  files: Pick<OneShotRun, "inputFiles" | "toolFiles">,
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
