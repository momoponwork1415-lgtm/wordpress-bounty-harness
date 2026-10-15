import type { LedgerEventV1 } from "../ledger/index.js";

type FinishedRun = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;

/** SPEC §6: a run with no source, child, or more than one broker transfer is not a Trial. */
export function countsAsTrial(
  finished: FinishedRun | undefined,
  childStarted: boolean,
): boolean {
  if (childStarted) return true;
  if (finished === undefined) return false;
  if (finished.observed === undefined || finished.brokerMetrics === undefined)
    return true;
  return (
    finished.observed.filesRead > 0 ||
    (finished.childThreadsObserved ?? 0) > 0 ||
    finished.brokerMetrics.forwardedRequests > 1
  );
}
