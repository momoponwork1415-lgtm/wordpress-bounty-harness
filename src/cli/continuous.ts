import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type {
  Ledger,
  LedgerEventV1,
  LedgerReadAllQuery,
} from "../ledger/index.js";
import type { CampaignSummary } from "./pipeline.js";

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
  "missing-floor-policy",
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

/** `lab up --for-review` holds the runner's Lab sweep while its pid lives. */
export async function holdLabSweep(
  stateDirectory: string,
  pid: number,
): Promise<() => Promise<void>> {
  const path = continuousPaths(stateDirectory).reviewLabPid;
  await writeFile(path, String(pid), { mode: 0o600 });
  return () => rm(path, { force: true });
}

export function labSweepHeld(
  stateDirectory: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<boolean> {
  return readLivePid(continuousPaths(stateDirectory).reviewLabPid, alive).then(
    (pid) => pid !== null,
  );
}

export interface ContinuousDeps {
  readonly stateDirectory: string;
  readonly campaignPrefix: string;
  readonly ledger: Pick<Ledger, "readAll">;
  readonly verifyConcurrency?: number;
  verifyNext?(): Promise<{
    readonly findingId: string;
    readonly status: string;
  } | null>;
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
    readonly retryIncompleteVerifications: boolean;
    readonly stop: () => boolean;
    readonly signal?: AbortSignal;
  }): Promise<CampaignSummary>;
  /** Removes crashed Lab leftovers (not review Labs); returns how many. */
  cleanupLeftovers(): Promise<number>;
  /** The same host check as `runtime check`; throws on failure. */
  preflight(): Promise<void>;
  legacyHistoryAvailable(): Promise<boolean>;
  floorPolicyAvailable(): Promise<boolean>;
  /** The provider login's expiry, re-read from its file; null when unreadable. */
  readAuth(): Promise<{ readonly expiresAt: Date } | null>;
  /** When the Programme scope copy was transcribed. */
  programmeObservedAt(): Promise<Date>;
  statfs(): Promise<{ readonly freeBytes: number }>;
  /** maximumTargets × (runWallTimeMinutes + 30 × 3 + 15). */
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
    /** Written by `lab up --for-review`; read by the sweep guard only. */
    reviewLabPid: join(stateDirectory, "review-lab.pid"),
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

/** The latest usage limit any run of this campaign hit; quota when unknown. */
function providerLimitOf(deps: ContinuousDeps, campaignId: string) {
  const limits = (["discovery-run-finished", "verifier-run-finished"] as const)
    .flatMap((type) => readAll(deps.ledger, { campaignId, type }))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .flatMap((event) =>
      "providerLimit" in event && event.providerLimit !== undefined
        ? [event.providerLimit]
        : [],
    );
  return limits.at(-1) === "rate-limit" ? "rate-limit" : "quota";
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
 * Explore Trials in the ledger: how many started, and the outcome of each one
 * that finished. Continuation and child runs belong to their Trial, not counted.
 */
export function exploreTrials(
  ledger: Pick<Ledger, "readAll">,
  query: Pick<LedgerReadAllQuery, "campaignId" | "since">,
): { readonly started: number; readonly finished: readonly string[] } {
  const key = (event: { campaignId: string; runId: string }) =>
    `${event.campaignId} ${event.runId}`;
  const explore = new Set(
    readAll(ledger, { ...query, type: "discovery-run-started" }).flatMap(
      (event) =>
        event.type === "discovery-run-started" &&
        (event.runKind ?? "explore") === "explore"
          ? [key(event)]
          : [],
    ),
  );
  const finished = readAll(ledger, {
    ...query,
    type: "discovery-run-finished",
  }).flatMap((event) =>
    event.type === "discovery-run-finished" && explore.has(key(event))
      ? [event.outcome]
      : [],
  );
  return { started: explore.size, finished };
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
      if (!(await deps.floorPolicyAvailable()))
        return stop("missing-floor-policy");
      if (stopRequested()) return stop("operator");
      await deps.preflight();
      if (stopRequested()) return stop("operator");
      await deps.cleanupLeftovers();
      let verifying = true;
      const verifyWorker = async () => {
        while (verifying && !stopRequested()) {
          try {
            const result = await deps.verifyNext!();
            if (result !== null) {
              deps.io.log(
                `${deps.clock().toISOString()} verification finding=${result.findingId} status=${result.status}`,
              );
              continue;
            }
          } catch (error) {
            deps.io.log(
              `${deps.clock().toISOString()} verification error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        }
      };
      const workers =
        deps.verifyNext === undefined
          ? []
          : Array.from({ length: deps.verifyConcurrency ?? 1 }, () =>
              verifyWorker(),
            );
      try {
        return await loop();
      } finally {
        verifying = false;
        await Promise.all(workers);
      }
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
        retry: true,
      }) ||
      (unboundBatch(deps) && {
        campaignId: nextCampaignId(deps),
        target: null,
        retry: false,
      }) ||
      undefined;
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
          retry: false,
        };
      }
      memo.campaignId = current.campaignId;
      memo.target = current.target;
      if (stopRequested()) return stop("operator");
      await enter("running", { campaignId: current.campaignId });
      if (stopRequested()) return stop("operator");
      let summary: CampaignSummary;
      try {
        summary = await deps.runCampaign({
          campaignId: current.campaignId,
          target: current.target,
          retryIncompleteVerifications: current.retry,
          stop: stopRequested,
          signal: operatorController.signal,
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
        current.retry = true;
        continue;
      }
      if (summary.stopped === "provider-limit") {
        const limit = providerLimitOf(deps, current.campaignId);
        const step = memo.backoffStep++;
        const minutes =
          limit === "rate-limit"
            ? BACKOFF_RATE_LIMIT_MINUTES[
                Math.min(step, BACKOFF_RATE_LIMIT_MINUTES.length - 1)
              ]!
            : (BACKOFF_QUOTA_MINUTES[step] ?? QUOTA_LONG_SLEEP_HOURS * 60);
        current.retry = true;
        await hold("backoff", minutes * MINUTE, {
          step: String(step + 1),
          minutes: String(minutes),
          providerLimit: limit,
        });
        continue;
      }
      // The campaign finished: the next batch gets a new id.
      memo.backoffStep = 0;
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
