import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCampaignPipeline } from "../../src/cli/pipeline.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 500 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * A campaign over `count` targets whose freeze blocks until the test ends it,
 * so each blocked freeze is one target in flight.
 */
async function campaign(count: number, live: () => number | null) {
  const root = await mkdtemp(join(tmpdir(), "wbh-target-limit-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const reports: number[] = [];
  let ids = 0;
  const done = runCampaignPipeline({
    campaignId: "prod-20261019-1",
    ledger,
    store,
    clock: () => new Date("2026-10-19T00:00:00Z"),
    newId: () => `id-${++ids}`,
    discoveryLab: "none",
    maxConcurrentTargets: 4,
    targetLimit: {
      read: async () => live(),
      report: (limit) => reports.push(limit),
      pollMs: 5,
    },
    pipeline: {
      select: async () =>
        Array.from({ length: count }, (_, index) => ({
          targetId: `wporg:t${index}`,
          version: "1.0.0",
          score: 1,
          selectedAt: "2026-10-19T00:00:00Z",
          policy: { id: "policy", digest: `sha256:${"b".repeat(64)}` },
        })),
      freeze: (target: { targetId: string }) =>
        new Promise((_, reject) => {
          started.push(target.targetId);
          finish.set(target.targetId, () => reject(new Error("synthetic end")));
        }),
    } as never,
  });
  const end = (targetId: string) => {
    finish.get(targetId)!();
    finish.delete(targetId);
  };
  return { done, started, reports, end, running: () => finish.size };
}

describe("live target limit", () => {
  it("holds new starts when lowered, never ends running targets, and starts more when raised up to the ceiling", async () => {
    let live: number | null = 2;
    const c = await campaign(6, () => live);
    await until(() => c.started.length === 2);
    await settle();
    expect(c.started).toHaveLength(2);

    live = 1;
    c.end("wporg:t0");
    await settle();
    // The lowered limit ends nothing; the other target keeps running.
    expect(c.started).toHaveLength(2);
    expect(c.running()).toBe(1);

    // A raise takes effect at the next poll, without a target finishing.
    live = 3;
    await until(() => c.started.length === 4);
    expect(c.running()).toBe(3);

    // Above the ceiling the config's maxConcurrentTargets (4) applies.
    live = 9;
    await until(() => c.started.length === 5);
    await settle();
    expect(c.started).toHaveLength(5);
    expect(c.running()).toBe(4);

    for (const targetId of ["wporg:t1", "wporg:t2", "wporg:t3", "wporg:t4"])
      c.end(targetId);
    await until(() => c.started.length === 6);
    c.end("wporg:t5");
    const summary = await c.done;
    expect(summary.skipped).toHaveLength(6);
    expect(c.reports).toEqual([2, 1, 3, 4]);
  });

  it("uses the ceiling when the live limit is unset", async () => {
    const c = await campaign(5, () => null);
    await until(() => c.started.length === 4);
    await settle();
    expect(c.started).toHaveLength(4);
    for (const targetId of [...c.started]) c.end(targetId);
    await until(() => c.started.length === 5);
    c.end("wporg:t4");
    await c.done;
    expect(c.reports).toEqual([4]);
  });
});
