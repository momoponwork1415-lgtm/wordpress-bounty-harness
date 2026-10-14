import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";

type Row = [string, string, Record<string, unknown>];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** Appends `[occurredAt, campaignId, event]` rows to a fresh ledger. */
async function ledgerWith(rows: readonly Row[]): Promise<Ledger> {
  const directory = await mkdtemp(join(tmpdir(), "ledger-stops-"));
  directories.push(directory);
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 10,
      maxBytes: 1024,
    }),
  });
  for (const [index, [occurredAt, campaignId, rest]] of rows.entries()) {
    const appended = await ledger.append({
      schemaVersion: 1,
      identity: `event-${index}`,
      campaignId,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      occurredAt,
      ...rest,
    } as LedgerEventInput);
    expect(appended.status).toBe("appended");
  }
  return ledger;
}

const run = (
  when: string,
  campaign: string,
  runId: string,
  finished: Record<string, unknown>,
): Row[] => [
  [
    when,
    campaign,
    {
      type: "discovery-run-started",
      runId,
      labId: `lab-${runId}`,
      runKind: "explore",
      history: { mode: "none" },
      configuration: { promptVariant: "v3", assignmentUnit: "cooperative" },
    },
  ],
  [
    when,
    campaign,
    {
      type: "discovery-run-finished",
      runId,
      costUsd: "unavailable",
      ...finished,
    },
  ],
];

const day = "2026-10-20T01:00:00Z";
// prettier-ignore
const refused = { outcome: "failed", reason: "provider", reasonDetail: "provider-cyber-policy", wallTimeMs: 20_000 };
// prettier-ignore
const quota = { outcome: "provider-limited", reason: "provider", providerLimit: "quota", wallTimeMs: 600_000 };
const skip = (stage: string, reason?: string) => ({
  type: "target-skipped",
  selectionId: "wporg:x@1.0.0",
  stage,
  ...(reason === undefined ? {} : { reason }),
});
const stopped = (reason: string) => ({ type: "campaign-stopped", reason });

describe("ledger stops", () => {
  it("groups refusals, provider limits, skips, Lab failures and campaign stops", async () => {
    // prettier-ignore
    const ledger = await ledgerWith([
      ...run(day, "a", "r1", refused),
      ...run(day, "a", "r2", refused),
      ...run(day, "a", "r3", refused),
      ...run(day, "a", "q1", quota),
      ...run(day, "a", "q2", quota),
      ...run(day, "a", "ok", { outcome: "completed", wallTimeMs: 3_000_000 }),
      [day, "a", skip("discovery", "other")],
      [day, "a", skip("discovery", "other")],
      [day, "a", skip("freeze", "http-response")],
      [day, "a", skip("verification")],
      [day, "a", { type: "lab-provisioned", labId: "l1", status: "failed", failureStage: "seed", reason: "precondition" }],
      [day, "a", { type: "lab-provisioned", labId: "l2", status: "ready" }],
      [day, "a", stopped("provider-limit")],
      [day, "b", stopped("provider-limit")],
    ]);
    const rows = ledger.stops({ campaignId: "a" });
    // prettier-ignore
    expect(rows).toEqual(expect.arrayContaining([
      { type: "discovery-run-finished", fields: { outcome: "failed", reason: "provider", reasonDetail: "provider-cyber-policy" }, count: 3, explore: 3, within60s: 3 },
      { type: "discovery-run-finished", fields: { outcome: "provider-limited", reason: "provider", providerLimit: "quota" }, count: 2, explore: 2, within60s: 0 },
      { type: "target-skipped", fields: { stage: "discovery", reason: "other" }, count: 2 },
      { type: "target-skipped", fields: { stage: "freeze", reason: "http-response" }, count: 1 },
      { type: "target-skipped", fields: { stage: "verification", reason: "unrecorded" }, count: 1 },
      { type: "lab-provisioned", fields: { status: "failed", failureStage: "seed", reason: "precondition" }, count: 1 },
      { type: "campaign-stopped", fields: { reason: "provider-limit" }, count: 1 },
    ]));
    // Completed runs and ready Labs are not stops.
    expect(rows).toHaveLength(7);
    const all = ledger.stops();
    expect(all.find((row) => row.type === "campaign-stopped")?.count).toBe(2);
  });

  it("filters stops, funnels and reads by --since across campaigns", async () => {
    // prettier-ignore
    const ledger = await ledgerWith([
      ["2026-10-13T23:59:59Z", "old", stopped("incomplete")],
      // An offset instant compares by time, not by text.
      ["2026-10-14T09:00:00+09:00", "new", stopped("provider-limit")],
      ...run("2026-10-14T00:00:00Z", "new", "n1", { outcome: "completed", wallTimeMs: 1 }),
      ...run("2026-10-12T00:00:00Z", "old", "o1", { outcome: "completed", wallTimeMs: 1 }),
    ]);
    const since = "2026-10-14T00:00:00Z";
    expect(ledger.stops({ since })).toEqual([
      {
        type: "campaign-stopped",
        fields: { reason: "provider-limit" },
        count: 1,
      },
    ]);
    const read = ledger.read({ type: "campaign-stopped", since });
    expect(read.map(({ event }) => event.campaignId)).toEqual(["new"]);
    const recent = ledger.funnel(undefined, { since });
    expect([recent.campaignId, recent.runCount]).toEqual(["*", 1]);
    const week = ledger.funnel(undefined, { since: "2026-10-01T00:00:00Z" });
    expect(week.runCount).toBe(2);
    expect(() => ledger.funnel(undefined)).toThrow();
  });
});
