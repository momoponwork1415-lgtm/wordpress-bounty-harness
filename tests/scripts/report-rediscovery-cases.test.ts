import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../scripts/report-rediscovery-cases.mjs", import.meta.url),
);
let state: string;
let database: DatabaseSync;
let sequence: number;

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "wbh-rediscovery-report-"));
  database = new DatabaseSync(join(state, "ledger.sqlite"));
  database.exec(`CREATE TABLE ledger_events (
    sequence INTEGER PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    event_json TEXT NOT NULL
  )`);
  sequence = 0;
});

afterEach(async () => {
  database.close();
  await rm(state, { recursive: true, force: true });
});

function record(event: Record<string, unknown>, campaignId = "case-a") {
  database
    .prepare("INSERT INTO ledger_events VALUES (?, ?, ?)")
    .run(++sequence, campaignId, JSON.stringify({ campaignId, ...event }));
}

function report(campaignId = "case-a") {
  const stdout = execFileSync(
    process.execPath,
    [script, "--state", state, "--campaign", campaignId],
    { encoding: "utf8" },
  );
  return { stdout, value: JSON.parse(stdout) as Record<string, unknown> };
}

test("reports each stage and counted human opens without leaking private text", () => {
  record({ type: "lab-provisioned", status: "ready" });
  record({
    type: "discovery-run-started",
    runId: "root",
    runKind: "explore",
    history: { mode: "none" },
  });
  record({
    type: "discovery-run-started",
    runId: "child",
    runKind: "child",
    history: { mode: "none" },
  });
  record({
    type: "discovery-run-finished",
    runId: "root",
    outcome: "completed",
    wallTimeMs: 120_000,
    observed: { filesRead: 17, uniqueFilesRead: 9 },
  });
  record({
    type: "discovery-run-finished",
    runId: "child",
    outcome: "completed",
    wallTimeMs: 60_000,
    observed: { filesRead: 6, uniqueFilesRead: 5 },
  });
  record({
    type: "candidate-normalized",
    runId: "root",
    candidateKind: "finding",
    candidateIndex: 0,
  });
  record({
    type: "candidate-held",
    runId: "root",
    candidateKind: "lead",
    candidateIndex: 1,
  });
  record({ type: "finding-recorded", findingId: "f1" });
  record({ type: "lead-recorded", leadId: "l1" });
  record({ type: "verifier-run-finished", findingId: "f1" });
  record({
    type: "verification-finished",
    findingId: "f1",
    result: {
      status: "incomplete",
      reason: "precondition",
      nextStep: "SECRET_PAYLOAD_SENTINEL",
    },
  });
  record({ type: "review-item-opened", findingId: "f1" });
  record({ type: "review-item-opened", findingId: "f1" });
  record({ type: "review-decided", findingId: "f1" });
  record({ type: "review-item-opened", findingId: "another" });
  record({ type: "finding-recorded", findingId: "other-campaign" }, "case-b");

  const { stdout, value } = report();
  expect(value).toMatchObject({
    campaignId: "case-a",
    publicRecordMatch: "unassessed",
    discovery: {
      rootTrials: 1,
      completed: 1,
      outcomes: { completed: 1 },
      historyModes: { none: 1 },
      rootWallMedianMs: 120_000,
      observedFileReads: 17,
      observedUniqueFileReadsByRun: 9,
      allAgentObservedFileReads: 23,
      allAgentObservedUniqueFileReadsByRun: 14,
    },
    candidates: {
      reachedBoundary: 2,
      held: 1,
      findings: 1,
      leads: 1,
      zeroCandidateCoverage: null,
    },
    verification: {
      verifierAttempts: 1,
      attempts: 1,
      latestStatuses: { incomplete: 1 },
      latestIncompleteReasons: { precondition: 1 },
    },
    humanOpenedFindings: 1,
    reviewDecisions: 1,
    fixedVersionControls: { findings: 0, attempts: 0 },
  });
  expect(stdout).not.toContain("SECRET_PAYLOAD_SENTINEL");
  expect(stdout).not.toContain("other-campaign");
});

test("separates fixed-version control and incomplete infrastructure runs", () => {
  record({
    type: "lab-provisioned",
    status: "failed",
    failureStage: "probe",
    reason: "reachability",
  });
  record({
    type: "discovery-run-started",
    runId: "root",
    runKind: "explore",
    history: { mode: "none" },
  });
  record({
    type: "discovery-run-finished",
    runId: "root",
    outcome: "failed",
    reason: "schema",
    reasonDetail: "schema:invalid-report",
    wallTimeMs: 10_000,
  });
  record({ type: "finding-recorded", findingId: "f1" });
  record({
    type: "finding-recorded",
    findingId: "fixed",
    derivationKind: "fixed-version-control",
  });
  record({
    type: "verification-finished",
    findingId: "fixed",
    result: { status: "contradicted" },
  });
  const { value } = report();
  expect(value).toMatchObject({
    discovery: {
      completed: 0,
      failures: { "schema:invalid-report": 1 },
      observedFileReads: null,
      allAgentObservedFileReads: null,
    },
    candidates: { findings: 1, zeroCandidateCoverage: null },
    verification: {
      attempts: 0,
      latestStatuses: { unverified: 1 },
    },
    fixedVersionControls: {
      findings: 1,
      attempts: 1,
      latestStatuses: { contradicted: 1 },
    },
    labFailures: { "probe:reachability": 1 },
  });
});

test("uses child source reads when a case has no candidates", () => {
  record({ type: "discovery-run-started", runId: "root", runKind: "explore" });
  record({ type: "discovery-run-started", runId: "child", runKind: "child" });
  record({
    type: "discovery-run-finished",
    runId: "root",
    outcome: "completed",
    wallTimeMs: 40_000,
    observed: { filesRead: 0, uniqueFilesRead: 0 },
  });
  record({
    type: "discovery-run-finished",
    runId: "child",
    outcome: "completed",
    wallTimeMs: 30_000,
    observed: { filesRead: 6, uniqueFilesRead: 4 },
  });
  const { value } = report();
  expect(value).toMatchObject({
    discovery: { observedFileReads: 0, allAgentObservedFileReads: 6 },
    candidates: { zeroCandidateCoverage: "read-no-candidate" },
  });
});

test("reports measured preflight blocks without exposing artifacts", () => {
  record({
    type: "evaluation-case-blocked",
    caseId: "case-a",
    stage: "lab",
    reason: "external-service-unavailable",
    artifacts: [{ kind: "private-log", digest: "SECRET_ARTIFACT_SENTINEL" }],
  });
  const { stdout, value } = report();
  expect(value).toMatchObject({
    preflightBlocks: [
      {
        caseId: "case-a",
        stage: "lab",
        reason: "external-service-unavailable",
      },
    ],
  });
  expect(stdout).not.toContain("SECRET_ARTIFACT_SENTINEL");
});
