import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import { recordWordPressReport } from "../../../src/profiles/wordpress/discovery/candidate-admission.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const reportDigest = `sha256:${"b".repeat(64)}`;
const now = "2026-11-04T00:00:00Z";
const campaignId = "audit-gate-test";
const trialId = "trial-1";
const rootId = "root-1";
const childId = "child-1";
const checkerId = "child-2";
const claim = {
  claim: "Synthetic stored script route",
  attackerPosition: "subscriber",
  impact: "stored-xss",
  configurationPrecondition: "ordinary feature use",
  brokenProperty: "Output encoding",
  sourceTrace: [{ file: "plugin.php", function: "render", line: 12 }],
  existingControls: "No output encoding on the cited path",
  labObservations: "A bounded Lab question was observed",
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wbh-audit-gate-"));
  directories.push(directory);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(directory, "evidence"),
    maxEntries: 100,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId,
    snapshotDigest,
    occurredAt: now,
  };
  await ledger.append({
    ...base,
    identity: "root-start",
    type: "discovery-run-started",
    runId: rootId,
    trialId,
    runKind: "explore",
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v24-wide",
      admissionContract: "checked/v1",
    },
  });
  await ledger.append({
    ...base,
    identity: "child-start",
    type: "discovery-run-started",
    runId: childId,
    trialId,
    runKind: "child",
    parentRunId: rootId,
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v24-wide",
      admissionContract: "checked/v1",
    },
  });
  const context = (runId: string, runKind: "root" | "child") => ({
    ledger,
    evidence,
    base,
    runId,
    runKind,
    trialId,
    snapshotDigest,
    reportArtifactDigest: reportDigest,
    admissionContract: "checked/v1" as const,
  });
  const events = () => ledger.readAll({ campaignId }).map(({ event }) => event);
  return { ledger, evidence, base, context, events };
}

async function finishChild(
  f: Awaited<ReturnType<typeof fixture>>,
  outcome: "completed" | "failed",
  runId = childId,
) {
  await f.ledger.append({
    ...f.base,
    identity: `child-finish-${runId}`,
    type: "discovery-run-finished",
    runId,
    outcome,
    costUsd: "unavailable",
    wallTimeMs: 1,
  });
}

it("requires a completed checker child other than a known child discoverer", async () => {
  const f = await fixture();
  await recordWordPressReport(
    {
      findings: [claim],
      leads: [],
      checks: [
        {
          kind: "finding",
          candidate: claim,
          verdict: "verified",
          explanation:
            "Reopened plugin.php:12 and compared the Lab observation",
        },
      ],
    },
    f.context(childId, "child"),
  );
  expect(
    f.events().filter((event) => event.type === "finding-recorded"),
  ).toHaveLength(0);
  expect(
    f.events().filter((event) => event.type === "audit-candidate-pending"),
  ).toHaveLength(1);
  expect(f.ledger.funnel(campaignId).auditPending).toBe(1);
  await finishChild(f, "completed");
  const rootReport = { findings: [claim], leads: [] };
  const selfChecked = await recordWordPressReport(
    rootReport,
    f.context(rootId, "root"),
  );
  expect(selfChecked.candidates[0]?.outcome).toBe("pending");
  await f.ledger.append({
    ...f.base,
    identity: "checker-start",
    type: "discovery-run-started",
    runId: checkerId,
    trialId,
    runKind: "child",
    parentRunId: rootId,
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v24-wide",
      admissionContract: "checked/v1",
    },
  });
  await recordWordPressReport(
    {
      findings: [],
      leads: [],
      checks: [
        {
          kind: "finding",
          candidate: claim,
          verdict: "verified",
          explanation:
            "Independent check of the original source and Lab question",
        },
      ],
    },
    f.context(checkerId, "child"),
  );
  await finishChild(f, "completed", checkerId);
  const result = await recordWordPressReport(
    rootReport,
    f.context(rootId, "root"),
  );
  expect(result.candidates[0]?.outcome).toBe("recorded");
  const recorded = f
    .events()
    .filter((event) => event.type === "finding-recorded");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    runId: rootId,
    auditCheck: { runId: checkerId, checkIndex: 0 },
  });
  expect(f.ledger.funnel(campaignId).auditPending).toBe(0);
});

it.each([
  ["blocked", "completed"],
  ["verified", "failed"],
] as const)(
  "keeps a Root claim pending for a %s check on a %s child",
  async (verdict, outcome) => {
    const f = await fixture();
    await recordWordPressReport(
      {
        findings: [],
        leads: [],
        checks: [
          {
            kind: "finding",
            candidate: claim,
            verdict,
            explanation: "The source or Lab evidence remains unresolved",
          },
        ],
      },
      f.context(childId, "child"),
    );
    await finishChild(f, outcome);
    const result = await recordWordPressReport(
      { findings: [claim], leads: [] },
      f.context(rootId, "root"),
    );
    expect(result.candidates[0]?.outcome).toBe("pending");
    expect(
      f.events().filter((event) => event.type === "finding-recorded"),
    ).toHaveLength(0);
    expect(
      f.events().filter((event) => event.type === "audit-candidate-pending"),
    ).toHaveLength(1);
  },
);

it("does not accept a Root-authored check as an independent child check", async () => {
  const f = await fixture();
  const result = await recordWordPressReport(
    {
      findings: [claim],
      leads: [],
      checks: [
        {
          kind: "finding",
          candidate: claim,
          verdict: "verified",
          explanation: "Root self-check",
        },
      ],
    },
    f.context(rootId, "root"),
  );
  expect(result.candidates[0]?.outcome).toBe("pending");
  expect(
    f.events().filter((event) => event.type === "audit-check-held"),
  ).toHaveLength(1);
});

it("keeps the claim pending when a later child check refutes it", async () => {
  const f = await fixture();
  await recordWordPressReport(
    {
      findings: [],
      leads: [],
      checks: [
        {
          kind: "finding",
          candidate: claim,
          verdict: "verified",
          explanation: "Initial source read",
        },
        {
          kind: "finding",
          candidate: claim,
          verdict: "refuted",
          explanation: "A later guard defeats the route",
        },
      ],
    },
    f.context(childId, "child"),
  );
  await finishChild(f, "completed");
  const result = await recordWordPressReport(
    { findings: [claim], leads: [] },
    f.context(rootId, "root"),
  );
  expect(result.candidates[0]?.outcome).toBe("pending");
  expect(
    f.events().filter((event) => event.type === "finding-recorded"),
  ).toHaveLength(0);
});

it("removes a Root candidate from the pending projection after a later check", async () => {
  const f = await fixture();
  const rootReport = { findings: [claim], leads: [] };
  const first = await recordWordPressReport(
    rootReport,
    f.context(rootId, "root"),
  );
  expect(first.candidates[0]?.outcome).toBe("pending");
  expect(f.ledger.funnel(campaignId).auditPending).toBe(1);
  await recordWordPressReport(
    {
      findings: [],
      leads: [],
      checks: [
        {
          kind: "finding",
          candidate: claim,
          verdict: "verified",
          explanation: "Rechecked current source and Lab evidence",
        },
      ],
    },
    f.context(childId, "child"),
  );
  await finishChild(f, "completed");
  const second = await recordWordPressReport(
    rootReport,
    f.context(rootId, "root"),
  );
  expect(second.candidates[0]?.outcome).toBe("recorded");
  expect(f.ledger.funnel(campaignId).auditPending).toBe(0);
  expect(
    f.events().filter((event) => event.type === "audit-candidate-promoted"),
  ).toHaveLength(1);
});
