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
    readonly assignmentUnit: string;
  };
};

const providerReportSchema = z.strictObject({
  findings: z.array(z.unknown()),
  examined: z.string(),
  unexamined: z.string(),
});

export type DiscoveryStop =
  | "no-new-finding"
  | "max-runs"
  | "plans-exhausted"
  | "provider-limit"
  | "daily-run-cap";

/** Run independent provider calls, record only admitted claims, and stop on no new findings. */
export async function runDiscoveryCampaign(options: {
  readonly campaignId: string;
  readonly labId: string;
  readonly input: CampaignInputV1;
  readonly historyFraction: number;
  /** Runs in flight at once on this host; at most four. */
  readonly concurrency?: number;
  /** Optional ceiling on runs started per UTC day across every campaign in the ledger. */
  readonly dailyRunCap?: number;
  /** Records each run's arm on the history axis: a without history, b with it. */
  readonly ablation?: { readonly axis: "history" };
  readonly plannedRuns: readonly PlannedDiscoveryRun[];
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
      (event.outcome === "completed" || event.outcome === "failed"),
  ).length;
  const seen = new Set<string>();
  let noNewFindings = 0;
  let runCount = 0;
  let findingsRecorded = 0;
  let stopped:
    "no-new-finding" | "provider-limit" | "daily-run-cap" | undefined;
  if (
    options.dailyRunCap !== undefined &&
    (!Number.isSafeInteger(options.dailyRunCap) || options.dailyRunCap < 1)
  )
    throw new Error("Invalid daily run cap");
  let startedToday = 0;
  if (options.dailyRunCap !== undefined) {
    const day = clock().toISOString().slice(0, 10);
    let afterSequence = 0;
    for (;;) {
      const page = options.ledger.read({
        type: "discovery-run-started",
        afterSequence,
        limit: 1000,
      });
      startedToday += page.filter(
        ({ event }) =>
          new Date(event.occurredAt).toISOString().slice(0, 10) === day,
      ).length;
      if (page.length < 1000) break;
      afterSequence = page[page.length - 1]!.sequence;
    }
  }
  const limit = Math.min(input.stopRules.maxRuns, options.plannedRuns.length);
  let next = spent;
  const runOne = async (index: number) => {
    const planned = options.plannedRuns[index]!;
    const run = planned.run;
    if (
      run.targetSnapshotDigest !== input.snapshotDigest ||
      run.profile.digest !== input.modelProfileDigest
    )
      throw new Error("Planned run differs from the CampaignInput");
    const history =
      input.history.mode === "catalog"
        ? historyForRun(index, options.historyFraction, input.history)
        : { mode: "none" as const };
    const historyMetadata =
      history.mode === "catalog"
        ? {
            mode: "catalog" as const,
            digest: history.digest,
            recordIds: history.records.map((record) => record.id),
          }
        : { mode: "none" as const };
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
      labId: options.labId,
      history: historyMetadata,
      configuration:
        options.ablation === undefined
          ? planned.configuration
          : {
              ...planned.configuration,
              axis: options.ablation.axis,
              arm: history.mode === "catalog" ? "b" : "a",
            },
    });
    if (started.status === "conflict")
      throw new Error("Discovery run identity conflict");
    runCount++;
    let outcome: "completed" | "failed" | "provider-limited" = "failed";
    let wallTimeMs = 0;
    let foundNew = false;
    let usage: NativeRunReceipt["usage"] | undefined;
    let receiptDigest: string | undefined;
    let failure:
      | {
          readonly reason: Exclude<NativeRunReceipt["reason"], "unavailable">;
          readonly reasonDetail?: string;
          readonly providerLimit?: "rate-limit" | "quota";
        }
      | undefined;
    try {
      const result = await options.executor.execute({
        ...run,
        campaignInput: { ...input, history },
      });
      const receipt = nativeRunReceiptSchema.parse(result.receipt);
      wallTimeMs = Math.max(
        0,
        Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt),
      );
      usage = receipt.usage;
      // The receipt carries the runtime the run used (CLI version, catalog digest, model).
      receiptDigest = await options.evidence.putFiles({
        "receipt.json": canonicalJson(receipt),
      });
      if (receipt.providerLimit !== undefined) outcome = "provider-limited";
      if (receipt.terminal === "incomplete" && receipt.reason !== "unavailable")
        failure = {
          reason: receipt.reason,
          ...(receipt.reasonDetail === undefined
            ? {}
            : { reasonDetail: receipt.reasonDetail }),
          ...(receipt.providerLimit === undefined
            ? {}
            : { providerLimit: receipt.providerLimit }),
        };
      if (
        receipt.terminal === "completed" &&
        receipt.runId === run.runId &&
        receipt.targetSnapshotDigest === input.snapshotDigest &&
        receipt.runtimeProfileDigest === run.profile.digest &&
        result.attachment !== undefined &&
        receipt.reportArtifactDigest === result.attachment.digest
      ) {
        const stored = await options.attachments.read(result.attachment);
        if (stored.status === "resolved") {
          const report = providerReportSchema.parse(
            JSON.parse(stored.bytes.toString("utf8")) as unknown,
          );
          const findings = report.findings.map((candidate) =>
            options.admitFinding(candidate, {
              runId: run.runId,
              snapshotDigest: input.snapshotDigest,
              reportArtifactDigest: result.attachment!.digest,
            }),
          );
          for (const finding of findings) {
            if (
              finding.discoveryRunId !== run.runId ||
              finding.snapshotDigest !== input.snapshotDigest
            )
              throw new Error("Finding differs from its run");
          }
          for (const finding of findings) {
            // The full claim and trace stay private; the ledger keeps the digest.
            const findingDigest = await options.evidence.putFiles({
              "finding.json": canonicalJson(finding),
            });
            const appended = await options.ledger.append({
              ...base,
              artifacts: [{ kind: "finding", digest: findingDigest }],
              identity: `discovery-finding-${finding.findingId}`,
              type: "finding-recorded",
              findingId: finding.findingId,
              runId: run.runId,
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
          outcome = "completed";
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
      ...(outcome === "completed" || failure === undefined ? {} : failure),
      ...(receiptDigest === undefined
        ? {}
        : {
            artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
          }),
    });
    if (finished.status === "conflict")
      throw new Error("Discovery finish identity conflict");
    // Stop rules are evaluated in completion order; in-flight runs still finish.
    if (outcome === "provider-limited") stopped ??= "provider-limit";
    if (outcome === "completed")
      noNewFindings = foundNew ? 0 : noNewFindings + 1;
    if (noNewFindings >= input.stopRules.noFindingRuns)
      stopped ??= "no-new-finding";
  };
  const worker = async () => {
    while (stopped === undefined && next < limit) {
      if (options.dailyRunCap !== undefined) {
        if (startedToday >= options.dailyRunCap) {
          stopped = "daily-run-cap";
          return;
        }
        startedToday++;
      }
      await runOne(next++);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const stoppedBy =
    stopped ??
    (options.plannedRuns.length >= input.stopRules.maxRuns
      ? "max-runs"
      : "plans-exhausted");
  // A provider limit or the daily cap leaves the target open so the campaign can resume it.
  if (stoppedBy !== "provider-limit" && stoppedBy !== "daily-run-cap") {
    const recorded = await options.ledger.append({
      schemaVersion: 1,
      campaignId: options.campaignId,
      snapshotDigest: input.snapshotDigest,
      occurredAt: clock().toISOString(),
      identity: `discovery-concluded-${options.campaignId}-${input.snapshotDigest}`,
      type: "discovery-concluded",
      stoppedBy,
    });
    if (recorded.status === "conflict")
      throw new Error("Discovery conclusion identity conflict");
  }
  return { runCount, findingsRecorded, stoppedBy };
}
