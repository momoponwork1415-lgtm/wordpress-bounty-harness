import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { recoverRootReportFromRollout } from "../../../discovery/codex-native-agent-runtime.js";
import { nativeRunReceiptSchema } from "../../../discovery/native-run-receipts.js";
import type { ProviderAttachmentStore } from "../../../discovery/provider-research-report.js";
import { admitWordPressFinding } from "./finding.js";
import { admitWordPressLead } from "./lead.js";
import { isWordPressProgrammeImpact } from "./programme-impacts.js";
import { classifyWordPressPrecondition } from "../verification/precondition-class.js";
import {
  classifyWordPressCandidate,
  normalizeWordPressCandidate,
} from "./normalize-candidate.js";

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
  const previous = new Set(
    events.flatMap((event) =>
      (event.type === "candidate-rejected" ||
        event.type === "candidate-held") &&
      event.runId === runId
        ? [`${event.candidateKind}:${event.candidateIndex}`]
        : [],
    ),
  );
  const allCandidates = [
    ...parsed.findings.map((raw, index) => ({
      kind: "finding" as const,
      index,
      raw,
    })),
    ...parsed.leads.map((raw, index) => ({
      kind: "lead" as const,
      index,
      raw,
    })),
  ];
  const selected =
    receipt.reportArtifactDigest === "unavailable"
      ? allCandidates
      : allCandidates.filter(({ kind, index }) =>
          previous.has(`${kind}:${index}`),
        );
  const normalizedBefore = new Set(
    events.flatMap((event) =>
      event.type === "candidate-normalized" &&
      event.runId === runId &&
      event.parserVersion === parserVersion
        ? [`${event.candidateKind}:${event.candidateIndex}`]
        : [],
    ),
  );
  const heldBefore = new Set(
    events.flatMap((event) =>
      event.type === "candidate-held" &&
      event.runId === runId &&
      event.parserVersion === parserVersion
        ? [`${event.candidateKind}:${event.candidateIndex}`]
        : [],
    ),
  );
  const recordedFindings = new Set(
    events.flatMap((event) =>
      event.type === "finding-recorded" || event.type === "finding-parked"
        ? [event.findingId]
        : [],
    ),
  );
  const recordedLeads = new Set(
    events.flatMap((event) =>
      event.type === "lead-recorded" ? [event.leadId] : [],
    ),
  );
  let accepted = 0,
    held = 0,
    alreadyProcessed = 0;
  for (const { kind, index, raw } of selected) {
    const rawDigest = await evidence.putFiles({
      "candidate.json": canonicalJson(raw),
    });
    const prior = events.find(
      (event) =>
        (event.type === "candidate-rejected" ||
          event.type === "candidate-held") &&
        event.runId === runId &&
        event.candidateKind === kind &&
        event.candidateIndex === index,
    );
    if (
      prior?.type === "candidate-rejected" ||
      prior?.type === "candidate-held"
    ) {
      if (
        !prior.artifacts.some(
          (artifact) =>
            artifact.kind === "candidate" && artifact.digest === rawDigest,
        )
      )
        throw new Error("Archived candidate differs from its sealed report");
    }
    const normalized = normalizeWordPressCandidate(raw);
    const base = {
      schemaVersion: 1 as const,
      campaignId,
      snapshotDigest: started.snapshotDigest,
      occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
    };
    const key = `${runId}-${kind}-${index}-${parserVersion}`;
    const wasNormalized = normalizedBefore.has(`${kind}:${index}`);
    if (!wasNormalized) {
      const recorded = await ledger.append({
        ...base,
        identity: `candidate-normalized-${key}`,
        type: "candidate-normalized",
        runId,
        candidateKind: kind,
        candidateIndex: index,
        parserVersion,
        changes: normalized.changes,
        artifacts: [{ kind: "candidate", digest: rawDigest }],
      });
      if (recorded.status === "conflict")
        throw new Error("Candidate normalization conflict");
    }
    try {
      if (kind === "finding") {
        const finding = admitWordPressFinding(normalized.value, {
          runId,
          snapshotDigest: started.snapshotDigest,
          reportArtifactDigest: reportDigest,
        });
        if (wasNormalized && recordedFindings.has(finding.findingId)) {
          alreadyProcessed++;
          continue;
        }
        if (!recordedFindings.has(finding.findingId)) {
          const findingDigest = await evidence.putFiles({
            "finding.json": canonicalJson(finding),
          });
          const preconditionClass = classifyWordPressPrecondition({
            configurationPrecondition: finding.configurationPrecondition,
          }).preconditionClass;
          const inScope = isWordPressProgrammeImpact(finding.impact);
          const result =
            inScope && preconditionClass !== "admin-configuration"
              ? await ledger.append({
                  ...base,
                  identity: `discovery-finding-${finding.findingId}`,
                  type: "finding-recorded",
                  runId,
                  findingId: finding.findingId,
                  category: finding.impact,
                  preconditionClass,
                  artifacts: [{ kind: "finding", digest: findingDigest }],
                })
              : await ledger.append({
                  ...base,
                  identity: `discovery-finding-parked-${finding.findingId}`,
                  type: "finding-parked",
                  runId,
                  findingId: finding.findingId,
                  category: finding.impact,
                  reason: inScope
                    ? "admin-configuration-precondition"
                    : "outside-programme-boundary",
                  preconditionClass,
                  artifacts: [{ kind: "finding", digest: findingDigest }],
                });
          if (result.status === "conflict")
            throw new Error("Finding identity conflict");
          recordedFindings.add(finding.findingId);
        }
      } else {
        const lead = admitWordPressLead(normalized.value, {
          runId,
          trialId: started.trialId ?? runId,
          snapshotDigest: started.snapshotDigest,
          reportArtifactDigest: reportDigest,
        });
        if (wasNormalized && recordedLeads.has(lead.leadId)) {
          alreadyProcessed++;
          continue;
        }
        if (!recordedLeads.has(lead.leadId)) {
          const leadDigest = await evidence.putFiles({
            "lead.json": canonicalJson(lead),
          });
          const result = await ledger.append({
            ...base,
            identity: `discovery-lead-${lead.leadId}`,
            type: "lead-recorded",
            runId,
            trialId: started.trialId ?? runId,
            leadId: lead.leadId,
            missingEdge: lead.missingEdge,
            primitive: lead.primitive,
            storageKind: lead.storage?.kind ?? "none",
            artifacts: [{ kind: "lead", digest: leadDigest }],
          });
          if (result.status === "conflict")
            throw new Error("Lead identity conflict");
          recordedLeads.add(lead.leadId);
        }
      }
      accepted++;
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      if (heldBefore.has(`${kind}:${index}`)) {
        alreadyProcessed++;
        continue;
      }
      const result = await ledger.append({
        ...base,
        identity: `candidate-held-${key}`,
        type: "candidate-held",
        runId,
        candidateKind: kind,
        candidateIndex: index,
        parserVersion,
        issuePaths: error.issues.map((issue) => issue.path.join(".")),
        ...classifyWordPressCandidate(normalized.value, kind),
        artifacts: [{ kind: "candidate", digest: rawDigest }],
      });
      if (result.status === "conflict")
        throw new Error("Candidate hold conflict");
      held++;
    }
  }
  return { reached: selected.length, accepted, held, alreadyProcessed };
}
