import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { recoverRootReportFromRollout } from "../../../discovery/codex-native-agent-runtime.js";
import { nativeRunReceiptSchema } from "../../../discovery/native-run-receipts.js";
import type { ProviderAttachmentStore } from "../../../discovery/provider-research-report.js";
import type { RecordedCandidate } from "../../../discovery/record-discovery-report.js";
import { recordWordPressReport } from "./candidate-admission.js";

/** Bump this when the syntax rules change; prior interpretations remain in the ledger. */
const parserVersion = "wordpress-candidate-v1";

function campaignEvents(ledger: Ledger, campaignId: string): LedgerEventV1[] {
  return ledger.readAll({ campaignId }).map(({ event }) => event);
}

/** Reinterpret only archived candidate output bound to an existing run receipt. */
export async function reacceptWordPressRun(options: {
  campaignId: string;
  runId: string;
  ledger: Ledger;
  evidence: PrivateArtifactStore;
  attachments: ProviderAttachmentStore;
  clock?: () => Date;
}) {
  const { campaignId, runId, ledger, evidence, attachments } = options;
  const events = campaignEvents(ledger, campaignId);
  const started = events.find(
    (event) => event.type === "discovery-run-started" && event.runId === runId,
  );
  const finished = events.find(
    (event) => event.type === "discovery-run-finished" && event.runId === runId,
  );
  if (
    started?.type !== "discovery-run-started" ||
    finished?.type !== "discovery-run-finished" ||
    started.snapshotDigest !== finished.snapshotDigest
  )
    throw new Error(
      "Archived discovery run is missing or has mismatched snapshots",
    );
  const receiptRef = finished.artifacts.find(
    (ref) => ref.kind === "native-run-receipt",
  );
  if (receiptRef === undefined)
    throw new Error("Archived run receipt is missing");
  const storedReceipt = await evidence.readFile(
    receiptRef.digest,
    "receipt.json",
    100_000,
  );
  if (storedReceipt.status !== "resolved")
    throw new Error("Archived run receipt is unreadable");
  const receipt = nativeRunReceiptSchema.parse(
    JSON.parse(storedReceipt.bytes.toString("utf8")) as unknown,
  );
  if (
    receipt.runId !== runId ||
    receipt.targetSnapshotDigest !== started.snapshotDigest
  )
    throw new Error("Archived receipt identity differs from the ledger");

  let reportDigest = receipt.reportArtifactDigest;
  let report: unknown;
  if (reportDigest !== "unavailable") {
    const stored = await attachments.readByDigest("findings", reportDigest);
    if (stored.status !== "resolved")
      throw new Error("Archived final report is unavailable");
    report = JSON.parse(stored.bytes.toString("utf8")) as unknown;
  } else {
    if (
      receipt.reason !== "schema" ||
      receipt.diagnosticArtifactDigest === undefined
    )
      throw new Error("Archived run has no recoverable final report");
    const diagnostic = await attachments.readByDigest(
      "diagnostic",
      receipt.diagnosticArtifactDigest,
    );
    if (diagnostic.status !== "resolved")
      throw new Error("Archived diagnostic is unavailable");
    report = recoverRootReportFromRollout(diagnostic.bytes.toString("utf8"));
    const recovered = await attachments.put(
      "findings",
      Buffer.from(canonicalJson(report)),
    );
    reportDigest = recovered.digest;
    if (
      !events.some(
        (event) =>
          event.type === "discovery-report-recovered" &&
          event.runId === runId &&
          event.parserVersion === parserVersion,
      )
    ) {
      const appended = await ledger.append({
        schemaVersion: 1,
        campaignId,
        snapshotDigest: started.snapshotDigest,
        occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        identity: `discovery-report-recovered-${runId}-${parserVersion}`,
        type: "discovery-report-recovered",
        runId,
        sourceDiagnosticDigest: receipt.diagnosticArtifactDigest,
        reportArtifactDigest: reportDigest,
        parserVersion,
      });
      if (appended.status === "conflict")
        throw new Error("Archived report recovery conflict");
    }
  }
  const parsed = z
    .object({
      findings: z.array(z.unknown()).default([]),
      leads: z.array(z.unknown()).default([]),
    })
    .parse(report);
  const previous = events.filter(
    (event) =>
      (event.type === "candidate-rejected" ||
        event.type === "candidate-held") &&
      event.runId === runId,
  );
  const previousKeys = new Set(
    previous.map((event) =>
      event.type === "candidate-rejected" || event.type === "candidate-held"
        ? `${event.candidateKind}:${event.candidateIndex}`
        : "",
    ),
  );
  // A sealed report fixes each candidate; a rejected or held candidate must match it byte for byte.
  for (const prior of previous) {
    if (prior.type !== "candidate-rejected" && prior.type !== "candidate-held")
      continue;
    const raw =
      prior.candidateKind === "finding"
        ? parsed.findings[prior.candidateIndex]
        : parsed.leads[prior.candidateIndex];
    if (raw === undefined) continue;
    const rawDigest = await evidence.putFiles({
      "candidate.json": canonicalJson(raw),
    });
    if (
      !prior.artifacts.some(
        (artifact) =>
          artifact.kind === "candidate" && artifact.digest === rawDigest,
      )
    )
      throw new Error("Archived candidate differs from its sealed report");
  }
  const recorded = await recordWordPressReport(parsed, {
    ledger,
    evidence,
    base: {
      schemaVersion: 1,
      campaignId,
      snapshotDigest: started.snapshotDigest,
      occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
    },
    runId,
    trialId: started.trialId ?? runId,
    snapshotDigest: started.snapshotDigest,
    reportArtifactDigest: reportDigest,
    parserVersion,
    existingIdentities: new Set(events.map((event) => event.identity)),
    ...(receipt.reportArtifactDigest === "unavailable"
      ? {}
      : {
          select: (kind: "finding" | "lead", index: number) =>
            previousKeys.has(`${kind}:${index}`),
        }),
  });
  const count = (
    predicate: (candidate: RecordedCandidate) => boolean,
  ): number => recorded.candidates.filter(predicate).length;
  return {
    reached: recorded.candidates.length,
    accepted: count(
      (candidate) =>
        candidate.outcome !== "held" && candidate.status === "appended",
    ),
    held: count(
      (candidate) =>
        candidate.outcome === "held" && candidate.status === "appended",
    ),
    alreadyProcessed: count((candidate) => candidate.status === "existing"),
  };
}
