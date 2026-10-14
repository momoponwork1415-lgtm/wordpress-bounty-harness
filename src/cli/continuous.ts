import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  Ledger,
  LedgerEventV1,
  LedgerReadQuery,
} from "../ledger/index.js";
import type { CampaignSummary } from "./pipeline.js";

// Final design P6. Constants, not settings.
export const BACKOFF_RATE_LIMIT_MINUTES = [5, 10, 20, 40, 60] as const;
export const BACKOFF_QUOTA_MINUTES = [30, 60] as const;
export const QUOTA_LONG_SLEEP_HOURS = 6;
export const MAX_CONSECUTIVE_ERROR_BATCHES = 3;
export const ERROR_GAP_MINUTES = 10;

export type ContinuousStopReason = "operator" | "errors" | "exhausted";

/** The runner's working memo. The ledger stays the record; this file may be deleted. */
export type ContinuousMemo = {
  state: string;
  detail: Record<string, string>;
  campaignId?: string;
  target?: string | null;
  backoffStep: number;
  consecutiveErrorBatches: number;
  lastError?: string;
  updatedAt: string;
};

export interface ContinuousDeps {
  readonly stateDirectory: string;
  readonly campaignPrefix: string;
  readonly ledger: Pick<Ledger, "read">;
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
  }): Promise<CampaignSummary>;
  /** Removes crashed Lab leftovers (not review Labs); returns how many. */
  cleanupLeftovers(): Promise<number>;
  /** The same host check as `runtime check`; throws on failure. */
  preflight(): Promise<void>;
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

export function continuousPaths(stateDirectory: string) {
  return {
    memo: join(stateDirectory, "continuous.json"),
    pid: join(stateDirectory, "continuous.pid"),
    stop: join(stateDirectory, "continuous.stop"),
    log: join(stateDirectory, "continuous.log"),
  };
}

function readAll(
  ledger: Pick<Ledger, "read">,
  query: Omit<LedgerReadQuery, "limit" | "afterSequence">,
): LedgerEventV1[] {
  const events: LedgerEventV1[] = [];
  for (let afterSequence = 0; ;) {
    const page = ledger.read({ ...query, afterSequence, limit: 1000 });
    events.push(...page.map(({ event }) => event));
    if (page.length < 1000) return events;
    afterSequence = page[page.length - 1]!.sequence;
  }
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

/** One host, one operator, one production state (OPERATIONS §2). */
export function createContinuousRunner(deps: ContinuousDeps) {
  const paths = continuousPaths(deps.stateDirectory);
  let memo: ContinuousMemo = {
    state: "starting",
    detail: {},
    backoffStep: 0,
    consecutiveErrorBatches: 0,
    updatedAt: deps.clock().toISOString(),
  };
  let signalled = false;
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
    await enter("stopped", { reason });
    return reason;
  };

  const run = async (): Promise<ContinuousStopReason> => {
    await mkdir(deps.stateDirectory, { recursive: true, mode: 0o700 });
    const previous = Number(await readFile(paths.pid, "utf8").catch(() => "0"));
    if (previous > 0 && previous !== deps.pid && deps.pidAlive(previous))
      throw new Error(`continuous run is already running as pid ${previous}`);
    await rm(paths.stop, { force: true });
    const saved = await readFile(paths.memo, "utf8").catch(() => "{}");
    memo = { ...memo, ...(JSON.parse(saved) as Partial<ContinuousMemo>) };
    await deps.preflight();
    await deps.cleanupLeftovers();
    await writeFile(paths.pid, String(deps.pid), { mode: 0o600 });
    const onSignal = () => {
      signalled = true;
    };
    deps.signals.on("SIGINT", onSignal);
    deps.signals.on("SIGTERM", onSignal);
    try {
      return await loop();
    } finally {
      deps.signals.off("SIGINT", onSignal);
      deps.signals.off("SIGTERM", onSignal);
      await rm(paths.pid, { force: true });
    }
  };

  const loop = async (): Promise<ContinuousStopReason> => {
    // An unfinished campaign resumes under its id.
    let current = memo.campaignId && {
      campaignId: memo.campaignId,
      target: memo.target ?? null,
      retry: true,
    };
    for (;;) {
      if (stopRequested()) return stop("operator");
      if (!current) {
        const selected = await deps.select();
        // Holds for an empty pool or a failed listing come with P6 (b).
        if (selected.batchId === null) return stop("exhausted");
        current = {
          campaignId: nextCampaignId(deps),
          target: null,
          retry: false,
        };
      }
      memo.campaignId = current.campaignId;
      memo.target = current.target;
      await enter("running", { campaignId: current.campaignId });
      let summary: CampaignSummary;
      try {
        summary = await deps.runCampaign({
          campaignId: current.campaignId,
          target: current.target,
          retryIncompleteVerifications: current.retry,
          stop: stopRequested,
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
      const removed = await deps.cleanupLeftovers();
      deps.io.log(
        `${deps.clock().toISOString()} batch ${current.campaignId} stopped=${summary.stopped ?? "none"} skipped=${summary.skipped.length} leftovers=${removed}`,
      );
      if (summary.stopped === "operator") return stop("operator");
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
      delete memo.campaignId;
      delete memo.target;
      current = undefined;
    }
  };

  return { run, memo: () => memo };
}
