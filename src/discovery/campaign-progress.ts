import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { countsAsTrial, recordedTrialActivity } from "./counts-as-trial.js";
import { supersedingRun } from "./resume-trial.js";

type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;

function exploreStarts(target: CampaignTarget): StartedEvent[] {
  return target.ledger
    .readAll({ campaignId: target.campaignId, type: "discovery-run-started" })
    .flatMap(({ event }) =>
      event.type === "discovery-run-started" &&
      event.snapshotDigest === target.snapshotDigest &&
      (event.runKind ?? "explore") === "explore"
        ? [event]
        : [],
    );
}

/** The last segment of the Trial `runId` starts: later segments name the one before in `resumesRun`. */
export function latestSegment(
  starts: readonly StartedEvent[],
  runId: string,
): string {
  const seen = new Set<string>();
  let current = runId;
  for (;;) {
    seen.add(current);
    const next = starts.find(
      (event) => event.resumesRun === current && !seen.has(event.runId),
    );
    if (next === undefined) return current;
    current = next.runId;
  }
}

/**
 * Per Trial ordinal, the latest segment that has a start but no finish and
 * that no later start replaced: a run the host may have died under (ADR 0036,
 * 2026-10-19 addendum 3). Whether it is dead is the sandbox marker's call.
 */
export function interruptedExplorations(
  target: CampaignTarget,
): ReadonlyMap<number, StartedEvent> {
  const finishes = readFinishedRuns(target);
  const starts = exploreStarts(target);
  const interrupted = new Map<number, StartedEvent>();
  for (const event of starts)
    if (
      !finishes.has(event.runId) &&
      latestSegment(starts, event.runId) === event.runId &&
      supersedingRun(starts, event) === undefined
    )
      interrupted.set(event.trialOrdinal ?? 0, event);
  return interrupted;
}
type ConcludedEvent = Extract<LedgerEventV1, { type: "discovery-concluded" }>;

/** One campaign on one Target Snapshot; events of other snapshots are not its progress. */
export type CampaignTarget = {
  readonly ledger: Pick<Ledger, "read" | "readAll">;
  readonly campaignId: string;
  readonly snapshotDigest: string;
};

/** What the ledger already holds for the target when a campaign starts or resumes. */
export type ResumeProgress = {
  /** A concluded target is done; nothing runs again. */
  readonly concluded: ConcludedEvent["stoppedBy"] | undefined;
  /** Explorations that consumed a Trial: finished with evidence of work, or with recorded activity. */
  readonly startedExplorations: ReadonlySet<string>;
  /** Trial ordinals those explorations spent; the campaign skips them. */
  readonly spentOrdinals: ReadonlySet<number>;
};

/** Every `discovery-run-finished` of the target, by run id. */
export function readFinishedRuns(
  target: CampaignTarget,
): Map<string, FinishedEvent> {
  const finishes = new Map<string, FinishedEvent>();
  for (const { event } of target.ledger.readAll({
    campaignId: target.campaignId,
    type: "discovery-run-finished",
  }))
    if (
      event.type === "discovery-run-finished" &&
      event.snapshotDigest === target.snapshotDigest
    )
      finishes.set(event.runId, event);
  return finishes;
}

/**
 * A start with no finish or receipt may reuse its ordinal on resume. A partial
 * Trial with a receipt still consumes its ordinal. Historical starts carried no
 * ordinal; they take the lowest ordinals not spent by stamped starts.
 */
export function readResumeProgress(target: CampaignTarget): ResumeProgress {
  const concluded = target.ledger
    .read({ campaignId: target.campaignId, type: "discovery-concluded" })
    .map(({ event }) => event)
    .find(
      (event): event is ConcludedEvent =>
        event.type === "discovery-concluded" &&
        event.snapshotDigest === target.snapshotDigest,
    );
  const finishedRuns = readFinishedRuns(target);
  const activeRuns = recordedTrialActivity(target.ledger, target.campaignId);
  const startedExplorations = new Set<string>();
  const spentOrdinals = new Set<number>();
  let nextLegacyOrdinal = 0;
  for (const { event } of target.ledger.readAll({
    campaignId: target.campaignId,
    type: "discovery-run-started",
  }))
    if (
      event.type === "discovery-run-started" &&
      event.snapshotDigest === target.snapshotDigest &&
      // Historical events had no runKind and each represented exploration.
      (event.runKind ?? "explore") === "explore" &&
      countsAsTrial(
        finishedRuns.get(event.runId),
        activeRuns.has(`${event.campaignId}\0${event.runId}`),
      )
    ) {
      startedExplorations.add(event.runId);
      if (event.trialOrdinal !== undefined)
        spentOrdinals.add(event.trialOrdinal);
      else {
        while (spentOrdinals.has(nextLegacyOrdinal)) nextLegacyOrdinal++;
        spentOrdinals.add(nextLegacyOrdinal++);
      }
    }
  return {
    concluded: concluded?.stoppedBy,
    startedExplorations,
    spentOrdinals,
  };
}

/**
 * After the runs: a run the provider limit ended stops the campaign (it is not
 * a Trial, so the target runs again after the backoff), and among the
 * explorations that counted as Trials any other unfinished run leaves it
 * incomplete. Neither is concluded; a resume continues the target.
 */
export function recordedFailureAfterRuns(
  target: CampaignTarget,
  startedExplorations: ReadonlySet<string>,
): "provider-limit" | "incomplete" | undefined {
  const outcomes = readFinishedRuns(target);
  const active = recordedTrialActivity(target.ledger, target.campaignId);
  if (
    [...startedExplorations].some(
      (runId) => outcomes.get(runId)?.outcome === "provider-limited",
    )
  )
    return "provider-limit";
  const countedRuns = [...startedExplorations].filter((runId) =>
    countsAsTrial(
      outcomes.get(runId),
      active.has(`${target.campaignId}\0${runId}`),
    ),
  );
  // A resumed Trial ends as its latest segment ends.
  const starts = exploreStarts(target);
  if (
    countedRuns.some(
      (runId) =>
        outcomes.get(latestSegment(starts, runId))?.outcome !== "completed",
    )
  )
    return "incomplete";
  return undefined;
}
