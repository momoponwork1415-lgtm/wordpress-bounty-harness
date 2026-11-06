import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * ADR 0052: the continuation contract. A Root may leave
 * `/workspace/research/continuation.json`, its own list of open routes. The
 * Harness reads only the file's shape, the number of routes and a digest of
 * each route id; it never reads, records or judges the route text
 * (`observation`, `unresolved`, `nextCheck`).
 */

/** The file at the root of the sealed notes directory. */
export const CONTINUATION_FILE = "continuation.json";
/** The id digests recorded per run; beyond this the list is cut and marked. */
export const MAX_CONTINUATION_ID_DIGESTS = 64;
/** Automatic Trials per Snapshot in one chain, the first included (owner rule, ADR 0051 addendum). */
export const MAX_AUTOMATIC_CONTINUATION_TRIALS = 3;

const relativeSourceFile = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.startsWith(".."), {
    message: "sourceFile is relative and does not start with / or ..",
  });

/** The file's shape (strict): the Harness checks it and nothing else. */
export const continuationFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  openRoutes: z.array(
    z.strictObject({
      id: z.string().min(1).max(128),
      sourceFile: relativeSourceFile,
      sourceLine: z.number().int().positive(),
      observation: z.string(),
      unresolved: z.string(),
      nextCheck: z.string(),
    }),
  ),
});

/** What `discovery-run-finished.continuation` records for one sealed notes archive. */
export type ContinuationRecord =
  | { readonly status: "absent" | "invalid" }
  | {
      readonly status: "valid";
      readonly openRouteCount: number;
      /** sha256 of each route id, in file order, at most `MAX_CONTINUATION_ID_DIGESTS`. */
      readonly openRouteIdDigests: string[];
      /** Present when more ids than the cap were declared. */
      readonly truncated?: true;
    };

export function continuationIdDigest(id: string): string {
  return `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

const archiveEntries = z.looseObject({
  entries: z.array(
    z.looseObject({
      path: z.string(),
      type: z.string(),
      contentBase64: z.string().optional(),
      truncated: z.literal(true).optional(),
    }),
  ),
});

/**
 * Checks the `continuation.json` entry of a sealed notes archive
 * (`research-directory-archive`) against the contract. A missing entry is
 * `absent`; a cut, unreadable or ill-shaped one is `invalid`. Undefined when
 * the archive itself cannot be read: nothing is recorded then.
 */
export function inspectContinuation(
  archive: Buffer,
): ContinuationRecord | undefined {
  let parsed: z.infer<typeof archiveEntries>;
  try {
    parsed = archiveEntries.parse(JSON.parse(archive.toString("utf8")));
  } catch {
    return undefined;
  }
  const entry = parsed.entries.find(
    ({ path, type }) => path === CONTINUATION_FILE && type === "file",
  );
  if (entry === undefined) return { status: "absent" };
  if (entry.truncated === true || entry.contentBase64 === undefined)
    return { status: "invalid" };
  let file: z.infer<typeof continuationFileSchema>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(entry.contentBase64, "base64"),
    );
    file = continuationFileSchema.parse(JSON.parse(text));
  } catch {
    return { status: "invalid" };
  }
  const digests = file.openRoutes.map(({ id }) => continuationIdDigest(id));
  return {
    status: "valid",
    openRouteCount: file.openRoutes.length,
    openRouteIdDigests: digests.slice(0, MAX_CONTINUATION_ID_DIGESTS),
    ...(digests.length > MAX_CONTINUATION_ID_DIGESTS
      ? { truncated: true as const }
      : {}),
  };
}

/**
 * The progress rule: a later Trial made none when every id digest it received
 * is still open. Set arithmetic on digests only.
 */
export function continuationMadeNoProgress(
  passed: readonly string[],
  open: readonly string[],
): boolean {
  const still = new Set(open);
  return passed.every((digest) => still.has(digest));
}
