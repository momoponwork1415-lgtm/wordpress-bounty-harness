import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import {
  interruptedExplorations,
  providerLimitedExplorations,
  readResumeProgress,
  recordedFailureAfterRuns,
} from "./campaign-progress.js";
import type {
  DiscoveryTransportRun,
  DiscoveryTransportResult,
} from "./codex-native-agent-runtime.js";
import {
  executeTrial,
  type TrialContext,
  type TrialOutcome,
} from "./execute-trial.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";
import type { ReportRecorder } from "./record-discovery-report.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/**
 * New runs receive no public history. The time-cut `catalog` mode and its
 * generator were deleted with the ablation arm (ADR 0034); the ledger keeps
 * reading `discovery-run-started.history` of old catalog runs.
 */
export const campaignHistorySchema = z.strictObject({
  mode: z.literal("none"),
});
export type CampaignHistory = z.infer<typeof campaignHistorySchema>;

export const campaignInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotDigest: digest,
  trustBoundary: z.strictObject({
    version: z.string().min(1),
    text: z.string().min(1),
  }),
  programmeBoundary: z.strictObject({
    version: z.string().min(1),
    text: z.string().min(1),
  }),
  modelProfileDigest: digest,
  promptDigest: digest,
  stopRules: z.strictObject({
    maxRuns: z.number().int().positive(),
    noFindingRuns: z.number().int().positive(),
  }),
  lab: z.union([
    z.strictObject({ setupDigest: digest }),
    z.strictObject({
      mode: z.literal("none"),
      setupDigest: z.undefined().optional(),
    }),
  ]),
  history: campaignHistorySchema,
});
export type CampaignInputV1 = z.infer<typeof campaignInputV1Schema>;

export type PlannedDiscoveryRun = {
  readonly run: Omit<DiscoveryTransportRun, "campaignInput">;
  readonly configuration: {
    readonly promptVariant: string;
    readonly promptDigest?: string;
    readonly objectiveDigest?: string;
    readonly contractDigest?: string;
    /** sha256 of each human-written section of a fragment-composed objective. */
    readonly sectionDigests?: {
      readonly [
        section in "objective" | "strategy" | "coordination" | "persistence"
      ]?: string | undefined;
    };
    /** sha256 of the complete prompt text handed to the Root. */
    readonly inputDigest?: string;
    readonly trustBoundaryVersion?: string;
    readonly sourcePack?: { readonly dependency: "mounted" | "none" };
    readonly labAccess?: { readonly database: "read-only" | "none" };
    readonly runtime?: "codex-native/v1" | "claude-code/v1";
    /** The launch mode the campaign config fixed for this Trial (ADR 0039). */
    readonly mode?: "deep" | "wide";
    /** What the Harness enforced, as the Run parameters section states it. */
    readonly wallMinutes?: number;
    readonly minimumActiveMinutes?: number;
    readonly maxChildren?: number;
    readonly lab?: {
      readonly mode: "none" | "attached";
      readonly maxResets: number;
    };
    readonly model?: string;
    readonly effort?: string;
  };
};

export type PlannedTrial = {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly explore: PlannedDiscoveryRun;
  /** Set only by an operator-triggered resume (ADR 0036): the refused run this segment continues. */
  readonly resumes?: { readonly runId: string; readonly segment: number };
  /**
   * Set only when an interrupted run is sealed (ADR 0036): its start is already
   * in the ledger at this time, so only the finish and its records are written.
   */
  readonly startRecordedAt?: string;
};

export type DiscoveryStop =
  /** Legacy concluded events remain readable; new campaigns do not emit this. */
  | "screened-no-candidate"
  | "no-new-finding"
  | "output-boundary"
  | "max-runs"
  | "plans-exhausted"
  | "provider-limit"
  | "incomplete";

export type ProviderLimitedResumeResult =
  | { readonly status: "resumed"; readonly outcome: TrialOutcome }
  | {
      readonly status: "incomplete";
      readonly runId: string;
      readonly reason: string;
      readonly detail?: string;
    };

/** Run planned Trials, preserve admitted claims, and apply campaign stop rules. */
export async function runDiscoveryCampaign(options: {
  readonly campaignId: string;
  readonly labId?: string;
  /** An explicit repeat runs every planned independent Trial unless a run fails. */
  readonly repeatAll?: boolean;
  readonly input: CampaignInputV1;
  /** Runs in flight at once on this host; at most four. */
  readonly concurrency?: number;
  /** Exploration wall time, stamped when each Trial starts rather than when all plans are built. */
  readonly runWallTimeMs?: number;
  /** Operator cancellation of in-flight exploration. */
  readonly signal?: AbortSignal;
  readonly plannedTrials: readonly PlannedTrial[];
  readonly executor: {
    execute(
      run: DiscoveryTransportRun,
      signal?: AbortSignal,
    ): Promise<DiscoveryTransportResult>;
  };
  readonly attachments: ProviderAttachmentStore;
  readonly evidence: PrivateArtifactStore;
  readonly ledger: Ledger;
  /** Profile-owned admission of every candidate in a report; see `ReportRecorder`. */
  readonly recordReport: ReportRecorder;
  readonly clock?: () => Date;
  /**
   * The runner only (ADR 0036, 2026-10-19 addendum 3): a Trial whose latest
   * segment has a start but no finish is offered here before its ordinal runs.
   * The outcome of the resumed segment, or `undefined` to run the ordinal as
   * before. It runs in this target's slot, so the target concurrency holds.
   */
  readonly resumeInterrupted?: (
    started: Extract<LedgerEventV1, { type: "discovery-run-started" }>,
    signal?: AbortSignal,
  ) => Promise<TrialOutcome | undefined>;
  /** The runner only, after provider backoff: continue a stopped Codex Trial in its target slot. */
  readonly resumeProviderLimited?: (
    started: Extract<LedgerEventV1, { type: "discovery-run-started" }>,
    signal?: AbortSignal,
  ) => Promise<ProviderLimitedResumeResult>;
}): Promise<{
  readonly runCount: number;
  readonly findingsRecorded: number;
  readonly stoppedBy: DiscoveryStop;
  readonly resumeRefusal?: {
    readonly runId: string;
    readonly reason: string;
    readonly detail?: string;
  };
}> {
  const input = campaignInputV1Schema.parse(options.input);
  const id = z.string().min(1).max(128);
  id.parse(options.campaignId);
  if (options.labId !== undefined) id.parse(options.labId);
  const clock = options.clock ?? (() => new Date());
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Invalid discovery concurrency");
  const target = {
    ledger: options.ledger,
    campaignId: options.campaignId,
    snapshotDigest: input.snapshotDigest,
  };
  // A concluded target is done; otherwise continue after the runs already spent.
  const progress = readResumeProgress(target);
  if (progress.concluded !== undefined)
    return { runCount: 0, findingsRecorded: 0, stoppedBy: progress.concluded };
  if (
    options.runWallTimeMs !== undefined &&
    (!Number.isSafeInteger(options.runWallTimeMs) ||
      options.runWallTimeMs < 1 ||
      options.runWallTimeMs > 240 * 60_000)
  )
    throw new Error("Invalid exploration wall time");
  const startedExplorations = new Set(progress.startedExplorations);
  const context: TrialContext = {
    campaignId: options.campaignId,
    ...(options.labId === undefined ? {} : { labId: options.labId }),
    input,
    ...(options.runWallTimeMs === undefined
      ? {}
      : { runWallTimeMs: options.runWallTimeMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    executor: options.executor,
    attachments: options.attachments,
    evidence: options.evidence,
    ledger: options.ledger,
    recordReport: options.recordReport,
    clock,
    seen: new Set<string>(),
  };
  // Stop rules are evaluated once per Trial; in-flight Trials still finish.
  const tally: {
    runCount: number;
    findingsRecorded: number;
    noNewFindings: number;
    resumeRefusal:
      | Extract<ProviderLimitedResumeResult, { status: "incomplete" }>
      | undefined;
    next: number;
    stopped:
      | Extract<
          DiscoveryStop,
          "no-new-finding" | "output-boundary" | "provider-limit" | "incomplete"
        >
      | undefined;
  } = {
    runCount: 0,
    findingsRecorded: 0,
    noNewFindings: 0,
    resumeRefusal: undefined,
    next: 0,
    stopped: undefined,
  };
  const limit = Math.min(input.stopRules.maxRuns, options.plannedTrials.length);
  const runOne = async (index: number) => {
    const trial = options.plannedTrials[index]!;
    if (
      trial.trialId !== trial.explore.run.runId ||
      trial.trialOrdinal !== index
    )
      throw new Error(
        "Trial identity or ordinal differs from its exploration run",
      );
    startedExplorations.add(trial.explore.run.runId);
    tally.runCount++;
    account(await executeTrial(context, trial));
  };
  const account = (explore: TrialOutcome) => {
    tally.findingsRecorded += explore.findingsRecorded;
    if (!explore.counted) {
      tally.stopped ??=
        explore.outcome === "provider-limited"
          ? "provider-limit"
          : "incomplete";
      return;
    }
    if (explore.outcome === "provider-limited")
      tally.stopped ??= "provider-limit";
    if (explore.outcome === "failed") tally.stopped ??= "incomplete";
    if (explore.outcome === "completed") {
      if (!options.repeatAll && explore.heldBoundary && !explore.foundNew)
        tally.stopped ??= "output-boundary";
      else tally.noNewFindings = explore.foundNew ? 0 : tally.noNewFindings + 1;
    }
    if (
      !options.repeatAll &&
      tally.noNewFindings >= input.stopRules.noFindingRuns
    )
      tally.stopped ??= "no-new-finding";
  };
  const interrupted =
    options.resumeInterrupted === undefined
      ? new Map()
      : interruptedExplorations(target);
  const providerLimited =
    options.resumeProviderLimited === undefined
      ? new Map()
      : providerLimitedExplorations(target);
  const worker = async () => {
    while (tally.stopped === undefined && tally.next < limit) {
      const ordinal = tally.next++;
      const dead = interrupted.get(ordinal);
      const resumed =
        dead === undefined
          ? undefined
          : await options.resumeInterrupted?.(dead, options.signal);
      if (dead !== undefined && resumed !== undefined) {
        startedExplorations.add(dead.runId);
        startedExplorations.add(resumed.runId);
        tally.runCount++;
        account(resumed);
      } else {
        const limited = providerLimited.get(ordinal);
        if (limited !== undefined) {
          const resumed = await options.resumeProviderLimited!(
            limited,
            options.signal,
          );
          if (resumed.status === "incomplete") {
            tally.resumeRefusal = resumed;
            tally.stopped = "incomplete";
          } else {
            startedExplorations.add(resumed.outcome.runId);
            tally.runCount++;
            account(resumed.outcome);
          }
        } else if (dead !== undefined || !progress.spentOrdinals.has(ordinal))
          await runOne(ordinal);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const stoppedBy: DiscoveryStop =
    (tally.resumeRefusal === undefined
      ? recordedFailureAfterRuns(target, startedExplorations)
      : "incomplete") ??
    tally.stopped ??
    (options.plannedTrials.length >= input.stopRules.maxRuns
      ? "max-runs"
      : "plans-exhausted");
  // A recorded partial Trial remains spent on resume.
  if (stoppedBy !== "provider-limit" && stoppedBy !== "incomplete") {
    const recorded = await options.ledger.append({
      schemaVersion: 1,
      campaignId: options.campaignId,
      snapshotDigest: input.snapshotDigest,
      occurredAt: clock().toISOString(),
      identity: `discovery-concluded-${canonicalDigest({
        campaignId: options.campaignId,
        snapshotDigest: input.snapshotDigest,
      })}`,
      type: "discovery-concluded",
      stoppedBy,
    });
    if (recorded.status === "conflict")
      throw new Error("Discovery conclusion identity conflict");
  }
  return {
    runCount: tally.runCount,
    findingsRecorded: tally.findingsRecorded,
    stoppedBy,
    ...(tally.resumeRefusal === undefined
      ? {}
      : {
          resumeRefusal: {
            runId: tally.resumeRefusal.runId,
            reason: tally.resumeRefusal.reason,
            ...(tally.resumeRefusal.detail === undefined
              ? {}
              : { detail: tally.resumeRefusal.detail }),
          },
        }),
  };
}
