import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ProviderAttachmentStore,
  recoverChildReportFromRollout,
  rootThreadIdFromRollout,
} from "../dist/discovery/index.js";
import { canonicalJson } from "../dist/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../dist/infrastructure/private-artifact-store.js";
import { Ledger } from "../dist/ledger/index.js";
import { admitWordPressFinding } from "../dist/profiles/wordpress/discovery/finding.js";
import { admitWordPressLead } from "../dist/profiles/wordpress/discovery/lead.js";

const usage =
  "node scripts/recover-child-reports.mjs --campaign <id> --state <private-state-dir> --attachments <private-provider-attachments-dir>";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(usage);
  args.set(key, value);
}
for (const key of ["--campaign", "--state", "--attachments"])
  if (!args.has(key)) throw new Error(usage);
const campaignId = args.get("--campaign");
const stateDirectory = resolve(args.get("--state"));
const attachmentDirectory = resolve(args.get("--attachments"));
const store = new PrivateArtifactStore({
  rootDirectory: join(stateDirectory, "private-evidence"),
  maxEntries: 64,
  maxBytes: 72 * 1024 * 1024,
});
const ledger = new Ledger({
  databasePath: join(stateDirectory, "ledger.sqlite"),
  artifactStore: store,
});
const attachments = new ProviderAttachmentStore(attachmentDirectory);
const events = [];
let afterSequence = 0;
for (;;) {
  const page = ledger.read({ campaignId, afterSequence, limit: 1000 });
  events.push(...page.map(({ event }) => event));
  if (page.length < 1000) break;
  afterSequence = page.at(-1).sequence;
}
const started = new Map(
  events
    .filter((event) => event.type === "discovery-run-started")
    .map((event) => [event.runId, event]),
);
const finished = new Map(
  events
    .filter((event) => event.type === "discovery-run-finished")
    .map((event) => [event.runId, event]),
);
const recoveredEvents = new Map(
  events
    .filter((event) => event.type === "child-report-recovered")
    .map((event) => [event.runId, event]),
);

async function receiptOf(event) {
  const digest = event.artifacts.find(
    (artifact) => artifact.kind === "native-run-receipt",
  )?.digest;
  if (!digest) throw new Error("A finished run has no private receipt");
  const read = await store.readFile(digest, "receipt.json", 64 * 1024);
  if (read.status !== "resolved")
    throw new Error("Private run receipt is unavailable");
  return JSON.parse(read.bytes.toString("utf8"));
}

async function diagnosticOf(digest) {
  const artifactId = `diagnostic-${digest.slice(7)}`;
  const manifest = JSON.parse(
    await readFile(
      join(attachmentDirectory, artifactId, "manifest.json"),
      "utf8",
    ),
  );
  const result = await attachments.read({
    kind: "diagnostic",
    digest,
    artifact: manifest.artifact,
  });
  if (result.status !== "resolved")
    throw new Error("Archived child diagnostic is unavailable");
  return result.bytes.toString("utf8");
}

async function append(event) {
  const result = await ledger.append(event);
  if (result.status === "conflict")
    throw new Error(`Ledger conflict: ${event.identity}`);
}

async function reject(base, runId, kind, index, candidate, reason) {
  const digest = await store.putFiles({
    "candidate.json": canonicalJson(candidate),
  });
  await append({
    ...base,
    identity: `candidate-rejected-${runId}-${kind}-${index}`,
    type: "candidate-rejected",
    runId,
    candidateKind: kind,
    candidateIndex: index,
    reason,
    artifacts: [{ kind: "candidate", digest }],
  });
}

let recovered = 0;
let findings = 0;
let leads = 0;
for (const childFinish of events) {
  if (
    childFinish.type !== "discovery-run-finished" ||
    childFinish.outcome !== "failed" ||
    childFinish.reason !== "schema" ||
    childFinish.reasonDetail !== "child-final-message-not-report"
  )
    continue;
  const childStart = started.get(childFinish.runId);
  if (
    childStart?.type !== "discovery-run-started" ||
    childStart.runKind !== "child" ||
    !childStart.parentRunId ||
    typeof childStart.configuration.agentPath !== "string" ||
    childStart.snapshotDigest !== childFinish.snapshotDigest
  )
    throw new Error(
      "Archived child run is not bound to one Trial and snapshot",
    );
  const rootFinish = finished.get(childStart.parentRunId);
  const rootStart = started.get(childStart.parentRunId);
  if (
    rootFinish?.type !== "discovery-run-finished" ||
    rootStart?.type !== "discovery-run-started" ||
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
    !childReceipt.diagnosticArtifactDigest ||
    !rootReceipt.diagnosticArtifactDigest
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
  const recoveryDigest = await store.putFiles({
    "recovery.json": canonicalJson({
      schemaVersion: 1,
      runId: childStart.runId,
      parentRunId: childStart.parentRunId,
      snapshotDigest: childStart.snapshotDigest,
      sourceDiagnosticDigest: childReceipt.diagnosticArtifactDigest,
      reportArtifactDigest: reportRef.digest,
      parserVersion: "child-coverage-array-v1",
    }),
  });
  const previousRecovery = recoveredEvents.get(childStart.runId);
  if (
    previousRecovery &&
    (previousRecovery.sourceDiagnosticDigest !==
      childReceipt.diagnosticArtifactDigest ||
      previousRecovery.reportArtifactDigest !== reportRef.digest ||
      previousRecovery.parserVersion !== "child-coverage-array-v1")
  )
    throw new Error("Archived recovery provenance changed");
  const base = {
    schemaVersion: 1,
    campaignId,
    snapshotDigest: childStart.snapshotDigest,
    occurredAt: previousRecovery?.occurredAt ?? new Date().toISOString(),
  };
  await append({
    ...base,
    identity: `child-report-recovered-${childStart.runId}-v1`,
    type: "child-report-recovered",
    runId: childStart.runId,
    sourceDiagnosticDigest: childReceipt.diagnosticArtifactDigest,
    reportArtifactDigest: reportRef.digest,
    parserVersion: "child-coverage-array-v1",
    artifacts: [{ kind: "child-report-recovery", digest: recoveryDigest }],
  });
  if (!previousRecovery) recovered++;
  for (const [index, candidate] of report.findings.entries()) {
    let finding;
    try {
      finding = admitWordPressFinding(candidate, {
        runId: childStart.runId,
        snapshotDigest: childStart.snapshotDigest,
        reportArtifactDigest: reportRef.digest,
      });
    } catch {
      await reject(
        base,
        childStart.runId,
        "finding",
        index,
        candidate,
        "schema",
      );
      continue;
    }
    const digest = await store.putFiles({
      "finding.json": canonicalJson(finding),
    });
    const event = {
      ...base,
      identity: `discovery-finding-${finding.findingId}`,
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: childStart.runId,
      category: finding.impact,
      ...(finding.historyRecordId === undefined
        ? {}
        : { historyRecordId: finding.historyRecordId }),
      artifacts: [{ kind: "finding", digest }],
    };
    const status = await ledger.append(event);
    if (status.status === "conflict") {
      await reject(
        base,
        childStart.runId,
        "finding",
        index,
        candidate,
        "identity",
      );
      continue;
    }
    if (status.status === "appended") findings++;
  }
  for (const [index, candidate] of report.leads.entries()) {
    let lead;
    try {
      lead = admitWordPressLead(candidate, {
        runId: childStart.runId,
        trialId: childStart.trialId,
        snapshotDigest: childStart.snapshotDigest,
        reportArtifactDigest: reportRef.digest,
      });
    } catch {
      await reject(base, childStart.runId, "lead", index, candidate, "schema");
      continue;
    }
    const digest = await store.putFiles({ "lead.json": canonicalJson(lead) });
    const status = await ledger.append({
      ...base,
      identity: `discovery-lead-${lead.leadId}`,
      type: "lead-recorded",
      leadId: lead.leadId,
      runId: childStart.runId,
      trialId: childStart.trialId,
      missingEdge: lead.missingEdge,
      primitive: lead.primitive,
      storageKind: lead.storage?.kind ?? "none",
      artifacts: [{ kind: "lead", digest }],
    });
    if (status.status === "conflict") {
      await reject(
        base,
        childStart.runId,
        "lead",
        index,
        candidate,
        "identity",
      );
      continue;
    }
    if (status.status === "appended") leads++;
  }
}
console.log(
  `Recovered ${recovered} child reports, ${findings} findings, ${leads} leads into the append-only ledger.`,
);
