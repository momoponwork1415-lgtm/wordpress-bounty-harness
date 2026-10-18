import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import type {
  CampaignHistory,
  CampaignInputV1,
  PlannedDiscoveryRun,
  PlannedTrial,
} from "./campaign.js";
import type {
  DiscoveryTransportResult,
  DiscoveryTransportRun,
} from "./codex-native-agent-runtime.js";
import { countsAsTrial } from "./counts-as-trial.js";
import {
  createNativeRunReceipt,
  nativeRunReceiptSchema,
  receiptWallTimeMs,
  runFinishedFieldsFrom,
  sealNativeRunReceipt,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";
import { recordReadPaths } from "./read-paths.js";
import {
  createReportRecorder,
  type ReportRecorder,
} from "./record-discovery-report.js";
import {
  recoverChildAgentReports,
  recoverRootAgentReport,
  type ReportFailure,
} from "./recover-agent-reports.js";

type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;
type EventBase = {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly occurredAt: string;
};

/** The campaign-wide inputs one Trial runs under; `seen` dedupes Findings across Trials. */
export type TrialContext = {
  readonly campaignId: string;
  readonly labId?: string;
  readonly input: CampaignInputV1;
  readonly history: CampaignHistory;
  readonly runWallTimeMs?: number;
  readonly signal?: AbortSignal;
  readonly executor: {
    execute(
      run: DiscoveryTransportRun,
      signal?: AbortSignal,
    ): Promise<DiscoveryTransportResult>;
  };
  readonly attachments: ProviderAttachmentStore;
  readonly evidence: PrivateArtifactStore;
  readonly ledger: Ledger;
  readonly recordReport: ReportRecorder;
  readonly assessCoverage?: (value: unknown) => {
    readonly accepted: boolean;
    readonly record?: unknown;
  };
  readonly clock: () => Date;
  readonly seen: Set<string>;
};

/**
 * Everything one exploration run left behind. `finishedEventFrom` maps it to
 * the `discovery-run-finished` event one to one; the campaign's stop rules read
 * `outcome`, `counted`, `foundNew` and `heldBoundary`.
 */
export type TrialOutcome = {
  readonly runId: string;
  readonly outcome: FinishedEvent["outcome"];
  readonly failure?: ReportFailure;
  /** The transport's receipt; absent when the executor threw before returning one. */
  readonly receipt?: NativeRunReceipt;
  /** The receipt's wall, or the configured wall when a cancelled transport threw. */
  readonly wallTimeMs: number;
  readonly researchArtifact?: FinishedEvent["researchArtifact"];
  /** Sealed receipt: the transport's, or a synthetic one after a cancellation. */
  readonly receiptDigest?: string;
  readonly coverageDigest?: string;
  readonly readPathsDigest?: string;
  /** SPEC §6: a run that did no observable work is not a Trial. */
  readonly counted: boolean;
  readonly foundNew: boolean;
  readonly heldBoundary: boolean;
  readonly findingsRecorded: number;
};

type TrialDraft = { -readonly [K in keyof TrialOutcome]: TrialOutcome[K] };

/** The `discovery-run-finished` event for one outcome, field for field. */
export function finishedEventFrom(
  base: EventBase,
  outcome: TrialOutcome,
): Parameters<Ledger["append"]>[0] {
  return {
    ...base,
    identity: `discovery-finish-${outcome.runId}`,
    type: "discovery-run-finished",
    runId: outcome.runId,
    outcome: outcome.outcome,
    costUsd: "unavailable",
    wallTimeMs: outcome.wallTimeMs,
    ...(outcome.receipt === undefined
      ? {}
      : runFinishedFieldsFrom(outcome.receipt)),
    ...(outcome.researchArtifact === undefined
      ? {}
      : { researchArtifact: outcome.researchArtifact }),
    ...(outcome.outcome === "completed" || outcome.failure === undefined
      ? {}
      : outcome.failure),
    artifacts: [
      ...(outcome.receiptDigest === undefined
        ? []
        : [{ kind: "native-run-receipt", digest: outcome.receiptDigest }]),
      ...(outcome.coverageDigest === undefined
        ? []
        : [{ kind: "coverage", digest: outcome.coverageDigest }]),
      ...(outcome.readPathsDigest === undefined
        ? []
        : [{ kind: "read-paths", digest: outcome.readPathsDigest }]),
    ],
  };
}

function historyMetadataOf(history: CampaignHistory) {
  return history.mode === "catalog"
    ? {
        mode: "catalog" as const,
        digest: history.digest,
        recordIds: history.records.map((record) => record.id),
      }
    : { mode: "none" as const };
}

/** The planned run must belong to the CampaignInput it runs under. */
function assertPlannedForInput(
  planned: PlannedDiscoveryRun,
  run: PlannedDiscoveryRun["run"],
  input: CampaignInputV1,
): void {
  if (
    run.targetSnapshotDigest !== input.snapshotDigest ||
    run.profile.digest !== input.modelProfileDigest ||
    (input.entryIndex === undefined
      ? planned.configuration.entryIndex !== undefined
      : input.entryIndex.enabled
        ? planned.configuration.entryIndex?.enabled !== true ||
          planned.configuration.entryIndex.digest !== input.entryIndex.digest
        : planned.configuration.entryIndex?.enabled !== false)
  )
    throw new Error("Planned run differs from the CampaignInput");
}

type Cancellation = {
  readonly signal: AbortSignal;
  /** Resolves with a synthetic receipt once a cancelled transport stays silent. */
  readonly fallback: Promise<DiscoveryTransportResult>;
  /** The transport answered; the wall no longer applies to what follows. */
  readonly disarmWall: () => void;
  readonly dispose: () => void;
};

/**
 * The wall and the operator cancel the transport through one signal. A
 * transport that ignores its cancellation is answered after a grace period so
 * the ledger still receives a finish.
 */
function armCancellation(options: {
  readonly operator: AbortSignal | undefined;
  readonly runWallTimeMs: number | undefined;
  readonly receiptOnSilence: (reason: "wall" | "operator") => NativeRunReceipt;
}): Cancellation {
  const controller = new AbortController();
  const timers: { wall?: NodeJS.Timeout; shutdown?: NodeJS.Timeout } = {};
  const onOperatorStop = () => controller.abort("operator");
  options.operator?.addEventListener("abort", onOperatorStop, { once: true });
  if (options.operator?.aborted) onOperatorStop();
  if (options.runWallTimeMs !== undefined)
    timers.wall = setTimeout(
      () => controller.abort("wall"),
      options.runWallTimeMs,
    );
  const fallback = new Promise<DiscoveryTransportResult>((resolve) => {
    const afterAbort = () => {
      timers.shutdown = setTimeout(
        () => {
          resolve({
            receipt: options.receiptOnSilence(
              controller.signal.reason === "operator" ? "operator" : "wall",
            ),
          });
        },
        Math.min(70_000, options.runWallTimeMs ?? 70_000),
      );
    };
    controller.signal.addEventListener("abort", afterAbort, { once: true });
    if (controller.signal.aborted) afterAbort();
  });
  const disarmWall = () => {
    if (timers.wall !== undefined) clearTimeout(timers.wall);
  };
  return {
    signal: controller.signal,
    fallback,
    disarmWall,
    dispose: () => {
      disarmWall();
      if (timers.shutdown !== undefined) clearTimeout(timers.shutdown);
      options.operator?.removeEventListener("abort", onOperatorStop);
    },
  };
}

/** The Root report's `coverage` member, if the report is readable JSON. */
async function coverageOf(
  attachments: ProviderAttachmentStore,
  attachment: DiscoveryTransportResult["attachment"],
): Promise<unknown> {
  if (attachment === undefined) return undefined;
  const stored = await attachments.read(attachment);
  if (stored.status !== "resolved") return undefined;
  try {
    const report = JSON.parse(stored.bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    return report.coverage;
  } catch {
    // The report recorder already classifies malformed reports.
    return undefined;
  }
}

/** A transport receipt that ended short of completion names the failure. */
function failureOf(receipt: NativeRunReceipt): ReportFailure | undefined {
  if (receipt.terminal !== "incomplete" || receipt.reason === "unavailable")
    return undefined;
  return {
    reason: receipt.reason,
    ...(receipt.reasonDetail === undefined
      ? {}
      : { reasonDetail: receipt.reasonDetail }),
    ...(receipt.providerLimit === undefined
      ? {}
      : { providerLimit: receipt.providerLimit }),
  };
}

/**
 * Runs one planned exploration: appends its start, runs the transport under
 * the wall, preserves child and Root claims, seals the receipt, and appends
 * the finish built from the returned outcome.
 */
export async function executeTrial(
  context: TrialContext,
  trial: PlannedTrial,
): Promise<TrialOutcome> {
  const { input, clock, runWallTimeMs } = context;
  const planned = trial.explore;
  const run =
    runWallTimeMs === undefined
      ? planned.run
      : {
          ...planned.run,
          expiresAt: new Date(clock().getTime() + runWallTimeMs).toISOString(),
        };
  assertPlannedForInput(planned, run, input);
  const historyMetadata = historyMetadataOf(context.history);
  const base: EventBase = {
    schemaVersion: 1,
    campaignId: context.campaignId,
    snapshotDigest: input.snapshotDigest,
    occurredAt: clock().toISOString(),
  };
  const started = await context.ledger.append({
    ...base,
    identity: `discovery-start-${run.runId}`,
    type: "discovery-run-started",
    runId: run.runId,
    trialId: trial.trialId,
    trialOrdinal: trial.trialOrdinal,
    runKind: "explore",
    ...(context.labId === undefined
      ? { labAttached: false as const }
      : { labId: context.labId, labAttached: true as const }),
    history: historyMetadata,
    configuration: {
      ...planned.configuration,
      promptDigest: planned.configuration.promptDigest ?? input.promptDigest,
      trustBoundaryVersion: input.trustBoundary.version,
      sourcePack: {
        dependency:
          run.dependencySource === undefined
            ? ("none" as const)
            : ("mounted" as const),
      },
    },
  });
  if (started.status === "conflict")
    throw new Error("Discovery run identity conflict");
  const draft: TrialDraft = {
    runId: run.runId,
    outcome: "failed",
    wallTimeMs: 0,
    counted: false,
    foundNew: false,
    heldBoundary: false,
    findingsRecorded: 0,
  };
  const recordReport = createReportRecorder({
    attachments: context.attachments,
    evidence: context.evidence,
    ledger: context.ledger,
    recordReport: context.recordReport,
    base,
    snapshotDigest: input.snapshotDigest,
    trialId: trial.trialId,
    seen: context.seen,
    state: draft,
    onFindingRecorded: (count) => {
      draft.findingsRecorded += count;
    },
  });
  const syntheticReceipt = (reason: "wall" | "operator") =>
    createNativeRunReceipt({
      runId: run.runId,
      targetSnapshotDigest: run.targetSnapshotDigest,
      profile: run.profile,
      terminal: "incomplete",
      reason,
      startedAt: base.occurredAt,
      completedAt: clock().toISOString(),
    });
  const cancellation = armCancellation({
    operator: context.signal,
    runWallTimeMs,
    receiptOnSilence: syntheticReceipt,
  });
  try {
    const execution = context.executor.execute(
      {
        ...run,
        campaignInput: {
          ...input,
          promptDigest:
            planned.configuration.promptDigest ?? input.promptDigest,
          history: context.history,
        },
      },
      cancellation.signal,
    );
    const result = await Promise.race([execution, cancellation.fallback]);
    cancellation.disarmWall();
    if (result.researchArtifact !== undefined) {
      if (result.researchArtifact.attachment.kind !== "research")
        throw new Error("Discovery research artifact kind is invalid");
      draft.researchArtifact = {
        digest: result.researchArtifact.attachment.digest,
        truncated: result.researchArtifact.truncated,
      };
    }
    const receipt = nativeRunReceiptSchema.parse(result.receipt);
    draft.receipt = receipt;
    draft.wallTimeMs = receiptWallTimeMs(receipt);
    // The receipt carries the runtime the run used (CLI version, catalog digest, model).
    draft.receiptDigest = await sealNativeRunReceipt(context.evidence, receipt);
    const readPathsDigest = await recordReadPaths(
      context.attachments,
      context.evidence,
      receipt.diagnosticArtifactDigest,
    );
    if (readPathsDigest !== undefined) draft.readPathsDigest = readPathsDigest;
    if (receipt.providerLimit !== undefined) draft.outcome = "provider-limited";
    const transportFailure = failureOf(receipt);
    if (transportFailure !== undefined) draft.failure = transportFailure;
    await recoverChildAgentReports({
      result,
      run,
      snapshotDigest: input.snapshotDigest,
      recordReport,
      ledger: context.ledger,
      evidence: context.evidence,
      attachments: context.attachments,
      base,
      trialId: trial.trialId,
      trialOrdinal: trial.trialOrdinal,
      ...(context.labId === undefined ? {} : { labId: context.labId }),
      history: historyMetadata,
      configuration: planned.configuration,
      promptDigest: input.promptDigest,
      trustBoundaryVersion: input.trustBoundary.version,
    });
    const recoveredRoot = await recoverRootAgentReport({
      result,
      receipt,
      run,
      snapshotDigest: input.snapshotDigest,
      recordReport,
    });
    if (recoveredRoot.recovered) draft.outcome = "completed";
    if (recoveredRoot.failure !== undefined)
      draft.failure = recoveredRoot.failure;
    if (
      draft.outcome === "completed" &&
      run.coverageSchema !== undefined &&
      context.assessCoverage !== undefined
    ) {
      const assessed = context.assessCoverage(
        await coverageOf(context.attachments, result.attachment),
      );
      if (assessed.record !== undefined)
        draft.coverageDigest = await context.evidence.putFiles({
          "coverage.json": canonicalJson(assessed.record),
        });
      if (!assessed.accepted) {
        draft.outcome = "failed";
        draft.failure = { reason: "depth" };
      }
    }
  } catch {
    draft.outcome = "failed";
    if (cancellation.signal.aborted) {
      const reason =
        cancellation.signal.reason === "operator" ? "operator" : "wall";
      draft.failure = { reason };
      draft.wallTimeMs = runWallTimeMs ?? 0;
      // Sealed for the record only; the event keeps the transport's fields, if any arrived.
      draft.receiptDigest = await sealNativeRunReceipt(
        context.evidence,
        syntheticReceipt(reason),
      );
    }
  } finally {
    cancellation.dispose();
  }
  draft.counted = countsAsTrial(draft.receipt ?? {});
  if (!draft.counted && draft.outcome === "completed") {
    draft.outcome = "failed";
    draft.failure = { reason: "evidence", reasonDetail: "no-work" };
  }
  const outcome: TrialOutcome = draft;
  const finished = await context.ledger.append(
    finishedEventFrom(base, outcome),
  );
  if (finished.status === "conflict")
    throw new Error("Discovery finish identity conflict");
  return outcome;
}
