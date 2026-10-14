import { reconcileContinuousRestart } from "../discovery/continuous-restart-reconciliation.js";
import type { ReviewExportCheck } from "../discovery/continuous-child-assessment.js";
import type { SqliteContinuousRunJournal } from "../infrastructure/continuous-run-journal.js";
import type {
  ContinuousRunOwnerHandle,
  SqliteContinuousRunOwner,
} from "../infrastructure/continuous-run-owner.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import type { Ledger } from "../ledger/index.js";

/** Settle a durable stop request only after the child ledger and host claims are checked. */
export async function settleContinuousStop(input: {
  readonly parentRunId: string;
  readonly journal: Pick<SqliteContinuousRunJournal, "get" | "transition">;
  readonly ledger: Pick<Ledger, "read">;
  readonly claims: Pick<SqliteHostResourceClaims, "status">;
  readonly owner: Pick<SqliteContinuousRunOwner, "assertReady">;
  readonly ownerHandle: ContinuousRunOwnerHandle;
  readonly reviewExportReady: ReviewExportCheck;
}) {
  const run = input.journal.get(input.parentRunId);
  if (run === null) throw new Error("Continuous parent is missing");
  if (!run.stopRequested) throw new Error("Continuous stop was not requested");
  if (run.state === "STOPPED") return run;
  const decision = await reconcileContinuousRestart({
    parentRunId: input.parentRunId,
    journal: input.journal,
    ledger: input.ledger,
    claims: input.claims,
    owner: input.owner,
    ownerHandle: input.ownerHandle,
    reviewExportReady: input.reviewExportReady,
    auditPriorSettled: true,
    allowStoppedResume: true,
  });
  const latest = input.journal.get(input.parentRunId);
  if (latest === null) throw new Error("Continuous parent is missing");
  if (!latest.stopRequested)
    throw new Error("Continuous stop request changed during reconciliation");
  if (latest.revision !== run.revision)
    throw new Error("Continuous stop changed during reconciliation");
  if (
    decision.action === "hold" &&
    decision.reason !== "quota" &&
    decision.reason !== "review-required"
  )
    return latest.state === "RECOVERING"
      ? latest
      : input.journal.transition(input.parentRunId, latest.revision, {
          state: "RECOVERING",
          reason: `stop-${decision.reason}`,
          nextCheckAt: null,
        });
  return input.journal.transition(input.parentRunId, latest.revision, {
    state: "STOPPED",
    reason: "operator-stop",
    nextCheckAt: null,
  });
}

/** A stop command may finish an idle wait after taking the same owner lock as the runner. */
export async function settleIdleContinuousStop(input: {
  readonly parentRunId: string;
  readonly journal: SqliteContinuousRunJournal;
  readonly ledger: Pick<Ledger, "read">;
  readonly claims: Pick<SqliteHostResourceClaims, "status">;
  readonly owner: SqliteContinuousRunOwner;
  readonly reviewExportReady: ReviewExportCheck;
}) {
  const acquisition = input.owner.tryAcquire(input.parentRunId);
  if (acquisition.status === "busy")
    return input.journal.get(input.parentRunId);
  // A dead owner first needs the runner's crash reconciliation. The stop
  // request remains durable, and a recovery-required claim cannot be dropped.
  if (acquisition.recoveryRequired) return input.journal.get(input.parentRunId);
  try {
    return await settleContinuousStop({
      ...input,
      ownerHandle: acquisition.handle,
    });
  } finally {
    input.owner.release(acquisition.handle);
  }
}
