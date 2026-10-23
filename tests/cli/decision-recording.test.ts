import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliProfile } from "../../src/cli/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { Review } from "../../src/review/index.js";

const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-10-23T12:00:00.000Z";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function unused(): never {
  throw new Error("Only human review recording is available in this fixture");
}

const profile: CliProfile = {
  review: (state) =>
    new Review({
      ledger: state.ledger,
      artifactStore: state.store,
      scopeEvaluator: {
        programmeIds: ["synthetic"],
        policyDigest: SNAPSHOT,
        assess: unused,
      },
      factsProvider: { load: unused },
      clock: state.clock,
    }),
  historyStatus: unused,
  stateDiffReader: unused,
  httpEvidenceReader: unused,
  verifierRecordReader: unused,
  select: unused,
  runCampaign: unused,
  targetCeiling: unused,
  runtimeCeilings: unused,
  resumeCampaignRun: unused,
  verifyNext: unused,
  latestVersion: unused,
  hostStatus: unused,
  labHeld: unused,
  cleanupLeftovers: unused,
  checkRuntime: unused,
  reverify: unused,
  reviewLab: unused,
  labDown: unused,
};

/** Recorded metadata and text artifacts only; no target or verification is run. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-cli-decision-"));
  roots.push(root);
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(stateDirectory, "private-evidence"),
    maxEntries: 8,
    maxBytes: 100_000,
  });
  const evidence = await store.putFiles({ "evidence.txt": "Synthetic record" });
  const packageDigest = await store.putFiles({
    "package.txt": "Synthetic historical package reference",
  });
  const ledger = new Ledger({
    databasePath: join(stateDirectory, "ledger.sqlite"),
    artifactStore: store,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: SNAPSHOT,
    occurredAt: "2026-10-23T11:00:00Z",
  };
  await ledger.append({
    ...base,
    identity: "finding-1",
    type: "finding-recorded",
    findingId: "finding-1",
    runId: "synthetic-record",
    category: "synthetic",
  });
  await ledger.append({
    ...base,
    identity: "verification-1",
    type: "verification-finished",
    findingId: "finding-1",
    verificationId: "verification-1",
    labSetupDigest: `sha256:${"b".repeat(64)}`,
    result: {
      status: "runtime-confirmed",
      judgeId: "synthetic",
      proofKind: "nonce-canary",
      evidenceDigest: evidence,
      reproductionPackageDigest: packageDigest,
    },
  });
  const notePath = join(root, "review-note.md");
  await writeFile(notePath, "Synthetic human review note");
  return {
    ledger,
    store,
    async decide(reason: string) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        [
          "review",
          "decide",
          "--campaign",
          "campaign-1",
          "--finding",
          "finding-1",
          "--decision",
          "accept",
          "--reason",
          reason,
          "--opened",
          evidence,
          "--duplicate",
          "no-match",
          "--duplicate-note",
          notePath,
          "--reproduced",
          "match",
          "--reproduce-minutes",
          "7.25",
          "--minutes",
          "2.5",
          "--by",
          "operator",
        ],
        { stateDirectory, profile, clock: () => new Date(NOW) },
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      return { code, stdout, stderr };
    },
  };
}

describe("CLI human review operation", () => {
  it("does not leave partial records or a filed note when the decision reason is invalid", async () => {
    const { ledger, store, decide } = await fixture();
    const eventsBefore = ledger.readAll();
    const artifactsBefore = await readdir(store.rootDirectory);
    const result = await decide("invalid reason");
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("reasonCode");
    expect(result.stdout).toEqual([]);
    expect(ledger.readAll()).toEqual(eventsBefore);
    expect(await readdir(store.rootDirectory)).toEqual(artifactsBefore);
  });

  it("records related work and prints completion in the existing order", async () => {
    const { ledger, decide } = await fixture();
    const countBefore = ledger.readAll().length;
    const result = await decide("accepted");
    expect(result).toEqual({
      code: 0,
      stderr: [],
      stdout: [
        "manual reproduction match recorded for finding finding-1",
        `recorded accept (accepted) for finding finding-1 at ${NOW}`,
      ],
    });
    const recorded = ledger
      .readAll()
      .slice(countBefore)
      .map(({ event }) => event);
    expect(recorded).toHaveLength(4);
    expect(recorded).toMatchObject([
      { type: "human-reproduction-recorded", result: "match" },
      { type: "human-effort-recorded", action: "reproduce", minutes: 7.25 },
      { type: "review-decided", decision: "accept", humanElapsedSeconds: 150 },
      { type: "human-effort-recorded", action: "read", minutes: 2.5 },
    ]);
  });
});
