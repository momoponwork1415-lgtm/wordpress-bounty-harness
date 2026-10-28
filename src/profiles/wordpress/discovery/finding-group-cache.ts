import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import { wordPressFindingGroupKeys } from "./finding.js";

const legacyTrace = z.object({
  sourceTrace: z.array(
    z.object({
      file: z.string().min(1),
      function: z.string().min(1),
      line: z.number().int().positive(),
    }),
  ),
});

/** Only key digests leave Private Evidence; old events and artifacts stay intact. */
export async function deriveWordPressLegacyGroupKeyCache(
  ledger: Ledger,
  evidence: PrivateArtifactStore,
): Promise<Map<string, readonly string[]>> {
  const cache = new Map<string, readonly string[]>();
  for (const { event } of ledger.readAll({ type: "finding-recorded" })) {
    if (event.type !== "finding-recorded" || event.group !== undefined)
      continue;
    const artifact = event.artifacts.find((ref) => ref.kind === "finding");
    if (artifact === undefined || cache.has(artifact.digest)) continue;
    const stored = await evidence.readJson(
      artifact.digest,
      "finding.json",
      legacyTrace,
      1024 * 1024,
    );
    if (stored.status !== "resolved") continue;
    const keys = [
      ...new Set(
        wordPressFindingGroupKeys(stored.value).map((key) =>
          canonicalDigest(key),
        ),
      ),
    ].sort();
    if (keys.length > 0) cache.set(artifact.digest, keys);
  }
  return cache;
}
