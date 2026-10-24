import { join } from "node:path";

import { z } from "zod";

import { exportReviewBundle, reviewExportV1Schema } from "./export.js";
import {
  currentManualObservation,
  MANUAL_LAB_RECEIPT_FILE,
  MANUAL_OBSERVATION_EVIDENCE_FILE,
  manualObservationEvidenceStatus,
} from "./manual-observation.js";

/** Opt-in extension: existing strict review-export/v1 consumers keep their contract. */
export const REVIEW_EXPORT_V2_SCHEMA_ID = "review-export/v2";
export const reviewExportV2Schema = z.strictObject({
  ...reviewExportV1Schema.shape,
  schema: z.literal(REVIEW_EXPORT_V2_SCHEMA_ID),
  review: z.strictObject({
    ...reviewExportV1Schema.shape.review.shape,
    manualObservation: z
      .strictObject({
        result: z.enum(["match", "mismatch", "unavailable"]),
        recordedBy: z.string().min(1).max(128),
        recordedAt: z.iso.datetime({ offset: true }),
        evidenceStatus: z.enum(["available", "unavailable"]),
        sessionReceipt: z.strictObject({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          path: z.string().min(1),
        }),
        evidence: z.strictObject({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          path: z.string().min(1),
        }),
      })
      .nullable(),
  }),
});
export type ReviewExportV2 = z.infer<typeof reviewExportV2Schema>;

export async function exportReviewBundleV2(
  options: Parameters<typeof exportReviewBundle>[0],
): Promise<ReviewExportV2> {
  const base = await exportReviewBundle(options);
  const manual =
    base.verification !== null
      ? currentManualObservation(options.ledger, {
          campaignId: base.campaignId,
          findingId: base.findingId,
          verificationId: base.verification.verificationId,
          snapshotDigest: base.snapshotDigest,
        })
      : null;
  const evidenceStatus =
    manual === null
      ? null
      : await manualObservationEvidenceStatus(options.store, manual);
  const contentPath = (digest: string) => options.store.contentPath(digest);
  const artifacts = [...base.privateEvidence.artifacts];
  if (manual !== null) {
    for (const [kind, digest] of [
      ["manual-lab-session", manual.sessionReceiptDigest],
      ["manual-observation-evidence", manual.evidenceDigest],
    ] as const)
      if (
        !artifacts.some((item) => item.kind === kind && item.digest === digest)
      )
        artifacts.push({ kind, digest, path: contentPath(digest) });
  }
  return reviewExportV2Schema.parse({
    ...base,
    schema: REVIEW_EXPORT_V2_SCHEMA_ID,
    review: {
      ...base.review,
      manualObservation:
        manual === null
          ? null
          : {
              result: manual.result,
              recordedBy: manual.recordedBy,
              recordedAt: manual.occurredAt,
              evidenceStatus,
              sessionReceipt: {
                digest: manual.sessionReceiptDigest,
                path: join(
                  contentPath(manual.sessionReceiptDigest),
                  MANUAL_LAB_RECEIPT_FILE,
                ),
              },
              evidence: {
                digest: manual.evidenceDigest,
                path: join(
                  contentPath(manual.evidenceDigest),
                  MANUAL_OBSERVATION_EVIDENCE_FILE,
                ),
              },
            },
    },
    privateEvidence: { ...base.privateEvidence, artifacts },
  });
}
