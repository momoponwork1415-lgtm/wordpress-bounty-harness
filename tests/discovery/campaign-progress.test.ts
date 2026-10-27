import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  autoResumesProviderLimit,
  partitionedTrialOutcomes,
  providerLimitedAutoResumeRefusal,
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
  it("offers five automatic resume segments to Codex runs only, including a startup failure", () => {
    expect(providerLimitedAutoResumeRefusal({})).toBeUndefined();
    expect(
      providerLimitedAutoResumeRefusal({ resumeSegment: 4 }),
    ).toBeUndefined();
    expect(providerLimitedAutoResumeRefusal({ resumeSegment: 5 })).toBe(
      "resume-limit",
    );
    // Claude keeps ADR 0029's backoff-then-new-Trial path; unmarked starts
    // predate the runtime share and ran on Codex.
    expect(
      autoResumesProviderLimit({
        configuration: { runtime: "codex-native/v1", promptVariant: "v" },
      }),
    ).toBe(true);
    expect(
      autoResumesProviderLimit({ configuration: { promptVariant: "v" } }),
    ).toBe(true);
    expect(
      autoResumesProviderLimit({
        configuration: { runtime: "claude-code/v1", promptVariant: "v" },
      }),
    ).toBe(false);
  });

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

  it("does not spend the ordinal of a run the provider limit ended, even after children started", async () => {
    const { start, finish, target } = await open();
    await start("limited", { trialOrdinal: 0, runKind: "explore" });
    await start("limited-child", { runKind: "child", parentRunId: "limited" });
    await finish("limited", "provider-limited", {
      reason: "provider",
      providerLimit: "rate-limit",
    });
    const progress = readResumeProgress(target);
    expect([...progress.startedExplorations]).toEqual([]);
    expect([...progress.spentOrdinals]).toEqual([]);
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

describe("partitioned Trials in the campaign's progress (ADR 0042)", () => {
  const enumeration = (
    trialId: string,
    runId: string,
    accepted: boolean,
  ): Record<string, unknown> => ({
    identity: `enumeration-${trialId}`,
    type: "enumeration-recorded",
    trialId,
    runId,
    accepted,
    resubmits: 0,
    ...(accepted ? {} : { rejectedReasons: ["proposal-missing"] }),
    inventoryDigest: digest,
    scriptRan: true,
    scriptRowCount: 1,
    agentRowCount: 0,
    duplicateRowCount: 0,
    partitionCount: accepted ? 2 : 0,
    definitionDigest: digest,
    toolsDigest: digest,
    rowSource: "agent",
  });

  it("reads a rejected enumeration as an incomplete, spent Trial", async () => {
    const { ledger, base, start, finish, target } = await open();
    await start("trial-1", {
      trialId: "trial-1",
      trialOrdinal: 0,
      runKind: "enumerate",
    });
    await finish("trial-1", "completed");
    await ledger.append({
      ...base,
      ...enumeration("trial-1", "trial-1", false),
    } as Parameters<Ledger["append"]>[0]);
    expect([...partitionedTrialOutcomes(target).values()]).toEqual([
      {
        trialId: "trial-1",
        outcome: "incomplete",
        reason: "schema",
        reasonDetail: "enumeration-rejected",
      },
    ]);
    expect(recordedFailureAfterRuns(target, new Set(["trial-1"]))).toBe(
      "incomplete",
    );
    const progress = readResumeProgress(target);
    expect([...progress.startedExplorations]).toEqual(["trial-1"]);
    expect([...progress.spentOrdinals]).toEqual([0]);
  });

  it("reads the tracers' ends: a limit outranks the wall, one completion completes, none finished is unfinished", async () => {
    const { ledger, base, start, finish, target } = await open();
    const trial = async (
      trialId: string,
      ordinal: number,
      tracers: readonly (
        | ["completed" | "failed" | "provider-limited", Record<string, unknown>]
        | undefined
      )[],
    ) => {
      await start(trialId, {
        trialId,
        trialOrdinal: ordinal,
        runKind: "enumerate",
      });
      await finish(trialId, "completed");
      await ledger.append({
        ...base,
        ...enumeration(trialId, trialId, true),
      } as Parameters<Ledger["append"]>[0]);
      for (const [index, tracer] of tracers.entries()) {
        const runId = `${trialId}-p-p${index}`;
        await start(runId, {
          trialId,
          trialOrdinal: ordinal,
          runKind: "trace",
        });
        if (tracer !== undefined) await finish(runId, tracer[0], tracer[1]);
      }
    };
    await trial("limited", 0, [
      ["failed", { reason: "wall", reasonDetail: "target-ceiling" }],
      ["provider-limited", { reason: "provider", providerLimit: "quota" }],
    ]);
    await trial("partial", 1, [
      ["failed", { reason: "schema", reasonDetail: "report-unreadable" }],
      ["completed", {}],
    ]);
    await trial("walled", 2, [
      ["failed", { reason: "wall", reasonDetail: "target-ceiling" }],
    ]);
    await trial("dangling", 3, [undefined]);
    const outcomes = partitionedTrialOutcomes(target);
    expect(outcomes.get("limited")).toEqual({
      trialId: "limited",
      outcome: "provider-limited",
      reason: "provider",
      providerLimit: "quota",
    });
    expect(outcomes.get("partial")).toEqual({
      trialId: "partial",
      outcome: "completed",
    });
    expect(outcomes.get("walled")).toEqual({
      trialId: "walled",
      outcome: "incomplete",
      reason: "wall",
      reasonDetail: "target-ceiling",
    });
    expect(outcomes.get("dangling")).toEqual({
      trialId: "dangling",
      outcome: "unfinished",
    });
    expect(recordedFailureAfterRuns(target, new Set(["partial"]))).toBe(
      undefined,
    );
    expect(
      recordedFailureAfterRuns(target, new Set(["partial", "walled"])),
    ).toBe("incomplete");
    expect(
      recordedFailureAfterRuns(
        target,
        new Set(["partial", "walled", "limited"]),
      ),
    ).toBe("provider-limit");
    // The limited and the dangling Trials do not spend their ordinals.
    expect([...readResumeProgress(target).spentOrdinals]).toEqual([1, 2]);
  });
});
