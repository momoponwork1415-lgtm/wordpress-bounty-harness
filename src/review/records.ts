import { z } from "zod";

import type {
  PrivateArtifactJsonResolution,
  PrivateArtifactStore,
} from "../infrastructure/private-artifact-store.js";
import type { LedgerEventV1 } from "../ledger/index.js";

/**
 * Review's own Private Evidence records. Review writes each one as
 * `record.json` through the schema here and references it from a ledger
 * event by artifact kind; everything that reads one back (Review itself,
 * `review export`) goes through `readReviewRecord`, so a field is read the
 * way it was written.
 */
export const id = z.string().min(1).max(128);
export const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const refSchema = z.strictObject({
  campaignId: id,
  findingId: id,
  verificationId: id,
  snapshotDigest: digest,
});
export const scopeStatus = z.enum([
  "in-scope",
  "out-of-scope",
  "ambiguous",
  "incomplete",
]);
export const assessmentSchema = z.strictObject({
  id: digest,
  ref: refSchema,
  policyDigest: digest,
  programmeId: id,
  status: scopeStatus,
  destination: id,
  reason: z.string().min(1).max(2000),
  assessedAt: z.iso.datetime(),
});
export const draftSchema = z.strictObject({
  assessmentId: digest,
  candidateId: digest,
  digest,
  revision: z.number().int().positive(),
  destination: id,
  content: z.string().min(1).max(100_000),
  preparedBy: z.enum(["ai", "human"]),
  createdAt: z.iso.datetime(),
});
export const authorizationSchema = z.strictObject({
  candidateId: digest,
  draftDigest: digest,
  destination: id,
  authorizedBy: id,
  authorizedAt: z.iso.datetime(),
});
/**
 * #442 (ADR 0038 stage 4): the wbh-dedupe result a decision carries. The
 * skill compares; Review keeps the value, when it was recorded and the
 * skill's note. Records before #442 hold the status and reference only.
 */
const duplicateRecorded = {
  /** When `review decide --duplicate` recorded it; absent, no result was recorded. */
  checkedAt: z.iso.datetime().optional(),
  /** The skill's note (`DEDUPE_NOTE_FILE`) in Private Evidence. */
  note: digest.optional(),
};
export const duplicateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("no-match"), ...duplicateRecorded }),
  z.strictObject({
    status: z.literal("unavailable"),
    /** Why the check could not finish; the Finding waits for a re-check. */
    reason: z.string().min(1).max(256).optional(),
    ...duplicateRecorded,
  }),
  z.strictObject({
    status: z.literal("possible-match"),
    /** The public record(s) matched: CVE id or public record URL. */
    reference: z.string().min(1).max(2048),
    ...duplicateRecorded,
  }),
]);
export const DEDUPE_NOTE_FILE = "dedupe-note.md";
export const reviewDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ref: refSchema,
  verificationStatus: z.enum([
    "runtime-confirmed",
    "reproduced",
    "contradicted",
    "incomplete",
  ]),
  decision: z.enum(["accept", "reject", "defer"]),
  reasonCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  duplicate: duplicateSchema,
  openedEvidence: z.array(digest).max(100),
  decidedBy: id,
  decidedAt: z.iso.datetime(),
  elapsedMs: z.number().int().nonnegative(),
  /** Seconds the human reported spending on this item (ADR 0032 Q22); absent on older records. */
  humanElapsedSeconds: z.number().int().nonnegative().max(604_800).optional(),
  /** Discovery run and prompt the Finding came from, so a submission can be traced back (Q22). */
  trace: z
    .strictObject({
      runId: id.optional(),
      promptDigest: digest.optional(),
    })
    .optional(),
});

export type ReviewRef = z.infer<typeof refSchema>;
export type ScopeAssessment = z.infer<typeof assessmentSchema>;
export type SubmissionDraft = z.infer<typeof draftSchema>;
export type ExternalActionAuthorization = z.infer<typeof authorizationSchema>;
export type ReviewDecisionV1 = z.infer<typeof reviewDecisionV1Schema>;
export type DuplicateCheck = z.infer<typeof duplicateSchema>;

/** The ledger artifact kind each record is filed under, and its shape. */
export interface ReviewRecordByKind {
  readonly "review-scope": ScopeAssessment;
  readonly "review-draft": SubmissionDraft;
  readonly "review-decision": ReviewDecisionV1;
  readonly "review-authorization": ExternalActionAuthorization;
}
export type ReviewRecordKind = keyof ReviewRecordByKind;
const reviewRecordSchemas: {
  readonly [K in ReviewRecordKind]: z.ZodType<ReviewRecordByKind[K]>;
} = {
  "review-scope": assessmentSchema,
  "review-draft": draftSchema,
  "review-decision": reviewDecisionV1Schema,
  "review-authorization": authorizationSchema,
};

export const REVIEW_RECORD_FILE = "record.json";
/** A draft carries up to 100,000 characters of content; the JSON around it stays well under this. */
export const REVIEW_RECORD_MAX_BYTES = 512_000;

export type ReviewRecordRead<T> =
  | { readonly status: "read"; readonly record: T }
  /** The event carries no artifact of that kind (older events, hand-written fixtures). */
  | { readonly status: "unreferenced" }
  | {
      readonly status: "unavailable";
      readonly reason: Exclude<
        PrivateArtifactJsonResolution<unknown>,
        { readonly status: "resolved" }
      >["status"];
    };

/** Reads the record an event references, through the schema Review wrote it with. */
export async function readReviewRecord<K extends ReviewRecordKind>(
  store: PrivateArtifactStore,
  event: LedgerEventV1,
  kind: K,
): Promise<ReviewRecordRead<ReviewRecordByKind[K]>> {
  const reference = event.artifacts.find((item) => item.kind === kind);
  if (reference === undefined) return { status: "unreferenced" };
  const file = await store.readJson(
    reference.digest,
    REVIEW_RECORD_FILE,
    reviewRecordSchemas[kind],
    REVIEW_RECORD_MAX_BYTES,
  );
  return file.status === "resolved"
    ? { status: "read", record: file.value }
    : { status: "unavailable", reason: file.status };
}
