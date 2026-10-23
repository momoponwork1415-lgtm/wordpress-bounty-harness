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
 * A queue decision is current only when it follows the latest verification.
 * Without a verification, the latest historical decision is still current.
 * Exports and duplicate-check carry-forward intentionally read history instead.
 */
export function currentReviewDecision(
  latestHistorical: DecisionHistoryEntry | undefined,
  latestVerificationSequence?: number,
): DecisionEvent | null {
  return latestHistorical !== undefined &&
    (latestVerificationSequence === undefined ||
      latestHistorical.sequence > latestVerificationSequence)
    ? latestHistorical.event
    : null;
}
