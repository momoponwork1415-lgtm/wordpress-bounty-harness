import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import {
  readResumeProgress,
  recordedFailureAfterRuns,
} from "./campaign-progress.js";
import type {
  DiscoveryTransportRun,
  DiscoveryTransportResult,
} from "./codex-native-agent-runtime.js";
import { executeTrial, type TrialContext } from "./execute-trial.js";
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
    readonly trustBoundaryVersion?: string;
    readonly sourcePack?: { readonly dependency: "mounted" | "none" };
    readonly labAccess?: { readonly database: "read-only" | "none" };
  };
};

export type PlannedTrial = {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly explore: PlannedDiscoveryRun;
  /** Set only by an operator-triggered resume (ADR 0036): the refused run this segment continues. */
  readonly resumes?: { readonly runId: string; readonly segment: number };
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
}): Promise<{
  readonly runCount: number;
  readonly findingsRecorded: number;
  readonly stoppedBy: DiscoveryStop;
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
    const explore = await executeTrial(context, trial);
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
  const worker = async () => {
    while (tally.stopped === undefined && tally.next < limit) {
      const ordinal = tally.next++;
      if (!progress.spentOrdinals.has(ordinal)) await runOne(ordinal);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const stoppedBy: DiscoveryStop =
    recordedFailureAfterRuns(target, startedExplorations) ??
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
  };
}
