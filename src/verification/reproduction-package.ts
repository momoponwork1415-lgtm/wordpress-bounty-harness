import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const packageDocumentReferenceSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  digest,
});

/** What the retired judge observed: roles used and reached, configuration, and so on. */
const conditionsSchema = z
  .record(
    z.string().regex(/^[a-z][A-Za-z0-9-]{0,63}$/),
    z.string().min(1).max(256),
  )
  .refine((value) => Object.keys(value).length <= 20)
  .default({});

/**
 * The `verification-finished` result. Since #525 (ADR 0039) a verification
 * ends `incomplete`: `awaiting-human-observation` when the Verifier finished
 * and the Harness recorded its observation, a failure reason otherwise.
 * `runtime-confirmed`, `reproduced`, `contradicted` and `no-judge` came from
 * the deleted judges; they stay readable for the events already recorded.
 */
export const verificationResultV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("runtime-confirmed"),
    judgeId: id,
    proofKind: z.literal("nonce-canary"),
    conditions: conditionsSchema,
    evidenceDigest: digest,
    reproductionPackageDigest: digest,
    /** Absent on packages recorded before the profile introduced templates. */
    acceptanceCriteria: packageDocumentReferenceSchema.optional(),
    reproductionTemplate: packageDocumentReferenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("reproduced"),
    reproducerId: id,
    proofKind: z.literal("captured-script-observation"),
    conditions: conditionsSchema,
    evidenceDigest: digest,
    reproductionPackageDigest: digest,
    /** A fixed release does not exist for a current, unpatched target. */
    negativeControl: z.enum([
      "unavailable-no-fixed-release",
      "pending-fixed-version",
    ]),
    acceptanceCriteria: packageDocumentReferenceSchema.optional(),
    reproductionTemplate: packageDocumentReferenceSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("contradicted"),
    judgeId: id,
    evidenceDigest: digest,
    refutationDigest: digest.optional(),
  }),
  z.strictObject({
    status: z.literal("incomplete"),
    reason: z.enum([
      "provision",
      "precondition",
      "recipe",
      "provider",
      "sandbox",
      "observation",
      "evidence",
      "cleanup",
      "digest-mismatch",
      "no-judge",
      "awaiting-human-observation",
    ]),
    nextStep: z.string().min(1).max(2000),
    /** Lab teardown failed; retain opaque ids so a resumed campaign can inspect them. */
    cleanupLabIds: z.array(id).min(1).max(2).optional(),
    /** A profile found an ordinary Lab scenario to try before human review. */
    nextScenarioId: id.optional(),
    evidenceDigest: digest.optional(),
    refutationDigest: digest.optional(),
  }),
]);

export type VerificationResultV1 = z.infer<typeof verificationResultV1Schema>;
