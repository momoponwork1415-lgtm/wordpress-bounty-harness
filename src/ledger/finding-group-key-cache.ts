import { readFile } from "node:fs/promises";

import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";

/** Bump this when the profile key rule changes; old caches then become unkeyed. */
export const FINDING_GROUP_KEY_RULE_VERSION = "profile-file-function/v1";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const cacheSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ruleVersion: z.literal(FINDING_GROUP_KEY_RULE_VERSION),
  entries: z.array(
    z.strictObject({ artifactDigest: digest, keyDigests: z.array(digest) }),
  ),
});

/** The file contains artifact and key digests only, never source frames. */
export function serializeFindingGroupKeyCache(
  entries: ReadonlyMap<string, readonly string[]>,
): string {
  return canonicalJson(
    cacheSchema.parse({
      schemaVersion: 1,
      ruleVersion: FINDING_GROUP_KEY_RULE_VERSION,
      entries: [...entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([artifactDigest, keyDigests]) => ({
          artifactDigest,
          keyDigests: [...new Set(keyDigests)].sort(),
        })),
    }),
  );
}

/** A missing, stale or malformed projection leaves legacy Findings unkeyed. */
export async function loadFindingGroupKeyCache(
  path: string,
): Promise<Map<string, readonly string[]>> {
  let bytes: string;
  try {
    bytes = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    return new Map();
  }
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) return new Map();
  const result = new Map<string, readonly string[]>();
  for (const entry of parsed.data.entries)
    if (!result.has(entry.artifactDigest))
      result.set(entry.artifactDigest, entry.keyDigests);
  return result;
}
