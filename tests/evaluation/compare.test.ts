import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Evaluation } from "../../src/evaluation/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { wordpressFindingLocations } from "../../src/profiles/wordpress/answer-key.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type SyntheticRun = {
  readonly campaignId: string;
  readonly snapshot: string;
  readonly arm: "a" | "b";
  /** Verification status of the run's single Finding, or no Finding. */
  readonly finding?: "runtime-confirmed" | "contradicted";
  readonly costUsd?: number;
  readonly setupFailed?: boolean;
  readonly providerLimited?: boolean;
};

async function ledgerWith(runs: readonly SyntheticRun[]) {
  const root = await mkdtemp(join(tmpdir(), "wbh-compare-"));
  directories.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const proof = await store.putFiles({ "proof.txt": "synthetic canary" });
  const selected = new Set<string>();
  for (const [index, run] of runs.entries()) {
    const base = {
      schemaVersion: 1 as const,
      campaignId: run.campaignId,
      snapshotDigest: run.snapshot,
      occurredAt: "2026-10-08T00:00:00Z",
    };
    if (!selected.has(`${run.campaignId}:${run.snapshot}`)) {
      selected.add(`${run.campaignId}:${run.snapshot}`);
      await ledger.append({
        ...base,
        identity: `selected-${run.campaignId}-${run.snapshot}`,
        type: "target-selected",
        selectionId: `wporg:plugin-${run.snapshot.slice(7, 8)}@1.0.0`,
      });
    }
    const runId = `run-${index}`;
    await ledger.append({
      ...base,
      identity: `start-${runId}`,
      type: "discovery-run-started",
      runId,
      labId: "lab-1",
      history: { mode: "none" },
      configuration: {
        promptVariant: "short-objective-v1",
        assignmentUnit: "plugin",
        axis: "history",
        arm: run.arm,
      },
    });
    await ledger.append({
      ...base,
      identity: `finish-${runId}`,
      type: "discovery-run-finished",
      runId,
      outcome:
        run.setupFailed === true
          ? "setup-failed"
          : run.providerLimited === true
            ? "provider-limited"
            : "completed",
      costUsd: run.costUsd ?? "unavailable",
      wallTimeMs: 1000,
    });
    if (run.finding === undefined) continue;
    const findingId = `finding-${index}`;
    await ledger.append({
      ...base,
      identity: `finding-${index}`,
      type: "finding-recorded",
      findingId,
      runId,
      category: "account-takeover",
    });
    await ledger.append({
      ...base,
      identity: `verification-${index}`,
      type: "verification-finished",
      verificationId: `verification-${index}`,
      findingId,
      labSetupDigest: digest("c"),
      result:
        run.finding === "runtime-confirmed"
          ? {
              status: "runtime-confirmed",
              judgeId: "synthetic-judge",
              proofKind: "nonce-canary",
              conditions: {},
              evidenceDigest: proof,
              reproductionPackageDigest: proof,
            }
          : {
              status: "contradicted",
              judgeId: "synthetic-judge",
              evidenceDigest: proof,
            },
    });
  }
  return new Evaluation({
    ledger,
    store,
    locationsOf: wordpressFindingLocations,
  });
}

describe("evaluation compare", () => {
  it("pools only targets with both arms and counts runs with a confirmed Finding as hits", async () => {
    const [one, two, three] = [digest("1"), digest("2"), digest("3")];
    const evaluation = await ledgerWith([
      {
        campaignId: "campaign-1",
        snapshot: one,
        arm: "a",
        finding: "runtime-confirmed",
        costUsd: 1,
      },
      { campaignId: "campaign-1", snapshot: one, arm: "a" },
      {
        campaignId: "campaign-1",
        snapshot: one,
        arm: "b",
        finding: "contradicted",
        costUsd: 2,
      },
      {
        campaignId: "campaign-1",
        snapshot: one,
        arm: "b",
        setupFailed: true,
        costUsd: 9,
      },
      // A run the subscription refused is not a discovery attempt either.
      {
        campaignId: "campaign-1",
        snapshot: one,
        arm: "b",
        providerLimited: true,
      },
      { campaignId: "campaign-2", snapshot: two, arm: "a", costUsd: 0.5 },
      {
        campaignId: "campaign-2",
        snapshot: two,
        arm: "b",
        finding: "runtime-confirmed",
        costUsd: 1.5,
      },
      { campaignId: "campaign-2", snapshot: two, arm: "b", costUsd: 0.5 },
      {
        campaignId: "campaign-3",
        snapshot: three,
        arm: "a",
        finding: "runtime-confirmed",
        costUsd: 1,
      },
    ]);
    const comparison = evaluation.compare({ axis: "history" });
    expect(comparison.targets).toEqual([
      {
        snapshotDigest: one,
        selectionId: "wporg:plugin-1@1.0.0",
        paired: true,
        arms: {
          a: {
            runs: 2,
            hits: 1,
            findings: 1,
            knownCostUsd: 1,
            unpricedRuns: 1,
          },
          b: {
            runs: 1,
            hits: 0,
            findings: 1,
            knownCostUsd: 2,
            unpricedRuns: 0,
          },
        },
      },
      {
        snapshotDigest: two,
        selectionId: "wporg:plugin-2@1.0.0",
        paired: true,
        arms: {
          a: {
            runs: 1,
            hits: 0,
            findings: 0,
            knownCostUsd: 0.5,
            unpricedRuns: 0,
          },
          b: {
            runs: 2,
            hits: 1,
            findings: 1,
            knownCostUsd: 2,
            unpricedRuns: 0,
          },
        },
      },
      {
        snapshotDigest: three,
        selectionId: "wporg:plugin-3@1.0.0",
        paired: false,
        arms: {
          a: {
            runs: 1,
            hits: 1,
            findings: 1,
            knownCostUsd: 1,
            unpricedRuns: 0,
          },
          b: {
            runs: 0,
            hits: 0,
            findings: 0,
            knownCostUsd: 0,
            unpricedRuns: 0,
          },
        },
      },
    ]);
    expect(comparison.pooled.a).toMatchObject({
      runs: 3,
      hits: 1,
      knownCostUsd: 1.5,
      unpricedRuns: 1,
    });
    expect(comparison.pooled.b).toMatchObject({
      runs: 3,
      hits: 1,
      knownCostUsd: 4,
    });
    expect(comparison.pooled.a.interval.lower).toBeCloseTo(0.0084, 4);
    expect(comparison.pooled.a.interval.upper).toBeCloseTo(0.9057, 4);
    expect(comparison.verdict).toBe("inconclusive");
  });

  it("names the higher arm only when the Clopper-Pearson intervals do not overlap", async () => {
    const snapshot = digest("4");
    const evaluation = await ledgerWith([
      ...Array.from({ length: 10 }, () => ({
        campaignId: "campaign-1",
        snapshot,
        arm: "a" as const,
      })),
      ...Array.from({ length: 10 }, () => ({
        campaignId: "campaign-1",
        snapshot,
        arm: "b" as const,
        finding: "runtime-confirmed" as const,
      })),
    ]);
    const comparison = evaluation.compare({ axis: "history" });
    expect(comparison.pooled.a.interval.lower).toBe(0);
    expect(comparison.pooled.a.interval.upper).toBeCloseTo(0.3085, 4);
    expect(comparison.pooled.b.interval.lower).toBeCloseTo(0.6915, 4);
    expect(comparison.pooled.b.interval.upper).toBe(1);
    expect(comparison.verdict).toBe("b-higher");
  });

  it("stays inconclusive without a target that ran both arms", async () => {
    const evaluation = await ledgerWith([
      {
        campaignId: "campaign-1",
        snapshot: digest("5"),
        arm: "a",
        finding: "runtime-confirmed",
      },
    ]);
    const comparison = evaluation.compare({ axis: "history" });
    expect(comparison.pooled.a.runs).toBe(0);
    expect(comparison.verdict).toBe("inconclusive");
  });
});
