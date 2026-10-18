import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import {
  recoverChildReportFromRollout,
  rootThreadIdFromRollout,
} from "../../../discovery/codex-native-agent-runtime.js";
import { nativeRunReceiptSchema } from "../../../discovery/native-run-receipts.js";
import type { ProviderAttachmentStore } from "../../../discovery/provider-research-report.js";
import { recordWordPressReport } from "./candidate-admission.js";

const parserVersion = "child-coverage-array-v1";

type Started = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type Finished = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;

/**
 * Reinterpret child runs that failed with `child-final-message-not-report` from
 * their immutable private rollouts. The failed events stay; `child-report-recovered`
 * and the admitted Findings / Leads are appended (docs/OPERATIONS.md).
 */
export async function recoverWordPressChildReports(options: {
  readonly campaignId: string;
  readonly ledger: Ledger;
  readonly evidence: PrivateArtifactStore;
  readonly attachments: Pick<ProviderAttachmentStore, "put" | "readByDigest">;
  readonly clock?: () => Date;
}): Promise<{
  readonly recovered: number;
  readonly findings: number;
  readonly leads: number;
}> {
  const { campaignId, ledger, evidence, attachments } = options;
  const events = ledger.readAll({ campaignId }).map(({ event }) => event);
  const started = new Map<string, Started>();
  const finished = new Map<string, Finished>();
  const recoveries = new Map<
    string,
    Extract<LedgerEventV1, { type: "child-report-recovered" }>
  >();
  for (const event of events) {
    if (event.type === "discovery-run-started") started.set(event.runId, event);
    else if (event.type === "discovery-run-finished")
      finished.set(event.runId, event);
    else if (event.type === "child-report-recovered")
      recoveries.set(event.runId, event);
  }
  const existingIdentities = new Set(events.map((event) => event.identity));

  const receiptOf = async (event: Finished) => {
    const digest = event.artifacts.find(
      (artifact) => artifact.kind === "native-run-receipt",
    )?.digest;
    if (digest === undefined)
      throw new Error("A finished run has no private receipt");
    const read = await evidence.readFile(digest, "receipt.json", 64 * 1024);
    if (read.status !== "resolved")
      throw new Error("Private run receipt is unavailable");
    return nativeRunReceiptSchema.parse(
      JSON.parse(read.bytes.toString("utf8")) as unknown,
    );
  };
  const diagnosticOf = async (digest: string) => {
    const result = await attachments.readByDigest("diagnostic", digest);
    if (result.status !== "resolved")
      throw new Error("Archived child diagnostic is unavailable");
    return result.bytes.toString("utf8");
  };
  const append = async (event: Parameters<Ledger["append"]>[0]) => {
    const result = await ledger.append(event);
    if (result.status === "conflict")
      throw new Error(`Ledger conflict: ${event.identity}`);
  };

  let recovered = 0;
  let findings = 0;
  let leads = 0;
  for (const childFinish of finished.values()) {
    if (
      childFinish.outcome !== "failed" ||
      childFinish.reason !== "schema" ||
      childFinish.reasonDetail !== "child-final-message-not-report"
    )
      continue;
    const childStart = started.get(childFinish.runId);
    if (
      childStart === undefined ||
      childStart.runKind !== "child" ||
      childStart.parentRunId === undefined ||
      typeof childStart.configuration.agentPath !== "string" ||
      childStart.snapshotDigest !== childFinish.snapshotDigest
    )
      throw new Error(
        "Archived child run is not bound to one Trial and snapshot",
      );
    const rootFinish = finished.get(childStart.parentRunId);
    const rootStart = started.get(childStart.parentRunId);
    if (
      rootFinish === undefined ||
      rootStart === undefined ||
      rootStart.snapshotDigest !== childStart.snapshotDigest ||
      rootStart.trialId !== childStart.trialId
    )
      throw new Error("Archived Root and child Trial do not match");
    const [childReceipt, rootReceipt] = await Promise.all([
      receiptOf(childFinish),
      receiptOf(rootFinish),
    ]);
    if (
      childReceipt.runId !== childStart.runId ||
      childReceipt.terminal !== "incomplete" ||
      childReceipt.reason !== "schema" ||
      childReceipt.reasonDetail !== "child-final-message-not-report" ||
      childReceipt.targetSnapshotDigest !== childStart.snapshotDigest ||
      rootReceipt.targetSnapshotDigest !== childStart.snapshotDigest ||
      childReceipt.runtimeProfileDigest !== rootReceipt.runtimeProfileDigest ||
      childReceipt.diagnosticArtifactDigest === undefined ||
      rootReceipt.diagnosticArtifactDigest === undefined
    )
      throw new Error("Archived receipts do not match the ledger");
    const [rootRaw, childRaw] = await Promise.all([
      diagnosticOf(rootReceipt.diagnosticArtifactDigest),
      diagnosticOf(childReceipt.diagnosticArtifactDigest),
    ]);
    const report = recoverChildReportFromRollout(childRaw, {
      parentThreadId: rootThreadIdFromRollout(rootRaw),
      childThreadId: childStart.runId,
      agentPath: childStart.configuration.agentPath,
      modelId: childReceipt.requestedModelId,
      effort: childReceipt.requestedEffort,
      cyberAccessProgram: childReceipt.cyberAccessProgram,
    });
    const reportRef = await attachments.put(
      "findings",
      Buffer.from(canonicalJson(report)),
    );
    const recoveryDigest = await evidence.putFiles({
      "recovery.json": canonicalJson({
        schemaVersion: 1,
        runId: childStart.runId,
        parentRunId: childStart.parentRunId,
        snapshotDigest: childStart.snapshotDigest,
        sourceDiagnosticDigest: childReceipt.diagnosticArtifactDigest,
        reportArtifactDigest: reportRef.digest,
        parserVersion,
      }),
    });
    const previousRecovery = recoveries.get(childStart.runId);
    if (
      previousRecovery !== undefined &&
      (previousRecovery.sourceDiagnosticDigest !==
        childReceipt.diagnosticArtifactDigest ||
        previousRecovery.reportArtifactDigest !== reportRef.digest ||
        previousRecovery.parserVersion !== parserVersion)
    )
      throw new Error("Archived recovery provenance changed");
    const base = {
      schemaVersion: 1 as const,
      campaignId,
      snapshotDigest: childStart.snapshotDigest,
      occurredAt:
        previousRecovery?.occurredAt ??
        (options.clock ?? (() => new Date()))().toISOString(),
    };
    await append({
      ...base,
      identity: `child-report-recovered-${childStart.runId}-v1`,
      type: "child-report-recovered",
      runId: childStart.runId,
      sourceDiagnosticDigest: childReceipt.diagnosticArtifactDigest,
      reportArtifactDigest: reportRef.digest,
      parserVersion,
      artifacts: [{ kind: "child-report-recovery", digest: recoveryDigest }],
    });
    if (previousRecovery === undefined) recovered++;
    const recorded = await recordWordPressReport(report, {
      ledger,
      evidence,
      base,
      runId: childStart.runId,
      trialId: childStart.trialId ?? childStart.runId,
      snapshotDigest: childStart.snapshotDigest,
      reportArtifactDigest: reportRef.digest,
      existingIdentities,
    });
    for (const candidate of recorded.candidates) {
      if (candidate.outcome !== "recorded" || candidate.status !== "appended")
        continue;
      if (candidate.kind === "finding") findings++;
      else leads++;
    }
  }
  return { recovered, findings, leads };
}
