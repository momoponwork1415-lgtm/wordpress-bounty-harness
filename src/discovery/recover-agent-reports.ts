import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import type {
  DiscoveryTransportResult,
  DiscoveryTransportRun,
} from "./codex-native-agent-runtime.js";
import type { PlannedDiscoveryRun } from "./campaign.js";
import {
  nativeRunReceiptSchema,
  type NativeRunReceipt,
} from "./native-run-receipts.js";

export class DiscoveryReportError extends Error {}

export type ReportFailure = {
  readonly reason: Exclude<NativeRunReceipt["reason"], "unavailable"> | "depth";
  readonly reasonDetail?: string;
  readonly providerLimit?: "rate-limit" | "quota";
};

type ReportAttachment = NonNullable<DiscoveryTransportResult["attachment"]>;
type RecoveryContext = {
  readonly result: DiscoveryTransportResult;
  readonly run: Omit<DiscoveryTransportRun, "campaignInput">;
  readonly snapshotDigest: string;
  readonly recordReport: (
    ownerRunId: string,
    attachment: ReportAttachment,
  ) => Promise<void>;
};

type ChildRecoveryOptions = RecoveryContext & {
  readonly ledger: Ledger;
  readonly evidence: PrivateArtifactStore;
  readonly base: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly occurredAt: string;
  };
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly labId?: string;
  readonly history:
    | { readonly mode: "none" }
    | {
        readonly mode: "catalog";
        readonly digest: string;
        readonly recordIds: string[];
      };
  readonly configuration: PlannedDiscoveryRun["configuration"];
  readonly promptDigest: string;
  readonly trustBoundaryVersion: string;
};

type ChildAgentRun = NonNullable<DiscoveryTransportResult["agentRuns"]>[number];

function childConfiguration(
  options: ChildRecoveryOptions,
  child: ChildAgentRun,
) {
  return {
    ...options.configuration,
    promptDigest: options.configuration.promptDigest ?? options.promptDigest,
    trustBoundaryVersion: options.trustBoundaryVersion,
    agentPath: child.agentPath,
  };
}

/** A malformed Root receipt cannot suppress already captured child reports. */
export async function recoverChildAgentReports(
  options: ChildRecoveryOptions,
): Promise<void> {
  for (const child of options.result.agentRuns ?? []) {
    const receipt = nativeRunReceiptSchema.parse(child.receipt);
    const started = await options.ledger.append({
      ...options.base,
      identity: `discovery-start-${receipt.runId}`,
      type: "discovery-run-started",
      runId: receipt.runId,
      trialId: options.trialId,
      trialOrdinal: options.trialOrdinal,
      runKind: "child",
      parentRunId: options.run.runId,
      ...(options.labId === undefined
        ? { labAttached: false as const }
        : { labId: options.labId, labAttached: true as const }),
      history: options.history,
      configuration: childConfiguration(options, child),
    });
    if (started.status === "conflict")
      throw new Error("Child start identity conflict");
    const receiptDigest = await options.evidence.putFiles({
      "receipt.json": canonicalJson(receipt),
    });
    let outcome: "completed" | "failed" = "failed";
    let failure: ReportFailure | undefined;
    if (
      (receipt.terminal === "completed" ||
        (receipt.terminal === "incomplete" && receipt.reason === "schema")) &&
      receipt.targetSnapshotDigest === options.snapshotDigest &&
      receipt.runtimeProfileDigest === options.run.profile.digest &&
      child.attachment !== undefined &&
      receipt.reportArtifactDigest === child.attachment.digest
    ) {
      try {
        await options.recordReport(receipt.runId, child.attachment);
        if (receipt.terminal === "completed") outcome = "completed";
        else
          failure = {
            reason: "schema",
            reasonDetail: receipt.reasonDetail ?? "child-report-unreadable",
          };
      } catch (error) {
        if (!(error instanceof DiscoveryReportError)) throw error;
        failure = { reason: "schema", reasonDetail: "child-report-unreadable" };
      }
    } else {
      failure = {
        reason: receipt.reason === "unavailable" ? "policy" : receipt.reason,
        reasonDetail: receipt.reasonDetail ?? "child-receipt-invalid",
      };
    }
    const finished = await options.ledger.append({
      ...options.base,
      identity: `discovery-finish-${receipt.runId}`,
      type: "discovery-run-finished",
      runId: receipt.runId,
      outcome,
      costUsd: "unavailable",
      wallTimeMs: Math.max(
        0,
        Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
      ),
      usage: receipt.usage,
      ...(receipt.observed === undefined ? {} : { observed: receipt.observed }),
      ...(receipt.sandboxExitCode === undefined
        ? {}
        : { sandboxExitCode: receipt.sandboxExitCode }),
      ...(receipt.diagnosticArtifactDigest === undefined
        ? {}
        : { diagnosticArtifactDigest: receipt.diagnosticArtifactDigest }),
      ...(failure === undefined ? {} : failure),
      artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
    });
    if (finished.status === "conflict")
      throw new Error("Child finish identity conflict");
  }
}

/** Recover a Root report even from a schema-failed transcript. */
export async function recoverRootAgentReport(
  options: RecoveryContext & { readonly receipt: NativeRunReceipt },
): Promise<{ readonly recovered: boolean; readonly failure?: ReportFailure }> {
  const { receipt, result, run } = options;
  const attachment = result.attachment;
  if (
    (receipt.terminal !== "completed" &&
      !(receipt.terminal === "incomplete" && receipt.reason === "schema")) ||
    receipt.runId !== run.runId ||
    receipt.targetSnapshotDigest !== options.snapshotDigest ||
    receipt.runtimeProfileDigest !== run.profile.digest ||
    attachment === undefined ||
    receipt.reportArtifactDigest !== attachment.digest
  )
    return { recovered: false };
  try {
    await options.recordReport(run.runId, attachment);
    return { recovered: receipt.terminal === "completed" };
  } catch (error) {
    if (!(error instanceof DiscoveryReportError)) throw error;
    return {
      recovered: false,
      failure: { reason: "schema", reasonDetail: "root-report-unreadable" },
    };
  }
}
