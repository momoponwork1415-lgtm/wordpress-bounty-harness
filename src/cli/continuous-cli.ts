import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  clearContinuousStop,
  continuousPaths,
  createContinuousRunner,
  readContinuousStopReason,
  requestContinuousStop,
  type ContinuousMemo,
} from "./continuous.js";
import type { CliIo, CliProfile, CliState } from "./index.js";

export type ContinuousHostStatus = {
  readonly loginExpiresAt: Date | null;
  readonly programmeObservedAt: Date;
  readonly freeBytes: number;
  readonly legacyHistoryAvailable: boolean;
  /** maximumTargets × (runWallTimeMinutes + 30 × 3 + 15). */
  readonly loginMarginMinutes: number;
};

const SELECT_MINIMUM = 1;
const FLOOR_POLICIES = ["selection.50000.json", "selection.30000.json"];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One line on the notify command's standard input; its failure never stops the runner. */
function notify(command: string, line: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: "pipe" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
    // A command that never reads its input closes the pipe first (EPIPE).
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${line}\n`);
  });
}

/** A review Lab must outlive a runner sweep (`lab up`, `lab up --for-review`). */
async function reviewLabLive(stateDirectory: string): Promise<boolean> {
  if (await stat(join(stateDirectory, "lab-up.json")).catch(() => null))
    return true;
  const pid = Number(
    await readFile(join(stateDirectory, "review-lab.pid"), "utf8").catch(
      () => "0",
    ),
  );
  return pid > 0 && pidAlive(pid);
}

/** Counts for `continuous status`, from the ledger only. */
export function continuousCounts(
  state: Pick<CliState, "ledger">,
  since: string,
) {
  const all = (type: "discovery-run-started" | "discovery-run-finished") => {
    const events = [];
    for (let afterSequence = 0; ;) {
      const page = state.ledger.read({
        type,
        since,
        afterSequence,
        limit: 1000,
      });
      events.push(...page.map(({ event }) => event));
      if (page.length < 1000) return events;
      afterSequence = page.at(-1)!.sequence;
    }
  };
  const explore = new Set(
    all("discovery-run-started").flatMap((event) =>
      event.type === "discovery-run-started" &&
      (event.runKind ?? "explore") === "explore"
        ? [`${event.campaignId} ${event.runId}`]
        : [],
    ),
  );
  const finished = all("discovery-run-finished").flatMap((event) =>
    event.type === "discovery-run-finished" &&
    explore.has(`${event.campaignId} ${event.runId}`)
      ? [event.outcome]
      : [],
  );
  const stops = state.ledger.stops({ since });
  const skipped = (reason: string) =>
    stops
      .filter(
        (row) => row.type === "target-skipped" && row.fields.reason === reason,
      )
      .reduce((sum, row) => sum + row.count, 0);
  const funnel = state.ledger.funnel(undefined, { since });
  return {
    started: explore.size,
    completed: finished.filter((outcome) => outcome === "completed").length,
    providerLimited: finished.filter(
      (outcome) => outcome === "provider-limited",
    ).length,
    providerRefused: skipped("provider-refused"),
    runFailed: skipped("run-failed"),
    labFailed: stops
      .filter((row) => row.type === "lab-provisioned")
      .reduce((sum, row) => sum + row.count, 0),
    unsettled: explore.size - finished.length,
    queue: funnel.raw,
    parked: funnel.parked,
  };
}

export async function continuousCommand(
  sub: string,
  context: {
    readonly state: CliState;
    readonly profile: CliProfile;
    readonly io: CliIo;
    readonly configPath: string | undefined;
    readonly selectionPath: string | undefined;
    readonly campaignPrefix: string;
    readonly notify: string | undefined;
    readonly resume: boolean;
  },
): Promise<number> {
  const { state, profile, io } = context;
  const paths = continuousPaths(state.stateDirectory);
  if (sub === "resume") {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    const pid = Number(await readFile(paths.pid, "utf8").catch(() => "0"));
    if (pid > 0 && pidAlive(pid))
      throw new Error(`continuous run is still running as pid ${pid}`);
    const cleared = await clearContinuousStop(state.stateDirectory);
    io.stdout(
      cleared
        ? "stop request cleared; start continuous run to resume"
        : "no stop request to clear",
    );
    return 0;
  }
  if (sub === "stop") {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    requestContinuousStop(state.stateDirectory);
    io.stdout("stop requested; the runner drains at the next target boundary");
    return 0;
  }
  if (sub === "status") {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    const memo = JSON.parse(
      await readFile(paths.memo, "utf8").catch(() => "null"),
    ) as ContinuousMemo | null;
    const pid = Number(await readFile(paths.pid, "utf8").catch(() => "0"));
    const livePid = pid > 0 && pidAlive(pid) ? pid : null;
    const stopReason = await readContinuousStopReason(state.stateDirectory);
    const displayState =
      stopReason !== null
        ? livePid === null
          ? "stopped"
          : "stopping"
        : memo !== null && memo.state !== "stopped" && livePid === null
          ? "stale"
          : (memo?.state ?? "never-started");
    const displayDetail =
      stopReason !== null ? { reason: stopReason } : (memo?.detail ?? {});
    io.stdout(
      `state ${displayState}${Object.entries(displayDetail)
        .map(([key, value]) => `  ${key} ${value}`)
        .join("")}  pid ${livePid ?? "none"}`,
    );
    if (memo?.lastError !== undefined)
      io.stdout(`last error ${memo.lastError}`);
    const now = state.clock();
    const day = new Date(now.toISOString().slice(0, 10));
    const monday = new Date(
      day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000,
    );
    for (const [label, since] of [
      ["today", day],
      ["week", monday],
    ] as const) {
      const c = continuousCounts(state, since.toISOString());
      io.stdout(
        `${label}  trials ${c.started}  completed ${c.completed}  provider-limited ${c.providerLimited}  provider-refused ${c.providerRefused}  run-failed ${c.runFailed}  lab-failed ${c.labFailed}  unsettled ${c.unsettled}  findings queue ${c.queue} + parked ${c.parked}`,
      );
    }
    return ["stopped", "stopping", "stale"].includes(displayState) ? 1 : 0;
  }
  if (sub !== "run") return 2;
  const configPath = context.configPath;
  const selectionPath = context.selectionPath;
  if (configPath === undefined || selectionPath === undefined)
    throw new Error("continuous run needs --config and --selection");
  if (
    context.campaignPrefix.startsWith("selection-") ||
    !/^[a-z0-9][a-z0-9-]{0,40}$/.test(context.campaignPrefix)
  )
    throw new Error(
      "--campaign-prefix must be a short slug not starting with selection-",
    );
  const hostStatus = profile.hostStatus;
  if (hostStatus === undefined)
    throw new Error("continuous run needs a host profile");
  const host = () => hostStatus(state, { configPath, selectionPath });
  const runner = createContinuousRunner({
    stateDirectory: state.stateDirectory,
    campaignPrefix: context.campaignPrefix,
    ledger: state.ledger,
    async select() {
      const report = await profile.select(state, {
        configPath: selectionPath,
        minimum: SELECT_MINIMUM,
      });
      return {
        batchId: report.batchId,
        targets: report.selected.map(({ targetId }) =>
          targetId.slice(targetId.indexOf(":") + 1),
        ),
        ...(report.sourceStatus === undefined
          ? {}
          : { sourceStatus: report.sourceStatus }),
      };
    },
    runCampaign: (input) =>
      profile.runCampaign(state, {
        ...input,
        configPath,
        selectionPolicyPath: selectionPath,
      }),
    async cleanupLeftovers() {
      if (await reviewLabLive(state.stateDirectory))
        throw new Error(
          "A review Lab is active; stop it before continuous run",
        );
      const remaining = await profile.cleanupLeftovers(state, {
        configPath,
        remove: false,
      });
      const count =
        remaining.containers.length +
        remaining.networks.length +
        remaining.volumes.length;
      if (count > 0)
        throw new Error(
          `${count} Lab resources remain; inspect them with lab cleanup before continuous run`,
        );
      return 0;
    },
    async preflight() {
      const items = await profile.checkRuntime(state, { configPath });
      if (items.some(({ profile: pinned, image }) => pinned !== image))
        throw new Error("The runtime check differs from the runtime profile");
    },
    legacyHistoryAvailable: async () => (await host()).legacyHistoryAvailable,
    floorPolicyAvailable: async () =>
      (
        await Promise.all(
          FLOOR_POLICIES.map((name) =>
            stat(join(dirname(selectionPath), name)).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).every(Boolean),
    readAuth: async () => {
      const expiresAt = (await host()).loginExpiresAt;
      return expiresAt === null ? null : { expiresAt };
    },
    programmeObservedAt: async () => (await host()).programmeObservedAt,
    statfs: async () => ({ freeBytes: (await host()).freeBytes }),
    loginMarginMinutes: (await host()).loginMarginMinutes,
    clock: state.clock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signals: process,
    pidAlive,
    pid: process.pid,
    io: {
      log(line) {
        appendFileSync(paths.log, `${line}\n`, { mode: 0o600 });
        io.stdout(line);
      },
      ...(context.notify === undefined
        ? {}
        : { notify: (line: string) => notify(context.notify!, line) }),
    },
  });
  await runner.run({ resume: context.resume });
  // All named stops are intentional. Restart=on-failure is for crashes.
  return 0;
}
