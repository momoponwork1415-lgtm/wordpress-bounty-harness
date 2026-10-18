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
  lab: z.union([
    z.strictObject({ setupDigest: digest }),
    z.strictObject({
      mode: z.literal("none"),
      setupDigest: z.undefined().optional(),
    }),
  ]),
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
    readonly labAccess?: { readonly database: "read-only" | "none" };
  };
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
  if (options.labId !== undefined) id.parse(options.labId);
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
    for (const { event } of options.ledger.readAll({
      campaignId: options.campaignId,
      type: "discovery-run-finished",
    }))
      if (
        event.type === "discovery-run-finished" &&
        event.snapshotDigest === input.snapshotDigest
      )
        finishes.set(event.runId, event);
    return finishes;
  };
  const finishedRuns = readFinishes();
  const activeRuns = recordedTrialActivity(options.ledger, options.campaignId);
  const startedExplorations = new Set<string>();
  const spentOrdinals = new Set<number>();
  let nextLegacyOrdinal = 0;
  for (const { event } of options.ledger.readAll({
    campaignId: options.campaignId,
    type: "discovery-run-started",
  }))
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
    const history =
      input.history.mode === "catalog"
        ? catalog.parse(input.history)
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
        ...(options.labId === undefined
          ? { labAttached: false as const }
          : { labId: options.labId, labAttached: true as const }),
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
        },
      });
      if (started.status === "conflict")
        throw new Error("Discovery run identity conflict");
      startedExplorations.add(run.runId);
      runCount++;
      let outcome: "completed" | "failed" | "provider-limited" = "failed";
      let wallTimeMs = 0;
      /** The transport's receipt; absent when the executor threw before returning one. */
      let receipt: NativeRunReceipt | undefined;
      let researchArtifact:
        { readonly digest: string; readonly truncated: boolean } | undefined;
      let receiptDigest: string | undefined;
      let coverageDigest: string | undefined;
      let readPathsDigest: string | undefined;
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
        receipt = nativeRunReceiptSchema.parse(result.receipt);
        wallTimeMs = receiptWallTimeMs(receipt);
        // The receipt carries the runtime the run used (CLI version, catalog digest, model).
        receiptDigest = await sealNativeRunReceipt(options.evidence, receipt);
        readPathsDigest = await recordReadPaths(
          options.attachments,
          options.evidence,
          receipt.diagnosticArtifactDigest,
        );
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
          attachments: options.attachments,
          base,
          trialId: trial.trialId,
          trialOrdinal: trial.trialOrdinal,
          ...(options.labId === undefined ? {} : { labId: options.labId }),
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
          // Sealed for the record only; the event keeps the transport's fields, if any arrived.
          receiptDigest = await sealNativeRunReceipt(
            options.evidence,
            createNativeRunReceipt({
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              terminal: "incomplete",
              reason,
              startedAt: base.occurredAt,
              completedAt: clock().toISOString(),
            }),
          );
        }
      } finally {
        if (wallTimer !== undefined) clearTimeout(wallTimer);
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
        options.signal?.removeEventListener("abort", onOperatorStop);
      }
      const counted = countsAsTrial(receipt ?? {});
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
        ...(receipt === undefined ? {} : runFinishedFieldsFrom(receipt)),
        ...(researchArtifact === undefined ? {} : { researchArtifact }),
        ...(outcome === "completed" || failure === undefined ? {} : failure),
        artifacts: [
          ...(receiptDigest === undefined
            ? []
            : [{ kind: "native-run-receipt", digest: receiptDigest }]),
          ...(coverageDigest === undefined
            ? []
            : [{ kind: "coverage", digest: coverageDigest }]),
          ...(readPathsDigest === undefined
            ? []
            : [{ kind: "read-paths", digest: readPathsDigest }]),
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
      if (!options.repeatAll && explore.heldBoundary && !explore.foundNew)
        stopped ??= "output-boundary";
      else noNewFindings = explore.foundNew ? 0 : noNewFindings + 1;
    }
    if (!options.repeatAll && noNewFindings >= input.stopRules.noFindingRuns)
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
