import type { CliIo } from "./index.js";
import {
  assessContinuousChildCampaign,
  type ReviewExportCheck,
} from "../discovery/continuous-child-assessment.js";
import type { SqliteContinuousRunJournal } from "../infrastructure/continuous-run-journal.js";
import type { Ledger } from "../ledger/index.js";

/** Host-common control plane; these commands never start or repeat a Trial. */
export async function runContinuousControl(
  args: readonly string[],
  journal: Pick<SqliteContinuousRunJournal, "get" | "requestStop">,
  io: Pick<CliIo, "stdout">,
  assessmentInputs: {
    readonly ledger?: Pick<Ledger, "read">;
    readonly reviewExportReady?: ReviewExportCheck;
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

  const run =
    action === "status"
      ? journal.get(parentRunId)
      : journal.requestStop(parentRunId);
  if (run === null) throw new Error("Continuous run not found");
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
            // Without the Private Evidence check, a Finding's export state is
            // unknown. Do not report a settled child as needing review merely
            // because status was invoked without a review reader.
            state:
              assessmentInputs.reviewExportReady === undefined &&
              assessment.progress.findings > 0
                ? null
                : assessment.nextState,
            reason:
              assessmentInputs.reviewExportReady === undefined &&
              assessment.progress.findings > 0
                ? "review-export-unchecked"
                : assessment.reason,
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
      children,
    }),
  );
  return 0;
}
