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
  type ContinuousStopReason,
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
  signal?: AbortSignal;
  resumeInterrupted?: { log(line: string): void };
  resumeProviderLimited?: { log(line: string): void };
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
  const slept: number[] = [];
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
    legacyHistoryAvailable: async () => true,
    readAuth: async () => ({ expiresAt: new Date(now + 30 * 86_400_000) }),
    programmeObservedAt: async () => new Date(now - 86_400_000),
    statfs: async () => ({ freeBytes: 100 * 1024 ** 3 }),
    loginMarginMinutes: 600,
    clock: () => new Date(now),
    sleep: async (ms) => void (slept.push(ms), (now += ms)),
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
  const hours = () => slept.reduce((a, b) => a + b, 0) / 3_600_000;
  const states = () => log.map((line) => line.split(" ")[1] ?? "");
  return {
    root,
    runner,
    calls,
    log,
    notified,
    trial,
    deps,
    hours,
    states,
    append,
  };
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

async function expectLatchedStop(
  t: Awaited<ReturnType<typeof setup>>,
  reason: ContinuousStopReason,
) {
  expect(await readFile(continuousPaths(t.root).stop, "utf8")).toBe(
    `${reason}\n`,
  );
  const campaigns = t.calls.length;
  const forbidden = async () => {
    throw new Error("a stopped restart must do no work");
  };
  t.deps.legacyHistoryAvailable = forbidden;
  t.deps.preflight = forbidden;
  t.deps.cleanupLeftovers = forbidden;
  t.deps.select = forbidden;
  t.deps.runCampaign = forbidden;
  expect(await createContinuousRunner(t.deps).run()).toBe(reason);
  expect(t.calls).toHaveLength(campaigns);
}

describe("continuous runner", () => {
  it("consumes verification work while a discovery batch is running", async () => {
    let campaignStarted!: () => void;
    let finishCampaign!: () => void;
    const started = new Promise<void>((resolve) => {
      campaignStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finishCampaign = resolve;
    });
    let verifiedDuringCampaign = false;
    const t = await setup(
      [
        async () => {
          campaignStarted();
          await finished;
          return {};
        },
      ],
      {
        verifyConcurrency: 1,
        verifyNext: async () => {
          await started;
          verifiedDuringCampaign = true;
          finishCampaign();
          return null;
        },
      },
    );
    expect(await t.runner.run()).toBe("operator");
    expect(verifiedDuringCampaign).toBe(true);
  });

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
      expect(t.calls[0]?.resumeProviderLimited).toBeUndefined();
      expect(
        t.calls
          .slice(1, -1)
          .every((call) => call.resumeProviderLimited !== undefined),
      ).toBe(true);
      expect(
        t.calls.slice(1).every((call) => call.retryIncompleteVerifications),
      ).toBe(true);
    },
  );

  it("finishes a saved backoff after restart before offering provider-limited resume", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    steps.push(limited("rate-limit", t));
    steps.push(async (input) => {
      expect(t.hours()).toBe(5 / 60);
      expect(input.resumeProviderLimited).toBeDefined();
      return {};
    });
    const normalSleep = t.deps.sleep;
    t.deps.sleep = async () => {
      throw new Error("simulated runner crash during backoff");
    };
    await expect(t.runner.run()).rejects.toThrow("simulated runner crash");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.resumeProviderLimited).toBeUndefined();
    expect(
      JSON.parse(await readFile(continuousPaths(t.root).memo, "utf8")),
    ).toMatchObject({ state: "backoff", detail: { minutes: "5" } });
    t.deps.sleep = normalSleep;
    expect(await createContinuousRunner(t.deps).run()).toBe("operator");
    expect(t.calls).toHaveLength(3);
  });

  it("backs off before offering resume when another incomplete result masks a provider limit", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    steps.push(async ({ campaignId }) => {
      await t.trial(campaignId, {
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "rate-limit",
      });
      return { stopped: "incomplete" };
    });
    steps.push((input) => {
      expect(t.hours()).toBe(5 / 60);
      expect(input.resumeProviderLimited).toBeDefined();
      return {};
    });
    expect(await t.runner.run()).toBe("operator");
  });

  it("does not offer resume after a terminal incomplete marker", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    steps.push(async ({ campaignId }) => {
      await t.trial(campaignId, {
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "rate-limit",
      });
      await t.append(campaignId, {
        type: "target-skipped",
        selectionId: "wporg:x@1.0.0",
        stage: "discovery",
        reason: "run-failed",
        artifacts: [
          {
            kind: "target-skip-diagnostic",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      });
      return { stopped: "incomplete" };
    });
    steps.push((input) => {
      expect(t.hours()).toBe(0);
      expect(input.resumeProviderLimited).toBeUndefined();
      return {};
    });
    expect(await t.runner.run()).toBe("operator");
  });

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

  it("hands the campaign the live limit file and logs the effective limit it reports", async () => {
    const seen: (number | null)[] = [];
    const t = await setup([
      async (input) => {
        const { targetLimit } = input as Parameters<
          ContinuousDeps["runCampaign"]
        >[0];
        seen.push(await targetLimit.read());
        await writeFile(continuousPaths(t.root).concurrency, "2\n");
        seen.push(await targetLimit.read());
        targetLimit.report?.(2);
        return {};
      },
    ]);
    await t.runner.run();
    expect(seen).toEqual([null, 2]);
    expect(t.log).toContain(
      "2026-10-20T00:00:00.000Z concurrency effective=2 campaign=prod-20261020-1",
    );
  });

  it("hands the campaign each runtime's live limit file and logs the effective runtime limit", async () => {
    const seen: (number | null)[] = [];
    const t = await setup([
      async (input) => {
        const { targetLimit } = input as Parameters<
          ContinuousDeps["runCampaign"]
        >[0];
        seen.push(await targetLimit.readRuntime!("claude"));
        await writeFile(`${continuousPaths(t.root).concurrency}.claude`, "0\n");
        seen.push(await targetLimit.readRuntime!("claude"));
        seen.push(await targetLimit.readRuntime!("codex"));
        targetLimit.reportRuntime?.("claude", 0);
        return {};
      },
    ]);
    await t.runner.run();
    expect(seen).toEqual([null, 0, null]);
    expect(t.log).toContain(
      "2026-10-20T00:00:00.000Z concurrency runtime=claude effective=0 campaign=prod-20261020-1",
    );
  });

  it("refuses to resume while another runner pid is live", async () => {
    const t = await setup([], { pidAlive: (pid) => pid === 7 });
    await writeFile(continuousPaths(t.root).pid, "7");
    await writeFile(continuousPaths(t.root).stop, "");
    await expect(t.runner.run({ resume: true })).rejects.toThrow(
      "already running as pid 7",
    );
    expect(existsSync(continuousPaths(t.root).stop)).toBe(true);
  });

  it("keeps a stop marker after a dead pid until explicit resume", async () => {
    let selects = 0;
    let cleanups = 0;
    const t = await setup([async () => ({})], {
      pidAlive: () => false,
      select: async () => (
        selects++,
        { batchId: "selection-1", targets: ["a"] }
      ),
      cleanupLeftovers: async () => ++cleanups,
    });
    await writeFile(continuousPaths(t.root).pid, "8");
    await writeFile(continuousPaths(t.root).stop, "");
    expect(await t.runner.run()).toBe("operator");
    expect({ selects, cleanups, campaigns: t.calls.length }).toEqual({
      selects: 0,
      cleanups: 0,
      campaigns: 0,
    });
    expect(existsSync(continuousPaths(t.root).stop)).toBe(true);
    expect(await t.runner.run({ resume: true })).toBe("operator");
    expect(t.calls).toHaveLength(2);
    expect(cleanups).toBe(2);
    expect(existsSync(continuousPaths(t.root).stop)).toBe(true);
  });

  it("does not resume a crashed campaign until the owner clears its marker", async () => {
    const t = await setup([async () => ({})]);
    await writeFile(
      continuousPaths(t.root).memo,
      JSON.stringify({ campaignId: "prod-20261019-4", target: null }),
    );
    await writeFile(continuousPaths(t.root).pid, "8");
    await writeFile(continuousPaths(t.root).stop, "");
    expect(await t.runner.run()).toBe("operator");
    expect(t.calls).toHaveLength(0);
    expect(await createContinuousRunner(t.deps).run({ resume: true })).toBe(
      "operator",
    );
    expect(t.calls[0]).toMatchObject({
      campaignId: "prod-20261019-4",
      retryIncompleteVerifications: true,
    });
  });

  it("does not start a cleanup after the operator stops an active campaign", async () => {
    let cleanups = 0;
    const steps: Step[] = [];
    const t = await setup(steps, {
      cleanupLeftovers: async () => ++cleanups,
    });
    steps.push(async () => {
      await writeFile(continuousPaths(t.root).stop, "");
      return {};
    });
    expect(await t.runner.run()).toBe("operator");
    expect(cleanups).toBe(1); // Startup sweep only.
    expect(t.calls).toHaveLength(1);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "drains on %s without latching an operator stop",
    async (signal) => {
      let send: () => void = () => undefined;
      const steps: Step[] = [
        () => (send(), {}),
        () => ({ stopped: "operator" }),
      ];
      const t = await setup(steps, {
        signals: {
          on(name: string, listener: () => void) {
            if (name === signal) send = listener;
            return process;
          },
          off: () => process,
        } as never,
      });
      expect(await t.runner.run()).toBe("operator");
      expect(existsSync(continuousPaths(t.root).stop)).toBe(false);
      expect(await createContinuousRunner(t.deps).run()).toBe("operator");
      expect(t.calls[1]).toMatchObject({
        campaignId: t.calls[0]?.campaignId,
        retryIncompleteVerifications: true,
      });
      expect(existsSync(continuousPaths(t.root).stop)).toBe(false);
    },
  );

  it("aborts the in-flight campaign on SIGTERM before recording operator stop", async () => {
    let send: () => void = () => undefined;
    let activeStopped = false;
    const t = await setup(
      [
        async ({ signal }) => {
          setTimeout(() => send(), 10);
          await new Promise<void>((resolve) =>
            signal?.addEventListener(
              "abort",
              () => {
                activeStopped = true;
                resolve();
              },
              { once: true },
            ),
          );
          return { stopped: "operator" };
        },
      ],
      {
        signals: {
          on(name: string, listener: () => void) {
            if (name === "SIGTERM") send = listener;
            return process;
          },
          off: () => process,
        } as never,
      },
    );
    await expect(t.runner.run()).resolves.toBe("operator");
    expect(activeStopped).toBe(true);
    expect(t.log.at(-1)).toMatch(/ stopped reason=operator$/);
  });

  it("resumes the unfinished campaign under its id, resuming runs whose host died", async () => {
    const steps: Step[] = [
      async (input) => {
        input.resumeInterrupted?.log("interrupted run=run-1 resumed as run-2");
        return {};
      },
    ];
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
    // The profile's resume lines reach the runner log with a timestamp (ADR 0036).
    expect(t.log).toContain(
      "2026-10-20T00:00:00.000Z interrupted run=run-1 resumed as run-2",
    );
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
    await expectLatchedStop(t, "errors");
  });

  it("holds after a batch whose every target was refused, then probes one target", async () => {
    const steps: Step[] = [];
    const t = await setup(steps);
    steps.push(async ({ campaignId }) => {
      await t.trial(campaignId, { outcome: "failed", reason: "provider" });
      await t.append(campaignId, {
        type: "target-skipped",
        selectionId: "wporg:a@1.0.0",
        stage: "discovery",
        reason: "provider-refused",
      });
      return {};
    });
    steps.push(async ({ campaignId }) => {
      await t.trial(campaignId, { outcome: "completed" });
      return {};
    });
    expect(await t.runner.run()).toBe("operator");
    expect(t.states()).toContain("holding-refusals");
    expect(t.calls.map((call) => call.target)).toEqual([null, "a", null]);
  });

  it("holds after two batches without a completed Trial and stops at the third", async () => {
    let preflights = 0;
    const steps: Step[] = [];
    const t = await setup(steps, { preflight: async () => void preflights++ });
    const failed: Step = async ({ campaignId }) => {
      await t.trial(campaignId, { outcome: "failed", reason: "sandbox" });
      return {};
    };
    steps.push(failed, failed, failed);
    expect(await t.runner.run()).toBe("no-progress");
    expect(t.states().filter((state) => state.startsWith("holding"))).toEqual([
      "holding-no-progress",
    ]);
    // Once at start, once more before the hold.
    expect(preflights).toBe(2);
    await expectLatchedStop(t, "no-progress");
  });

  it("sleeps a day on an empty pool, retries a failed listing hourly, and stops exhausted on the third empty day", async () => {
    const results = ["unavailable", "available", "available", "available"];
    const t = await setup([], {
      select: async () => ({
        batchId: null,
        targets: [],
        sourceStatus: results.shift()!,
      }),
    });
    expect(await t.runner.run()).toBe("exhausted");
    expect(
      t.log.filter((line) => line.includes("reason=listing-unavailable")),
    ).toHaveLength(1);
    expect(t.hours()).toBe(1 + 2 * 24);
    await expectLatchedStop(t, "exhausted");
  });

  it("waits for a renewed login without exiting", async () => {
    const t = await setup([]);
    const start = t.deps.clock().getTime();
    const renewedAt = start + 25 * 60_000;
    t.deps.readAuth = async () => ({
      expiresAt: new Date(
        t.deps.clock().getTime() >= renewedAt
          ? renewedAt + 86_400_000
          : start + 60_000,
      ),
    });
    expect(await createContinuousRunner(t.deps).run()).toBe("operator");
    expect(
      t.states().filter((state) => state === "waiting-login"),
    ).toHaveLength(1);
    expect(t.hours()).toBe(0.5);
  });

  it("holds hourly while the disk is low", async () => {
    let checks = 0;
    const t = await setup([], {
      statfs: async () => ({
        freeBytes: checks++ < 2 ? 1024 ** 3 : 100 * 1024 ** 3,
      }),
    });
    expect(await t.runner.run()).toBe("operator");
    expect(
      t.states().filter((state) => state === "holding-disk-low"),
    ).toHaveLength(1);
    expect(t.hours()).toBe(2);
  });

  it.each([
    [
      "programme-stale",
      { programmeObservedAt: async () => new Date("2026-09-01T00:00:00Z") },
    ],
    ["legacy-history-missing", { legacyHistoryAvailable: async () => false }],
  ] as const)("stops as %s before any campaign", async (reason, override) => {
    const t = await setup([], override);
    expect(await t.runner.run()).toBe(reason);
    expect(t.calls).toHaveLength(0);
    expect(t.notified.at(-1)).toContain(`reason=${reason}`);
    await expectLatchedStop(t, reason);
  });

  it("runs an unbound batch left by a crash before selecting again", async () => {
    let selects = 0;
    const t = await setup([async () => ({})], {
      select: async () => (
        selects++,
        { batchId: "selection-9", targets: ["a"] }
      ),
    });
    await t.append("selection-1", {
      type: "target-selected",
      selectionId: "wporg:a@1.0.0",
    });
    await t.runner.run();
    expect(t.calls[0]).toMatchObject({
      campaignId: "prod-20261020-1",
      retryIncompleteVerifications: false,
    });
    expect(selects).toBe(1);
  });
});
