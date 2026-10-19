import type { Ledger, LedgerEventV1 } from "../ledger/index.js";

type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type TrialObservation = {
  readonly outcome?: FinishedEvent["outcome"] | undefined;
  readonly observed?: FinishedEvent["observed"] | undefined;
  readonly childThreadsObserved?:
    FinishedEvent["childThreadsObserved"] | undefined;
  readonly brokerMetrics?: FinishedEvent["brokerMetrics"] | undefined;
};

/** Persisted child starts and candidate records prove work before a root finish. */
export function recordedTrialActivity(
  ledger: Pick<Ledger, "readAll">,
  campaignId?: string,
): ReadonlySet<string> {
  const active = new Set<string>();
  for (const { event } of ledger.readAll(
    campaignId === undefined ? {} : { campaignId },
  )) {
    const runId =
      event.type === "discovery-run-started"
        ? event.runKind === "child"
          ? event.parentRunId
          : undefined
        : event.type === "finding-recorded" ||
            event.type === "lead-recorded" ||
            event.type === "candidate-held"
          ? event.runId
          : undefined;
    if (runId !== undefined) active.add(`${event.campaignId}\0${runId}`);
  }
  return active;
}

/**
 * SPEC §6: an observed bootstrap with no source, child or further broker use is
 * not a Trial, and neither is a run the provider limit ended (owner decision
 * 2026-10-19, ADR 0029): the target is run again after the backoff.
 */
export function countsAsTrial(
  finished: TrialObservation | undefined,
  hasRecordedActivity = false,
): boolean {
  if (finished?.outcome === "provider-limited") return false;
  if (hasRecordedActivity) return true;
  if (finished === undefined) return false;
  if (
    finished.observed === undefined ||
    finished.childThreadsObserved === undefined ||
    finished.brokerMetrics === undefined
  )
    return true;
  return (
    finished.observed.filesRead > 0 ||
    finished.childThreadsObserved > 0 ||
    finished.brokerMetrics.forwardedRequests > 1
  );
}
