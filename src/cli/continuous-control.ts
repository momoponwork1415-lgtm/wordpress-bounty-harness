import type { CliIo } from "./index.js";
import {
  assessContinuousChildCampaign,
  type ReviewExportCheck,
} from "../discovery/continuous-child-assessment.js";
import type {
  ContinuousRunRecord,
  SqliteContinuousRunJournal,
} from "../infrastructure/continuous-run-journal.js";
import type { ContinuousRunOwnerObservation } from "../infrastructure/continuous-run-owner.js";
import type { Ledger } from "../ledger/index.js";

/** Host-common control plane; these commands never start or repeat a Trial. */
export async function runContinuousControl(
  args: readonly string[],
  journal: Pick<SqliteContinuousRunJournal, "get" | "requestStop">,
  io: Pick<CliIo, "stdout"> & Partial<Pick<CliIo, "stderr">>,
  assessmentInputs: {
    readonly ledger?: Pick<Ledger, "read">;
    readonly reviewExportReady?: ReviewExportCheck;
    readonly ownerObservation?: (
      parentRunId: string,
    ) => ContinuousRunOwnerObservation;
    /** Stop intent is already durable when this optional idle drain runs. */
    readonly settleStop?: (
      requested: ContinuousRunRecord,
    ) => Promise<ContinuousRunRecord | null>;
  } = {},
): Promise<number> {
  const [group, action, flag, parentRunId] = args;
  if (
    group !== "continuous" ||
    (action !== "status" && action !== "stop") ||
    flag !== "--run" ||
    parentRunId === undefined ||
    args.length !== 4
  )
    throw new Error("Use continuous status|stop --run <parent run id>");

  const previous = action === "stop" ? journal.get(parentRunId) : null;
  let run =
    action === "status"
      ? journal.get(parentRunId)
      : journal.requestStop(parentRunId);
  if (run === null) throw new Error("Continuous run not found");
  const ownerObservation =
    action === "status"
      ? (assessmentInputs.ownerObservation?.(parentRunId) ?? {
          pidLiveness: "unknown" as const,
          claimStatus: null,
          ownerPid: null,
          reason: "owner-not-checked" as const,
        })
      : null;
  if (
    action === "stop" &&
    (previous?.state === "RUNNING" ||
      previous?.state === "WAIT_REVIEW" ||
      previous?.state === "WAIT_QUOTA" ||
      previous?.state === "STOPPING") &&
    assessmentInputs.settleStop !== undefined
  ) {
    try {
      run =
        (await assessmentInputs.settleStop(run)) ??
        journal.get(parentRunId) ??
        run;
    } catch (error) {
      // The stop flag is already persisted. Leave an uncertain drain visible
      // instead of turning a stop command into a failed request.
      run = journal.get(parentRunId) ?? run;
      io.stderr?.(
        `Stop requested; reconciliation pending: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const children = [];
  for (const child of run.children) {
    const assessment =
      action === "status" &&
      child.binding !== null &&
      assessmentInputs.ledger !== undefined
        ? await assessContinuousChildCampaign({
            campaignId: child.campaignId,
            snapshotDigests: child.binding.snapshotDigests,
            ledger: assessmentInputs.ledger,
            ...(assessmentInputs.reviewExportReady === undefined
              ? {}
              : { reviewExportReady: assessmentInputs.reviewExportReady }),
          })
        : null;
    children.push({
      ordinal: child.ordinal,
      campaignId: child.campaignId,
      status: child.status,
      targetCount: child.binding?.snapshotDigests.length ?? 0,
      ...(assessment === null
        ? {}
        : {
            // Missing export evidence only obscures export readiness. A
            // higher-priority quota or failed-run hold must remain visible.
            state:
              assessment.reason === "review-export-unchecked"
                ? null
                : assessment.nextState,
            reason: assessment.reason,
            reviewExportChecked:
              assessmentInputs.reviewExportReady !== undefined,
            lastLedgerSequence: assessment.lastLedgerSequence,
            targetsComplete: assessment.progress.targetsComplete,
            trialsStarted: assessment.progress.trialsStarted,
            trialsFinished: assessment.progress.trialsFinished,
            findings: assessment.progress.findings,
            verificationComplete: assessment.progress.verificationComplete,
            verificationIncomplete: assessment.progress.verificationIncomplete,
            reviewExportsReady:
              assessmentInputs.reviewExportReady === undefined &&
              assessment.progress.findings > 0
                ? null
                : assessment.progress.reviewExportsReady,
            // The bound Snapshot digest is already in the journal. Per-target
            // receipt states show which attempts are spent and which have not
            // started, without exposing Finding text or Private Evidence.
            targets: assessment.targets.map((target) => ({
              snapshotDigest: target.snapshotDigest,
              state:
                target.reason === "review-export-unchecked"
                  ? null
                  : target.nextState,
              reason: target.reason,
              trialsStarted: target.trialsStarted,
              trialsFinished: target.trialsFinished,
              findings: target.findings,
              verificationCovered: target.verificationCovered,
              verificationComplete: target.verificationComplete,
              verificationIncomplete: target.verificationIncomplete,
              reviewExportsReady:
                assessmentInputs.reviewExportReady === undefined &&
                target.findings > 0
                  ? null
                  : target.reviewExportsReady,
            })),
          }),
    });
  }
  io.stdout(
    JSON.stringify({
      parentRunId: run.parentRunId,
      configDigest: run.configDigest,
      policyDigest: run.policyDigest,
      inventoryDigest: run.inventoryDigest,
      state: run.state,
      reason: run.reason,
      nextCheckAt: run.nextCheckAt,
      stopRequested: run.stopRequested,
      lastLedgerSequence: run.lastLedgerSequence,
      revision: run.revision,
      ...(ownerObservation === null ? {} : { ownerObservation }),
      children,
    }),
  );
  return 0;
}
