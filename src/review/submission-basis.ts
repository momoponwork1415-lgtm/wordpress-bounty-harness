import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { isCurrentVerification } from "./current-verification.js";
import {
  currentManualObservation,
  observationAttempt,
} from "./manual-observation.js";
import { refSchema, type ReviewRef } from "./records.js";

type FinishedVerification = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;
type VerificationResult = FinishedVerification["result"];

/**
 * The review step that asks, from the least to the most it needs:
 *
 * - `reproduce`: what `review decide --reproduced` records against.
 * - `scope`: what `review scope` assesses. A human-observed basis also needs
 *   the reviewer's own `--reproduced match` for its package.
 * - `draft`: what `review draft` saves for. `scope`, and the attempt is
 *   current.
 * - `authorize`: what `review authorize` and admission rest on. The attempt
 *   is current, and the reviewer's latest `--reproduced` for the package is
 *   `match` whatever the kind.
 */
export type BasisUse = "reproduce" | "scope" | "draft" | "authorize";

/**
 * Why a Finding has no basis for the step, in the order they are checked.
 *
 * - `no-verification`: no attempt with this verification ID for the Finding.
 * - `snapshot-mismatch`: the Finding record or the attempt has another Target
 *   Snapshot digest (invariant 5).
 * - `parked`: the Finding is parked at the Programme Boundary.
 * - `superseded`: a later attempt or a newer latest-version Finding replaces
 *   this attempt. `draft` and `authorize` ask for the current attempt first,
 *   so for them any ref that does not name it is `superseded`.
 * - `not-awaiting-human-observation`: the attempt is neither a judge-era
 *   `runtime-confirmed` / `reproduced` nor `incomplete(awaiting-human-observation)`.
 * - `no-harness-capture`: the attempt kept no Harness capture.
 * - `no-human-match`: no named person recorded `review observe` `match` for the
 *   latest ready review Lab receipt of this attempt.
 * - `no-reproduction-match`: the reviewer's latest `review decide --reproduced`
 *   for this package is missing or not `match`.
 */
export type BasisMissingReason =
  | "no-verification"
  | "snapshot-mismatch"
  | "parked"
  | "superseded"
  | "not-awaiting-human-observation"
  | "no-harness-capture"
  | "no-human-match"
  | "no-reproduction-match";

/** What a Finding is taken toward submission on (ADR 0040, invariants 3, 5, 7). */
export type SubmissionBasis = (
  | {
      /** A result from before the judges were removed; read only. */
      readonly kind: "judge-era";
      readonly verification: FinishedVerification & {
        readonly result: Extract<
          VerificationResult,
          { status: "runtime-confirmed" | "reproduced" }
        >;
      };
    }
  | {
      /** `incomplete(awaiting-human-observation)` a named person observed as `match`. */
      readonly kind: "human-observed";
      readonly verification: FinishedVerification & {
        readonly result: Extract<VerificationResult, { status: "incomplete" }>;
      };
      readonly observation: Extract<
        LedgerEventV1,
        { type: "manual-observation-recorded" }
      >;
    }
) & {
  /** The judge-era reproduction package, or the sealed review Lab package. */
  readonly packageDigest: string;
  /** False once a later attempt or a newer latest-version Finding replaces it. */
  readonly current: boolean;
  /** The reviewer's latest `review decide --reproduced` for this package. */
  readonly reproduction: {
    readonly result: "match" | "mismatch" | "unavailable";
    /** Its ledger sequence, for ordering against drafts and decisions. */
    readonly sequence: number;
  } | null;
};

export type BasisAnswer =
  | { readonly status: "basis"; readonly basis: SubmissionBasis }
  | { readonly status: "missing"; readonly reason: BasisMissingReason };

/**
 * Basis or not for one review step, and why not. Reads Harness-owned ledger
 * records only: the attempt, the review Lab receipt and observation a named
 * person recorded, and the reviewer's `--reproduced` record. Never reads an
 * agent's or recipe's own account. Throws only on a malformed ref.
 */
export function submissionBasis(
  ledger: Ledger,
  ref: ReviewRef,
  use: BasisUse,
): BasisAnswer {
  const parsed = refSchema.parse(ref);
  const missing = (reason: BasisMissingReason): BasisAnswer => ({
    status: "missing",
    reason,
  });
  const current = isCurrentVerification(ledger, parsed);
  if ((use === "draft" || use === "authorize") && !current)
    return missing("superseded");
  const found = reproducible(ledger, parsed, current);
  if (found.status === "missing") return found;
  const { basis } = found;
  const reproduced = basis.reproduction?.result === "match";
  if (use === "authorize" && !reproduced)
    return missing("no-reproduction-match");
  if (
    (use === "scope" || use === "draft") &&
    basis.kind === "human-observed" &&
    !reproduced
  )
    return missing("no-reproduction-match");
  return found;
}

/** The basis a person reproduces against, before their own `--reproduced`. */
function reproducible(
  ledger: Ledger,
  ref: ReviewRef,
  current: boolean,
): BasisAnswer {
  const withReproduction = (
    basis: SubmissionBasis extends infer Each
      ? Each extends SubmissionBasis
        ? Omit<Each, "reproduction" | "current">
        : never
      : never,
  ): BasisAnswer => ({
    status: "basis",
    basis: {
      ...basis,
      current,
      reproduction: latestReproduction(ledger, ref, basis.packageDigest),
    } as SubmissionBasis,
  });
  const recorded = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })
    .map(({ event }) => event)
    .find(
      (event) =>
        event.type === "verification-finished" &&
        event.verificationId === ref.verificationId,
    );
  if (
    recorded?.type === "verification-finished" &&
    (recorded.result.status === "runtime-confirmed" ||
      recorded.result.status === "reproduced")
  ) {
    if (recorded.snapshotDigest !== ref.snapshotDigest)
      return { status: "missing", reason: "snapshot-mismatch" };
    return withReproduction({
      kind: "judge-era",
      verification: recorded as Extract<
        SubmissionBasis,
        { kind: "judge-era" }
      >["verification"],
      packageDigest: recorded.result.reproductionPackageDigest,
    });
  }

  const attempt = observationAttempt(ledger, ref);
  if (attempt.status === "missing") return attempt;
  const { verification } = attempt;
  if (
    verification.result.status !== "incomplete" ||
    verification.result.reason !== "awaiting-human-observation"
  )
    return { status: "missing", reason: "not-awaiting-human-observation" };
  if (verification.evidenceCapture !== "harness-captured")
    return { status: "missing", reason: "no-harness-capture" };
  const observation = currentManualObservation(ledger, ref);
  if (observation === null || observation.result !== "match")
    return { status: "missing", reason: "no-human-match" };
  return withReproduction({
    kind: "human-observed",
    verification: verification as Extract<
      SubmissionBasis,
      { kind: "human-observed" }
    >["verification"],
    observation,
    packageDigest: observation.packageDigest,
  });
}

function latestReproduction(
  ledger: Ledger,
  ref: ReviewRef,
  packageDigest: string,
): SubmissionBasis["reproduction"] {
  const latest = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "human-reproduction-recorded",
    })
    .filter(
      ({ event }) =>
        event.type === "human-reproduction-recorded" &&
        event.verificationId === ref.verificationId &&
        event.reproductionPackageDigest === packageDigest,
    )
    .at(-1);
  return latest?.event.type === "human-reproduction-recorded"
    ? { result: latest.event.result, sequence: latest.sequence }
    : null;
}
