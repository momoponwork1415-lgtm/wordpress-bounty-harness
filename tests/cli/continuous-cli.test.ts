import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { continuousCommand } from "../../src/cli/continuous-cli.js";
import {
  continuousPaths,
  holdLabSweep,
  labSweepHeld,
  requestContinuousStop,
} from "../../src/cli/continuous.js";
import type { CliIo, CliProfile, CliState } from "../../src/cli/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Wednesday; the week line counts from Monday 2026-10-19. */
const NOW = "2026-10-21T12:00:00Z";

const unused = (name: string) => () => {
  throw new Error(`${name} must not be called by this command`);
};

/** Every profile method refuses until a test replaces it. */
function fakeProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    review: unused("review"),
    historyStatus: unused("historyStatus"),
    select: unused("select"),
    runCampaign: unused("runCampaign"),
    labHeld: unused("labHeld"),
    cleanupLeftovers: unused("cleanupLeftovers"),
    checkRuntime: unused("checkRuntime"),
    reverify: unused("reverify"),
    stateDiffReader: unused("stateDiffReader"),
    httpEvidenceReader: unused("httpEvidenceReader"),
    labDown: unused("labDown"),
    ...overrides,
  } as CliProfile;
}

async function setup(
  makeProfile: CliProfile | ((stateDirectory: string) => CliProfile),
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-continuous-cli-"));
  roots.push(root);
  const profile =
    typeof makeProfile === "function" ? makeProfile(root) : makeProfile;
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 4,
    maxBytes: 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  let ids = 0;
  const state: CliState = {
    ledger,
    store,
    stateDirectory: root,
    clock: () => new Date(NOW),
    newId: () => `id-${++ids}`,
  };
  const stdout: string[] = [];
  const io: CliIo = {
    stdout: (line) => stdout.push(line),
    stderr: unused("stderr"),
  };
  const command = (
    sub: string,
    options: Partial<Parameters<typeof continuousCommand>[1]> = {},
  ) =>
    continuousCommand(sub, {
      state,
      profile,
      io,
      configPath: undefined,
      selectionPath: undefined,
      campaignPrefix: "prod",
      notify: undefined,
      resume: false,
      ...options,
    });
  /** One explore Trial (or a run of another kind) at an instant, with its finish unless `null`. */
  const run = async (
    campaignId: string,
    occurredAt: string,
    finished: object | null,
    runKind: "explore" | "child" = "explore",
  ) => {
    const runId = `run-${++ids}`;
    const append = (rest: Record<string, unknown>) =>
      ledger.append({
        schemaVersion: 1,
        identity: `event-${++ids}`,
        campaignId,
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        occurredAt,
        ...rest,
      } as LedgerEventInput);
    await append({
      type: "discovery-run-started",
      runId,
      labId: "lab",
      runKind,
      history: { mode: "none" },
      configuration: { promptVariant: "v8", assignmentUnit: "cooperative" },
    });
    if (finished === null) return;
    await append({
      type: "discovery-run-finished",
      runId,
      costUsd: "unavailable",
      wallTimeMs: 1,
      ...finished,
    });
  };
  return { root, state, stdout, command, run, paths: continuousPaths(root) };
}

const RUN_OPTIONS = {
  configPath: "/config.json",
  selectionPath: "/policies/selection.json",
};

/** A host whose checks all pass, so the runner reaches the step under test. */
function hostProfile(
  overrides: Partial<CliProfile> & {
    readonly stateDirectory: string;
    readonly sweeps: string[];
  },
): CliProfile {
  const { stateDirectory, sweeps, ...rest } = overrides;
  return fakeProfile({
    hostStatus: async () => ({
      loginExpiresAt: new Date("2027-01-01T00:00:00Z"),
      programmeObservedAt: new Date(NOW),
      freeBytes: 100 * 1024 ** 3,
      legacyHistoryAvailable: true,
      loginMarginMinutes: 60,
    }),
    labHeld: async () => false,
    checkRuntime: async () => [],
    async cleanupLeftovers(_state, input) {
      sweeps.push(input.remove ? "remove" : "list");
      return { containers: ["c"], networks: [], volumes: [] };
    },
    // The operator stops at the first selection; the sweep before it is what matters.
    async select() {
      requestContinuousStop(stateDirectory);
      return { batchId: null, selected: [], excluded: [] };
    },
    ...rest,
  });
}

describe("continuous status", () => {
  it("reports never-started with zero counts when nothing has run", async () => {
    const t = await setup(fakeProfile());
    expect(await t.command("status")).toBe(0);
    expect(t.stdout).toEqual([
      "state never-started  pid none",
      "today  trials 0  completed 0  provider-limited 0  provider-refused 0  run-failed 0  lab-failed 0  unsettled 0  findings queue 0 + parked 0",
      "week  trials 0  completed 0  provider-limited 0  provider-refused 0  run-failed 0  lab-failed 0  unsettled 0  findings queue 0 + parked 0",
    ]);
  });

  it("counts explore Trials from the ledger for today and this week only, leaving provider-limited runs out of trials", async () => {
    const t = await setup(fakeProfile());
    await t.run("prod-20261021-1", "2026-10-21T01:00:00Z", {
      outcome: "completed",
    });
    await t.run(
      "prod-20261021-1",
      "2026-10-21T01:00:00Z",
      { outcome: "completed" },
      "child",
    );
    await t.run("prod-20261019-1", "2026-10-19T01:00:00Z", {
      outcome: "provider-limited",
      reason: "provider",
      providerLimit: "quota",
    });
    await t.run("prod-20261001-1", "2026-10-01T01:00:00Z", {
      outcome: "completed",
    });
    expect(await t.command("status")).toBe(0);
    expect(t.stdout[1]).toBe(
      "today  trials 1  completed 1  provider-limited 0  provider-refused 0  run-failed 0  lab-failed 0  unsettled 0  findings queue 0 + parked 0",
    );
    expect(t.stdout[2]).toBe(
      "week  trials 1  completed 1  provider-limited 1  provider-refused 0  run-failed 0  lab-failed 0  unsettled 0  findings queue 0 + parked 0",
    );
  });

  it("leaves an unfinished run that a restarted campaign ran again out of trials and unsettled", async () => {
    const t = await setup(fakeProfile());
    // The host died during the first run; the restarted runner ran the target again.
    await t.run("prod-20261021-1", "2026-10-21T01:00:00Z", null);
    await t.run("prod-20261021-1", "2026-10-21T03:00:00Z", {
      outcome: "completed",
    });
    // Another campaign's run died and was not run again: resumable, so unsettled.
    await t.run("prod-20261021-2", "2026-10-21T04:00:00Z", null);
    expect(await t.command("status")).toBe(0);
    expect(t.stdout[1]).toBe(
      "today  trials 2  completed 1  provider-limited 0  provider-refused 0  run-failed 0  lab-failed 0  unsettled 1  findings queue 0 + parked 0",
    );
  });

  it("shows the memo's state as stale without a live pid, and live with one", async () => {
    const t = await setup(fakeProfile());
    await writeFile(
      t.paths.memo,
      JSON.stringify({
        state: "running",
        detail: { campaignId: "crashed" },
        lastError: "boom",
      }),
    );
    expect(await t.command("status")).toBe(1);
    expect(t.stdout.slice(0, 2)).toEqual([
      "state stale  campaignId crashed  pid none",
      "last error boom",
    ]);
    t.stdout.length = 0;
    await writeFile(t.paths.pid, String(process.pid));
    expect(await t.command("status")).toBe(0);
    expect(t.stdout[0]).toBe(
      `state running  campaignId crashed  pid ${process.pid}`,
    );
  });

  it("refuses a malformed memo instead of guessing a state", async () => {
    const t = await setup(fakeProfile());
    await writeFile(t.paths.memo, JSON.stringify({ state: 5, detail: {} }));
    await expect(t.command("status")).rejects.toThrow(/memo .* is malformed/);
  });

  it("rejects --resume outside continuous run", async () => {
    const t = await setup(fakeProfile());
    for (const sub of ["status", "stop", "resume"])
      await expect(t.command(sub, { resume: true })).rejects.toThrow(
        "--resume is only valid with continuous run",
      );
  });
});

describe("continuous stop and resume", () => {
  it("latches an operator stop that status reports until resume clears it", async () => {
    const t = await setup(fakeProfile());
    expect(await t.command("stop")).toBe(0);
    expect(t.stdout).toEqual([
      "stop requested; the runner drains at the next target boundary",
    ]);
    expect(await readFile(t.paths.stop, "utf8")).toBe("operator\n");
    t.stdout.length = 0;
    expect(await t.command("status")).toBe(1);
    expect(t.stdout[0]).toBe("state stopped  reason operator  pid none");
    t.stdout.length = 0;
    expect(await t.command("resume")).toBe(0);
    expect(t.stdout).toEqual([
      "stop request cleared; start continuous run to resume",
    ]);
    await expect(stat(t.paths.stop)).rejects.toThrow();
    t.stdout.length = 0;
    expect(await t.command("resume")).toBe(0);
    expect(t.stdout).toEqual(["no stop request to clear"]);
  });

  it("reports stopping while the runner pid lives and refuses to resume", async () => {
    const t = await setup(fakeProfile());
    await t.command("stop");
    await writeFile(t.paths.pid, String(process.pid));
    t.stdout.length = 0;
    expect(await t.command("status")).toBe(1);
    expect(t.stdout[0]).toBe(
      `state stopping  reason operator  pid ${process.pid}`,
    );
    await expect(t.command("resume")).rejects.toThrow(
      `continuous run is still running as pid ${process.pid}`,
    );
    // A dead pid in the file is no runner.
    await writeFile(t.paths.pid, "999999");
    expect(await t.command("resume")).toBe(0);
  });

  it("returns 2 for an unknown subcommand", async () => {
    const t = await setup(fakeProfile());
    expect(await t.command("pause")).toBe(2);
  });
});

describe("continuous run", () => {
  it("checks its arguments before touching the host", async () => {
    const t = await setup(fakeProfile());
    await expect(t.command("run")).rejects.toThrow(
      "continuous run needs --config and --selection",
    );
    await expect(
      t.command("run", { ...RUN_OPTIONS, verifyConcurrency: 9 }),
    ).rejects.toThrow("--verify-concurrency must be an integer from 1 to 8");
    await expect(
      t.command("run", { ...RUN_OPTIONS, campaignPrefix: "selection-x" }),
    ).rejects.toThrow("--campaign-prefix must be a short slug");
    await expect(t.command("run", RUN_OPTIONS)).rejects.toThrow(
      "continuous run needs a host profile",
    );
  });

  it("stops when the host status says the legacy history is missing", async () => {
    const sweeps: string[] = [];
    const t = await setup(
      hostProfile({
        stateDirectory: "unused",
        sweeps,
        hostStatus: async () => ({
          loginExpiresAt: null,
          programmeObservedAt: new Date(NOW),
          freeBytes: 0,
          legacyHistoryAvailable: false,
          loginMarginMinutes: 60,
        }),
      }),
    );
    expect(await t.command("run", RUN_OPTIONS)).toBe(0);
    expect(await readFile(t.paths.stop, "utf8")).toBe(
      "legacy-history-missing\n",
    );
    expect(sweeps).toEqual([]);
  });

  it("sweeps leftovers through the profile when no operator Lab is held", async () => {
    const sweeps: string[] = [];
    const t = await setup((stateDirectory) =>
      hostProfile({ stateDirectory, sweeps }),
    );
    expect(await t.command("run", RUN_OPTIONS)).toBe(0);
    expect(sweeps).toEqual(["remove"]);
    expect(t.stdout.at(-1)).toMatch(/ stopped reason=operator$/);
  });

  it("keeps the sweep held until every holder has released it", async () => {
    const t = await setup(fakeProfile());
    const first = await holdLabSweep(t.root, process.pid);
    const second = await holdLabSweep(t.root, process.ppid);
    await first();
    expect(await labSweepHeld(t.root)).toBe(true);
    await second();
    expect(await labSweepHeld(t.root)).toBe(false);
    // A holder whose process died no longer holds the sweep.
    await holdLabSweep(t.root, process.pid);
    expect(await labSweepHeld(t.root, () => false)).toBe(false);
  });

  it("skips the sweep while the profile holds a Lab or a review Lab pid lives", async () => {
    for (const hold of ["profile", "review-lab"] as const) {
      const sweeps: string[] = [];
      const t = await setup((stateDirectory) =>
        hostProfile({
          stateDirectory,
          sweeps,
          labHeld: async () => hold === "profile",
        }),
      );
      const release =
        hold === "review-lab"
          ? await holdLabSweep(t.root, process.pid)
          : async () => undefined;
      expect(await t.command("run", RUN_OPTIONS)).toBe(0);
      await release();
      expect(sweeps).toEqual([]);
    }
  });
});
