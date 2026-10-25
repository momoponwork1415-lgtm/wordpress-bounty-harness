import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type {
  Ledger,
  LedgerEventV1,
  LedgerReadAllQuery,
} from "../ledger/index.js";
import {
  autoResumesProviderLimit,
  countsAsTrialChain,
  latestSegment,
  recordedTrialActivity,
  supersedingRun,
} from "../discovery/index.js";
import type { CampaignSummary, TargetLimit } from "./pipeline.js";

// Final design P6. Constants, not settings.
export const BACKOFF_RATE_LIMIT_MINUTES = [5, 10, 20, 40, 60] as const;
export const BACKOFF_QUOTA_MINUTES = [30, 60] as const;
export const QUOTA_LONG_SLEEP_HOURS = 6;
export const MAX_CONSECUTIVE_ERROR_BATCHES = 3;
export const ERROR_GAP_MINUTES = 10;
export const REFUSAL_HOLD_MINUTES = 60;
export const MAX_CONSECUTIVE_REFUSAL_BATCHES = 1;
export const MAX_CONSECUTIVE_NO_PROGRESS_BATCHES = 2;
export const NO_PROGRESS_HOLD_MINUTES = 60;
export const EMPTY_SLEEP_HOURS = 24;
export const EMPTY_DAYS_BEFORE_EXHAUSTED = 3;
export const LISTING_UNAVAILABLE_RETRY_MINUTES = 60;
export const LOGIN_POLL_MINUTES = 10;
export const MIN_FREE_GIB = 10;
export const DISK_RECHECK_MINUTES = 60;
export const PROGRAMME_STALE_DAYS = 35;
export const PROGRAMME_WARN_DAYS = 7;

const STOP_REASONS = [
  "operator",
  "errors",
  "no-progress",
  "programme-stale",
  "exhausted",
  "legacy-history-missing",
] as const;

export type ContinuousStopReason = (typeof STOP_REASONS)[number];

/**
 * The runner's working memo. The ledger stays the record; this file may be
 * deleted. Fields a saved memo lacks start over, so a hand-trimmed memo reads.
 */
const continuousMemoSchema = z.object({
  state: z.string().default("starting"),
  detail: z.record(z.string(), z.string()).default({}),
  campaignId: z.string().optional(),
  target: z.string().nullable().optional(),
  backoffStep: z.number().int().nonnegative().default(0),
  /** Per runtime, after a limit that stopped only its targets: its step and when it may start again. */
  runtimeBackoff: z
    .record(
      z.string(),
      z.object({ step: z.number().int().positive(), until: z.string() }),
    )
    .default({}),
  consecutiveErrorBatches: z.number().int().nonnegative().default(0),
  consecutiveRefusalBatches: z.number().int().nonnegative().default(0),
  consecutiveNoProgressBatches: z.number().int().nonnegative().default(0),
  consecutiveEmptyDays: z.number().int().nonnegative().default(0),
  /** After a refused batch, the next batch runs one target. */
  probe: z.boolean().default(false),
  lastError: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type ContinuousMemo = z.infer<typeof continuousMemoSchema>;

/** The saved memo, or null when none exists; a malformed memo is an error, not a state. */
export async function readContinuousMemo(
  stateDirectory: string,
): Promise<ContinuousMemo | null> {
  const raw = await readFile(
    continuousPaths(stateDirectory).memo,
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  const parsed = continuousMemoSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success)
    throw new Error(
      `The runner memo ${continuousPaths(stateDirectory).memo} is malformed: ${parsed.error.message}`,
    );
  return parsed.data;
}

/** Signal 0 probes without killing; EPERM means the pid exists under another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a marker file names, when that process is alive; null otherwise. */
export async function readLivePid(
  path: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<number | null> {
  const pid = Number(await readFile(path, "utf8").catch(() => "0"));
  return pid > 0 && alive(pid) ? pid : null;
}

/**
 * A process that owns discovery resources outside the runner (`campaign run`,
 * `campaign resume`) holds the runner's leftover sweep while its pid lives.
 * Each holder has its own file.
 */
export async function holdDiscoverySweep(
  stateDirectory: string,
  pid: number,
): Promise<() => Promise<void>> {
  const directory = continuousPaths(stateDirectory).sweepHolds;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, String(pid));
  await writeFile(path, String(pid), { mode: 0o600 });
  return () => rm(path, { force: true });
}

export async function discoverySweepHeld(
  stateDirectory: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<boolean> {
  const directory = continuousPaths(stateDirectory).sweepHolds;
  const names = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const name of names)
    if ((await readLivePid(join(directory, name), alive)) !== null) return true;
  return false;
}

export interface ContinuousDeps {
  readonly stateDirectory: string;
  readonly campaignPrefix: string;
  readonly ledger: Pick<Ledger, "readAll">;
  /** Freezes a batch of at least SELECT_MINIMUM targets, or none. */
  select(): Promise<{
    readonly batchId: string | null;
    /** Profile target names, in rank order. */
    readonly targets: readonly string[];
    readonly sourceStatus?: string;
  }>;
  runCampaign(input: {
    readonly campaignId: string;
    readonly target: string | null;
    readonly stop: () => boolean;
    readonly signal?: AbortSignal;
    /** Resume the campaign's runs whose host died instead of running them again (ADR 0036). */
    readonly resumeInterrupted: { log(line: string): void };
    /** After provider backoff, resume its stopped Codex Trials in their target slots. */
    readonly resumeProviderLimited?: { log(line: string): void };
    /** The operator's live limits (total and per runtime), read before each new target starts. */
    readonly targetLimit: TargetLimit;
  }): Promise<CampaignSummary>;
  /** Removes crashed discovery leftovers, never a Lab (#526); returns how many. */
  cleanupLeftovers(): Promise<number>;
  /** The same host check as `runtime check`; throws on failure. */
  preflight(): Promise<void>;
  legacyHistoryAvailable(): Promise<boolean>;
  /** The provider login's expiry, re-read from its file; null when unreadable. */
  readAuth(): Promise<{ readonly expiresAt: Date } | null>;
  /** When the Programme scope copy was transcribed. */
  programmeObservedAt(): Promise<Date>;
  statfs(): Promise<{ readonly freeBytes: number }>;
  /** ceil(maximumTargets / maxConcurrentTargets) × (runWallTimeMinutes + 30 × 3 + 15). */
  readonly loginMarginMinutes: number;
  clock(): Date;
  sleep(ms: number): Promise<void>;
  readonly signals: Pick<NodeJS.Process, "on" | "off">;
  pidAlive(pid: number): boolean;
  readonly pid: number;
  readonly io: {
    log(line: string): void;
    notify?(line: string): Promise<void>;
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function continuousPaths(stateDirectory: string) {
  return {
    memo: join(stateDirectory, "continuous.json"),
    pid: join(stateDirectory, "continuous.pid"),
    stop: join(stateDirectory, "continuous.stop"),
    log: join(stateDirectory, "continuous.log"),
    /** The live target limit under the config's maxConcurrentTargets. */
    concurrency: join(stateDirectory, "continuous.concurrency"),
    /** One pid file per holder of the sweep; read by the sweep guard only. */
    sweepHolds: join(stateDirectory, "sweep-holds"),
  };
}

/** Atomically publish an explicit operator or terminal policy stop. */
export function requestContinuousStop(
  stateDirectory: string,
  reason: ContinuousStopReason = "operator",
): void {
  const path = continuousPaths(stateDirectory).stop;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${reason}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Empty legacy markers still mean operator stop; unknown contents fail closed. */
export async function readContinuousStopReason(
  stateDirectory: string,
): Promise<ContinuousStopReason | null> {
  const raw = await readFile(
    continuousPaths(stateDirectory).stop,
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return raw === null
    ? null
    : (STOP_REASONS.find((reason) => reason === raw.trim()) ?? "operator");
}

/** Consume only the marker that existed at this instant. Later stop requests remain. */
export async function clearContinuousStop(
  stateDirectory: string,
): Promise<boolean> {
  const path = continuousPaths(stateDirectory).stop;
  const consumed = `${path}.resume-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, consumed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await rm(consumed, { force: true });
  return true;
}

/** The live target limit; null when the file is missing or does not hold a positive integer. */
export async function readContinuousConcurrency(
  stateDirectory: string,
): Promise<number | null> {
  const raw = await readFile(
    continuousPaths(stateDirectory).concurrency,
    "utf8",
  ).catch(() => "");
  return /^\s*[1-9]\d{0,2}\s*$/.test(raw) ? Number(raw) : null;
}

/** A runtime name that may become part of a file name. */
export const RUNTIME_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `<state>/continuous.concurrency.<runtime>`: one runtime's live limit under its cap. */
export function continuousRuntimeConcurrencyPath(
  stateDirectory: string,
  runtime: string,
): string {
  if (!RUNTIME_NAME.test(runtime))
    throw new Error(`Invalid runtime name: ${runtime}`);
  return `${continuousPaths(stateDirectory).concurrency}.${runtime}`;
}

/** One runtime's live limit; null when the file is missing or does not hold a whole number. 0 holds its starts. */
export async function readContinuousRuntimeConcurrency(
  stateDirectory: string,
  runtime: string,
): Promise<number | null> {
  const raw = await readFile(
    continuousRuntimeConcurrencyPath(stateDirectory, runtime),
    "utf8",
  ).catch(() => "");
  return /^\s*\d{1,3}\s*$/.test(raw) ? Number(raw) : null;
}

/** The runtimes that have a live limit file, by name. */
export async function liveRuntimeConcurrencies(
  stateDirectory: string,
): Promise<readonly { runtime: string; limit: number }[]> {
  const prefix = "continuous.concurrency.";
  const names = await readdir(stateDirectory).catch(() => [] as string[]);
  const runtimes = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter((runtime) => RUNTIME_NAME.test(runtime))
    .sort();
  const live = [];
  for (const runtime of runtimes) {
    const limit = await readContinuousRuntimeConcurrency(
      stateDirectory,
      runtime,
    );
    if (limit !== null) live.push({ runtime, limit });
  }
  return live;
}

/**
 * Atomically publish a live target limit, or one runtime's; the caller checks
 * it against the ceiling.
 */
export async function writeContinuousConcurrency(
  stateDirectory: string,
  limit: number,
  runtime?: string,
): Promise<void> {
  const path =
    runtime === undefined
      ? continuousPaths(stateDirectory).concurrency
      : continuousRuntimeConcurrencyPath(stateDirectory, runtime);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${limit}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function readAll(
  ledger: Pick<Ledger, "readAll">,
  query: LedgerReadAllQuery,
): LedgerEventV1[] {
  return ledger.readAll(query).map(({ event }) => event);
}

/** `<prefix>-<YYYYMMDD>-<n>`; n continues from the ledger's highest. */
function nextCampaignId(deps: ContinuousDeps): string {
  const day = deps.clock().toISOString().slice(0, 10).replaceAll("-", "");
  const head = `${deps.campaignPrefix}-${day}-`;
  let highest = 0;
  for (const type of ["selection-batch-bound", "target-selected"] as const)
    for (const event of readAll(deps.ledger, { type }))
      if (event.campaignId.startsWith(head))
        highest = Math.max(
          highest,
          Number(event.campaignId.slice(head.length)) || 0,
        );
  return `${head}${highest + 1}`;
}

/**
 * The latest usage limit any run of this campaign hit, or with a runtime, any
 * run of a target that runtime's stop names; quota when unknown.
 */
function providerLimitOf(
  deps: ContinuousDeps,
  campaignId: string,
  runtime?: string,
) {
  const stoppedTargets = new Set(
    readAll(deps.ledger, { campaignId, type: "campaign-stopped" }).flatMap(
      (event) =>
        event.type === "campaign-stopped" && event.runtime === runtime
          ? [event.snapshotDigest]
          : [],
    ),
  );
  const limits = (["discovery-run-finished", "verifier-run-finished"] as const)
    .flatMap((type) => readAll(deps.ledger, { campaignId, type }))
    .filter(
      (event) =>
        runtime === undefined || stoppedTargets.has(event.snapshotDigest),
    )
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .flatMap((event) =>
      "providerLimit" in event && event.providerLimit !== undefined
        ? [event.providerLimit]
        : [],
    );
  return limits.at(-1) === "rate-limit" ? "rate-limit" : "quota";
}

/** The wait before the step-th retry (0-based) after this kind of limit. */
function backoffMinutes(limit: "rate-limit" | "quota", step: number): number {
  return limit === "rate-limit"
    ? BACKOFF_RATE_LIMIT_MINUTES[
        Math.min(step, BACKOFF_RATE_LIMIT_MINUTES.length - 1)
      ]!
    : (BACKOFF_QUOTA_MINUTES[step] ?? QUOTA_LONG_SLEEP_HOURS * 60);
}

/** Whether this campaign still has a provider-limited latest Codex segment to continue. */
export function pendingProviderLimited(
  ledger: Pick<Ledger, "readAll">,
  campaignId: string,
): boolean {
  const terminal = new Set(
    readAll(ledger, { campaignId, type: "target-skipped" }).flatMap((event) =>
      event.type === "target-skipped" &&
      event.stage === "discovery" &&
      (event.reason === "run-failed" || event.reason === "provider-refused")
        ? [event.snapshotDigest]
        : [],
    ),
  );
  const starts = readAll(ledger, {
    campaignId,
    type: "discovery-run-started",
  }).filter(
    (
      event,
    ): event is Extract<LedgerEventV1, { type: "discovery-run-started" }> =>
      event.type === "discovery-run-started" &&
      (event.runKind ?? "explore") === "explore",
  );
  const finishes = new Map(
    readAll(ledger, { campaignId, type: "discovery-run-finished" })
      .filter(
        (
          event,
        ): event is Extract<
          LedgerEventV1,
          { type: "discovery-run-finished" }
        > => event.type === "discovery-run-finished",
      )
      .map((event) => [event.runId, event] as const),
  );
  return starts.some((start, index) => {
    if (start.resumesRun !== undefined) return false;
    if (!autoResumesProviderLimit(start)) return false;
    if (terminal.has(start.snapshotDigest)) return false;
    const superseded = starts
      .slice(index + 1)
      .some(
        (later) =>
          later.resumesRun === undefined &&
          later.snapshotDigest === start.snapshotDigest &&
          (later.trialOrdinal ?? 0) === (start.trialOrdinal ?? 0),
      );
    if (superseded) return false;
    const latest = latestSegment(starts, start.runId);
    return finishes.get(latest)?.outcome === "provider-limited";
  });
}

/** The latest automatic batch that no campaign has bound yet. */
function unboundBatch(deps: ContinuousDeps): string | undefined {
  const bound = new Set(
    readAll(deps.ledger, { type: "selection-batch-bound" }).flatMap((event) =>
      event.type === "selection-batch-bound" ? [event.selectionBatchId] : [],
    ),
  );
  const latest = readAll(deps.ledger, { type: "target-selected" })
    .filter((event) => event.campaignId.startsWith("selection-"))
    .at(-1)?.campaignId;
  return latest === undefined || bound.has(latest) ? undefined : latest;
}

/**
 * Explore runs in the ledger: how many started, the outcome of each one that
 * finished, how many finished runs SPEC §6 does not count as a Trial, and how
 * many unfinished runs a later start of the same Trial ordinal replaced (a
 * restarted campaign ran the target again; ADR 0036). Resume segments,
 * continuation and child runs belong to their Trial, not counted.
 */
export function exploreTrials(
  ledger: Pick<Ledger, "readAll">,
  query: Pick<LedgerReadAllQuery, "campaignId" | "since">,
): {
  readonly started: number;
  readonly finished: readonly string[];
  readonly notTrials: number;
  readonly superseded: number;
} {
  const key = (event: { campaignId: string; runId: string }) =>
    `${event.campaignId} ${event.runId}`;
  const starts = readAll(ledger, {
    ...query,
    type: "discovery-run-started",
  }).flatMap((event) =>
    event.type === "discovery-run-started" &&
    (event.runKind ?? "explore") === "explore"
      ? [event]
      : [],
  );
  const finishes = new Map(
    readAll(ledger, { ...query, type: "discovery-run-finished" }).flatMap(
      (event) =>
        event.type === "discovery-run-finished" ? [[key(event), event]] : [],
    ),
  );
  // A resumed Trial is counted once, by its first start, and ends as its
  // latest segment ends (ADR 0036).
  const heads = starts.filter((event) => event.resumesRun === undefined);
  const startsById = new Map(starts.map((event) => [key(event), event]));
  const lastRunIdOf = (head: (typeof starts)[number]) =>
    latestSegment(
      starts.filter((event) => event.campaignId === head.campaignId),
      head.runId,
    );
  const lastOf = (head: (typeof starts)[number]) =>
    key({ campaignId: head.campaignId, runId: lastRunIdOf(head) });
  const ended = heads.flatMap((head) => {
    const finished = finishes.get(lastOf(head));
    return finished === undefined ? [] : [finished.outcome];
  });
  const terminalLimited = new Set(
    readAll(ledger, { ...query, type: "target-skipped" }).flatMap((event) =>
      event.type === "target-skipped" &&
      event.stage === "discovery" &&
      event.reason === "run-failed" &&
      event.artifacts.some(
        (artifact) => artifact.kind === "target-skip-diagnostic",
      )
        ? [`${event.campaignId}\0${event.snapshotDigest}`]
        : [],
    ),
  );
  const active = recordedTrialActivity(ledger, query.campaignId);
  const notTrials = heads.filter((head) => {
    const lastRunId = lastRunIdOf(head);
    const own = finishes.get(
      key({ campaignId: head.campaignId, runId: lastRunId }),
    );
    const segment = (runId: string) => ({
      finished: finishes.get(key({ campaignId: head.campaignId, runId })),
      hasRecordedActivity: active.has(`${head.campaignId}\0${runId}`),
      resumesRun: startsById.get(key({ campaignId: head.campaignId, runId }))
        ?.resumesRun,
    });
    return (
      own !== undefined &&
      !(
        own.outcome === "provider-limited" &&
        terminalLimited.has(`${head.campaignId}\0${head.snapshotDigest}`)
      ) &&
      !countsAsTrialChain(lastRunId, segment)
    );
  }).length;
  const superseded = heads.filter(
    (head) =>
      !finishes.has(lastOf(head)) && supersedingRun(starts, head) !== undefined,
  ).length;
  return { started: heads.length, finished: ended, notTrials, superseded };
}

/** Completed explore Trials, and whether every skipped target was refused. */
function batchFacts(deps: ContinuousDeps, campaignId: string) {
  const completed = exploreTrials(deps.ledger, { campaignId }).finished.filter(
    (outcome) => outcome === "completed",
  ).length;
  const skips = readAll(deps.ledger, { campaignId, type: "target-skipped" });
  const refusedAll =
    completed === 0 &&
    skips.length > 0 &&
    skips.every(
      (event) =>
        event.type === "target-skipped" && event.reason === "provider-refused",
    );
  return { completed, refusedAll };
}

/** One host, one operator, one production state (OPERATIONS §2). */
export function createContinuousRunner(deps: ContinuousDeps) {
  const paths = continuousPaths(deps.stateDirectory);
  let memo: ContinuousMemo = {
    state: "starting",
    detail: {},
    backoffStep: 0,
    runtimeBackoff: {},
    consecutiveErrorBatches: 0,
    consecutiveRefusalBatches: 0,
    consecutiveNoProgressBatches: 0,
    consecutiveEmptyDays: 0,
    probe: false,
    updatedAt: deps.clock().toISOString(),
  };
  let signalled = false;
  let operatorController = new AbortController();
  const stopRequested = () => signalled || existsSync(paths.stop);
  const save = async () => {
    memo.updatedAt = deps.clock().toISOString();
    await writeFile(paths.memo, `${JSON.stringify(memo, null, 2)}\n`, {
      mode: 0o600,
    });
  };
  /** A state change writes one line to the log and to --notify. */
  const enter = async (state: string, detail: Record<string, string> = {}) => {
    // A new `until` alone is the same state continuing, not a transition.
    const { until: _until, ...stable } = detail;
    const { until: _previous, ...previous } = memo.detail;
    const changed =
      state !== memo.state ||
      JSON.stringify(stable) !== JSON.stringify(previous);
    memo.state = state;
    memo.detail = detail;
    await save();
    if (!changed) return;
    const line = [
      deps.clock().toISOString(),
      state,
      ...Object.entries(detail).map(([key, value]) => `${key}=${value}`),
    ].join(" ");
    deps.io.log(line);
    await deps.io.notify?.(line).catch(() => undefined);
  };
  /** Sleeps in one-minute steps so a stop request is never late by more. */
  const hold = async (
    state: string,
    ms: number,
    detail: Record<string, string> = {},
  ) => {
    const until = new Date(deps.clock().getTime() + ms);
    await enter(state, { until: until.toISOString(), ...detail });
    while (!stopRequested() && deps.clock() < until)
      await deps.sleep(
        Math.min(MINUTE, until.getTime() - deps.clock().getTime()),
      );
  };
  const stop = async (reason: ContinuousStopReason) => {
    if (reason !== "operator" && !existsSync(paths.stop))
      requestContinuousStop(deps.stateDirectory, reason);
    await enter("stopped", { reason });
    return reason;
  };

  const run = async (
    options: { readonly resume?: boolean } = {},
  ): Promise<ContinuousStopReason> => {
    signalled = false;
    operatorController = new AbortController();
    await mkdir(deps.stateDirectory, { recursive: true, mode: 0o700 });
    const previous = await readLivePid(paths.pid, deps.pidAlive);
    if (previous !== null && previous !== deps.pid)
      throw new Error(`continuous run is already running as pid ${previous}`);
    memo = { ...memo, ...(await readContinuousMemo(deps.stateDirectory)) };
    const heldReason = await readContinuousStopReason(deps.stateDirectory);
    if (heldReason !== null) {
      if (!options.resume) {
        // Preserve the marker and unfinished campaign across service restarts.
        await enter("stopped", { reason: heldReason });
        return heldReason;
      }
      await clearContinuousStop(deps.stateDirectory);
    }
    await writeFile(paths.pid, String(deps.pid), { mode: 0o600 });
    const onSignal = () => {
      signalled = true;
      operatorController.abort("operator");
    };
    deps.signals.on("SIGINT", onSignal);
    deps.signals.on("SIGTERM", onSignal);
    try {
      if (stopRequested()) return stop("operator");
      if (!(await deps.legacyHistoryAvailable()))
        return stop("legacy-history-missing");
      if (stopRequested()) return stop("operator");
      await deps.preflight();
      if (stopRequested()) return stop("operator");
      await deps.cleanupLeftovers();
      // The runner explores only; every accepted Finding waits for `verify next --handoff` (#423).
      return await loop();
    } finally {
      deps.signals.off("SIGINT", onSignal);
      deps.signals.off("SIGTERM", onSignal);
      await rm(paths.pid, { force: true });
    }
  };

  const loop = async (): Promise<ContinuousStopReason> => {
    // An unfinished campaign resumes under its id.
    // An unbound batch from a crash runs before any new selection.
    let current =
      (memo.campaignId && {
        campaignId: memo.campaignId,
        target: memo.target ?? null,
      }) ||
      (unboundBatch(deps) && {
        campaignId: nextCampaignId(deps),
        target: null,
      }) ||
      undefined;
    let providerBackoffFinished = false;
    const backoffProvider = async (campaignId: string) => {
      const limit = providerLimitOf(deps, campaignId);
      const step = memo.backoffStep++;
      const minutes = backoffMinutes(limit, step);
      await hold("backoff", minutes * MINUTE, {
        step: String(step + 1),
        minutes: String(minutes),
        providerLimit: limit,
      });
      providerBackoffFinished = !stopRequested();
    };
    // The process may have died during the wait, or just after the ledger
    // recorded a limit but before it wrote the backoff memo. Resume only after
    // the remaining saved wait or a fresh wait, respectively.
    if (current && pendingProviderLimited(deps.ledger, current.campaignId)) {
      const until =
        memo.state === "backoff" ? Date.parse(memo.detail.until ?? "") : NaN;
      if (Number.isFinite(until)) {
        while (!stopRequested() && deps.clock().getTime() < until)
          await deps.sleep(Math.min(MINUTE, until - deps.clock().getTime()));
      } else {
        await backoffProvider(current.campaignId);
      }
      providerBackoffFinished = !stopRequested();
    }
    for (;;) {
      if (stopRequested()) return stop("operator");
      const now = deps.clock();
      const age = now.getTime() - (await deps.programmeObservedAt()).getTime();
      if (age >= PROGRAMME_STALE_DAYS * DAY) return stop("programme-stale");
      if (age >= (PROGRAMME_STALE_DAYS - PROGRAMME_WARN_DAYS) * DAY)
        deps.io.log(`${now.toISOString()} warning programme-copy-ageing`);
      if ((await deps.statfs()).freeBytes < MIN_FREE_GIB * 1024 ** 3) {
        await hold("holding-disk-low", DISK_RECHECK_MINUTES * MINUTE);
        continue;
      }
      const auth = await deps.readAuth();
      const margin = deps.loginMarginMinutes * MINUTE;
      if (auth === null || auth.expiresAt.getTime() - now.getTime() < margin) {
        await hold("waiting-login", LOGIN_POLL_MINUTES * MINUTE, {
          expiredAt: auth?.expiresAt.toISOString() ?? "unavailable",
        });
        continue;
      }
      if (!current) {
        if (stopRequested()) return stop("operator");
        const selected = await deps.select();
        if (stopRequested()) return stop("operator");
        if (selected.batchId === null) {
          // A failed listing is not an empty pool.
          if (["unavailable", "stale"].includes(selected.sourceStatus ?? "")) {
            await hold("sleeping", LISTING_UNAVAILABLE_RETRY_MINUTES * MINUTE, {
              reason: "listing-unavailable",
            });
            continue;
          }
          if (++memo.consecutiveEmptyDays >= EMPTY_DAYS_BEFORE_EXHAUSTED)
            return stop("exhausted");
          await hold("sleeping", EMPTY_SLEEP_HOURS * 60 * MINUTE, {
            reason: "empty",
          });
          continue;
        }
        memo.consecutiveEmptyDays = 0;
        current = {
          campaignId: nextCampaignId(deps),
          target: memo.probe ? (selected.targets[0] ?? null) : null,
        };
      }
      memo.campaignId = current.campaignId;
      memo.target = current.target;
      if (stopRequested()) return stop("operator");
      await enter("running", { campaignId: current.campaignId });
      if (stopRequested()) return stop("operator");
      let summary: CampaignSummary;
      const campaignId = current.campaignId;
      const resumeProviderLimited = providerBackoffFinished;
      providerBackoffFinished = false;
      try {
        summary = await deps.runCampaign({
          campaignId: current.campaignId,
          target: current.target,
          stop: stopRequested,
          signal: operatorController.signal,
          resumeInterrupted: {
            log: (line) => deps.io.log(`${deps.clock().toISOString()} ${line}`),
          },
          ...(resumeProviderLimited
            ? {
                resumeProviderLimited: {
                  log: (line: string) =>
                    deps.io.log(`${deps.clock().toISOString()} ${line}`),
                },
              }
            : {}),
          targetLimit: {
            read: () => readContinuousConcurrency(deps.stateDirectory),
            report: (limit) =>
              deps.io.log(
                `${deps.clock().toISOString()} concurrency effective=${limit} campaign=${campaignId}`,
              ),
            readRuntime: (runtime) =>
              readContinuousRuntimeConcurrency(deps.stateDirectory, runtime),
            reportRuntime: (runtime, limit) =>
              deps.io.log(
                `${deps.clock().toISOString()} concurrency runtime=${runtime} effective=${limit} campaign=${campaignId}`,
              ),
            heldRuntimes: () =>
              new Set(
                Object.entries(memo.runtimeBackoff).flatMap(
                  ([runtime, { until }]) =>
                    Date.parse(until) > deps.clock().getTime() ? [runtime] : [],
                ),
              ),
          },
        });
        memo.consecutiveErrorBatches = 0;
      } catch (error) {
        memo.lastError = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 200);
        memo.consecutiveErrorBatches++;
        delete memo.campaignId;
        current = undefined;
        if (memo.consecutiveErrorBatches >= MAX_CONSECUTIVE_ERROR_BATCHES)
          return stop("errors");
        await hold("holding-error", ERROR_GAP_MINUTES * MINUTE);
        continue;
      }
      if (stopRequested() || summary.stopped === "operator")
        return stop("operator");
      const removed = await deps.cleanupLeftovers();
      deps.io.log(
        `${deps.clock().toISOString()} batch ${current.campaignId} stopped=${summary.stopped ?? "none"} skipped=${summary.skipped.length} leftovers=${removed}`,
      );
      if (stopRequested()) return stop("operator");
      if (summary.stopped === "incomplete") {
        if (pendingProviderLimited(deps.ledger, current.campaignId))
          await backoffProvider(current.campaignId);
        continue;
      }
      if (
        summary.stopped === "provider-limit" &&
        (summary.limitedRuntimes?.length ?? 0) > 0
      ) {
        // Each limited runtime backs off on its own steps. The runner waits for
        // the first to return; one still in backoff is held at the next start.
        const now = deps.clock().getTime();
        for (const runtime of summary.limitedRuntimes!) {
          const limit = providerLimitOf(deps, current.campaignId, runtime);
          const step = memo.runtimeBackoff[runtime]?.step ?? 0;
          const minutes = backoffMinutes(limit, step);
          memo.runtimeBackoff[runtime] = {
            step: step + 1,
            until: new Date(now + minutes * MINUTE).toISOString(),
          };
          deps.io.log(
            `${deps.clock().toISOString()} backoff runtime=${runtime} step=${step + 1} minutes=${minutes} providerLimit=${limit}`,
          );
        }
        const [runtime, { until }] = Object.entries(memo.runtimeBackoff)
          .filter(([, held]) => Date.parse(held.until) > now)
          .sort(([, a], [, b]) => a.until.localeCompare(b.until))[0]!;
        await hold("backoff", Date.parse(until) - now, { runtime });
        // A held runtime's targets start only when its own wait ends, so its
        // provider-limited Codex Trials resume after that runtime's backoff.
        providerBackoffFinished = !stopRequested();
        continue;
      }
      if (summary.stopped === "provider-limit") {
        await backoffProvider(current.campaignId);
        continue;
      }
      // The campaign finished: the next batch gets a new id.
      memo.backoffStep = 0;
      memo.runtimeBackoff = {};
      const facts = batchFacts(deps, current.campaignId);
      delete memo.campaignId;
      delete memo.target;
      current = undefined;
      if (facts.refusedAll) {
        // Refused runs are not Trials, so the same slugs come back on top.
        if (
          ++memo.consecutiveRefusalBatches >= MAX_CONSECUTIVE_REFUSAL_BATCHES
        ) {
          memo.probe = true;
          await hold("holding-refusals", REFUSAL_HOLD_MINUTES * MINUTE);
        }
        continue;
      }
      memo.consecutiveRefusalBatches = 0;
      if (facts.completed > 0) {
        memo.probe = false;
        memo.consecutiveNoProgressBatches = 0;
        continue;
      }
      const stalled = ++memo.consecutiveNoProgressBatches;
      if (stalled > MAX_CONSECUTIVE_NO_PROGRESS_BATCHES)
        return stop("no-progress");
      if (stalled === MAX_CONSECUTIVE_NO_PROGRESS_BATCHES) {
        await deps.preflight();
        await hold("holding-no-progress", NO_PROGRESS_HOLD_MINUTES * MINUTE);
      }
    }
  };

  return { run, memo: () => memo };
}
