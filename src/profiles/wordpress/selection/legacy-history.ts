import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { WordPressLegacyHistory } from "./ledger-exclusions.js";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/);

/** The Git-outside JSON that `scripts/export-legacy-slugs.mjs` writes (D2). */
export const wordPressLegacyHistorySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    exportedAt: z.iso.datetime({ offset: true }),
    sources: z.array(z.string().min(1)).max(1000),
    started: z.array(slug),
    ambiguous: z.array(slug),
    reconsider: z.array(slug).default([]),
  })
  .refine(
    ({ started, ambiguous, reconsider }) => {
      const startedSlugs = new Set(started);
      const ambiguousSlugs = new Set(ambiguous);
      return (
        startedSlugs.size === started.length &&
        ambiguousSlugs.size === ambiguous.length &&
        new Set(reconsider).size === reconsider.length &&
        started.every((item) => !ambiguousSlugs.has(item))
      );
    },
    { message: "Legacy history has duplicate or conflicting slugs" },
  );

export type WordPressLegacyHistoryReport =
  | { readonly status: "unavailable" }
  | {
      readonly status: "available";
      readonly digest: string;
      readonly started: number;
      readonly ambiguous: number;
      readonly reconsider: number;
    };

/** Read on every selection; a missing file is `unavailable`, a malformed one is an error. */
export async function loadWordPressLegacyHistory(
  file: string | undefined,
): Promise<{
  readonly history: WordPressLegacyHistory;
  readonly report: WordPressLegacyHistoryReport;
}> {
  const unavailable = {
    history: "unavailable" as const,
    report: { status: "unavailable" as const },
  };
  if (file === undefined) return unavailable;
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unavailable;
    throw error;
  }
  const parsed = wordPressLegacyHistorySchema.safeParse(
    JSON.parse(bytes.toString("utf8")),
  );
  if (!parsed.success)
    throw new Error(`Legacy history is invalid: ${parsed.error.message}`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const { started, ambiguous, reconsider, exportedAt } = parsed.data;
  return {
    history: {
      started: new Set(started),
      ambiguous: new Set(ambiguous),
      reconsider: new Set(reconsider),
      exportedAt,
      digest,
    },
    report: {
      status: "available",
      digest,
      started: started.length,
      ambiguous: ambiguous.length,
      reconsider: reconsider.length,
    },
  };
}
