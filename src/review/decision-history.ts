import type { Ledger, LedgerEventV1 } from "../ledger/index.js";

type DecisionEvent = Extract<LedgerEventV1, { type: "review-decided" }>;
export type DecisionHistoryEntry = {
  readonly sequence: number;
  readonly event: DecisionEvent;
};

/** Append order is the historical order, including decisions superseded by a later verification. */
export function readDecisionHistory(
  ledger: Ledger,
  query: { readonly campaignId?: string; readonly findingId?: string } = {},
): readonly DecisionHistoryEntry[] {
  return ledger
    .readAll({
      ...(query.campaignId === undefined
        ? {}
        : { campaignId: query.campaignId }),
      ...(query.findingId === undefined ? {} : { findingId: query.findingId }),
      type: "review-decided",
    })
    .flatMap((entry) =>
      entry.event.type === "review-decided"
        ? [{ sequence: entry.sequence, event: entry.event }]
        : [],
    );
}

/**
 * A queue decision must name the current target and follow its verification.
 * Later decisions on older targets stay historical without replacing it.
 * Exports and duplicate-check carry-forward intentionally read history instead.
 */
export function currentReviewDecision(
  history: readonly DecisionHistoryEntry[],
  ref: Pick<
    DecisionEvent,
    "campaignId" | "findingId" | "snapshotDigest" | "verificationId"
  >,
  latestVerificationSequence?: number,
): DecisionEvent | null {
  return (
    history
      .filter(
        ({ sequence, event }) =>
          event.campaignId === ref.campaignId &&
          event.findingId === ref.findingId &&
          event.snapshotDigest === ref.snapshotDigest &&
          event.verificationId === ref.verificationId &&
          (latestVerificationSequence === undefined ||
            sequence > latestVerificationSequence),
      )
      .at(-1)?.event ?? null
  );
}
