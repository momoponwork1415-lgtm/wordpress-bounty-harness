import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";
import type {
  DiscoveryTransportRun,
  DiscoveryTransportResult,
} from "./codex-native-agent-runtime.js";
import {
  nativeRunReceiptSchema,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";

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
  readonly axis: "history" | "prompt" | "continuation";
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

type AdmittedFinding = {
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
    readonly trustBoundaryVersion?: string;
    readonly sourcePack?: { readonly dependency: "mounted" | "none" };
    readonly assignmentUnit: string;
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
  readonly continuation?: {
    readonly maxRuns: number;
    readonly wallTimeMs: number;
    readonly plan: (lead: AdmittedLead) => PlannedDiscoveryRun;
  };
};

const providerReportSchema = z.strictObject({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()).default([]),
  examined: z.string(),
  unexamined: z.string(),
});

class DiscoveryReportError extends Error {}

export type DiscoveryStop =
  | "no-new-finding"
  | "max-runs"
  | "plans-exhausted"
  | "provider-limit"
  | "incomplete";

/** Run independent provider calls, record only admitted claims, and stop on no new findings. */
export async function runDiscoveryCampaign(options: {
  readonly campaignId: string;
  readonly labId: string;
  readonly input: CampaignInputV1;
  readonly historyFraction: number;
  /** Runs in flight at once on this host; at most four. */
  readonly concurrency?: number;
  /** Exploration wall time, stamped when each Trial starts rather than when all plans are built. */
  readonly runWallTimeMs?: number;
  /** Records each run's arm on the history axis: a without history, b with it. */
  readonly ablation?: { readonly axes: readonly AblationAxis[] };
  readonly plannedTrials: readonly PlannedTrial[];
  readonly executor: {
    execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult>;
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
  const startedRuns = new Map<string, "explore" | "continue" | "child">();
  let startAfterSequence = 0;
  for (;;) {
    const page = options.ledger.read({
      campaignId: options.campaignId,
      type: "discovery-run-started",
      afterSequence: startAfterSequence,
      limit: 1000,
    });
    for (const { event } of page)
      if (event.type === "discovery-run-started")
        startedRuns.set(event.runId, event.runKind ?? "explore");
    if (page.length < 1000) break;
    startAfterSequence = page[page.length - 1]!.sequence;
  }
  const spent = ofTarget(
    options.ledger
      .read({
        campaignId: options.campaignId,
        type: "discovery-run-finished",
        limit: 1000,
      })
      .map(({ event }) => event),
  ).filter(
    (event) =>
      event.type === "discovery-run-finished" &&
      // Old events precede runKind and each represented one exploration.
      (startedRuns.get(event.runId) ?? "explore") === "explore" &&
      event.outcome === "completed",
  ).length;
  const seen = new Set<string>();
  let noNewFindings = 0;
  let runCount = 0;
  let findingsRecorded = 0;
  let stopped: "no-new-finding" | "provider-limit" | "incomplete" | undefined;
  if (
    options.runWallTimeMs !== undefined &&
    (!Number.isSafeInteger(options.runWallTimeMs) ||
      options.runWallTimeMs < 1 ||
      options.runWallTimeMs > 240 * 60_000)
  )
    throw new Error("Invalid exploration wall time");
  const limit = Math.min(input.stopRules.maxRuns, options.plannedTrials.length);
  let next = spent;
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
      runKind: "explore" | "continue",
      continuationOf?: string,
      runWallTimeMs = options.runWallTimeMs,
    ): Promise<{
      outcome: "completed" | "failed" | "provider-limited";
      foundNew: boolean;
      leads: AdmittedLead[];
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
        runKind === "continue" &&
        (continuationOf === undefined ||
          run.runId === trial.trialId ||
          run.sourceDirectory !== trial.explore.run.sourceDirectory ||
          run.sourceTree.digest !== trial.explore.run.sourceTree.digest ||
          run.dependencySource?.tree.digest !==
            trial.explore.run.dependencySource?.tree.digest ||
          canonicalDigest(run.lab) !== canonicalDigest(trial.explore.run.lab))
      )
        throw new Error(
          "Continuation differs from its Trial source pack or Lab",
        );
      if (
        run.targetSnapshotDigest !== input.snapshotDigest ||
        run.profile.digest !== input.modelProfileDigest
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
        runKind,
        ...(continuationOf === undefined ? {} : { continuationOf }),
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
      if (runKind === "explore") runCount++;
      let outcome: "completed" | "failed" | "provider-limited" = "failed";
      let wallTimeMs = 0;
      let foundNew = false;
      const admittedLeads: AdmittedLead[] = [];
      let usage: NativeRunReceipt["usage"] | undefined;
      let observed: NativeRunReceipt["observed"] | undefined;
      let brokerMetrics: NativeRunReceipt["brokerMetrics"];
      let sandboxExitCode: number | undefined;
      let diagnosticArtifactDigest: string | undefined;
      let receiptDigest: string | undefined;
      let failure:
        | {
            readonly reason: Exclude<NativeRunReceipt["reason"], "unavailable">;
            readonly reasonDetail?: string;
            readonly providerLimit?: "rate-limit" | "quota";
          }
        | undefined;
      const rejectCandidate = async (
        ownerRunId: string,
        candidateKind: "finding" | "lead",
        candidateIndex: number,
        candidate: unknown,
        reason: "schema" | "identity",
      ) => {
        const candidateDigest = await options.evidence.putFiles({
          "candidate.json": canonicalJson(candidate),
        });
        const appended = await options.ledger.append({
          ...base,
          identity: `candidate-rejected-${ownerRunId}-${candidateKind}-${candidateIndex}`,
          type: "candidate-rejected",
          runId: ownerRunId,
          candidateKind,
          candidateIndex,
          reason,
          artifacts: [{ kind: "candidate", digest: candidateDigest }],
        });
        if (appended.status === "conflict")
          throw new Error("Candidate rejection identity conflict");
      };
      const recordReport = async (
        ownerRunId: string,
        attachment: NonNullable<DiscoveryTransportResult["attachment"]>,
      ): Promise<void> => {
        const stored = await options.attachments.read(attachment);
        if (stored.status !== "resolved")
          throw new DiscoveryReportError(
            "Discovery report attachment is unavailable",
          );
        let report: z.infer<typeof providerReportSchema>;
        try {
          report = providerReportSchema.parse(
            JSON.parse(stored.bytes.toString("utf8")) as unknown,
          );
        } catch {
          throw new DiscoveryReportError("Discovery report is malformed");
        }
        for (const [index, candidate] of report.findings.entries()) {
          let finding: AdmittedFinding;
          try {
            finding = options.admitFinding(candidate, {
              runId: ownerRunId,
              snapshotDigest: input.snapshotDigest,
              reportArtifactDigest: attachment.digest,
            });
          } catch {
            await rejectCandidate(
              ownerRunId,
              "finding",
              index,
              candidate,
              "schema",
            );
            continue;
          }
          if (
            finding.discoveryRunId !== ownerRunId ||
            finding.snapshotDigest !== input.snapshotDigest
          ) {
            await rejectCandidate(
              ownerRunId,
              "finding",
              index,
              candidate,
              "identity",
            );
            continue;
          }
          const findingDigest = await options.evidence.putFiles({
            "finding.json": canonicalJson(finding),
          });
          const appended = await options.ledger.append({
            ...base,
            artifacts: [{ kind: "finding", digest: findingDigest }],
            identity: `discovery-finding-${finding.findingId}`,
            type: "finding-recorded",
            findingId: finding.findingId,
            runId: ownerRunId,
            category: finding.impact,
            ...(finding.historyRecordId === undefined
              ? {}
              : { historyRecordId: finding.historyRecordId }),
          });
          if (appended.status === "conflict")
            throw new Error("Finding identity conflict");
          findingsRecorded += appended.status === "appended" ? 1 : 0;
          const signature = canonicalDigest({
            claim: finding.claim,
            impact: finding.impact,
            sourceTrace: finding.sourceTrace,
          });
          if (!seen.has(signature)) foundNew = true;
          seen.add(signature);
        }
        for (const [index, candidate] of report.leads.entries()) {
          let lead: AdmittedLead;
          try {
            if (
              options.admitLead === undefined ||
              options.leadSignature === undefined
            )
              throw new Error("Lead admission is unavailable");
            lead = options.admitLead(candidate, {
              runId: ownerRunId,
              trialId: trial.trialId,
              snapshotDigest: input.snapshotDigest,
              reportArtifactDigest: attachment.digest,
            });
          } catch {
            await rejectCandidate(
              ownerRunId,
              "lead",
              index,
              candidate,
              "schema",
            );
            continue;
          }
          if (
            lead.discoveryRunId !== ownerRunId ||
            lead.trialId !== trial.trialId ||
            lead.snapshotDigest !== input.snapshotDigest
          ) {
            await rejectCandidate(
              ownerRunId,
              "lead",
              index,
              candidate,
              "identity",
            );
            continue;
          }
          const leadDigest = await options.evidence.putFiles({
            "lead.json": canonicalJson(lead),
          });
          const appended = await options.ledger.append({
            ...base,
            artifacts: [{ kind: "lead", digest: leadDigest }],
            identity: `discovery-lead-${lead.leadId}`,
            type: "lead-recorded",
            leadId: lead.leadId,
            runId: ownerRunId,
            trialId: trial.trialId,
            missingEdge: lead.missingEdge,
            primitive: lead.primitive,
            storageKind: lead.storage?.kind ?? "none",
          });
          if (appended.status === "conflict")
            throw new Error("Lead identity conflict");
          admittedLeads.push(lead);
          const signature = digest.parse(options.leadSignature!(lead));
          if (!seen.has(signature)) foundNew = true;
          seen.add(signature);
        }
      };
      try {
        const result = await options.executor.execute({
          ...run,
          campaignInput: {
            ...input,
            promptDigest:
              planned.configuration.promptDigest ?? input.promptDigest,
            history,
          },
        });
        const receipt = nativeRunReceiptSchema.parse(result.receipt);
        wallTimeMs = Math.max(
          0,
          Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
        );
        usage = receipt.usage;
        observed = receipt.observed;
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
        for (const child of result.agentRuns ?? []) {
          const childReceipt = nativeRunReceiptSchema.parse(child.receipt);
          const childStart = await options.ledger.append({
            ...base,
            identity: `discovery-start-${childReceipt.runId}`,
            type: "discovery-run-started",
            runId: childReceipt.runId,
            trialId: trial.trialId,
            trialOrdinal: trial.trialOrdinal,
            runKind: "child",
            parentRunId: run.runId,
            labId: options.labId,
            history: historyMetadata,
            configuration: {
              ...planned.configuration,
              promptDigest:
                planned.configuration.promptDigest ?? input.promptDigest,
              trustBoundaryVersion: input.trustBoundary.version,
              agentPath: child.agentPath,
            },
          });
          if (childStart.status === "conflict")
            throw new Error("Child start identity conflict");
          const childReceiptDigest = await options.evidence.putFiles({
            "receipt.json": canonicalJson(childReceipt),
          });
          let childOutcome: "completed" | "failed" = "failed";
          let childFailure: typeof failure;
          if (
            childReceipt.terminal === "completed" &&
            childReceipt.targetSnapshotDigest === input.snapshotDigest &&
            childReceipt.runtimeProfileDigest === run.profile.digest &&
            child.attachment !== undefined &&
            childReceipt.reportArtifactDigest === child.attachment.digest
          ) {
            try {
              await recordReport(childReceipt.runId, child.attachment);
              childOutcome = "completed";
            } catch (error) {
              if (!(error instanceof DiscoveryReportError)) throw error;
              childFailure = {
                reason: "schema",
                reasonDetail: "child-report-unreadable",
              };
            }
          } else {
            childFailure = {
              reason:
                childReceipt.reason === "unavailable"
                  ? "policy"
                  : childReceipt.reason,
              reasonDetail:
                childReceipt.reasonDetail ?? "child-receipt-invalid",
            };
          }
          const childFinished = await options.ledger.append({
            ...base,
            identity: `discovery-finish-${childReceipt.runId}`,
            type: "discovery-run-finished",
            runId: childReceipt.runId,
            outcome: childOutcome,
            costUsd: "unavailable",
            wallTimeMs: Math.max(
              0,
              Date.parse(childReceipt.completedAt) -
                Date.parse(childReceipt.startedAt),
            ),
            usage: childReceipt.usage,
            ...(childReceipt.observed === undefined
              ? {}
              : { observed: childReceipt.observed }),
            ...(childReceipt.sandboxExitCode === undefined
              ? {}
              : { sandboxExitCode: childReceipt.sandboxExitCode }),
            ...(childReceipt.diagnosticArtifactDigest === undefined
              ? {}
              : {
                  diagnosticArtifactDigest:
                    childReceipt.diagnosticArtifactDigest,
                }),
            ...(childFailure === undefined ? {} : childFailure),
            artifacts: [
              { kind: "native-run-receipt", digest: childReceiptDigest },
            ],
          });
          if (childFinished.status === "conflict")
            throw new Error("Child finish identity conflict");
        }
        const attachment = result.attachment;
        if (
          receipt.terminal === "completed" &&
          receipt.runId === run.runId &&
          receipt.targetSnapshotDigest === input.snapshotDigest &&
          receipt.runtimeProfileDigest === run.profile.digest &&
          attachment !== undefined &&
          receipt.reportArtifactDigest === attachment.digest
        ) {
          try {
            await recordReport(run.runId, attachment);
            outcome = "completed";
          } catch (error) {
            if (!(error instanceof DiscoveryReportError)) throw error;
            failure = {
              reason: "schema",
              reasonDetail: "root-report-unreadable",
            };
          }
        }
      } catch {
        outcome = "failed";
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
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        ...(sandboxExitCode === undefined ? {} : { sandboxExitCode }),
        ...(diagnosticArtifactDigest === undefined
          ? {}
          : { diagnosticArtifactDigest }),
        ...(outcome === "completed" || failure === undefined ? {} : failure),
        ...(receiptDigest === undefined
          ? {}
          : {
              artifacts: [
                { kind: "native-run-receipt", digest: receiptDigest },
              ],
            }),
      });
      if (finished.status === "conflict")
        throw new Error("Discovery finish identity conflict");
      return { outcome, foundNew, leads: admittedLeads };
    };
    const explore = await executePlanned(trial.explore, "explore");
    let trialFoundNew = explore.foundNew;
    if (
      explore.outcome === "completed" &&
      trial.continuation !== undefined &&
      explore.leads.length > 0
    ) {
      if (
        !Number.isSafeInteger(trial.continuation.maxRuns) ||
        trial.continuation.maxRuns < 1 ||
        trial.continuation.maxRuns > 2 ||
        !Number.isSafeInteger(trial.continuation.wallTimeMs) ||
        trial.continuation.wallTimeMs < 1 ||
        trial.continuation.wallTimeMs > 120 * 60_000
      )
        throw new Error("Invalid Trial continuation bounds");
      const edgeOrder = [
        "auth-use",
        "consumer",
        "producer",
        "reachability",
        "precondition",
      ] as const;
      const ranked = [...explore.leads].sort(
        (a, b) =>
          edgeOrder.indexOf(a.missingEdge) - edgeOrder.indexOf(b.missingEdge) ||
          (a.sourceTrace[0]?.file ?? "").localeCompare(
            b.sourceTrace[0]?.file ?? "",
          ) ||
          a.leadId.localeCompare(b.leadId),
      );
      for (const lead of ranked.slice(0, trial.continuation.maxRuns)) {
        const followUp = trial.continuation.plan(lead);
        const continued = await executePlanned(
          followUp,
          "continue",
          lead.leadId,
          trial.continuation.wallTimeMs,
        );
        trialFoundNew ||= continued.foundNew;
        if (continued.outcome === "provider-limited") {
          stopped ??= "provider-limit";
          break;
        }
      }
    }
    // Stop rules are evaluated once per Trial; in-flight Trials still finish.
    if (explore.outcome === "provider-limited") stopped ??= "provider-limit";
    if (explore.outcome === "failed") stopped ??= "incomplete";
    if (explore.outcome === "completed")
      noNewFindings = trialFoundNew ? 0 : noNewFindings + 1;
    if (noNewFindings >= input.stopRules.noFindingRuns)
      stopped ??= "no-new-finding";
  };
  const worker = async () => {
    while (stopped === undefined && next < limit) {
      await runOne(next++);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const stoppedBy =
    stopped ??
    (options.plannedTrials.length >= input.stopRules.maxRuns
      ? "max-runs"
      : "plans-exhausted");
  // An incomplete attempt or provider limit leaves the target open for a fresh Trial.
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
