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
export const ONE_SHOT_MAX_FILES = 16;
export const ONE_SHOT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const ONE_SHOT_MAX_TOOL_BYTES = 1024 * 1024;
export const ONE_SHOT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
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

export interface OneShotRun {
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
  readonly prompt: string;
  /** Mounted read-only at `/workspace/input/<name>`. */
  readonly inputFiles: readonly OneShotFile[];
  /** Mounted read-only at `/workspace/tools/<name>`; the agent runs them itself. */
  readonly toolFiles: readonly OneShotToolFile[];
  /**
   * `files`: the run's result is every `*.json` under `/workspace/output`.
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
  /** Whether a Bash tool call of the run named a mounted tool file. */
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
 * Observed, not claimed: whether any `Bash` tool call in the given events
 * (runner stdout or a transcript) named a file under the tools mount. The
 * agent's prose is never read for this.
 */
export function scriptRanIn(
  events: readonly Record<string, unknown>[],
): boolean {
  const prefix = `${SANDBOX_TOOLS_MOUNT_PATH}/`;
  for (const event of events) {
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
