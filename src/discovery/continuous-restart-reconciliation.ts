import {
  assessContinuousChildCampaign,
  type ChildCampaignAssessment,
  type ReviewExportCheck,
} from "./continuous-child-assessment.js";
import {
  continuousChildCampaignId,
  type ContinuousRunRecord,
} from "../infrastructure/continuous-run-journal.js";
import type { ContinuousRunOwnerHandle } from "../infrastructure/continuous-run-owner.js";
import type { Ledger, LedgerRecord } from "../ledger/index.js";

type JournalReader = {
  get(parentRunId: string): ContinuousRunRecord | null;
};
type LedgerReader = Pick<Ledger, "read">;
type DiscoveryStart = Extract<
  LedgerRecord["event"],
  { type: "discovery-run-started" }
>;
type ClaimReader = {
  status(): {
    readonly claims: readonly {
      readonly campaignId: string;
      readonly snapshotDigest: string;
      readonly status: "active" | "recovery-needed";
    }[];
  };
};
type OwnerReader = {
  assertReady(handle: ContinuousRunOwnerHandle): void;
};

export type ContinuousRestartDecision =
  | {
      readonly action: "reserve-next-child";
      readonly parentRunId: string;
      readonly expectedRevision: number;
      readonly nextOrdinal: number;
      readonly lastChildAssessment: ChildCampaignAssessment | null;
    }
  | {
      readonly action: "settle-child";
      readonly parentRunId: string;
      readonly expectedRevision: number;
      readonly ordinal: number;
      readonly lastLedgerSequence: number;
      readonly assessment: ChildCampaignAssessment;
    }
  | {
      readonly action: "resume-child";
      readonly parentRunId: string;
      readonly expectedRevision: number;
      readonly ordinal: number;
      readonly campaignId: string;
      readonly assessment: ChildCampaignAssessment | null;
    }
  | {
      readonly action: "hold";
      readonly parentRunId: string;
      /** A drained, assessed wait may release a dead owner's recovery claim. */
      readonly ownerReconciliationSafe: boolean;
      readonly reason:
        | "parent-missing"
        | "journal-unavailable"
        | "journal-mismatch"
        | "parent-not-running"
        | "stop-requested"
        | "owner-not-ready"
        | "claims-unavailable"
        | "resource-active"
        | "resource-recovery-needed"
        | "orphan-resource-claim"
        | "ledger-unavailable"
        | "ledger-mismatch"
        | "orphan-child-ledger"
        | "unbound-child-ledger"
        | "settled-child-incomplete"
        | "trial-unsettled"
        | "quota"
        | "review-required";
      readonly expectedRevision: number | null;
      readonly campaignId: string | null;
      readonly assessment: ChildCampaignAssessment | null;
    };

function campaignRows(
  ledger: LedgerReader,
  campaignId: string,
  type?: "selection-batch-bound" | "target-selected",
  limit = 1,
): readonly LedgerRecord[] {
  const rows = ledger.read({
    campaignId,
    ...(type === undefined ? {} : { type }),
    limit,
  });
  if (
    rows.length > limit ||
    rows.some(
      ({ event }) =>
        event.campaignId !== campaignId ||
        (type !== undefined && event.type !== type),
    )
  )
    throw new Error(
      "Ledger reader returned a different campaign or event type",
    );
  return rows;
}

/** Validate the single Root and its child receipts for every Snapshot. */
function cooperativeTrialLineageMatches(
  ledger: LedgerReader,
  campaignId: string,
): boolean {
  // A child campaign binds at most five targets, each with one Root and three
  // children. A 21st start means this bounded view cannot establish lineage.
  const starts = ledger.read({
    campaignId,
    type: "discovery-run-started",
    limit: 21,
  });
  if (starts.length > 20) return false;
  const rootsBySnapshot = new Map<string, DiscoveryStart>();
  const childrenBySnapshot = new Map<string, DiscoveryStart[]>();
  for (const { event } of starts) {
    if (
      event.campaignId !== campaignId ||
      event.type !== "discovery-run-started" ||
      event.runKind === "continue" ||
      (event.trialOrdinal ?? 0) !== 0 ||
      event.stage !== undefined ||
      event.continuationOf !== undefined ||
      event.configuration.arm !== undefined ||
      event.configuration.arms !== undefined ||
      event.configuration.axis !== undefined
    )
      return false;
    if ((event.runKind ?? "explore") === "explore") {
      if (rootsBySnapshot.has(event.snapshotDigest)) return false;
      rootsBySnapshot.set(event.snapshotDigest, event);
    } else {
      childrenBySnapshot.set(event.snapshotDigest, [
        ...(childrenBySnapshot.get(event.snapshotDigest) ?? []),
        event,
      ]);
    }
  }
  // A finished child is still part of the same cooperative Trial only when
  // both its parent and Trial identity match this Snapshot's sole Root.
  return [...childrenBySnapshot].every(([snapshotDigest, children]) => {
    const root = rootsBySnapshot.get(snapshotDigest);
    return (
      root !== undefined &&
      root.trialId !== undefined &&
      children.length <= 3 &&
      children.every(
        (child) =>
          child.parentRunId === root.runId && child.trialId === root.trialId,
      )
    );
  });
}

/** A drained Trial is spent; only unfinished child work may resume. */
function canResumeStartedChild(assessment: ChildCampaignAssessment): boolean {
  return (
    assessment.progress.trialsStarted > 0 &&
    assessment.progress.trialsStarted === assessment.progress.trialsFinished &&
    assessment.targets.every(
      (target) =>
        target.trialsStarted === target.trialsFinished &&
        (target.nextState === "pending" ||
          target.nextState === "complete" ||
          (target.nextState === "unsettled" &&
            target.reason === "no-conclusion")),
    )
  );
}

/** Only typed, fully drained outcomes can clear a crashed parent's owner claim. */
function safelyAssessedWait(assessment: ChildCampaignAssessment): boolean {
  if (!assessment.allRunsSettled) return false;
  return assessment.targets.every((target) => {
    if (
      target.verificationCovered < target.findings ||
      target.reviewExportsReady < target.findings
    )
      return false;
    if (
      target.nextState === "complete" ||
      (target.nextState === "pending" && target.reason === "not-started")
    )
      return true;
    return target.reason === "quota" || target.reason === "cyber-policy";
  });
}

/**
 * Read-only restart preflight. The caller must acquire the parent owner claim,
 * apply the returned journal operation with expectedRevision, and run this
 * preflight again before reserving another child. A returned decision is never
 * permission to start an additional Trial within the same child campaign.
 * A stopped parent may be inspected for explicit resume only; the caller must
 * then clear its stop request with the same journal revision.
 */
export async function reconcileContinuousRestart(input: {
  readonly parentRunId: string;
  readonly journal: JournalReader;
  readonly ledger: LedgerReader;
  readonly claims: ClaimReader;
  readonly owner: OwnerReader;
  readonly ownerHandle: ContinuousRunOwnerHandle;
  readonly reviewExportReady?: ReviewExportCheck;
  /** Recheck evidence for settled predecessors after process recovery. */
  readonly auditPriorSettled?: boolean;
  readonly allowStoppedResume?: boolean;
  /** Explicit operator resume after a non-running recovery hold. */
  readonly allowRecoveringResume?: boolean;
  /** Explicit retry of a repaired operational review hold. */
  readonly allowReviewResume?: boolean;
}): Promise<ContinuousRestartDecision> {
  const hold = (
    reason: Extract<ContinuousRestartDecision, { action: "hold" }>["reason"],
    run: ContinuousRunRecord | null = null,
    assessment: ChildCampaignAssessment | null = null,
    campaignId: string | null = run?.children.at(-1)?.campaignId ?? null,
    ownerReconciliationSafe = false,
  ): ContinuousRestartDecision => ({
    action: "hold",
    parentRunId: input.parentRunId,
    ownerReconciliationSafe,
    reason,
    expectedRevision: run?.revision ?? null,
    campaignId,
    assessment,
  });

  let run: ContinuousRunRecord | null;
  try {
    run = input.journal.get(input.parentRunId);
  } catch {
    return hold("journal-unavailable");
  }
  if (run === null) return hold("parent-missing");
  if (
    run.parentRunId !== input.parentRunId ||
    !run.children.every(
      (child, index) =>
        child.ordinal === index &&
        child.campaignId ===
          continuousChildCampaignId(run.parentRunId, index) &&
        (child.status !== "settled" ||
          (child.binding !== null && child.settledAt !== null)) &&
        (index === run.children.length - 1 || child.status === "settled"),
    ) ||
    (run.children.length === 0 && run.lastLedgerSequence !== 0)
  )
    return hold("journal-mismatch", run);

  const last = run.children.at(-1);
  const nextCampaignId = continuousChildCampaignId(
    run.parentRunId,
    run.children.length,
  );
  let activeClaims: ReturnType<ClaimReader["status"]>["claims"];
  try {
    activeClaims = input.claims.status().claims;
  } catch {
    return hold("claims-unavailable", run);
  }
  for (const claim of activeClaims) {
    const child = run.children.find(
      (entry) => entry.campaignId === claim.campaignId,
    );
    if (claim.campaignId === nextCampaignId)
      return hold("orphan-resource-claim", run);
    if (child === undefined) continue;
    if (
      child.binding !== null &&
      !child.binding.snapshotDigests.includes(claim.snapshotDigest)
    )
      return hold("journal-mismatch", run);
    return hold(
      claim.status === "recovery-needed"
        ? "resource-recovery-needed"
        : "resource-active",
      run,
    );
  }

  let assessment: ChildCampaignAssessment | null = null;
  try {
    if (campaignRows(input.ledger, nextCampaignId).length > 0)
      return hold("orphan-child-ledger", run);
    if (input.auditPriorSettled) {
      for (const prior of run.children.slice(0, -1)) {
        if (prior.binding === null)
          return hold("journal-mismatch", run, null, prior.campaignId);
        if (!cooperativeTrialLineageMatches(input.ledger, prior.campaignId))
          return hold("ledger-mismatch", run, null, prior.campaignId);
        const priorAssessment = await assessContinuousChildCampaign({
          campaignId: prior.campaignId,
          snapshotDigests: prior.binding.snapshotDigests,
          ledger: input.ledger,
          ...(input.reviewExportReady === undefined
            ? {}
            : { reviewExportReady: input.reviewExportReady }),
        });
        if (priorAssessment.nextState !== "complete")
          return hold(
            "settled-child-incomplete",
            run,
            priorAssessment,
            prior.campaignId,
          );
      }
    }
    if (last !== undefined) {
      const rows = campaignRows(input.ledger, last.campaignId);
      if (last.binding === null) {
        if (rows.length > 0) return hold("unbound-child-ledger", run);
      } else {
        const bindings = campaignRows(
          input.ledger,
          last.campaignId,
          "selection-batch-bound",
          2,
        );
        const selections = campaignRows(
          input.ledger,
          last.campaignId,
          "target-selected",
          6,
        );
        const expectedSelectionIds =
          bindings[0]?.event.type === "selection-batch-bound"
            ? bindings[0].event.selectionIds
            : [];
        if (
          (rows.length > 0 && bindings.length !== 1) ||
          bindings.some(
            ({ event }) =>
              event.type !== "selection-batch-bound" ||
              event.selectionBatchId !== last.binding!.selectionBatchId ||
              event.policyDigest !== run.policyDigest ||
              event.snapshotDigest !== last.binding!.snapshotDigests[0] ||
              event.selectionIds.length !==
                last.binding!.snapshotDigests.length,
          ) ||
          selections.length > last.binding.snapshotDigests.length ||
          selections.some(
            ({ event }, index) =>
              event.snapshotDigest !== last.binding!.snapshotDigests[index] ||
              event.type !== "target-selected" ||
              event.selectionId !== expectedSelectionIds[index],
          ) ||
          !cooperativeTrialLineageMatches(input.ledger, last.campaignId)
        )
          return hold("ledger-mismatch", run);
        assessment = await assessContinuousChildCampaign({
          campaignId: last.campaignId,
          snapshotDigests: last.binding.snapshotDigests,
          ledger: input.ledger,
          ...(input.reviewExportReady === undefined
            ? {}
            : { reviewExportReady: input.reviewExportReady }),
        });
      }
    }
  } catch {
    return hold("ledger-unavailable", run);
  }

  const stoppedResume =
    input.allowStoppedResume === true &&
    (run.state === "STOPPED" ||
      run.state === "STOPPING" ||
      run.state === "RECOVERING") &&
    run.stopRequested;
  const recoveringResume =
    input.allowRecoveringResume === true &&
    run.state === "RECOVERING" &&
    !run.stopRequested;
  const reviewResume =
    input.allowReviewResume === true &&
    run.state === "WAIT_REVIEW" &&
    !run.stopRequested;
  if (run.stopRequested && !stoppedResume)
    return hold("stop-requested", run, assessment);
  if (
    run.state !== "RUNNING" &&
    !stoppedResume &&
    !recoveringResume &&
    !reviewResume
  )
    return hold("parent-not-running", run, assessment);
  if (last?.status === "settled") {
    if (
      assessment?.nextState !== "complete" ||
      assessment.lastLedgerSequence < run.lastLedgerSequence
    )
      return hold("settled-child-incomplete", run, assessment);
  } else if (assessment?.nextState === "wait-quota") {
    return hold(
      "quota",
      run,
      assessment,
      last?.campaignId ?? null,
      safelyAssessedWait(assessment),
    );
  } else if (assessment?.nextState === "wait-review") {
    return hold(
      "review-required",
      run,
      assessment,
      last?.campaignId ?? null,
      safelyAssessedWait(assessment),
    );
  } else if (
    assessment?.nextState === "unsettled" &&
    assessment.progress.trialsStarted > 0 &&
    !canResumeStartedChild(assessment)
  ) {
    return hold("trial-unsettled", run, assessment);
  }
  if (
    assessment?.nextState === "complete" &&
    assessment.lastLedgerSequence < run.lastLedgerSequence
  )
    return hold("ledger-mismatch", run, assessment);

  try {
    input.owner.assertReady(input.ownerHandle);
  } catch {
    return hold("owner-not-ready", run, assessment);
  }

  if (last === undefined || last.status === "settled")
    return {
      action: "reserve-next-child",
      parentRunId: run.parentRunId,
      expectedRevision: run.revision,
      nextOrdinal: run.children.length,
      lastChildAssessment: assessment,
    };
  if (assessment?.nextState === "complete")
    return {
      action: "settle-child",
      parentRunId: run.parentRunId,
      expectedRevision: run.revision,
      ordinal: last.ordinal,
      lastLedgerSequence: assessment.lastLedgerSequence,
      assessment,
    };
  if (
    assessment !== null &&
    assessment.progress.trialsStarted > 0 &&
    !canResumeStartedChild(assessment)
  )
    return hold("trial-unsettled", run, assessment);
  return {
    action: "resume-child",
    parentRunId: run.parentRunId,
    expectedRevision: run.revision,
    ordinal: last.ordinal,
    campaignId: last.campaignId,
    assessment,
  };
}
