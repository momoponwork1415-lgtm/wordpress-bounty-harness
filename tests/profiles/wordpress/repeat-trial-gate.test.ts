import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

function completeCoverage(inventory: object, stateA: string) {
  return {
    schemaVersion: 1,
    stateInventoryDigest: canonicalDigest({ inventory, directories: [stateA] }),
    auditDigest: hash("9"),
    auditedBy: "independent-operator",
    approvedBy: "owner",
    cutoffAt: "2026-10-13T00:00:00.000Z",
    auditedAt: "2026-10-14T00:00:00.000Z",
    approvedAt: "2026-10-14T01:00:00.000Z",
    legacyWritersStoppedAt: "2026-10-12T23:00:00.000Z",
    sourceFreezeEvidenceDigest: hash("6"),
    sources: [
      "state-ledgers",
      "legacy-research-databases",
      "legacy-queues",
      "archives",
    ].map((sourceClass) => ({
      sourceClass,
      rosterDigest: hash("1"),
      contentDigest: hash("2"),
      evidenceDigest: hash("3"),
      sourceCount: 1,
      complete: true,
      unknownSlugStarts: 0,
    })),
    legacyStarts: [
      {
        slug: "old-plugin",
        minimumStartedTrials: 1,
        evidenceDigest: hash("4"),
      },
    ],
    heldSlugs: [{ slug: "uncertain-plugin", evidenceDigest: hash("5") }],
  };
}

async function writeStartedTrial(
  stateDirectory: string,
  start: RepeatTrialStart,
): Promise<void> {
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateDirectory, "private-evidence"),
    maxEntries: 8,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(stateDirectory, "ledger.sqlite"),
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
    selectionId: `wporg:${start.slug}@1.0.0`,
  });
  await ledger.append({
    ...base,
    type: "discovery-run-started",
    identity: "started-first",
    runId: "run-first",
    labId: "lab-one",
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v3",
      promptDigest: start.promptDigest,
      assignmentUnit: "plugin",
    },
  });
}

it("reports only proven prior starts and explicit legacy holds without declaring an unseen slug eligible", async () => {
  const { gate, stateA, start, inventory } = await fixture();
  const ambiguity = {
    schemaVersion: 1,
    auditDigest: hash("f"),
    ambiguousSlugs: ["uncertain-plugin"],
  };
  expect(gate.inspectInitialSlug(start.slug)).toEqual({
    status: "coverage-incomplete",
    reason: "state-inventory-uninitialized",
  });
  await writeStartedTrial(stateA, start);
  gate.bootstrap(inventory);
  expect(gate.inspectInitialSlug(start.slug, ambiguity)).toEqual({
    status: "prior-start",
    startedTrials: 1,
  });
  expect(gate.inspectInitialSlug("uncertain-plugin", ambiguity)).toEqual({
    status: "hold-ambiguous",
    auditDigest: ambiguity.auditDigest,
  });
  expect(gate.inspectInitialSlug("selection-only", ambiguity)).toEqual({
    status: "coverage-incomplete",
    reason: "legacy-history-unverified",
  });
  expect(() =>
    gate.assertMayStart({
      ...start,
      slug: "selection-only",
      campaignId: "selection-only-campaign",
    }),
  ).toThrow("historical coverage");
  expect(() => gate.inspectInitialSlug("../bad-slug", ambiguity)).toThrow();
  expect(() =>
    gate.inspectInitialSlug("uncertain-plugin", {
      ...ambiguity,
      auditDigest: "not-a-digest",
    }),
  ).toThrow();
});

it("holds new initial Trials while legacy coverage is unverified and gates known slugs across versions and prompts", async () => {
  const { gate, stateA, stateB, start, inventory, approve } = await fixture();
  expect(() => gate.reserve(start)).toThrow("uninitialized");
  await writeStartedTrial(stateA, start);
  expect(gate.bootstrap(inventory).importedTrials).toBe(1);
  expect(() => approve(start)).toThrow("already started");
  expect(gate.reserve(start)).toBeUndefined(); // imported exact Trial resumes

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
  ).toThrow("historical coverage");
});

it("checks each ordinal even within one campaign and consumes each approval once", async () => {
  const { gate, stateA, start, inventory, approve } = await fixture();
  await writeStartedTrial(stateA, start);
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
  const { gate, stateA, stateB, start, inventory, approve } = await fixture();
  await writeStartedTrial(stateA, start);
  gate.bootstrap(inventory);
  const otherState = {
    ...start,
    stateDirectory: stateB,
    campaignId: "next-campaign",
  };
  approve(otherState);
  gate.assertMayStart(otherState); // Lab can still fail; approval remains unspent.
  gate.reserve(otherState);
  expect(() => gate.reserve({ ...otherState, campaignId: "third" })).toThrow(
    "human approval",
  );
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

it("holds an unseen slug from both independent gate connections", async () => {
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
  expect(outcomes).toEqual(["blocked", "blocked"]);
});

it("imports a complete audited cut atomically and separates old slug starts from exact resumes", async () => {
  const { gate, stateA, start, inventory, approve } = await fixture();
  gate.bootstrap(inventory);
  const manifest = completeCoverage(inventory, stateA);
  const coverageDigest = gate.importCoverage(manifest);
  expect(coverageDigest).toBe(canonicalDigest(manifest));
  expect(gate.inspectInitialSlug("fresh-plugin")).toEqual({
    status: "eligible",
    coverageDigest,
  });
  expect(gate.inspectInitialSlug("old-plugin")).toEqual({
    status: "prior-start",
    startedTrials: 1,
  });
  expect(gate.inspectInitialSlug("uncertain-plugin")).toEqual({
    status: "hold-ambiguous",
    auditDigest: hash("9"),
  });
  expect(() => gate.reserve({ ...start, slug: "old-plugin" })).toThrow(
    "human approval",
  );
  expect(() => approve({ ...start, slug: "old-plugin" })).not.toThrow();
  expect(gate.reserve({ ...start, slug: "old-plugin" })).toBeDefined();
  expect(() =>
    gate.reserve({
      ...start,
      slug: "uncertain-plugin",
      campaignId: "uncertain-campaign",
    }),
  ).toThrow("historical coverage");
  expect(
    gate.reserve({
      ...start,
      slug: "fresh-plugin",
      campaignId: "fresh-campaign",
    }),
  ).toBeUndefined();
  expect(() =>
    gate.reserve({ ...start, slug: "fresh-plugin", campaignId: "another" }),
  ).toThrow("human approval");
});

it("serializes two connections on the same initially eligible slug", async () => {
  const { gate, gatePath, stateA, start, inventory } = await fixture();
  gate.bootstrap(inventory);
  gate.importCoverage(completeCoverage(inventory, stateA));
  const secondProcess = new SqliteRepeatTrialGate(gatePath);
  const first = { ...start, slug: "fresh-plugin" };
  const second = { ...first, campaignId: "another-campaign" };
  expect(gate.reserve(first)).toBeUndefined();
  expect(() => secondProcess.reserve(second)).toThrow("human approval");
  expect(secondProcess.reserve(first)).toBeUndefined();
});

it("rejects partial, conflicting, or stale coverage without releasing initial Trials", async () => {
  const { gate, stateA, stateB, start, inventory } = await fixture();
  const manifest = completeCoverage(inventory, stateA);
  expect(() => gate.importCoverage(manifest)).toThrow("bootstrapped");
  gate.bootstrap(inventory);
  expect(() =>
    gate.importCoverage({ ...manifest, sources: manifest.sources.slice(1) }),
  ).toThrow();
  expect(() =>
    gate.importCoverage({
      ...manifest,
      sources: manifest.sources.map((source, index) =>
        index === 1 ? { ...source, sourceClass: "state-ledgers" } : source,
      ),
    }),
  ).toThrow("one complete cut");
  expect(() =>
    gate.importCoverage({
      ...manifest,
      sources: manifest.sources.map((source, index) =>
        index === 1 ? { ...source, unknownSlugStarts: 1 } : source,
      ),
    }),
  ).toThrow();
  expect(() =>
    gate.importCoverage({ ...manifest, stateInventoryDigest: hash("8") }),
  ).toThrow("different state inventory");
  expect(() =>
    gate.importCoverage({ ...manifest, auditedAt: "2026-10-12T00:00:00.000Z" }),
  ).toThrow("predates");
  expect(() =>
    gate.importCoverage({
      ...manifest,
      legacyWritersStoppedAt: "2026-10-13T01:00:00.000Z",
    }),
  ).toThrow("not frozen");
  expect(() =>
    gate.importCoverage({
      ...manifest,
      approvedAt: "2026-10-13T23:00:00.000Z",
    }),
  ).toThrow("approval predates");
  expect(() =>
    gate.importCoverage({ ...manifest, approvedBy: undefined }),
  ).toThrow();
  expect(() =>
    gate.importCoverage({
      ...manifest,
      heldSlugs: [{ slug: "old-plugin", evidenceDigest: hash("5") }],
    }),
  ).toThrow("repeats a slug");
  expect(gate.inspectInitialSlug("fresh-plugin")).toEqual({
    status: "coverage-incomplete",
    reason: "legacy-history-unverified",
  });
  expect(() => gate.reserve({ ...start, slug: "fresh-plugin" })).toThrow(
    "historical coverage",
  );

  gate.importCoverage(manifest);
  expect(() => gate.importCoverage(manifest)).toThrow("already been imported");
  await writeStartedTrial(stateB, {
    ...start,
    stateDirectory: stateB,
    slug: "omitted-plugin",
  });
  expect(() => gate.ensureReady(stateB)).toThrow("new legacy coverage audit");
  expect(gate.inspectInitialSlug("omitted-plugin")).toEqual({
    status: "prior-start",
    startedTrials: 1,
  });
  expect(() =>
    gate.reserve({
      ...start,
      slug: "omitted-plugin",
      campaignId: "new-campaign",
    }),
  ).toThrow("human approval");
  expect(gate.inspectInitialSlug("unrelated-fresh-plugin")).toEqual({
    status: "coverage-incomplete",
    reason: "coverage-invalidated",
  });
  expect(() =>
    gate.reserve({ ...start, slug: "unrelated-fresh-plugin" }),
  ).toThrow("historical coverage");
});

it("keeps a legitimately new empty state usable after coverage", async () => {
  const { gate, stateA, stateB, inventory } = await fixture();
  gate.bootstrap(inventory);
  const coverageDigest = gate.importCoverage(
    completeCoverage(inventory, stateA),
  );
  expect(() => gate.ensureReady(stateB)).not.toThrow();
  expect(gate.inspectInitialSlug("new-plugin")).toEqual({
    status: "eligible",
    coverageDigest,
  });
});

it("durably invalidates coverage for an unregistered missing ledger", async () => {
  const { gate, gatePath, stateA, stateB, start, inventory } = await fixture();
  gate.bootstrap(inventory);
  gate.importCoverage(completeCoverage(inventory, stateA));
  await writeFile(join(stateB, "stale-marker"), "metadata-only");
  expect(() => gate.ensureReady(stateB)).toThrow("missing-ledger");
  const secondProcess = new SqliteRepeatTrialGate(gatePath);
  expect(secondProcess.inspectInitialSlug("new-plugin")).toEqual({
    status: "coverage-incomplete",
    reason: "coverage-invalidated",
  });
  expect(() => secondProcess.reserve({ ...start, slug: "new-plugin" })).toThrow(
    "historical coverage",
  );
});

it("invalidates coverage when an unregistered ledger cannot be parsed", async () => {
  const { gate, gatePath, stateA, stateB, inventory } = await fixture();
  gate.bootstrap(inventory);
  gate.importCoverage(completeCoverage(inventory, stateA));
  await writeFile(join(stateB, "ledger.sqlite"), "not a sqlite database");
  expect(() => gate.ensureReady(stateB)).toThrow(
    "unreadable-or-malformed-ledger",
  );
  expect(
    new SqliteRepeatTrialGate(gatePath).inspectInitialSlug("new-plugin"),
  ).toEqual({
    status: "coverage-incomplete",
    reason: "coverage-invalidated",
  });
});

it("invalidates coverage when a started Trial has no uniquely mapped slug", async () => {
  const { gate, stateA, stateB, inventory } = await fixture();
  gate.bootstrap(inventory);
  gate.importCoverage(completeCoverage(inventory, stateA));
  const ledger = new Ledger({
    databasePath: join(stateB, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(stateB, "private-evidence"),
      maxEntries: 8,
      maxBytes: 1024 * 1024,
    }),
  });
  await ledger.append({
    schemaVersion: 1,
    campaignId: "unmapped-campaign",
    snapshotDigest: hash("a"),
    occurredAt,
    type: "discovery-run-started",
    identity: "unmapped-start",
    runId: "run-unmapped",
    labId: "lab-one",
    history: { mode: "none" },
    configuration: {
      promptVariant: "wp2shell-bounty-v3",
      assignmentUnit: "plugin",
    },
  });
  expect(() => gate.ensureReady(stateB)).toThrow(
    "unreadable-or-malformed-ledger",
  );
  expect(gate.inspectInitialSlug("new-plugin")).toEqual({
    status: "coverage-incomplete",
    reason: "coverage-invalidated",
  });
});
