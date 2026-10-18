import { relative, sep } from "node:path";

import { z } from "zod";

import {
  buildWordPressSourceIndex,
  phpFiles,
  type WordPressSourceIndex,
} from "./storage-index.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const entryId = z.string().regex(/^e-[1-9][0-9]*$/);

export const wordpressCoverageRecordSchema = z
  .strictObject({
    indexDigest: digest,
    incomplete: z.boolean(),
    entries: z.array(
      z.strictObject({
        id: entryId,
        status: z.enum(["observed", "blocked", "unvisited"]),
        reason: z
          .enum(["precondition", "source-unavailable", "lab-unavailable"])
          .nullable(),
      }),
    ),
  })
  .superRefine((record, context) => {
    record.entries.forEach((entry, ordinal) => {
      if ((entry.status === "blocked") !== (entry.reason !== null))
        context.addIssue({
          code: "custom",
          path: ["entries", ordinal, "reason"],
          message: "Blocked requires a reason; other statuses require null",
        });
    });
  });

export type WordPressCoverageRecord = z.infer<
  typeof wordpressCoverageRecordSchema
>;

/** IDs are local to the digest-pinned catalogue and follow its stable order. */
export function wordpressEntryIds(
  index: WordPressSourceIndex,
): readonly string[] {
  return index.entries.map((_, ordinal) => `e-${ordinal + 1}`);
}

export function assessWordPressCoverage(
  raw: unknown,
  index: WordPressSourceIndex,
  maxUnvisitedRatio: number,
): { readonly accepted: boolean; readonly record?: WordPressCoverageRecord } {
  const parsed = wordpressCoverageRecordSchema.safeParse(raw);
  if (!parsed.success) return { accepted: false };
  const record = parsed.data;
  const expected = wordpressEntryIds(index);
  const actual = new Set(record.entries.map((entry) => entry.id));
  if (
    record.indexDigest !== index.digest ||
    record.incomplete !== index.incomplete ||
    record.entries.length !== expected.length ||
    actual.size !== expected.length ||
    expected.some((id) => !actual.has(id))
  )
    return { accepted: false };
  const unvisited = record.entries.filter(
    (entry) => entry.status === "unvisited",
  ).length;
  return {
    accepted:
      index.incomplete ||
      expected.length === 0 ||
      unvisited / expected.length <= maxUnvisitedRatio,
    record,
  };
}

/** PHP files of a source tree and the registration files of its index entries, for `ledger coverage`. */
export async function wordpressSourceFileSets(sourceDirectory: string) {
  const listed = await phpFiles(sourceDirectory);
  // The plugin prefix only classifies storage keys; entry files do not depend on it.
  const index = await buildWordPressSourceIndex(sourceDirectory, "");
  return {
    all: listed.files
      .map((file) => relative(sourceDirectory, file).split(sep).join("/"))
      .sort(),
    indexed: [...new Set(index.entries.map((entry) => entry.file))].sort(),
  };
}
