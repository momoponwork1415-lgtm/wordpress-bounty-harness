import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CampaignSummary } from "../../src/cli/pipeline.js";
import {
  continuousPaths,
  createContinuousRunner,
  type ContinuousDeps,
} from "../../src/cli/continuous.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Step = (input: {
  campaignId: string;
  target: string | null;
  retryIncompleteVerifications: boolean;
}) => Promise<Partial<CampaignSummary>> | Partial<CampaignSummary>;

async function setup(steps: Step[], overrides: Partial<ContinuousDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-continuous-"));
  roots.push(root);
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 4,
      maxBytes: 1024,
    }),
  });
  let now = new Date("2026-10-20T00:00:00Z").getTime();
  let ids = 0;
  const append = async (campaignId: string, rest: Record<string, unknown>) =>
    ledger.append({
      schemaVersion: 1,
      identity: `event-${++ids}`,
      campaignId,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      occurredAt: new Date(now).toISOString(),
      ...rest,
    } as LedgerEventInput);
  /** One explore Trial with the given finish fields. */
  const trial = async (campaignId: string, finished: object) => {
    const runId = `run-${++ids}`;
    await append(campaignId, {
      type: "discovery-run-started",
      runId,
      labId: "lab",
      runKind: "explore",
      history: { mode: "none" },
      configuration: { promptVariant: "v3", assignmentUnit: "cooperative" },
    });
    await append(campaignId, {
      type: "discovery-run-finished",
      runId,
      costUsd: "unavailable",
      wallTimeMs: 1,
      ...finished,
    });
  };
  const calls: Parameters<Step>[0][] = [];
  const log: string[] = [];
  const notified: string[] = [];
  const deps: ContinuousDeps = {
    stateDirectory: root,
    campaignPrefix: "prod",
    ledger,
    select: async () => ({ batchId: `selection-${++ids}`, targets: ["a"] }),
    async runCampaign(input) {
      calls.push(input);
      const step = steps.shift();
      // With the script spent, the operator stops the runner.
      if (step === undefined) await writeFile(continuousPaths(root).stop, "");
      else
        await append(input.campaignId, {
          type: "selection-batch-bound",
          selectionBatchId: `bound-${ids}`,
          policyDigest: `sha256:${"b".repeat(64)}`,
          selectionIds: ["wporg:x@1.0.0"],
        });
      const result =
        step === undefined ? { stopped: "operator" } : await step(input);
      return {
        campaignId: input.campaignId,
        targets: [],
        skipped: [],
        ...result,
      } as CampaignSummary;
    },
    cleanupLeftovers: async () => 0,
    preflight: async () => undefined,
    clock: () => new Date(now),
    sleep: async (ms) => void (now += ms),
    signals: { on: () => process, off: () => process } as never,
    pidAlive: () => false,
    pid: 4242,
    io: {
      log: (line) => log.push(line),
      notify: async (line) => void notified.push(line),
    },
    ...overrides,
  };
  const runner = createContinuousRunner(deps);
  return { root, runner, calls, log, notified, trial, deps };
}

const limited =
  (
    providerLimit: "quota" | "rate-limit",
    setup: { trial: (c: string, f: object) => Promise<void> },
  ): Step =>
  async ({ campaignId }) => {
    await setup.trial(campaignId, {
      outcome: "provider-limited",
      reason: "provider",
      providerLimit,
    });
    return { stopped: "provider-limit" };
  };

describe("continuous runner", () => {
  it.each([
    ["rate-limit", [5, 10, 20, 40, 60, 60]],
    ["quota", [30, 60, 360]],
  ] as const)(
    "backs off a %s on the same campaign id",
    async (kind, minutes) => {
      const steps: Step[] = [];
      const t = await setup(steps);
      steps.push(...minutes.map(() => limited(kind, t)));
      expect(await t.runner.run()).toBe("operator");
      const backoffs = t.log.filter((line) => line.includes(" backoff "));
      expect(backoffs.map((line) => /minutes=(\d+)/.exec(line)?.[1])).toEqual(
        minutes.map(String),
      );
      expect(new Set(t.calls.map((call) => call.campaignId)).size).toBe(1);
      expect(
        t.calls.slice(1).every((call) => call.retryIncompleteVerifications),
      ).toBe(true);
    },
  );

  it("starts a new campaign id after a finished one, numbered from the ledger", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    const completed: Step = async ({ campaignId }) => {
      await t.trial(campaignId, { outcome: "completed" });
      return {};
    };
    steps.push(completed, completed);
    await t.runner.run();
    expect(t.calls.map((call) => call.campaignId)).toEqual([
      "prod-20261020-1",
      "prod-20261020-2",
      "prod-20261020-3",
    ]);
  });

  it("refuses a live pid and clears a dead pid and a stale stop marker", async () => {
    const t = await setup([], { pidAlive: (pid) => pid === 7 });
    await writeFile(continuousPaths(t.root).pid, "7");
    await expect(t.runner.run()).rejects.toThrow("already running as pid 7");
    await writeFile(continuousPaths(t.root).pid, "8");
    await writeFile(continuousPaths(t.root).stop, "");
    const steps: Step[] = [async () => ({})];
    const fresh = await setup(steps, {
      stateDirectory: t.root,
      pidAlive: (pid) => pid === 7,
    });
    await fresh.runner.run();
    expect(fresh.calls).toHaveLength(2);
  });

  it("resumes the unfinished campaign under its id", async () => {
    const steps: Step[] = [async () => ({})];
    const t = await setup(steps);
    await writeFile(
      continuousPaths(t.root).memo,
      JSON.stringify({ campaignId: "prod-20261019-4", target: null }),
    );
    await t.runner.run();
    expect(t.calls[0]).toMatchObject({
      campaignId: "prod-20261019-4",
      retryIncompleteVerifications: true,
    });
  });

  it("writes one log line and one notification per state change", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    steps.push(limited("quota", t));
    await t.runner.run();
    const states = t.log
      .filter((line) => !line.includes(" batch "))
      .map((line) => line.split(" ")[1]);
    expect(states).toEqual(["running", "backoff", "running", "stopped"]);
    expect(t.notified).toHaveLength(4);
    expect(t.log.at(-1)).toMatch(/ stopped reason=operator$/);
    expect(existsSync(continuousPaths(t.root).pid)).toBe(false);
    expect(
      JSON.parse(await readFile(continuousPaths(t.root).memo, "utf8")),
    ).toMatchObject({ state: "stopped" });
  });

  it("gives up a batch on an error and stops after three in a row", async () => {
    const boom: Step = () => {
      throw new Error("x".repeat(300));
    };
    const t = await setup([boom, boom, boom]);
    expect(await t.runner.run()).toBe("errors");
    expect(t.runner.memo().lastError).toHaveLength(200);
    expect(new Set(t.calls.map((call) => call.campaignId)).size).toBe(3);
  });
});
