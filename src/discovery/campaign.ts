import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { countsAsTrial, recordedTrialActivity } from "./counts-as-trial.js";
import type {
  DiscoveryTransportRun,
  DiscoveryTransportResult,
} from "./codex-native-agent-runtime.js";
import {
  createNativeRunReceipt,
  nativeRunReceiptSchema,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";
import { createReportRecorder } from "./record-discovery-report.js";
import {
  recoverChildAgentReports,
  recoverRootAgentReport,
  type ReportFailure,
} from "./recover-agent-reports.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const publishedAt = z.iso.datetime({ offset: true });
const catalogRecordSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.string().min(1).max(128),
  affectedVersions: z.array(z.string().min(1)),
  fixedVersions: z.array(z.string().min(1)),
  publishedAt,
  title: z.string().min(1).max(1024),
  changedFiles: z.array(z.string().min(1)),
});
export type CatalogRecord = z.infer<typeof catalogRecordSchema>;

const catalog = z
  .strictObject({
    mode: z.literal("catalog"),
    historyCutoff: publishedAt,
    digest,
    records: z.array(catalogRecordSchema),
  })
  .superRefine((value, context) => {
    if (
      value.digest !==
      canonicalDigest({
        historyCutoff: value.historyCutoff,
        records: value.records,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "History catalog digest mismatch",
      });
    }
    for (const [index, record] of value.records.entries()) {
      if (Date.parse(record.publishedAt) >= Date.parse(value.historyCutoff)) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "publishedAt"],
          message: "History record is at or after the cutoff",
        });
      }
    }
  });

export const campaignHistorySchema = z.union([
  z.strictObject({ mode: z.literal("none") }),
  catalog,
]);
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
  lab: z.strictObject({ setupDigest: digest }),
  history: campaignHistorySchema,
  entryIndex: z
    .union([
      z.strictObject({ enabled: z.literal(true), digest }),
      z.strictObject({ enabled: z.literal(false) }),
    ])
    .optional(),
});
export type CampaignInputV1 = z.infer<typeof campaignInputV1Schema>;

/** Validate before either evaluation or provider transport. */
export function createHistoryCatalog(
  historyCutoff: string,
  records: readonly unknown[],
): Extract<CampaignHistory, { mode: "catalog" }> {
  const parsedRecords = records.map((record) =>
    catalogRecordSchema.parse(record),
  );
  const body = { historyCutoff, records: parsedRecords };
  return catalog.parse({
    mode: "catalog",
    ...body,
    digest: canonicalDigest(body),
  });
}

/** An evaluation run must use the held-out publication instant as its cutoff. */
export function validateEvaluationCampaignInput(
  input: unknown,
  heldOutPublishedAt: string,
): CampaignInputV1 {
  const heldOut = publishedAt.parse(heldOutPublishedAt);
  const parsed = campaignInputV1Schema.parse(input);
  if (
    parsed.history.mode === "catalog" &&
    Date.parse(parsed.history.historyCutoff) !== Date.parse(heldOut)
  ) {
    throw new Error(
      "Evaluation history cutoff differs from held-out publication",
    );
  }
  return parsed;
}

/** Production uses the pinned snapshot version's publication instant. */
export function validateProductionCampaignInput(
  input: unknown,
  snapshotVersionPublishedAt: string,
): CampaignInputV1 {
  const published = publishedAt.parse(snapshotVersionPublishedAt);
  const parsed = campaignInputV1Schema.parse(input);
  if (
    parsed.history.mode === "catalog" &&
    Date.parse(parsed.history.historyCutoff) !== Date.parse(published)
  ) {
    throw new Error(
      "Production history cutoff differs from snapshot publication",
    );
  }
  return parsed;
}

/** Deterministic fractional allocation of run ordinals to arm b; zero means none and one means all. */
export function allocateArm(ordinal: number, armBFraction: number): "a" | "b" {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new Error("Invalid run ordinal");
  if (!Number.isFinite(armBFraction) || armBFraction < 0 || armBFraction > 1)
    throw new Error("Invalid arm fraction");
  return Math.floor((ordinal + 1) * armBFraction) >
    Math.floor(ordinal * armBFraction)
    ? "b"
    : "a";
}

export type AblationAxis = {
  readonly axis: "history" | "prompt";
  readonly armBFraction: number;
};
export type TrialArms = Partial<Record<AblationAxis["axis"], "a" | "b">>;

/** Offset each axis by powers of two to cover a 2x2 cell every four Trials. */
export function allocateTrialArms(
  trialOrdinal: number,
  axes: readonly AblationAxis[],
): TrialArms {
  if (!Number.isSafeInteger(trialOrdinal) || trialOrdinal < 0)
    throw new Error("Invalid Trial ordinal");
  const arms: TrialArms = {};
  const seen = new Set<AblationAxis["axis"]>();
  for (const [index, axis] of axes.entries()) {
    if (seen.has(axis.axis)) throw new Error("Duplicate ablation axis");
    seen.add(axis.axis);
    arms[axis.axis] = allocateArm(
      Math.floor(trialOrdinal / 2 ** index),
      axis.armBFraction,
    );
  }
  return arms;
}

/** Deterministic fractional allocation; zero means no history and one means all runs. */
export function historyForRun(
  ordinal: number,
  historyFraction: number,
  catalogHistory: Extract<CampaignHistory, { mode: "catalog" }>,
): CampaignHistory {
  const arm = allocateArm(ordinal, historyFraction);
  const admitted = catalog.parse(catalogHistory);
  return arm === "b" ? admitted : { mode: "none" };
}

export type AdmittedFinding = {
  readonly findingId: string;
  readonly discoveryRunId: string;
  readonly snapshotDigest: string;
  readonly claim: string;
  readonly impact: string;
  readonly sourceTrace: readonly unknown[];
  readonly historyRecordId?: string | undefined;
};

export type PlannedDiscoveryRun = {
  readonly run: Omit<DiscoveryTransportRun, "campaignInput">;
  readonly configuration: {
    readonly promptVariant: string;
    readonly promptDigest?: string;
    readonly objectiveDigest?: string;
    readonly contractDigest?: string;
    readonly trustBoundaryVersion?: string;
    readonly sourcePack?: { readonly dependency: "mounted" | "none" };
    readonly assignmentUnit: string;
    readonly entryIndex?:
      | { readonly enabled: true; readonly digest: string }
      | { readonly enabled: false };
    readonly assignment?: {
      readonly partition: number;
      readonly of: number;
      readonly planDigest: string;
      readonly indexDigest?: string;
      readonly componentDigest?: string;
    };
    readonly labAccess?: { readonly database: "read-only" | "none" };
  };
};

/** Shared identity of an admitted lead; a profile supplies its claim fields. */
export type AdmittedLead = {
  readonly leadId: string;
  readonly discoveryRunId: string;
  readonly trialId: string;
  readonly snapshotDigest: string;
  readonly primitive: string;
  readonly storage: { readonly kind: string; readonly key: string } | null;
  readonly missingEdge:
    "producer" | "consumer" | "auth-use" | "reachability" | "precondition";
  readonly sourceTrace: readonly { readonly file: string }[];
};

export type PlannedTrial = {
  readonly trialId: string;
  readonly trialOrdinal: number;
  readonly explore: PlannedDiscoveryRun;
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
  readonly labId: string;
  readonly input: CampaignInputV1;
  readonly historyFraction: number;
  /** Runs in flight at once on this host; at most four. */
  readonly concurrency?: number;
  /** Exploration wall time, stamped when each Trial starts rather than when all plans are built. */
  readonly runWallTimeMs?: number;
  /** Operator cancellation of in-flight exploration. */
  readonly signal?: AbortSignal;
  /** Records each run's arm on the history axis: a without history, b with it. */
  readonly ablation?: { readonly axes: readonly AblationAxis[] };
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
  readonly admitFinding: (
    candidate: unknown,
    context: {
      runId: string;
      snapshotDigest: string;
      reportArtifactDigest: string;
    },
  ) => AdmittedFinding;
  /** Programme Boundary 外の impact を `finding-parked` に落とす（#185）。 */
  readonly isProgrammeImpact?: (impact: string) => boolean;
  /** Profile-owned admission policy; the generic recorder only stores its result. */
  readonly classifyFindingPrecondition?: (finding: AdmittedFinding) => {
    readonly preconditionClass: string;
    readonly park: boolean;
  };
  readonly normalizeCandidate?: (candidate: unknown) => {
    value: unknown;
    changes: { path: string; operation: string }[];
  };
  readonly classifyCandidate?: (
    candidate: unknown,
    kind: "finding" | "lead",
  ) => {
    impact?: string;
    primitive?: string;
    missingEdge?: string;
  };
  readonly admitLead?: (
    candidate: unknown,
    context: {
      runId: string;
      trialId: string;
      snapshotDigest: string;
      reportArtifactDigest: string;
    },
  ) => AdmittedLead;
  readonly leadSignature?: (lead: AdmittedLead) => string;
  /** Profile-owned Root coverage validator. Absent for archived or control arms. */
  readonly assessCoverage?: (value: unknown) => {
    readonly accepted: boolean;
    readonly record?: unknown;
  };
  readonly clock?: () => Date;
}): Promise<{
  readonly runCount: number;
  readonly findingsRecorded: number;
  readonly stoppedBy: DiscoveryStop;
}> {
  const input = campaignInputV1Schema.parse(options.input);
  const id = z.string().min(1).max(128);
  id.parse(options.campaignId);
  id.parse(options.labId);
  if (
    !Number.isFinite(options.historyFraction) ||
    options.historyFraction < 0 ||
    options.historyFraction > 1
  )
    throw new Error("Invalid history allocation fraction");
  const clock = options.clock ?? (() => new Date());
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("Invalid discovery concurrency");
  const ofTarget = <T extends { readonly snapshotDigest: string }>(
    events: readonly T[],
  ) => events.filter((event) => event.snapshotDigest === input.snapshotDigest);
  // A concluded target is done; otherwise continue after the runs already spent.
  const concluded = ofTarget(
    options.ledger
      .read({ campaignId: options.campaignId, type: "discovery-concluded" })
      .map(({ event }) => event),
  ).at(0);
  if (concluded?.type === "discovery-concluded")
    return { runCount: 0, findingsRecorded: 0, stoppedBy: concluded.stoppedBy };
  // A start with no finish or receipt may reuse its ordinal on resume. A
  // partial Trial with a receipt still consumes its ordinal.
  const readFinishes = () => {
    const finishes = new Map<
      string,
      Extract<LedgerEventV1, { type: "discovery-run-finished" }>
    >();
    for (let afterSequence = 0; ;) {
      const page = options.ledger.read({
        campaignId: options.campaignId,
        type: "discovery-run-finished",
        afterSequence,
        limit: 1000,
      });
      for (const { event } of page)
        if (
          event.type === "discovery-run-finished" &&
          event.snapshotDigest === input.snapshotDigest
        )
          finishes.set(event.runId, event);
      if (page.length < 1000) return finishes;
      afterSequence = page[page.length - 1]!.sequence;
    }
  };
  const finishedRuns = readFinishes();
  const activeRuns = recordedTrialActivity(options.ledger, options.campaignId);
  const startedExplorations = new Set<string>();
  const spentOrdinals = new Set<number>();
  let nextLegacyOrdinal = 0;
  let startAfterSequence = 0;
  for (;;) {
    const page = options.ledger.read({
      campaignId: options.campaignId,
      type: "discovery-run-started",
      afterSequence: startAfterSequence,
      limit: 1000,
    });
    for (const { event } of page)
      if (
        event.type === "discovery-run-started" &&
        event.snapshotDigest === input.snapshotDigest &&
        // Historical events had no runKind and each represented exploration.
        (event.runKind ?? "explore") === "explore" &&
        countsAsTrial(
          finishedRuns.get(event.runId),
          activeRuns.has(`${event.campaignId}\0${event.runId}`),
        )
      ) {
        startedExplorations.add(event.runId);
        if (event.trialOrdinal !== undefined)
          spentOrdinals.add(event.trialOrdinal);
        else {
          while (spentOrdinals.has(nextLegacyOrdinal)) nextLegacyOrdinal++;
          spentOrdinals.add(nextLegacyOrdinal++);
        }
      }
    if (page.length < 1000) break;
    startAfterSequence = page[page.length - 1]!.sequence;
  }
  const seen = new Set<string>();
  let noNewFindings = 0;
  let runCount = 0;
  let findingsRecorded = 0;
  let stopped:
    | "no-new-finding"
    | "output-boundary"
    | "provider-limit"
    | "incomplete"
    | undefined;
  if (
    options.runWallTimeMs !== undefined &&
    (!Number.isSafeInteger(options.runWallTimeMs) ||
      options.runWallTimeMs < 1 ||
      options.runWallTimeMs > 240 * 60_000)
  )
    throw new Error("Invalid exploration wall time");
  const limit = Math.min(input.stopRules.maxRuns, options.plannedTrials.length);
  let next = 0;
  const runOne = async (index: number) => {
    const trial = options.plannedTrials[index]!;
    if (
      trial.trialId !== trial.explore.run.runId ||
      trial.trialOrdinal !== index
    )
      throw new Error(
        "Trial identity or ordinal differs from its exploration run",
      );
    const assignedArms = allocateTrialArms(
      trial.trialOrdinal,
      options.ablation?.axes ?? [],
    );
    const arms: TrialArms =
      input.history.mode === "none" && assignedArms.history !== undefined
        ? { ...assignedArms, history: "a" }
        : assignedArms;
    const history =
      input.history.mode === "catalog"
        ? arms.history === undefined
          ? historyForRun(index, options.historyFraction, input.history)
          : arms.history === "b"
            ? input.history
            : { mode: "none" as const }
        : { mode: "none" as const };
    const historyMetadata =
      history.mode === "catalog"
        ? {
            mode: "catalog" as const,
            digest: history.digest,
            recordIds: history.records.map((record) => record.id),
          }
        : { mode: "none" as const };
    const executePlanned = async (
      planned: PlannedDiscoveryRun,
      runWallTimeMs = options.runWallTimeMs,
    ): Promise<{
      outcome: "completed" | "failed" | "provider-limited";
      counted: boolean;
      foundNew: boolean;
      heldBoundary: boolean;
    }> => {
      const run =
        runWallTimeMs === undefined
          ? planned.run
          : {
              ...planned.run,
              expiresAt: new Date(
                clock().getTime() + runWallTimeMs,
              ).toISOString(),
            };
      if (
        run.targetSnapshotDigest !== input.snapshotDigest ||
        run.profile.digest !== input.modelProfileDigest ||
        (input.entryIndex === undefined
          ? planned.configuration.entryIndex !== undefined
          : input.entryIndex.enabled
            ? planned.configuration.entryIndex?.enabled !== true ||
              planned.configuration.entryIndex.digest !==
                input.entryIndex.digest
            : planned.configuration.entryIndex?.enabled !== false)
      )
        throw new Error("Planned run differs from the CampaignInput");
      const base = {
        schemaVersion: 1 as const,
        campaignId: options.campaignId,
        snapshotDigest: input.snapshotDigest,
        occurredAt: clock().toISOString(),
      };
      const started = await options.ledger.append({
        ...base,
        identity: `discovery-start-${run.runId}`,
        type: "discovery-run-started",
        runId: run.runId,
        trialId: trial.trialId,
        trialOrdinal: trial.trialOrdinal,
        runKind: "explore",
        labId: options.labId,
        history: historyMetadata,
        configuration: {
          ...planned.configuration,
          promptDigest:
            planned.configuration.promptDigest ?? input.promptDigest,
          trustBoundaryVersion: input.trustBoundary.version,
          sourcePack: {
            dependency:
              run.dependencySource === undefined
                ? ("none" as const)
                : ("mounted" as const),
          },
          ...(options.ablation === undefined ? {} : { arms }),
        },
      });
      if (started.status === "conflict")
        throw new Error("Discovery run identity conflict");
      startedExplorations.add(run.runId);
      runCount++;
      let outcome: "completed" | "failed" | "provider-limited" = "failed";
      let wallTimeMs = 0;
      let usage: NativeRunReceipt["usage"] | undefined;
      let observed: NativeRunReceipt["observed"] | undefined;
      let childThreadsObserved: number | undefined;
      let childThreadsAdmitted: number | undefined;
      let brokerMetrics: NativeRunReceipt["brokerMetrics"];
      let sandboxExitCode: number | undefined;
      let diagnosticArtifactDigest: string | undefined;
      let researchArtifact:
        { readonly digest: string; readonly truncated: boolean } | undefined;
      let receiptDigest: string | undefined;
      let coverageDigest: string | undefined;
      let failure: ReportFailure | undefined;
      const reportState = { foundNew: false, heldBoundary: false };
      const recordReport = createReportRecorder({
        ...options,
        base,
        snapshotDigest: input.snapshotDigest,
        trialId: trial.trialId,
        seen,
        state: reportState,
        onFindingRecorded: (count) => {
          findingsRecorded += count;
        },
      });
      const controller = new AbortController();
      const onOperatorStop = () => controller.abort("operator");
      options.signal?.addEventListener("abort", onOperatorStop, { once: true });
      if (options.signal?.aborted) onOperatorStop();
      const wallTimer =
        runWallTimeMs === undefined
          ? undefined
          : setTimeout(() => controller.abort("wall"), runWallTimeMs);
      let shutdownTimer: NodeJS.Timeout | undefined;
      const shutdownFallback = new Promise<DiscoveryTransportResult>(
        (resolve) => {
          const afterAbort = () => {
            shutdownTimer = setTimeout(
              () => {
                resolve({
                  receipt: createNativeRunReceipt({
                    runId: run.runId,
                    targetSnapshotDigest: run.targetSnapshotDigest,
                    profile: run.profile,
                    terminal: "incomplete",
                    reason:
                      controller.signal.reason === "operator"
                        ? "operator"
                        : "wall",
                    startedAt: base.occurredAt,
                    completedAt: clock().toISOString(),
                  }),
                });
              },
              Math.min(70_000, runWallTimeMs ?? 70_000),
            );
          };
          controller.signal.addEventListener("abort", afterAbort, {
            once: true,
          });
          if (controller.signal.aborted) afterAbort();
        },
      );
      try {
        const execution = options.executor.execute(
          {
            ...run,
            campaignInput: {
              ...input,
              promptDigest:
                planned.configuration.promptDigest ?? input.promptDigest,
              history,
            },
          },
          controller.signal,
        );
        const result = await Promise.race([execution, shutdownFallback]);
        if (wallTimer !== undefined) clearTimeout(wallTimer);
        if (result.researchArtifact !== undefined) {
          if (result.researchArtifact.attachment.kind !== "research")
            throw new Error("Discovery research artifact kind is invalid");
          researchArtifact = {
            digest: result.researchArtifact.attachment.digest,
            truncated: result.researchArtifact.truncated,
          };
        }
        const receipt = nativeRunReceiptSchema.parse(result.receipt);
        wallTimeMs = Math.max(
          0,
          Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
        );
        usage = receipt.usage;
        observed = receipt.observed;
        childThreadsObserved = receipt.childThreadsObserved;
        childThreadsAdmitted = receipt.childThreadsAdmitted;
        brokerMetrics = receipt.brokerMetrics;
        sandboxExitCode = receipt.sandboxExitCode;
        diagnosticArtifactDigest = receipt.diagnosticArtifactDigest;
        // The receipt carries the runtime the run used (CLI version, catalog digest, model).
        receiptDigest = await options.evidence.putFiles({
          "receipt.json": canonicalJson(receipt),
        });
        if (receipt.providerLimit !== undefined) outcome = "provider-limited";
        if (
          receipt.terminal === "incomplete" &&
          receipt.reason !== "unavailable"
        )
          failure = {
            reason: receipt.reason,
            ...(receipt.reasonDetail === undefined
              ? {}
              : { reasonDetail: receipt.reasonDetail }),
            ...(receipt.providerLimit === undefined
              ? {}
              : { providerLimit: receipt.providerLimit }),
          };
        await recoverChildAgentReports({
          result,
          run,
          snapshotDigest: input.snapshotDigest,
          recordReport,
          ledger: options.ledger,
          evidence: options.evidence,
          base,
          trialId: trial.trialId,
          trialOrdinal: trial.trialOrdinal,
          labId: options.labId,
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
        if (recoveredRoot.recovered) outcome = "completed";
        if (recoveredRoot.failure !== undefined)
          failure = recoveredRoot.failure;
        if (
          outcome === "completed" &&
          run.coverageSchema !== undefined &&
          options.assessCoverage !== undefined
        ) {
          let coverage: unknown;
          if (result.attachment !== undefined) {
            const stored = await options.attachments.read(result.attachment);
            if (stored.status === "resolved") {
              try {
                const report = JSON.parse(
                  stored.bytes.toString("utf8"),
                ) as Record<string, unknown>;
                coverage = report.coverage;
              } catch {
                // The report recorder already classifies malformed reports.
              }
            }
          }
          const assessed = options.assessCoverage(coverage);
          if (assessed.record !== undefined)
            coverageDigest = await options.evidence.putFiles({
              "coverage.json": canonicalJson(assessed.record),
            });
          if (!assessed.accepted) {
            outcome = "failed";
            failure = { reason: "depth" };
          }
        }
      } catch {
        outcome = "failed";
        if (controller.signal.aborted) {
          const reason =
            controller.signal.reason === "operator" ? "operator" : "wall";
          failure = { reason };
          wallTimeMs = runWallTimeMs ?? 0;
          const receipt = createNativeRunReceipt({
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            terminal: "incomplete",
            reason,
            startedAt: base.occurredAt,
            completedAt: clock().toISOString(),
          });
          receiptDigest = await options.evidence.putFiles({
            "receipt.json": canonicalJson(receipt),
          });
        }
      } finally {
        if (wallTimer !== undefined) clearTimeout(wallTimer);
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
        options.signal?.removeEventListener("abort", onOperatorStop);
      }
      const counted = countsAsTrial({
        observed,
        childThreadsObserved,
        brokerMetrics,
      });
      if (!counted && outcome === "completed") {
        outcome = "failed";
        failure = { reason: "evidence", reasonDetail: "no-work" };
      }
      const finished = await options.ledger.append({
        ...base,
        identity: `discovery-finish-${run.runId}`,
        type: "discovery-run-finished",
        runId: run.runId,
        outcome,
        costUsd: "unavailable",
        wallTimeMs,
        ...(usage === undefined ? {} : { usage }),
        ...(observed === undefined ? {} : { observed }),
        ...(childThreadsObserved === undefined ? {} : { childThreadsObserved }),
        ...(childThreadsAdmitted === undefined ? {} : { childThreadsAdmitted }),
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        ...(sandboxExitCode === undefined ? {} : { sandboxExitCode }),
        ...(diagnosticArtifactDigest === undefined
          ? {}
          : { diagnosticArtifactDigest }),
        ...(researchArtifact === undefined ? {} : { researchArtifact }),
        ...(outcome === "completed" || failure === undefined ? {} : failure),
        artifacts: [
          ...(receiptDigest === undefined
            ? []
            : [{ kind: "native-run-receipt", digest: receiptDigest }]),
          ...(coverageDigest === undefined
            ? []
            : [{ kind: "coverage", digest: coverageDigest }]),
        ],
      });
      if (finished.status === "conflict")
        throw new Error("Discovery finish identity conflict");
      return { outcome, counted, ...reportState };
    };
    const explore = await executePlanned(trial.explore);
    if (!explore.counted) {
      stopped ??=
        explore.outcome === "provider-limited"
          ? "provider-limit"
          : "incomplete";
      return;
    }
    // Stop rules are evaluated once per Trial; in-flight Trials still finish.
    if (explore.outcome === "provider-limited") stopped ??= "provider-limit";
    if (explore.outcome === "failed") stopped ??= "incomplete";
    if (explore.outcome === "completed") {
      if (explore.heldBoundary && !explore.foundNew)
        stopped ??= "output-boundary";
      else noNewFindings = explore.foundNew ? 0 : noNewFindings + 1;
    }
    if (noNewFindings >= input.stopRules.noFindingRuns)
      stopped ??= "no-new-finding";
  };
  const worker = async () => {
    while (stopped === undefined && next < limit) {
      const ordinal = next++;
      if (!spentOrdinals.has(ordinal)) await runOne(ordinal);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const outcomes = readFinishes();
  const activeAfter = recordedTrialActivity(options.ledger, options.campaignId);
  const countedRuns = [...startedExplorations].filter((runId) =>
    countsAsTrial(
      outcomes.get(runId),
      activeAfter.has(`${options.campaignId}\0${runId}`),
    ),
  );
  const recordedFailure = countedRuns.some(
    (runId) => outcomes.get(runId)?.outcome === "provider-limited",
  )
    ? "provider-limit"
    : countedRuns.some((runId) => outcomes.get(runId)?.outcome !== "completed")
      ? "incomplete"
      : undefined;
  const stoppedBy =
    recordedFailure ??
    stopped ??
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
  return { runCount, findingsRecorded, stoppedBy };
}
