import type { CliIo } from "./index.js";
import type { SqliteContinuousRunJournal } from "../infrastructure/continuous-run-journal.js";

/** Host-common control plane; these commands never start or repeat a Trial. */
export function runContinuousControl(
  args: readonly string[],
  journal: Pick<SqliteContinuousRunJournal, "get" | "requestStop">,
  io: Pick<CliIo, "stdout">,
): number {
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
      children: run.children.map((child) => ({
        ordinal: child.ordinal,
        campaignId: child.campaignId,
        status: child.status,
        targetCount: child.binding?.snapshotDigests.length ?? 0,
      })),
    }),
  );
  return 0;
}
