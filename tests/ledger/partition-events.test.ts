import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, ledgerEventV1Schema } from "../../src/ledger/index.js";

// ADR 0042: the ledger carries the enumerator's observed counts and each
// partition's assignment as digests and enum tokens; never the rows themselves.

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const base = (identity: string) => ({
  schemaVersion: 1 as const,
  identity,
  campaignId: "campaign-1",
  snapshotDigest: digest,
  occurredAt: "2026-10-28T00:00:00Z",
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ledger-partition-"));
  directories.push(directory);
  return new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 10,
      maxBytes: 1024,
    }),
  });
}

const enumeration = {
  ...base("enumeration-trial-1"),
  type: "enumeration-recorded" as const,
  trialId: "trial-1",
  runId: "run-enumerate-1",
  accepted: true,
  resubmits: 1,
  inventoryDigest: digest,
  partitionsDigest: other,
  scriptRan: true,
  scriptRowCount: 40,
  agentRowCount: 12,
  duplicateRowCount: 3,
  partitionCount: 4,
  definitionDigest: digest,
  toolsDigest: other,
  rowSource: "agent" as const,
};

describe("partitioned Trial events", () => {
  it("records an accepted enumeration, an exhausted one with its reasons, and each assignment", async () => {
    const ledger = await fixture();
    expect(await ledger.append(enumeration)).toEqual({ status: "appended" });
    const { partitionsDigest: _unparsed, ...withoutProposal } = enumeration;
    expect(
      await ledger.append({
        ...withoutProposal,
        identity: "enumeration-trial-2",
        trialId: "trial-2",
        accepted: false,
        resubmits: 2,
        rejectedReasons: ["partition-too-large", "row-unassigned"],
        partitionCount: 0,
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...base("partition-trial-1-p1"),
        type: "partition-assigned",
        trialId: "trial-1",
        partitionId: "p1",
        ordinal: 0,
        of: 4,
        rowCount: 13,
        scriptRowCount: 10,
        agentRowCount: 3,
        assignmentDigest: digest,
        runId: "run-trace-1",
        definitionDigest: other,
      }),
    ).toEqual({ status: "appended" });
    expect(
      ledger
        .readAll({ campaignId: "campaign-1" })
        .map(({ event }) => event.type),
    ).toEqual([
      "enumeration-recorded",
      "enumeration-recorded",
      "partition-assigned",
    ]);
  });

  it("refuses free text in the reasons and rows in the event", () => {
    expect(
      ledgerEventV1Schema.safeParse({
        ...enumeration,
        accepted: false,
        rejectedReasons: ["The partition Forms has 70 rows"],
      }).success,
    ).toBe(false);
    expect(
      ledgerEventV1Schema.safeParse({ ...enumeration, rows: [] }).success,
    ).toBe(false);
    expect(
      ledgerEventV1Schema.safeParse({
        ...enumeration,
        accepted: false,
        rejectedReasons: [],
      }).success,
    ).toBe(false);
  });

  it("carries the role on a run start and the partition on a Finding and a Lead", async () => {
    const ledger = await fixture();
    expect(
      await ledger.append({
        ...base("run-trace-1-started"),
        type: "discovery-run-started",
        runId: "run-trace-1",
        trialId: "trial-1",
        runKind: "trace",
        history: { mode: "none" },
        configuration: {
          promptVariant: "objective-partition-v1",
          mode: "partitioned",
          role: {
            kind: "tracer",
            definitionDigest: digest,
            partitionId: "p1",
          },
        },
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...base("run-enumerate-1-started"),
        type: "discovery-run-started",
        runId: "run-enumerate-1",
        trialId: "trial-1",
        runKind: "enumerate",
        history: { mode: "none" },
        configuration: {
          promptVariant: "objective-partition-v1",
          mode: "partitioned",
          role: {
            kind: "enumerator",
            definitionDigest: digest,
            toolsDigest: other,
            resubmit: 1,
          },
        },
      }),
    ).toEqual({ status: "appended" });
    expect(
      ledgerEventV1Schema.safeParse({
        ...base("finding-1"),
        type: "finding-recorded",
        findingId: "finding-1",
        runId: "run-trace-1",
        trialId: "trial-1",
        category: "stored-xss",
        partition: "p1",
      }).success,
    ).toBe(true);
    expect(
      ledgerEventV1Schema.safeParse({
        ...base("run-x"),
        type: "discovery-run-started",
        runId: "run-x",
        history: { mode: "none" },
        configuration: {
          promptVariant: "x",
          role: { kind: "Tracer", definitionDigest: digest },
        },
      }).success,
    ).toBe(false);
  });

  it("counts a partitioned Trial once in the funnel: the enumerate run, not its send-backs or tracers", async () => {
    const ledger = await fixture();
    for (const [runId, runKind, resubmit] of [
      ["trial-1", "enumerate", 0],
      ["trial-1-r1", "enumerate", 1],
      ["run-trace-1", "trace", undefined],
      ["run-trace-2", "trace", undefined],
    ] as const) {
      await ledger.append({
        ...base(`${runId}-started`),
        type: "discovery-run-started",
        runId,
        trialId: "trial-1",
        runKind,
        labAttached: false,
        history: { mode: "none" },
        configuration: {
          promptVariant: "objective-partition-v1",
          role: {
            kind: runKind === "enumerate" ? "enumerator" : "tracer",
            definitionDigest: digest,
            ...(resubmit === undefined ? {} : { resubmit }),
          },
        },
      });
      await ledger.append({
        ...base(`${runId}-finished`),
        type: "discovery-run-finished",
        runId,
        outcome: "completed",
        costUsd: "unavailable",
        wallTimeMs: 1,
      });
    }
    await ledger.append({ ...enumeration, runId: "trial-1-r1" });
    const funnel = ledger.funnel("campaign-1");
    expect(funnel.discoveryAttempts).toBe(1);
    expect(funnel.runCount).toBe(4);
    // Completed through its tracers; no tracer reached a candidate.
    expect(funnel.attemptOutcomes).toEqual({
      completed: 1,
      completedWithoutCandidate: 1,
      incomplete: 0,
      incompleteByReason: {},
      providerLimited: 0,
      unfinished: 0,
    });
  });

  it("reads a rejected enumeration and an all-failed tracer set as incomplete attempts, never as zero candidates (ADR 0042)", async () => {
    const ledger = await fixture();
    const run = async (
      trialId: string,
      runId: string,
      runKind: "enumerate" | "trace",
      finish: Record<string, unknown> | undefined,
    ) => {
      await ledger.append({
        ...base(`${runId}-started`),
        type: "discovery-run-started",
        runId,
        trialId,
        runKind,
        labAttached: false,
        history: { mode: "none" },
        configuration: { promptVariant: "objective-partition-v1" },
      });
      if (finish !== undefined)
        await ledger.append({
          ...base(`${runId}-finished`),
          type: "discovery-run-finished",
          runId,
          costUsd: "unavailable",
          wallTimeMs: 1,
          ...finish,
        } as Parameters<Ledger["append"]>[0]);
    };
    // Trial 1: the send-backs ran out.
    await run("trial-1", "trial-1", "enumerate", { outcome: "completed" });
    await ledger.append({
      ...enumeration,
      identity: "enumeration-trial-1",
      accepted: false,
      rejectedReasons: ["proposal-missing"],
      partitionCount: 0,
    });
    // Trial 2: accepted, but both tracers hit the wall.
    await run("trial-2", "trial-2", "enumerate", { outcome: "completed" });
    await ledger.append({
      ...enumeration,
      identity: "enumeration-trial-2",
      trialId: "trial-2",
      runId: "trial-2",
    });
    for (const runId of ["trial-2-p-a", "trial-2-p-b"])
      await run("trial-2", runId, "trace", {
        outcome: "failed",
        reason: "wall",
        reasonDetail: "target-ceiling",
      });
    // Trial 3: the enumerator's limit; Trial 4: a dangling enumerate start.
    await run("trial-3", "trial-3", "enumerate", {
      outcome: "provider-limited",
      reason: "provider",
      providerLimit: "rate-limit",
    });
    await run("trial-4", "trial-4", "enumerate", undefined);
    const funnel = ledger.funnel("campaign-1");
    expect(funnel.discoveryAttempts).toBe(4);
    expect(funnel.attemptOutcomes).toEqual({
      completed: 0,
      completedWithoutCandidate: 0,
      incomplete: 2,
      incompleteByReason: {
        "schema/enumeration-rejected": 1,
        "wall/target-ceiling": 1,
      },
      providerLimited: 1,
      unfinished: 1,
    });
  });
});
