import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  SqliteRepeatTrialGate,
  type RepeatTrialStart,
} from "../../../src/profiles/wordpress/discovery/repeat-trial-gate.js";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const occurredAt = "2026-10-13T00:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repeat-trial-gate-"));
  roots.push(root);
  const stateA = join(root, "state-a");
  const stateB = join(root, "state-b");
  await Promise.all([mkdir(stateA), mkdir(stateB)]);
  const gatePath = join(root, "shared", "repeat-trials.sqlite");
  const gate = new SqliteRepeatTrialGate(gatePath);
  const start: RepeatTrialStart = {
    stateDirectory: stateA,
    slug: "first-plugin",
    snapshotDigest: hash("a"),
    promptDigest: hash("b"),
    campaignId: "campaign-a",
    trialOrdinal: 0,
  };
  const inventory = {
    schemaVersion: 1,
    stateDirectories: [stateA],
    inventoriedBy: "operator",
    inventoriedAt: occurredAt,
  };
  const approve = (trial: RepeatTrialStart) => {
    const approval = {
      schemaVersion: 1,
      ...trial,
      approvedBy: "operator",
      approvedAt: occurredAt,
      purpose: "Review of the prior Trial authorized this one attempt",
    };
    gate.approve(approval);
    return canonicalDigest(approval);
  };
  return { gate, gatePath, stateA, stateB, start, inventory, approve };
}

it("fails closed before explicit inventory and gates the same slug across states, versions and prompts", async () => {
  const { gate, stateB, start, inventory, approve } = await fixture();
  expect(() => gate.reserve(start)).toThrow("uninitialized");
  expect(gate.bootstrap(inventory).importedTrials).toBe(0);
  expect(() => approve({ ...start, trialOrdinal: 1 })).toThrow(
    "before the first",
  );
  gate.assertMayStart(start);
  gate.reserve(start);

  const repeat = {
    ...start,
    stateDirectory: stateB,
    snapshotDigest: hash("c"),
    promptDigest: hash("d"),
    campaignId: "campaign-b",
  };
  expect(() => gate.assertMayStart(repeat)).toThrow("human approval");
  const approvalDigest = approve(repeat);
  expect(gate.reserve(repeat)).toBe(approvalDigest);
  expect(gate.reserve(repeat)).toBe(approvalDigest); // exact started Trial resume

  expect(() => gate.reserve({ ...repeat, promptDigest: hash("e") })).toThrow(
    "differs from its prior start",
  );
  expect(() => gate.reserve({ ...repeat, campaignId: "campaign-c" })).toThrow(
    "human approval",
  );
  expect(() =>
    gate.reserve({
      ...repeat,
      slug: "second-plugin",
      campaignId: "campaign-c",
    }),
  ).not.toThrow(); // a different plugin's first Trial stays autonomous
});

it("checks each ordinal even within one campaign and consumes each approval once", async () => {
  const { gate, start, inventory, approve } = await fixture();
  gate.bootstrap(inventory);
  gate.reserve(start);
  const second = { ...start, trialOrdinal: 1 };
  expect(() => gate.reserve(second)).toThrow("human approval");
  approve(second);
  gate.reserve(second);
  expect(() => gate.reserve({ ...start, trialOrdinal: 2 })).toThrow(
    "human approval",
  );
  expect(() => approve(second)).toThrow("already started");
});

it("does not spend a Trial during preflight or a Lab failure before start", async () => {
  const { gate, stateB, start, inventory } = await fixture();
  gate.bootstrap(inventory);
  gate.assertMayStart(start); // Lab can still fail; no reservation exists yet.
  const otherState = { ...start, stateDirectory: stateB };
  gate.reserve(otherState);
  expect(() => gate.reserve(start)).toThrow("human approval");
});

it("imports prior started Trials with stable resume keys and rejects missing slug mappings", async () => {
  const { gate, stateA, stateB, start, inventory } = await fixture();
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateA, "private-evidence"),
    maxEntries: 8,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(stateA, "ledger.sqlite"),
    artifactStore: store,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: start.campaignId,
    snapshotDigest: start.snapshotDigest,
    occurredAt,
  };
  await ledger.append({
    ...base,
    type: "target-selected",
    identity: "selected-first",
    selectionId: "wporg:first-plugin@1.0.0",
  });
  for (const ordinal of [0, 1])
    await ledger.append({
      ...base,
      type: "discovery-run-started",
      identity: `started-${ordinal}`,
      runId: `run-${ordinal}`,
      labId: "lab-one",
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v3",
        promptDigest: start.promptDigest,
        assignmentUnit: "plugin",
      },
    });
  expect(gate.bootstrap(inventory).importedTrials).toBe(2);
  expect(() => gate.reserve(start)).not.toThrow(); // imported ordinal zero
  expect(() => gate.reserve({ ...start, trialOrdinal: 1 })).not.toThrow();
  expect(() => gate.reserve({ ...start, trialOrdinal: 2 })).toThrow(
    "human approval",
  );

  const missingStore = new PrivateArtifactStore({
    rootDirectory: join(stateB, "private-evidence"),
    maxEntries: 8,
    maxBytes: 1024 * 1024,
  });
  const missing = new Ledger({
    databasePath: join(stateB, "ledger.sqlite"),
    artifactStore: missingStore,
  });
  await missing.append({
    ...base,
    type: "discovery-run-started",
    identity: "unmapped-start",
    runId: "unmapped-run",
    labId: "lab-one",
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v3",
      assignmentUnit: "plugin",
    },
  });
  expect(() => gate.ensureReady(stateB)).toThrow("cannot identify");
});

it("serializes independent gate connections so only one unapproved first start wins", async () => {
  const { gate, gatePath, stateB, start, inventory } = await fixture();
  gate.bootstrap(inventory);
  const secondProcess = new SqliteRepeatTrialGate(gatePath);
  const otherState = { ...start, stateDirectory: stateB, campaignId: "other" };
  const outcomes = [
    () => gate.reserve(start),
    () => secondProcess.reserve(otherState),
  ].map((run) => {
    try {
      run();
      return "started";
    } catch {
      return "blocked";
    }
  });
  expect(outcomes).toEqual(["started", "blocked"]);
});
