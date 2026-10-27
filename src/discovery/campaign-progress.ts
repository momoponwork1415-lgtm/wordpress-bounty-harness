import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import {
  countsAsTrialChain,
  recordedTrialActivity,
} from "./counts-as-trial.js";
import { supersedingRun } from "./resume-trial.js";

type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;

/**
 * The runner resumes a provider-limited run only on Codex (ADR 0036, addendum
 * 4). A Claude run keeps ADR 0029's 2026-10-19 path: after the backoff its
 * target runs again as a new Trial. Starts without a runtime predate the
 * runtime share and ran on Codex.
 */
export function autoResumesProviderLimit(
  started: Pick<StartedEvent, "configuration">,
): boolean {
  return started.configuration.runtime !== "claude-code/v1";
}

/** Five resume segments exhaust a Trial's automatic resumes; the original run is not one of them. */
export function providerLimitedAutoResumeRefusal(
  started: Pick<StartedEvent, "resumeSegment">,
): "resume-limit" | undefined {
  if ((started.resumeSegment ?? 0) >= 5) return "resume-limit";
  return undefined;
}

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

/** The latest provider-limited Codex segment per Trial ordinal, before a replacement Trial starts. */
export function providerLimitedExplorations(
  target: CampaignTarget,
): ReadonlyMap<number, StartedEvent> {
  const finishes = readFinishedRuns(target);
  const starts = exploreStarts(target);
  const limited = new Map<number, StartedEvent>();
  for (const event of starts)
    if (
      autoResumesProviderLimit(event) &&
      finishes.get(event.runId)?.outcome === "provider-limited" &&
      latestSegment(starts, event.runId) === event.runId &&
      supersedingRun(starts, event) === undefined
    )
      limited.set(event.trialOrdinal ?? 0, event);
  return limited;
}
type ConcludedEvent = Extract<LedgerEventV1, { type: "discovery-concluded" }>;
type EnumerationEvent = Extract<
  LedgerEventV1,
  { type: "enumeration-recorded" }
>;

/** How a partitioned Trial (ADR 0042) ended, read from its role runs and its enumeration record. */
export type PartitionedTrialOutcome = {
  readonly trialId: string;
  readonly outcome:
    "completed" | "incomplete" | "provider-limited" | "unfinished";
  readonly reason?: string;
  readonly reasonDetail?: string;
  readonly providerLimit?: "rate-limit" | "quota";
};

/**
 * A partitioned Trial is one attempt: its enumerate run (resubmits continue
 * it) and its tracer runs. It is incomplete when the enumeration was
 * rejected after the send-backs or when no tracer finished `completed`; it
 * is provider-limited when the enumerator was, or when no tracer completed
 * and one was limited. A Trial whose enumerate run has no finish, or whose
 * accepted enumeration has no tracer finish yet, is unfinished.
 */
export function partitionedTrialOutcomes(
  target: CampaignTarget,
): ReadonlyMap<string, PartitionedTrialOutcome> {
  const finishes = readFinishedRuns(target);
  const enumerations = new Map<string, EnumerationEvent>();
  for (const { event } of target.ledger.readAll({
    campaignId: target.campaignId,
    type: "enumeration-recorded",
  }))
    if (
      event.type === "enumeration-recorded" &&
      event.snapshotDigest === target.snapshotDigest
    )
      enumerations.set(event.trialId, event);
  const trials = new Map<
    string,
    { enumerate: StartedEvent[]; trace: StartedEvent[] }
  >();
  for (const { event } of target.ledger.readAll({
    campaignId: target.campaignId,
    type: "discovery-run-started",
  })) {
    if (
      event.type !== "discovery-run-started" ||
      event.snapshotDigest !== target.snapshotDigest ||
      (event.runKind !== "enumerate" && event.runKind !== "trace") ||
      event.trialId === undefined
    )
      continue;
    const trial = trials.get(event.trialId) ?? { enumerate: [], trace: [] };
    trial[event.runKind].push(event);
    trials.set(event.trialId, trial);
  }
  const outcomes = new Map<string, PartitionedTrialOutcome>();
  const failed = (
    trialId: string,
    outcome: PartitionedTrialOutcome["outcome"],
    finish?: FinishedEvent,
  ): PartitionedTrialOutcome => ({
    trialId,
    outcome,
    ...(finish?.reason === undefined ? {} : { reason: finish.reason }),
    ...(finish?.reasonDetail === undefined
      ? {}
      : { reasonDetail: finish.reasonDetail }),
    ...(finish?.providerLimit === undefined
      ? {}
      : { providerLimit: finish.providerLimit }),
  });
  for (const [trialId, trial] of trials) {
    if (trial.enumerate.length === 0) continue;
    const enumeration = enumerations.get(trialId);
    if (enumeration?.accepted === false) {
      outcomes.set(trialId, {
        trialId,
        outcome: "incomplete",
        reason: "schema",
        reasonDetail: "enumeration-rejected",
      });
      continue;
    }
    const latest = finishes.get(trial.enumerate.at(-1)!.runId);
    if (latest === undefined) {
      outcomes.set(trialId, failed(trialId, "unfinished"));
      continue;
    }
    if (latest.outcome === "provider-limited") {
      outcomes.set(trialId, failed(trialId, "provider-limited", latest));
      continue;
    }
    if (latest.outcome !== "completed" || enumeration === undefined) {
      outcomes.set(
        trialId,
        failed(
          trialId,
          latest.outcome === "completed" ? "unfinished" : "incomplete",
          latest,
        ),
      );
      continue;
    }
    const traces = trial.trace.flatMap((start) => {
      const finish = finishes.get(start.runId);
      return finish === undefined ? [] : [finish];
    });
    if (traces.some((finish) => finish.outcome === "completed")) {
      outcomes.set(trialId, { trialId, outcome: "completed" });
      continue;
    }
    if (traces.length === 0) {
      outcomes.set(trialId, failed(trialId, "unfinished"));
      continue;
    }
    const limited = traces.find(
      (finish) => finish.outcome === "provider-limited",
    );
    outcomes.set(
      trialId,
      limited === undefined
        ? failed(trialId, "incomplete", traces[0])
        : failed(trialId, "provider-limited", limited),
    );
  }
  return outcomes;
}

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
  const starts = new Map(
    exploreStarts(target).map((event) => [event.runId, event]),
  );
  const segment = (runId: string) => ({
    finished: finishedRuns.get(runId),
    hasRecordedActivity: activeRuns.has(`${target.campaignId}\0${runId}`),
    resumesRun: starts.get(runId)?.resumesRun,
  });
  const startedExplorations = new Set<string>();
  const spentOrdinals = new Set<number>();
  let nextLegacyOrdinal = 0;
  // ADR 0042: a partitioned Trial is spent once its enumerate run finished
  // without a usage limit; a dangling start runs the ordinal again.
  const partitioned = partitionedTrialOutcomes(target);
  const spentPartitioned = (event: StartedEvent): boolean => {
    if (event.runKind !== "enumerate" || event.trialId !== event.runId)
      return false;
    const outcome = partitioned.get(event.trialId)?.outcome;
    return outcome === "completed" || outcome === "incomplete";
  };
  for (const { event } of target.ledger.readAll({
    campaignId: target.campaignId,
    type: "discovery-run-started",
  }))
    if (
      event.type === "discovery-run-started" &&
      event.snapshotDigest === target.snapshotDigest &&
      (spentPartitioned(event) ||
        // Historical events had no runKind and each represented exploration.
        ((event.runKind ?? "explore") === "explore" &&
          countsAsTrialChain(event.runId, segment)))
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
  const starts = exploreStarts(target);
  const startsById = new Map(starts.map((event) => [event.runId, event]));
  const segment = (runId: string) => ({
    finished: outcomes.get(runId),
    hasRecordedActivity: active.has(`${target.campaignId}\0${runId}`),
    resumesRun: startsById.get(runId)?.resumesRun,
  });
  // ADR 0042: a partitioned Trial's id is its enumerate run; its outcome is
  // read across its role runs, not from that one finish.
  const partitioned = partitionedTrialOutcomes(target);
  const partitionedOutcomes = [...startedExplorations].flatMap((runId) => {
    const outcome = partitioned.get(runId);
    return outcome === undefined ? [] : [outcome];
  });
  const latestRuns = new Set(
    [...startedExplorations]
      .filter((runId) => !partitioned.has(runId))
      .map((runId) => latestSegment(starts, runId)),
  );
  if (
    partitionedOutcomes.some((trial) => trial.outcome === "provider-limited") ||
    [...latestRuns].some(
      (runId) => outcomes.get(runId)?.outcome === "provider-limited",
    )
  )
    return "provider-limit";
  const countedRuns = [...latestRuns].filter((runId) =>
    countsAsTrialChain(runId, segment),
  );
  if (
    partitionedOutcomes.some((trial) => trial.outcome !== "completed") ||
    countedRuns.some((runId) => outcomes.get(runId)?.outcome !== "completed")
  )
    return "incomplete";
  return undefined;
}
