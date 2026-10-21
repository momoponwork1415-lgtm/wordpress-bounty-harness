import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  VerifierRecord,
  VerifierRecordReader,
} from "../../../review/index.js";
import { wordpressVictimRouteSchema } from "../lab/index.js";

const routeSchema = z.looseObject({
  victim: wordpressVictimRouteSchema.optional(),
});
/** Only the stored script judge has the Lab browser open the victim pages. */
const observerSchema = z.looseObject({
  judgeId: z.literal("wordpress-stored-script"),
  status: z.string().optional(),
  observedVia: z.string().optional(),
});
const SCREEN_FILES = ["victim-screen.png", "victim-screen-diagnostic.png"];

/**
 * Reads, for `review export`, the Verifier's `steps.md` and what the Lab
 * browser recorded on the victim pages `route.json` declared (#437). It copies
 * the observer's own status; the Verifier's narrative is never an observation,
 * and another judge's record is not a visit.
 */
export function createWordPressVerifierRecordReader(options: {
  readonly store: PrivateArtifactStore;
}): VerifierRecordReader {
  const { store } = options;
  const file = async (artifact: string, name: string) => {
    const read = await store.readFile(artifact, name, 16 * 1024 * 1024);
    if (read.status !== "resolved") return null;
    const digest = createHash("sha256").update(read.bytes).digest("hex");
    const path = join(store.contentPath(artifact), name);
    return { bytes: read.bytes, ref: { path, digest: `sha256:${digest}` } };
  };
  const parse = <T>(schema: z.ZodType<T>, entry: { bytes: Buffer } | null) => {
    try {
      const parsed = schema.safeParse(
        JSON.parse(entry?.bytes.toString("utf8") ?? "null") as unknown,
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  return {
    async read({ recipeDigest, evidenceDigest }): Promise<VerifierRecord> {
      const steps = (await file(recipeDigest, "steps.md"))?.ref ?? null;
      const route = parse(routeSchema, await file(recipeDigest, "route.json"));
      if (route?.victim === undefined) return { steps, victim: null };
      const evidence = async (name: string) =>
        evidenceDigest === null ? null : file(evidenceDigest, name);
      const beacon = await evidence("canary-observation.json");
      const seen = parse(observerSchema, beacon);
      const failure =
        seen === null ? await evidence("observer-diagnostic.json") : null;
      const failed = parse(observerSchema, failure) !== null;
      let screenshot: string | null = null;
      for (const name of seen === null ? [] : SCREEN_FILES)
        screenshot ??= (await evidence(name))?.ref.path ?? null;
      const fired =
        seen?.observedVia === "canary-beacon" ||
        seen?.status === "self-observed";
      return {
        steps,
        victim: {
          role: route.victim.role,
          pages: route.victim.paths.map((page) =>
            typeof page === "string"
              ? { address: page, actions: 0 }
              : { address: page.path, actions: page.actions.length },
          ),
          firing:
            seen !== null
              ? fired
                ? "observed"
                : "not-observed"
              : failed
                ? "visit-failed"
                : "not-recorded",
          record:
            (seen !== null ? beacon : failed ? failure : null)?.ref ?? null,
          screenshot,
        },
      };
    },
  };
}
