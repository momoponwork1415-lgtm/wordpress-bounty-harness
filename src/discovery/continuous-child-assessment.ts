import type { Ledger, LedgerEventV1, LedgerRecord } from "../ledger/index.js";

const MAX_TARGETS = 5;
const MAX_EVENTS = 50_000;
const PAGE_SIZE = 1000;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export type ChildNextState =
  "pending" | "unsettled" | "complete" | "wait-quota" | "wait-review";

export type ChildStateReason =
  | "not-started"
  | "trial-unsettled"
  | "no-conclusion"
  | "verification-missing"
  | "review-export-unchecked"
  | "review-export-unavailable"
  | "quota"
  | "cyber-policy"
  | "run-failed"
  | "lab-failed"
  | "target-skipped"
  | "ledger-mismatch"
  | "ledger-limit"
  | "complete";

export type ChildTargetAssessment = {
  readonly snapshotDigest: string;
  readonly nextState: ChildNextState;
  readonly reason: ChildStateReason;
  readonly trialsStarted: number;
  readonly trialsFinished: number;
  readonly findings: number;
  readonly verificationCovered: number;
  readonly verificationComplete: number;
  /** A recorded inconclusive outcome remains reviewable, not a negative result. */
  readonly verificationIncomplete: number;
  readonly reviewExportsReady: number;
};

export type ChildCampaignAssessment = {
  readonly campaignId: string;
  readonly nextState: ChildNextState;
  readonly reason: ChildStateReason;
  /** Global ledger sequence, usable as an observation cursor, not a completion claim. */
  readonly lastLedgerSequence: number;
  readonly progress: {
    readonly targetsTotal: number;
    readonly targetsComplete: number;
    readonly trialsStarted: number;
    readonly trialsFinished: number;
    readonly findings: number;
    readonly verificationCovered: number;
    readonly verificationComplete: number;
    readonly verificationIncomplete: number;
    readonly reviewExportsReady: number;
  };
  /** At most five digest-bound targets. No Finding body or private evidence is returned. */
  readonly targets: readonly ChildTargetAssessment[];
};

export type ReviewExportCheck = (input: {
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly findingId: string;
}) => boolean | Promise<boolean>;

type LedgerReader = Pick<Ledger, "read">;
type DiscoveryStart = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type DiscoveryFinish = Extract<
  LedgerEventV1,
  { type: "discovery-run-finished" }
>;
type VerificationFinish = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;

function readCampaign(
  ledger: LedgerReader,
  campaignId: string,
): {
  readonly records: readonly LedgerRecord[];
  readonly limitReached: boolean;
  readonly lastSequence: number;
} {
  const records: LedgerRecord[] = [];
  let afterSequence = 0;
  for (;;) {
    const remaining = MAX_EVENTS - records.length;
    const page = ledger.read({
      campaignId,
      afterSequence,
      limit: Math.min(PAGE_SIZE, remaining + 1),
    });
    if (page.some((record) => record.sequence <= afterSequence))
      throw new Error("Ledger read returned non-advancing sequence");
    if (page.length > remaining) {
      records.push(...page.slice(0, remaining));
      return {
        records,
        limitReached: true,
        lastSequence: records.at(-1)?.sequence ?? afterSequence,
      };
    }
    records.push(...page);
    if (page.length < Math.min(PAGE_SIZE, remaining + 1))
      return {
        records,
        limitReached: false,
        lastSequence: page.at(-1)?.sequence ?? afterSequence,
      };
    afterSequence = page.at(-1)!.sequence;
  }
}

function isCyberPolicy(event: DiscoveryFinish): boolean {
  // Only explicit, typed diagnostic codes count. A generic provider error is
  // never inferred to be a policy refusal from private transcript text.
  return (
    event.outcome !== "completed" &&
    (event.reasonDetail === "cyber_policy" ||
      event.reasonDetail === "provider:cyber_policy" ||
      event.reasonDetail === "provider-cyber-policy")
  );
}

function targetState(input: {
  readonly selected: boolean;
  readonly frozen: boolean;
  readonly labFailed: boolean;
  readonly skipped: boolean;
  readonly concluded: boolean;
  readonly starts: readonly DiscoveryStart[];
  readonly finishes: ReadonlyMap<string, DiscoveryFinish>;
  readonly unmatchedChild: boolean;
  readonly findings: number;
  readonly verificationCovered: number;
  readonly reviewExportsReady: number;
  readonly reviewExportChecked: boolean;
  readonly limitReached: boolean;
}): { readonly nextState: ChildNextState; readonly reason: ChildStateReason } {
  if (input.limitReached)
    return { nextState: "wait-review", reason: "ledger-limit" };
  const roots = input.starts.filter(
    (start) => (start.runKind ?? "explore") === "explore",
  );
  if (
    (input.starts.length > 0 || input.findings > 0 || input.concluded) &&
    (!input.selected || !input.frozen)
  )
    return { nextState: "wait-review", reason: "ledger-mismatch" };
  if (input.concluded && roots.length === 0)
    return { nextState: "wait-review", reason: "ledger-mismatch" };
  if (input.skipped)
    return { nextState: "wait-review", reason: "target-skipped" };
  if (input.labFailed)
    return { nextState: "wait-review", reason: "lab-failed" };
  const outcomes = roots.map((start) => input.finishes.get(start.runId));
  if (outcomes.some((finish) => finish !== undefined && isCyberPolicy(finish)))
    return { nextState: "wait-review", reason: "cyber-policy" };
  if (
    outcomes.some(
      (finish) =>
        finish !== undefined &&
        finish.outcome !== "completed" &&
        !(
          finish.outcome === "provider-limited" &&
          finish.reason === "provider" &&
          finish.providerLimit !== undefined
        ),
    )
  )
    return { nextState: "wait-review", reason: "run-failed" };
  if (outcomes.some((finish) => finish === undefined) || input.unmatchedChild)
    return { nextState: "unsettled", reason: "trial-unsettled" };
  if (
    outcomes.some(
      (finish) =>
        finish?.outcome === "provider-limited" &&
        finish.reason === "provider" &&
        finish.providerLimit !== undefined,
    )
  )
    return { nextState: "wait-quota", reason: "quota" };
  if (roots.length === 0)
    return input.selected || input.frozen
      ? { nextState: "unsettled", reason: "trial-unsettled" }
      : { nextState: "pending", reason: "not-started" };
  if (!input.concluded)
    return { nextState: "unsettled", reason: "no-conclusion" };
  if (input.verificationCovered < input.findings)
    return { nextState: "wait-review", reason: "verification-missing" };
  if (input.findings > 0 && !input.reviewExportChecked)
    return { nextState: "wait-review", reason: "review-export-unchecked" };
  if (input.reviewExportsReady < input.findings)
    return { nextState: "wait-review", reason: "review-export-unavailable" };
  return { nextState: "complete", reason: "complete" };
}

/**
 * Read-only reconciliation of one immutable child campaign. The parent owns
 * process liveness, resource recovery, and dispatch; an unsettled ledger does
 * not authorize another Trial. A review export check may inspect Private
 * Evidence, but its contents never enter this result.
 */
export async function assessContinuousChildCampaign(input: {
  readonly campaignId: string;
  readonly snapshotDigests: readonly string[];
  readonly ledger: LedgerReader;
  readonly reviewExportReady?: ReviewExportCheck;
}): Promise<ChildCampaignAssessment> {
  if (input.campaignId.length < 1 || input.campaignId.length > 128)
    throw new Error("Invalid child campaign ID");
  if (
    input.snapshotDigests.length < 1 ||
    input.snapshotDigests.length > MAX_TARGETS ||
    new Set(input.snapshotDigests).size !== input.snapshotDigests.length ||
    input.snapshotDigests.some((value) => !digestPattern.test(value))
  )
    throw new Error("Invalid bound target snapshot digests");
  const { records, limitReached, lastSequence } = readCampaign(
    input.ledger,
    input.campaignId,
  );
  const bound = new Set(input.snapshotDigests);
  const selected = new Set<string>();
  const frozen = new Set<string>();
  const concluded = new Set<string>();
  const discoveryLabStatus = new Map<string, "ready" | "failed">();
  const skipped = new Set<string>();
  const starts = new Map<string, DiscoveryStart[]>();
  const finishes = new Map<string, DiscoveryFinish>();
  const findings = new Map<string, Set<string>>();
  const findingRuns = new Map<string, string>();
  const verifications = new Map<string, VerificationFinish>();
  let unboundEvent = false;
  let orphanFinish = false;
  const ownerByRun = new Map<string, string>();
  for (const { event } of records) {
    if (event.campaignId !== input.campaignId)
      throw new Error("Ledger read returned another campaign");
    // Before Snapshot freeze, target-skipped can carry a selection digest.
    // It is not safe to assign that event to a target by guesswork.
    if (event.type === "target-skipped" && !bound.has(event.snapshotDigest)) {
      unboundEvent = true;
      continue;
    }
    if (
      (event.type === "target-selected" ||
        event.type === "snapshot-frozen" ||
        event.type === "discovery-run-started" ||
        event.type === "discovery-run-finished" ||
        event.type === "discovery-concluded" ||
        event.type === "finding-recorded" ||
        event.type === "finding-parked" ||
        event.type === "verification-finished" ||
        event.type === "lab-provisioned") &&
      !bound.has(event.snapshotDigest)
    ) {
      unboundEvent = true;
      continue;
    }
    switch (event.type) {
      case "target-selected":
        selected.add(event.snapshotDigest);
        break;
      case "snapshot-frozen":
        frozen.add(event.snapshotDigest);
        break;
      case "discovery-concluded":
        concluded.add(event.snapshotDigest);
        break;
      case "lab-provisioned":
        if (event.purpose === "discovery" || event.purpose === undefined)
          discoveryLabStatus.set(event.snapshotDigest, event.status);
        break;
      case "target-skipped":
        skipped.add(event.snapshotDigest);
        break;
      case "discovery-run-started":
        starts.set(event.snapshotDigest, [
          ...(starts.get(event.snapshotDigest) ?? []),
          event,
        ]);
        if (ownerByRun.has(event.runId)) orphanFinish = true;
        ownerByRun.set(event.runId, event.snapshotDigest);
        break;
      case "discovery-run-finished":
        if (finishes.has(event.runId)) orphanFinish = true;
        finishes.set(event.runId, event);
        break;
      case "finding-recorded": {
        const ids = findings.get(event.snapshotDigest) ?? new Set<string>();
        ids.add(event.findingId);
        findings.set(event.snapshotDigest, ids);
        findingRuns.set(
          `${event.snapshotDigest}\0${event.findingId}`,
          event.runId,
        );
        break;
      }
      case "verification-finished":
        if (event.basis === undefined)
          verifications.set(
            `${event.snapshotDigest}\0${event.findingId}`,
            event,
          );
        break;
    }
  }
  for (const [runId, finish] of finishes) {
    if (ownerByRun.get(runId) !== finish.snapshotDigest) orphanFinish = true;
  }
  for (const [key, runId] of findingRuns) {
    const snapshotDigest = key.split("\0", 1)[0]!;
    if (ownerByRun.get(runId) !== snapshotDigest) orphanFinish = true;
  }
  for (const [key] of verifications) {
    const snapshotDigest = key.split("\0", 1)[0]!;
    if (
      !findings.get(snapshotDigest)?.has(key.slice(snapshotDigest.length + 1))
    )
      orphanFinish = true;
  }
  const targets: ChildTargetAssessment[] = [];
  for (const snapshotDigest of input.snapshotDigests) {
    const targetStarts = starts.get(snapshotDigest) ?? [];
    const roots = targetStarts.filter(
      (start) => (start.runKind ?? "explore") === "explore",
    );
    const findingIds = findings.get(snapshotDigest) ?? new Set<string>();
    let verificationCovered = 0;
    let verificationComplete = 0;
    let verificationIncomplete = 0;
    let reviewExportsReady = 0;
    for (const findingId of findingIds) {
      const verification = verifications.get(`${snapshotDigest}\0${findingId}`);
      if (verification !== undefined) {
        verificationCovered++;
        if (verification.result.status === "incomplete")
          verificationIncomplete++;
        else verificationComplete++;
      }
      if (input.reviewExportReady !== undefined) {
        try {
          if (
            await input.reviewExportReady({
              campaignId: input.campaignId,
              snapshotDigest,
              findingId,
            })
          )
            reviewExportsReady++;
        } catch {
          // A missing or unreadable export is an operator-visible hold.
        }
      }
    }
    const unmatchedChild = targetStarts.some(
      (start) => start.runKind === "child" && !finishes.has(start.runId),
    );
    const state = targetState({
      selected: selected.has(snapshotDigest),
      frozen: frozen.has(snapshotDigest),
      labFailed: discoveryLabStatus.get(snapshotDigest) === "failed",
      skipped: skipped.has(snapshotDigest),
      concluded: concluded.has(snapshotDigest),
      starts: targetStarts,
      finishes,
      unmatchedChild,
      findings: findingIds.size,
      verificationCovered,
      reviewExportsReady,
      reviewExportChecked: input.reviewExportReady !== undefined,
      limitReached,
    });
    targets.push({
      snapshotDigest,
      ...state,
      trialsStarted: roots.length,
      trialsFinished: roots.filter((start) => finishes.has(start.runId)).length,
      findings: findingIds.size,
      verificationCovered,
      verificationComplete,
      verificationIncomplete,
      reviewExportsReady,
    });
  }
  const next =
    unboundEvent || orphanFinish
      ? {
          nextState: "wait-review" as const,
          reason: "ledger-mismatch" as const,
        }
      : (targets.find((target) => target.nextState === "wait-review") ??
        targets.find((target) => target.nextState === "unsettled") ??
        targets.find((target) => target.nextState === "wait-quota") ??
        targets.find((target) => target.nextState === "pending") ??
        targets[0]!);
  return {
    campaignId: input.campaignId,
    nextState: next.nextState,
    reason: next.reason,
    lastLedgerSequence: lastSequence,
    progress: {
      targetsTotal: targets.length,
      targetsComplete: targets.filter(
        (target) => target.nextState === "complete",
      ).length,
      trialsStarted: targets.reduce(
        (total, target) => total + target.trialsStarted,
        0,
      ),
      trialsFinished: targets.reduce(
        (total, target) => total + target.trialsFinished,
        0,
      ),
      findings: targets.reduce((total, target) => total + target.findings, 0),
      verificationCovered: targets.reduce(
        (total, target) => total + target.verificationCovered,
        0,
      ),
      verificationComplete: targets.reduce(
        (total, target) => total + target.verificationComplete,
        0,
      ),
      verificationIncomplete: targets.reduce(
        (total, target) => total + target.verificationIncomplete,
        0,
      ),
      reviewExportsReady: targets.reduce(
        (total, target) => total + target.reviewExportsReady,
        0,
      ),
    },
    targets,
  };
}
