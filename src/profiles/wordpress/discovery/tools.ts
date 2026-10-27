import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";

/**
 * The tool files a partitioned Trial mounts read-only at `/workspace/tools`
 * for the enumerator (ADR 0042). They are tools the agent runs and reads
 * itself, not Harness preprocessing: the Harness never runs them first and
 * never hands their output to the agent as a floor (design 2026-10-27 §4).
 * Each file is pinned by digest, and `toolsDigest` of a run names the set.
 */
interface WordPressEnumerationToolRecord {
  readonly id: string;
  readonly file: string;
  readonly digest: `sha256:${string}`;
  readonly status: "current" | "archived";
}

export const WORDPRESS_ENUMERATION_TOOLS = [
  {
    id: "enumerate-hooks-v1",
    file: "enumerate-hooks-v1.sh",
    digest:
      "sha256:dd208c53a31fb8c6d35759e4f651dcfc174ebfdc1273d7172f6bfe4acf2f5362",
    status: "current",
  },
  {
    id: "enumerate-sinks-v1",
    file: "enumerate-sinks-v1.sh",
    digest:
      "sha256:957be12aa7a8e250d40edfa6b637b7c65cd111abf8f6af42d28c90117d7605ea",
    status: "current",
  },
] as const satisfies readonly WordPressEnumerationToolRecord[];

export type WordPressEnumerationToolId =
  (typeof WORDPRESS_ENUMERATION_TOOLS)[number]["id"];
export const WORDPRESS_ENUMERATION_TOOL_IDS: readonly WordPressEnumerationToolId[] =
  WORDPRESS_ENUMERATION_TOOLS.map((tool) => tool.id);
/** The default tool set of a partitioned campaign: every current tool. */
export const WORDPRESS_CURRENT_ENUMERATION_TOOL_IDS: readonly WordPressEnumerationToolId[] =
  WORDPRESS_ENUMERATION_TOOLS.filter((tool) => tool.status === "current").map(
    (tool) => tool.id,
  );

export type WordPressEnumerationTool = {
  readonly id: WordPressEnumerationToolId;
  readonly file: string;
  readonly sourceUrl: URL;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
};

/** Reads one tool file and checks it against its pinned digest. */
export async function loadWordPressEnumerationTool(
  id: WordPressEnumerationToolId,
): Promise<WordPressEnumerationTool> {
  const record = WORDPRESS_ENUMERATION_TOOLS.find((tool) => tool.id === id);
  if (record === undefined)
    throw new Error("Unknown WordPress enumeration tool");
  const sourceUrl = new URL(`./tools/${record.file}`, import.meta.url);
  const bytes = await readFile(sourceUrl);
  const digest =
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  if (digest !== record.digest)
    throw new Error("Enumeration tool differs from its pinned digest");
  return { id, file: record.file, sourceUrl, bytes, digest };
}

/** The digest of a tool set, as `enumeration-recorded.toolsDigest` records it. */
export function wordPressEnumerationToolsDigest(
  ids: readonly WordPressEnumerationToolId[],
): string {
  const unique = [...new Set(ids)].sort();
  return canonicalDigest(
    unique.map((id) => {
      const record = WORDPRESS_ENUMERATION_TOOLS.find((tool) => tool.id === id);
      if (record === undefined)
        throw new Error("Unknown WordPress enumeration tool");
      return { id, digest: record.digest };
    }),
  );
}
