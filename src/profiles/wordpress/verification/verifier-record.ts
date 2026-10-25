import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type {
  VerifierRecord,
  VerifierRecordReader,
} from "../../../review/index.js";
import { wordpressVictimRouteSchema } from "../lab/index.js";
import {
  LAB_BROWSER_OBSERVATION_FILE,
  VICTIM_SCREEN_FILE,
} from "./attempt-observer.js";

const routeSchema = z.looseObject({
  victim: wordpressVictimRouteSchema.optional(),
});
/** Since #525 the attempt observer opens the victim pages and records what it saw. */
const labBrowserSchema = z.looseObject({
  observerId: z.literal("wordpress-lab-browser"),
  status: z.enum(["visited", "visit-failed"]),
  dialog: z
    .looseObject({
      marker: z.string(),
      event: z.looseObject({
        message: z.string(),
        topLevelPageUrlAtEvent: z.string().max(2048),
        frameUrlsAtEvent: z.array(z.string().max(2048)).min(1).max(50),
      }),
    })
    .optional(),
});
/** Records the deleted stored script judge left; they stay readable. */
const observerSchema = z.looseObject({
  judgeId: z.literal("wordpress-stored-script"),
  status: z.string().optional(),
  observedVia: z.string().optional(),
});
const dialogSchema = z.looseObject({
  judgeId: z.literal("wordpress-stored-script"),
  kind: z.literal("numeric-dialog"),
  status: z.literal("dialog-observed"),
  marker: z.string().regex(/^[1-9][0-9]{9,14}$/),
  dialogEvent: z.strictObject({
    type: z.literal("alert"),
    message: z.string(),
    topLevelPageUrlAtEvent: z.string().max(2048),
    topLevelPageOriginAtEvent: z.literal("http://wordpress"),
    frameUrlsAtEvent: z.array(z.string().max(2048)).min(1).max(50),
  }),
  victimRole: z.enum([
    "administrator",
    "subscriber",
    "customer",
    "unauthenticated",
  ]),
  victimPrincipal: z.enum(["self", "separate"]),
  snapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  labSetupDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  capturedAttackerRequestMarkerMatch: z.boolean(),
  verificationSequence: z.enum([
    "post-setup-request-before-victim-visit",
    "not-established",
  ]),
  requiresHumanPreexistingContentCheck: z.literal(true),
});
function atLabOrigin(url: string): boolean {
  try {
    return new URL(url).origin === "http://wordpress";
  } catch {
    return false;
  }
}
const SCREEN_FILES = ["victim-screen.png", "victim-screen-diagnostic.png"];

/**
 * Reads, for `review export`, the Verifier's `steps.md` and what the Lab
 * browser recorded on the victim pages `route.json` declared (#437). It copies
 * the observer's own status; the Verifier's narrative is never an observation,
 * and another judge's record is not a visit. Records made since #525 come
 * from the attempt observer; older ones from the deleted judges.
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
      const pages = route.victim.paths.map((page) =>
        typeof page === "string"
          ? { address: page, actions: 0 }
          : { address: page.path, actions: page.actions.length },
      );
      const browserRecord = await evidence(LAB_BROWSER_OBSERVATION_FILE);
      const browser = parse(labBrowserSchema, browserRecord);
      if (browser !== null && browserRecord !== null) {
        const dialog = browser.dialog;
        const fired =
          dialog !== undefined &&
          route.victim.dialogMarker !== undefined &&
          dialog.marker === route.victim.dialogMarker &&
          dialog.event.message === dialog.marker &&
          atLabOrigin(dialog.event.topLevelPageUrlAtEvent) &&
          dialog.event.frameUrlsAtEvent.every(atLabOrigin);
        return {
          steps,
          victim: {
            role: route.victim.role,
            pages,
            firing:
              browser.status === "visit-failed"
                ? "visit-failed"
                : fired
                  ? "observed"
                  : "not-observed",
            record: browserRecord.ref,
            screenshot:
              (
                (await evidence("victim-page-after-dialog.png")) ??
                (await evidence(VICTIM_SCREEN_FILE))
              )?.ref.path ?? null,
          },
        };
      }
      const beacon = await evidence("canary-observation.json");
      const seen = parse(observerSchema, beacon);
      const failure =
        seen === null ? await evidence("observer-diagnostic.json") : null;
      const failed = parse(observerSchema, failure) !== null;
      const dialog = await evidence("browser-dialog-observation.json");
      const candidateSignal = parse(dialogSchema, dialog);
      const signal =
        candidateSignal !== null &&
        route.victim.dialogMarker !== undefined &&
        candidateSignal.marker === route.victim.dialogMarker &&
        candidateSignal.dialogEvent.message === candidateSignal.marker &&
        candidateSignal.victimRole === route.victim.role &&
        atLabOrigin(candidateSignal.dialogEvent.topLevelPageUrlAtEvent) &&
        candidateSignal.dialogEvent.frameUrlsAtEvent.every(atLabOrigin) &&
        (candidateSignal.capturedAttackerRequestMarkerMatch
          ? candidateSignal.verificationSequence ===
            "post-setup-request-before-victim-visit"
          : candidateSignal.verificationSequence === "not-established")
          ? candidateSignal
          : null;
      const pageAfterDialogScreenshot =
        signal === null
          ? null
          : ((await evidence("victim-page-after-dialog.png"))?.ref.path ??
            null);
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
          pages,
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
          ...(signal === null || dialog === null
            ? {}
            : {
                browserSignal: {
                  kind: signal.kind,
                  status: signal.status,
                  capturedAttackerRequestMarkerMatch:
                    signal.capturedAttackerRequestMarkerMatch,
                  verificationSequence: signal.verificationSequence,
                  victimPrincipal: signal.victimPrincipal,
                  record: dialog.ref,
                  pageAfterDialogScreenshot,
                },
              }),
        },
      };
    },
  };
}
