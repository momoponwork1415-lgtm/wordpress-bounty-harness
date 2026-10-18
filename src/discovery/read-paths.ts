import { posix } from "node:path";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";

/** Private Evidence file of a run's `read-paths` artifact: sorted source-relative paths. */
export const READ_PATHS_FILE = "read-paths.json";
/** The read-only target source mount inside the sandbox. */
const SOURCE_MOUNT = "/workspace/main";
// A file-like token: no flags, globs, variables or `file:line`; the last segment has an extension.
const PATH_TOKEN = /^[A-Za-z0-9_./@+][A-Za-z0-9_./@+,-]*\.[A-Za-z0-9]+$/;

export type ObservedCommand = {
  readonly text: string;
  readonly cwd?: string;
  readonly parsed?: readonly unknown[];
};

/** Completed command events of one archived rollout; malformed lines are skipped. */
export function commandsFromRollout(raw: string): ObservedCommand[] {
  const commands: ObservedCommand[] = [];
  for (const line of raw.split("\n")) {
    type Loose = { [key: string]: unknown } | null | undefined;
    let event: Loose;
    try {
      event = JSON.parse(line) as Loose;
    } catch {
      continue;
    }
    const payload = event?.payload as Loose;
    const item = payload?.item as Loose;
    if (
      event?.type !== "event_msg" ||
      payload?.type !== "item_completed" ||
      item?.type !== "CommandExecution" ||
      !Array.isArray(item.command)
    )
      continue;
    commands.push({
      text:
        item.command
          .filter((part): part is string => typeof part === "string")
          .at(-1) ?? "",
      ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
      ...(Array.isArray(item.parsed_cmd) ? { parsed: item.parsed_cmd } : {}),
    });
  }
  return commands;
}

function directoryOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return SOURCE_MOUNT;
  if (!cwd.startsWith("file://")) return cwd;
  try {
    return new URL(cwd).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Sorted distinct source-relative paths that observed commands name under the
 * target or supplied dependency mounts. A lower bound: paths built by the
 * shell or tools are missed.
 */
export function readPathsFromCommands(
  commands: readonly ObservedCommand[],
): string[] {
  const paths = new Set<string>();
  for (const command of commands) {
    const directory = directoryOf(command.cwd);
    if (directory === undefined) continue;
    const parsed = (command.parsed ?? []).flatMap((raw) => {
      const entry = raw as { type?: unknown; path?: unknown } | null;
      return entry?.type === "read" && typeof entry.path === "string"
        ? [entry.path]
        : [];
    });
    const words = command.text
      .split(/[\s;&|()<>]+/)
      .map((word) => word.replace(/^['"]+|['"]+$/g, ""));
    for (const token of [...parsed, ...words]) {
      if (!PATH_TOKEN.test(token)) continue;
      const resolved = posix.resolve(directory, token);
      if (resolved.startsWith(`${SOURCE_MOUNT}/`))
        paths.add(resolved.slice(SOURCE_MOUNT.length + 1));
      else if (resolved.startsWith("/workspace/wordpress/"))
        paths.add(
          `@wordpress/${resolved.slice("/workspace/wordpress/".length)}`,
        );
      else if (resolved.startsWith("/workspace/php/"))
        paths.add(`@php/${resolved.slice("/workspace/php/".length)}`);
      else if (
        /^\/workspace\/dependencies\/[a-z0-9][a-z0-9-]{0,63}\//.test(resolved)
      )
        paths.add(
          `@dependencies/${resolved.slice("/workspace/dependencies/".length)}`,
        );
    }
  }
  return [...paths].sort();
}

/**
 * Derives read paths from one archived rollout and stores them as Private
 * Evidence. Returns the artifact digest, or undefined; it never fails a run.
 */
export async function recordReadPaths(
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  evidence: Pick<PrivateArtifactStore, "putFiles">,
  diagnosticDigest: string | undefined,
): Promise<string | undefined> {
  if (diagnosticDigest === undefined) return undefined;
  try {
    const stored = await attachments.readByDigest(
      "diagnostic",
      diagnosticDigest,
    );
    if (stored.status !== "resolved") return undefined;
    const paths = readPathsFromCommands(
      commandsFromRollout(stored.bytes.toString("utf8")),
    );
    return await evidence.putFiles({ [READ_PATHS_FILE]: canonicalJson(paths) });
  } catch {
    return undefined;
  }
}
