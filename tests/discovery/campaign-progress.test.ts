import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readResumeProgress,
  recordedFailureAfterRuns,
} from "../../src/discovery/campaign-progress.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const otherSnapshot = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function open() {
  const root = await mkdtemp(join(tmpdir(), "wbh-progress-"));
  directories.push(root);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 10,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: digest,
    occurredAt: "2026-10-08T07:00:00Z",
  };
  const start = (
    runId: string,
    extra: Record<string, unknown> = {},
    snapshotDigest = digest,
  ) =>
    ledger.append({
      ...base,
      snapshotDigest,
      identity: `start-${runId}`,
      type: "discovery-run-started",
      runId,
      history: { mode: "none" },
      configuration: { promptVariant: "v", assignmentUnit: "plugin" },
      ...extra,
    } as Parameters<Ledger["append"]>[0]);
  const finish = (
    runId: string,
    outcome: "completed" | "failed" | "provider-limited",
    extra: Record<string, unknown> = {},
  ) =>
    ledger.append({
      ...base,
      identity: `finish-${runId}`,
      type: "discovery-run-finished",
      runId,
      outcome,
      costUsd: "unavailable",
      wallTimeMs: 1,
      artifacts: [],
      ...extra,
    } as Parameters<Ledger["append"]>[0]);
  const target = { ledger, campaignId: "campaign-1", snapshotDigest: digest };
  return { ledger, base, start, finish, target };
}

describe("readResumeProgress", () => {
  it("spends ordinals only for explorations that count, and lowest free ones for legacy starts", async () => {
    const { start, finish, target } = await open();
    await start("stamped-2", { trialOrdinal: 2, runKind: "explore" });
    await finish("stamped-2", "completed");
    // A start that never finished and shows no work does not spend its ordinal.
    await start("abandoned-0", { trialOrdinal: 0, runKind: "explore" });
    // A finished run with no observable work is not a Trial.
    await start("idle-1", { trialOrdinal: 1, runKind: "explore" });
    await finish("idle-1", "failed", {
      observed: {
        toolCalls: 0,
        filesRead: 0,
        uniqueFilesRead: 0,
        labRequests: 0,
        dbQueries: 0,
      },
      childThreadsObserved: 0,
      brokerMetrics: {
        forwardedRequests: 1,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
    });
    // Legacy explorations carried no ordinal or kind; one has a child, so it counts.
    await start("legacy-a");
    await start("legacy-a-child", {
      runKind: "child",
      parentRunId: "legacy-a",
    });
    await start("legacy-b");
    await finish("legacy-b", "failed");
    // Another snapshot's events are not this target's progress.
    await start(
      "elsewhere",
      { trialOrdinal: 5, runKind: "explore" },
      otherSnapshot,
    );
    const progress = readResumeProgress(target);
    expect(progress.concluded).toBeUndefined();
    expect([...progress.startedExplorations].sort()).toEqual([
      "legacy-a",
      "legacy-b",
      "stamped-2",
    ]);
    expect([...progress.spentOrdinals].sort()).toEqual([0, 1, 2]);
  });

  it("reports the recorded conclusion of the target", async () => {
    const { ledger, base, target } = await open();
    await ledger.append({
      ...base,
      identity: "concluded",
      type: "discovery-concluded",
      stoppedBy: "max-runs",
    });
    expect(readResumeProgress(target).concluded).toBe("max-runs");
    expect(
      readResumeProgress({ ...target, snapshotDigest: otherSnapshot })
        .concluded,
    ).toBeUndefined();
  });
});

describe("recordedFailureAfterRuns", () => {
  it("ranks a provider limit over an incomplete run and ignores runs it did not start", async () => {
    const { start, finish, target } = await open();
    await start("done", { trialOrdinal: 0, runKind: "explore" });
    await finish("done", "completed");
    await start("refused", { trialOrdinal: 1, runKind: "explore" });
    await finish("refused", "provider-limited", { reason: "provider" });
    await start("broken", { trialOrdinal: 2, runKind: "explore" });
    await finish("broken", "failed", { reason: "schema" });
    expect(recordedFailureAfterRuns(target, new Set(["done"]))).toBeUndefined();
    expect(recordedFailureAfterRuns(target, new Set(["done", "broken"]))).toBe(
      "incomplete",
    );
    expect(
      recordedFailureAfterRuns(target, new Set(["done", "broken", "refused"])),
    ).toBe("provider-limit");
    // A start with no finish and no recorded activity is not counted at all.
    await start("crashed", { trialOrdinal: 3, runKind: "explore" });
    expect(
      recordedFailureAfterRuns(target, new Set(["done", "crashed"])),
    ).toBeUndefined();
  });
});
