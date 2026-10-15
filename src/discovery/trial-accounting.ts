import type { LedgerEventV1 } from "../ledger/index.js";

type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type FinishedRun = {
  readonly observed?: FinishedEvent["observed"] | undefined;
  readonly childThreadsObserved?: FinishedEvent["childThreadsObserved"] | undefined;
  readonly brokerMetrics?: FinishedEvent["brokerMetrics"] | undefined;
};

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
