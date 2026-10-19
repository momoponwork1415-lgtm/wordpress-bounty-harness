import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  clearContinuousStop,
  continuousPaths,
  createContinuousRunner,
  exploreTrials,
  labSweepHeld,
  liveRuntimeConcurrencies,
  pidAlive,
  readContinuousConcurrency,
  readContinuousRuntimeConcurrency,
  readContinuousMemo,
  readContinuousStopReason,
  readLivePid,
  requestContinuousStop,
  writeContinuousConcurrency,
} from "./continuous.js";
import type { CliIo, CliProfile, CliState } from "./index.js";

export type ContinuousHostStatus = {
  readonly loginExpiresAt: Date | null;
  readonly programmeObservedAt: Date;
  readonly freeBytes: number;
  readonly legacyHistoryAvailable: boolean;
  /** ceil(maximumTargets / maxConcurrentTargets) × (runWallTimeMinutes + 30 × 3 + 15). */
  readonly loginMarginMinutes: number;
};

const SELECT_MINIMUM = 1;

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

/** Counts for `continuous status`, from the ledger only. */
export function continuousCounts(
  state: Pick<CliState, "ledger">,
  since: string,
) {
  const { started, finished, notTrials, superseded } = exploreTrials(
    state.ledger,
    { since },
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
    // SPEC §6: provider-limited and bootstrap-only runs are not Trials, nor
    // an unfinished run that a restarted campaign ran again (ADR 0036).
    trials: started - notTrials - superseded,
    completed: finished.filter((outcome) => outcome === "completed").length,
    providerLimited: finished.filter(
      (outcome) => outcome === "provider-limited",
    ).length,
    providerRefused: skipped("provider-refused"),
    runFailed: skipped("run-failed"),
    labFailed: stops
      .filter((row) => row.type === "lab-provisioned")
      .reduce((sum, row) => sum + row.count, 0),
    // Running now, or dead and still resumable with `campaign resume`.
    unsettled: started - finished.length - superseded,
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
    readonly verifyConcurrency?: number;
    /** Positionals after the subcommand: `continuous concurrency <n>`. */
    readonly rest?: readonly string[];
    /** `continuous concurrency --runtime <name>`: one runtime's live limit. */
    readonly runtime?: string | undefined;
  },
): Promise<number> {
  const { state, profile, io } = context;
  const paths = continuousPaths(state.stateDirectory);
  if (context.runtime !== undefined && sub !== "concurrency")
    throw new Error("--runtime is only valid with continuous concurrency");
  if (sub === "concurrency" && context.runtime !== undefined) {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    if (context.configPath === undefined)
      throw new Error("continuous concurrency needs --config");
    if (profile.runtimeCeilings === undefined)
      throw new Error("This profile has no runtime caps");
    const runtime = context.runtime;
    const ceiling = (await profile.runtimeCeilings(context.configPath))[
      runtime
    ];
    if (ceiling === undefined)
      throw new Error(
        `runtime ${runtime} has no cap in resources.maxConcurrentTargetsByRuntime`,
      );
    const live = await readContinuousRuntimeConcurrency(
      state.stateDirectory,
      runtime,
    );
    const current = Math.min(live ?? ceiling, ceiling);
    const rest = context.rest ?? [];
    if (rest.length === 0) {
      io.stdout(
        `concurrency runtime=${runtime} ${current}  ceiling ${ceiling}  live ${live ?? "unset"}`,
      );
      return 0;
    }
    const value = rest[0]!;
    if (rest.length > 1 || !/^\d{1,3}$/.test(value) || Number(value) > ceiling)
      throw new Error(
        `concurrency of ${runtime} must be an integer from 0 to ${ceiling}`,
      );
    await writeContinuousConcurrency(
      state.stateDirectory,
      Number(value),
      runtime,
    );
    const line = `${state.clock().toISOString()} concurrency runtime=${runtime} ${current}->${Number(value)}`;
    appendFileSync(paths.log, `${line}\n`, { mode: 0o600 });
    io.stdout(line);
    io.stdout(
      "the runner applies it before its next target start; running Trials go on",
    );
    return 0;
  }
  if (sub === "concurrency") {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    if (context.configPath === undefined)
      throw new Error("continuous concurrency needs --config");
    if (profile.targetCeiling === undefined)
      throw new Error("This profile has no target ceiling");
    const ceiling = await profile.targetCeiling(context.configPath);
    const live = await readContinuousConcurrency(state.stateDirectory);
    const current = Math.min(live ?? ceiling, ceiling);
    const rest = context.rest ?? [];
    if (rest.length === 0) {
      io.stdout(
        `concurrency ${current}  ceiling ${ceiling}  live ${live ?? "unset"}`,
      );
      const caps = (await profile.runtimeCeilings?.(context.configPath)) ?? {};
      for (const [runtime, cap] of Object.entries(caps)) {
        const runtimeLive = await readContinuousRuntimeConcurrency(
          state.stateDirectory,
          runtime,
        );
        io.stdout(
          `concurrency runtime=${runtime} ${Math.min(runtimeLive ?? cap, cap)}  ceiling ${cap}  live ${runtimeLive ?? "unset"}`,
        );
      }
      return 0;
    }
    const value = rest[0]!;
    if (
      rest.length > 1 ||
      !/^\d{1,3}$/.test(value) ||
      Number(value) < 1 ||
      Number(value) > ceiling
    )
      throw new Error(`concurrency must be an integer from 1 to ${ceiling}`);
    await writeContinuousConcurrency(state.stateDirectory, Number(value));
    const line = `${state.clock().toISOString()} concurrency ${current}->${Number(value)}`;
    appendFileSync(paths.log, `${line}\n`, { mode: 0o600 });
    io.stdout(line);
    io.stdout(
      "the runner applies it before its next target start; running Trials go on",
    );
    return 0;
  }
  if (sub === "resume") {
    if (context.resume)
      throw new Error("--resume is only valid with continuous run");
    const pid = await readLivePid(paths.pid);
    if (pid !== null)
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
    const memo = await readContinuousMemo(state.stateDirectory);
    const livePid = await readLivePid(paths.pid);
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
    // Unset means the config's maxConcurrentTargets.
    const live = await readContinuousConcurrency(state.stateDirectory);
    if (live !== null) io.stdout(`concurrency live ${live}`);
    for (const { runtime, limit } of await liveRuntimeConcurrencies(
      state.stateDirectory,
    ))
      io.stdout(`concurrency live runtime=${runtime} ${limit}`);
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
        `${label}  trials ${c.trials}  completed ${c.completed}  provider-limited ${c.providerLimited}  provider-refused ${c.providerRefused}  run-failed ${c.runFailed}  lab-failed ${c.labFailed}  unsettled ${c.unsettled}  findings queue ${c.queue} + parked ${c.parked}`,
      );
    }
    return ["stopped", "stopping", "stale"].includes(displayState) ? 1 : 0;
  }
  if (sub !== "run") return 2;
  const verifyConcurrency = context.verifyConcurrency ?? 1;
  if (
    !Number.isSafeInteger(verifyConcurrency) ||
    verifyConcurrency < 1 ||
    verifyConcurrency > 8
  )
    throw new Error("--verify-concurrency must be an integer from 1 to 8");
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
  let activeVerification = 0;
  const runner = createContinuousRunner({
    stateDirectory: state.stateDirectory,
    campaignPrefix: context.campaignPrefix,
    ledger: state.ledger,
    verifyConcurrency,
    ...(profile.verifyNext === undefined
      ? {}
      : {
          verifyNext: async () => {
            activeVerification++;
            try {
              return await profile.verifyNext!(state, {
                configPath,
                campaignPrefix: context.campaignPrefix,
              });
            } finally {
              activeVerification--;
            }
          },
        }),
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
    // An operator's Lab (`lab up`, `lab up --for-review`) outlives a sweep.
    async cleanupLeftovers() {
      if (activeVerification > 0) return 0;
      if (await labSweepHeld(state.stateDirectory)) return 0;
      if (await profile.labHeld(state)) return 0;
      const removed = await profile.cleanupLeftovers(state, {
        configPath,
        remove: true,
      });
      return (
        removed.containers.length +
        removed.networks.length +
        removed.volumes.length
      );
    },
    async preflight() {
      const items = await profile.checkRuntime(state, { configPath });
      if (items.some(({ profile: pinned, image }) => pinned !== image))
        throw new Error("The runtime check differs from the runtime profile");
    },
    legacyHistoryAvailable: async () => (await host()).legacyHistoryAvailable,
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
  // All seven named stops are intentional. Restart=on-failure is for crashes.
  return 0;
}
