import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import { bytesDigest } from "../infrastructure/content-digest.js";
import {
  DISCOVERY_OWNER_DIRECTORY,
  forgetDiscoveryOwners,
  readDiscoveryOwners,
  recordDiscoveryOwner,
} from "../infrastructure/lab-owner-record.js";
import type { Ledger } from "../ledger/index.js";
import type { PlannedDiscoveryRun, PlannedTrial } from "./campaign.js";
import { countsAsTrial } from "./counts-as-trial.js";
import {
  armCancellation,
  failureOf,
  finishedEventFrom,
  type EventBase,
  type TrialContext,
  type TrialOutcome,
} from "./execute-trial.js";
import {
  createNativeRunReceipt,
  nativeRunReceiptSchema,
  receiptWallTimeMs,
  sealNativeRunReceipt,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import {
  admittedOneShotFiles,
  ONE_SHOT_MAX_INPUT_BYTES,
  type OneShotFile,
  type OneShotResult,
  type OneShotRun,
} from "./one-shot-run.js";
import {
  collapseInventory,
  inventorySchema,
  partitionProposalSchema,
  rejectionReasonTokens,
  resubmitDecision,
  validatePartitionProposal,
  type AssignedPartition,
  type Inventory,
  type PartitionLimits,
  type PartitionProposal,
  type PartitionRejection,
} from "./partition.js";
import { recordReadPaths } from "./read-paths.js";
import { createReportRecorder } from "./record-discovery-report.js";
import {
  DiscoveryReportError,
  type ReportFailure,
} from "./recover-agent-reports.js";
import { dependencyMountPathsOf } from "./sandbox-layout.js";

/**
 * A partitioned Trial (ADR 0042): one enumerator run, the Harness's shape
 * check of its inventory and partition proposal, and one tracer run per
 * accepted partition. Every role run is one `discovery-run-started` /
 * `discovery-run-finished` pair under the Trial's id. The Harness never
 * adds, moves or splits a row or a partition: an over-limit or malformed
 * proposal goes back to the enumerator with the reasons, up to
 * `maxResubmits`, and then the Trial ends incomplete.
 */
export type PartitionedRolePlan = {
  /** The role's run; the Harness adds the run id, its input files and the expiry. */
  readonly run: Omit<OneShotRun, "runId" | "inputFiles" | "expiresAt">;
  /** Recorded on the role's start event; `role.partitionId` / `role.resubmit` are added per run. */
  readonly configuration: PlannedDiscoveryRun["configuration"];
};

export type PartitionedTrialPlan = {
  readonly enumerate: PartitionedRolePlan;
  readonly trace: PartitionedRolePlan;
  readonly limits: PartitionLimits;
  /** Tracer runs in flight at once. */
  readonly maxParallel: number;
  /** The whole target's wall from the enumerator's start; capped at the ceiling. */
  readonly targetWallMs: number;
  readonly rowSource: "agent" | "script-only";
  readonly definitionDigests: {
    readonly enumerator: string;
    readonly tracer: string;
  };
  readonly toolsDigest: string;
};

/** One target in a partitioned campaign may take this long at most (ADR 0042). */
export const PARTITIONED_TARGET_CEILING_MS = 240 * 60_000;
/**
 * A role run after the enumerator's first (a send-back, a tracer, a retry)
 * starts only when at least this much of the target wall is left; otherwise
 * it is recorded as `wall / target-ceiling` without a sandbox the wall would
 * kill at once.
 */
export const ROLE_START_FLOOR_MS = 5 * 60_000;

/** The files the Harness places under `/workspace/input` for a role. */
export const PARTITION_INPUT_FILES = {
  /** A sent-back enumerator: its previous inventory and proposal, as submitted. */
  previous: "previous.json",
  /** A sent-back enumerator: why the proposal came back. */
  sentBack: "sent-back.json",
  /** A tracer: `{id, label, rows}` of its partition. */
  partition: "partition.json",
} as const;
/** The files the enumerator writes under `/workspace/output`. */
export const ENUMERATION_OUTPUT_FILES = {
  inventory: "inventory.json",
  partitions: "partitions.json",
} as const;

/** Why a submission came back, as the enumerator reads it in `sent-back.json`. */
type SentBackRejection =
  | PartitionRejection
  | {
      readonly reason:
        | "inventory-missing"
        | "inventory-unreadable"
        | "inventory-invalid"
        | "proposal-missing"
        | "proposal-unreadable"
        | "proposal-invalid";
      /** The first schema issue, bounded; file text only, never in the ledger. */
      readonly detail?: string;
    };

/** The send-back could not be mounted: the previous submission exceeds the input file cap. */
const SEND_BACK_OVERSIZE = "send-back-oversize";

type Submission = {
  /** The submitted values as JSON, or null where the file was absent or not JSON. */
  readonly inventory: unknown;
  readonly partitions: unknown;
  readonly parsedInventory?: Inventory;
  readonly parsedProposal?: PartitionProposal;
  readonly rejections: readonly SentBackRejection[];
};

function readJson(text: string | undefined): {
  readonly value: unknown;
  readonly state: "missing" | "unreadable" | "read";
} {
  if (text === undefined) return { value: null, state: "missing" };
  try {
    return { value: JSON.parse(text) as unknown, state: "read" };
  } catch {
    return { value: null, state: "unreadable" };
  }
}

function issueDetail(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined
    ? "invalid"
    : `${issue.path.map(String).join(".")}: ${issue.message}`.slice(0, 200);
}

/** Reads the enumerator's two files; every shape problem is listed, not the first. */
export function readEnumerationOutput(
  files: readonly OneShotFile[],
): Submission {
  const text = (name: string) =>
    files.find((file) => file.name === name)?.content;
  const inventory = readJson(text(ENUMERATION_OUTPUT_FILES.inventory));
  const partitions = readJson(text(ENUMERATION_OUTPUT_FILES.partitions));
  const rejections: SentBackRejection[] = [];
  let parsedInventory: Inventory | undefined;
  let parsedProposal: PartitionProposal | undefined;
  if (inventory.state !== "read")
    rejections.push({ reason: `inventory-${inventory.state}` });
  else {
    const parsed = inventorySchema.safeParse(inventory.value);
    if (parsed.success) parsedInventory = parsed.data;
    else
      rejections.push({
        reason: "inventory-invalid",
        detail: issueDetail(parsed.error),
      });
  }
  if (partitions.state !== "read")
    rejections.push({ reason: `proposal-${partitions.state}` });
  else {
    const parsed = partitionProposalSchema.safeParse(partitions.value);
    if (parsed.success) parsedProposal = parsed.data;
    else
      rejections.push({
        reason: "proposal-invalid",
        detail: issueDetail(parsed.error),
      });
  }
  return {
    inventory: inventory.value,
    partitions: partitions.value,
    ...(parsedInventory === undefined ? {} : { parsedInventory }),
    ...(parsedProposal === undefined ? {} : { parsedProposal }),
    rejections,
  };
}

type RoleRun = {
  readonly runId: string;
  readonly runKind: "enumerate" | "trace";
  readonly plan: PartitionedRolePlan;
  readonly inputFiles: readonly OneShotFile[];
  /** 0 or less: the target ceiling is spent; the run is recorded without starting. */
  readonly wallMs: number;
  readonly role: { readonly partitionId?: string; readonly resubmit?: number };
  /** Admits a completed result before the finish is appended; a failure it returns ends the run incomplete. */
  readonly admit?: (
    result: OneShotResult,
  ) => Promise<ReportFailure | undefined>;
};

type RoleOutcome = {
  readonly runId: string;
  readonly outcome: "completed" | "failed" | "provider-limited";
  readonly failure?: ReportFailure;
  readonly receipt?: NativeRunReceipt;
  readonly receiptDigest?: string;
  readonly readPathsDigest?: string;
  /** Complete JSON output from a file-producing role, sealed before its finish. */
  readonly outputDigest?: string;
  /** Private archive of the role's Trial-local notes. */
  readonly researchArtifactDigest?: string;
  /** The message of a Harness-side throw after the run, in Private Evidence. */
  readonly errorDigest?: string;
  readonly result?: OneShotResult;
  readonly wallTimeMs: number;
};

/** The finish artifact that carries a post-run throw's message. */
const ROLE_RUN_ERROR_ARTIFACT = "role-run-error";
/** The sandbox collects at most 8 MiB of notes; the JSON archive is bounded too. */
const MAX_RESEARCH_ARCHIVE_BYTES = 12 * 1024 * 1024;

/** Run owners are separate from Docker resource owners, which broad cleanup removes. */
const ONE_SHOT_OWNER_DIRECTORY = join(
  dirname(DISCOVERY_OWNER_DIRECTORY),
  "one-shot-owners",
);

function oneShotOwnerName(
  campaignId: string,
  snapshotDigest: string,
  runId: string,
): string {
  return `one-shot-${createHash("sha256")
    .update(`${campaignId}\0${snapshotDigest}\0${runId}`)
    .digest("hex")}`;
}

/** Seal only one-shot starts with positive proof that their owner process died. */
export async function sealDeadOneShotRuns(input: {
  readonly ledger: Ledger;
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly clock: () => Date;
  readonly ownerDirectory?: string;
}): Promise<void> {
  const directory = input.ownerDirectory ?? ONE_SHOT_OWNER_DIRECTORY;
  const { dead } = await readDiscoveryOwners(directory);
  if (dead.size === 0) return;
  const finished = new Set(
    input.ledger
      .readAll({ campaignId: input.campaignId, type: "discovery-run-finished" })
      .flatMap(({ event }) =>
        event.type === "discovery-run-finished" &&
        event.snapshotDigest === input.snapshotDigest
          ? [event.runId]
          : [],
      ),
  );
  for (const { event } of input.ledger.readAll({
    campaignId: input.campaignId,
    type: "discovery-run-started",
  })) {
    if (
      event.type !== "discovery-run-started" ||
      event.snapshotDigest !== input.snapshotDigest ||
      (event.runKind !== "enumerate" && event.runKind !== "trace")
    )
      continue;
    const resource = oneShotOwnerName(
      input.campaignId,
      input.snapshotDigest,
      event.runId,
    );
    if (!dead.has(resource)) continue;
    if (finished.has(event.runId)) {
      await forgetDiscoveryOwners([resource], directory);
      continue;
    }
    const sealed = await input.ledger.append({
      schemaVersion: 1,
      campaignId: input.campaignId,
      snapshotDigest: input.snapshotDigest,
      occurredAt: input.clock().toISOString(),
      identity: `discovery-finish-${event.runId}`,
      type: "discovery-run-finished",
      runId: event.runId,
      outcome: "failed",
      reason: "interrupted",
      reasonDetail: "owner-dead",
      costUsd: "unavailable",
      // No one-shot receipt survived to establish a lower bound on active wall.
      wallTimeMs: 0,
    });
    if (sealed.status === "conflict")
      throw new Error("Interrupted one-shot finish identity conflict");
    finished.add(event.runId);
    await forgetDiscoveryOwners([resource], directory);
  }
}

class ResearchArchiveSizeError extends Error {}

type Draft<T> = { -readonly [K in keyof T]: T[K] };

/** One role run: start event, transport under its wall, sealed receipt, finish event. */
async function runRole(
  context: TrialContext,
  trial: PlannedTrial,
  base: EventBase,
  role: RoleRun,
): Promise<RoleOutcome> {
  const { input, clock } = context;
  const executor = context.oneShotExecutor!;
  const { configuration } = role.plan;
  const wallMs = Math.max(0, Math.floor(role.wallMs));
  const run: OneShotRun = {
    ...role.plan.run,
    runId: role.runId,
    inputFiles: role.inputFiles,
    wallMs: Math.max(1, wallMs),
    expiresAt: new Date(clock().getTime() + Math.max(1, wallMs)).toISOString(),
  };
  if (
    run.targetSnapshotDigest !== input.snapshotDigest ||
    run.profile.digest !== input.modelProfileDigest
  )
    throw new Error("Planned role run differs from the CampaignInput");
  const owner = await recordDiscoveryOwner({
    resource: oneShotOwnerName(
      context.campaignId,
      input.snapshotDigest,
      run.runId,
    ),
    directory: context.oneShotOwnerDirectory ?? ONE_SHOT_OWNER_DIRECTORY,
  });
  const startedAt = clock().toISOString();
  try {
    const started = await context.ledger.append({
      ...base,
      occurredAt: startedAt,
      identity: `discovery-start-${run.runId}`,
      type: "discovery-run-started",
      runId: run.runId,
      trialId: trial.trialId,
      trialOrdinal: trial.trialOrdinal,
      runKind: role.runKind,
      labAttached: false,
      history: input.history,
      configuration: {
        ...configuration,
        promptDigest: configuration.promptDigest ?? input.promptDigest,
        trustBoundaryVersion: input.trustBoundary.version,
        sourcePack: {
          dependency:
            run.dependencySource === undefined
              ? ("none" as const)
              : ("mounted" as const),
        },
        ...(configuration.role === undefined
          ? {}
          : {
              role: {
                ...configuration.role,
                ...(role.role.partitionId === undefined
                  ? {}
                  : { partitionId: role.role.partitionId }),
                ...(role.role.resubmit === undefined
                  ? {}
                  : { resubmit: role.role.resubmit }),
              },
            }),
      },
    });
    if (started.status === "conflict")
      throw new Error("Discovery run identity conflict");
  } catch (error: unknown) {
    await owner.release().catch(() => undefined);
    throw error;
  }
  const synthetic = (
    reason: "wall" | "operator" | "evidence",
    detail?: string,
    diagnosticArtifactDigest?: string,
  ): OneShotResult => ({
    receipt: createNativeRunReceipt({
      runId: run.runId,
      targetSnapshotDigest: run.targetSnapshotDigest,
      profile: run.profile,
      terminal: "incomplete",
      reason,
      ...(detail === undefined ? {} : { reasonDetail: detail }),
      ...(diagnosticArtifactDigest === undefined
        ? {}
        : { diagnosticArtifactDigest }),
      startedAt,
      completedAt: clock().toISOString(),
    }),
    scriptRan: false,
  });
  const draft: Draft<RoleOutcome> = {
    runId: run.runId,
    outcome: "failed",
    wallTimeMs: 0,
  };
  const cancellation = armCancellation<OneShotResult>({
    operator: context.signal,
    runWallTimeMs: wallMs > 0 ? wallMs : undefined,
    resultOnSilence: (reason) => synthetic(reason),
  });
  // Only the transport is under the catch-all: a throw there is the sandbox's.
  let result: OneShotResult | undefined;
  try {
    // The ceiling is spent or the operator stopped: recorded, never started.
    result =
      wallMs <= 0
        ? synthetic("wall", "target-ceiling")
        : context.signal?.aborted
          ? synthetic("operator")
          : await Promise.race([
              executor.execute(run, cancellation.signal),
              cancellation.fallback,
            ]);
  } catch {
    if (cancellation.signal.aborted) {
      const reason =
        cancellation.signal.reason === "operator" ? "operator" : "wall";
      draft.failure = { reason };
      draft.wallTimeMs = wallMs;
      draft.receiptDigest = await sealNativeRunReceipt(
        context.evidence,
        synthetic(reason).receipt,
      );
    } else
      draft.failure = { reason: "sandbox", reasonDetail: "transport-threw" };
  } finally {
    cancellation.disarmWall();
    cancellation.dispose();
  }
  if (result !== undefined) {
    // Returned files outlive receipt parsing/sealing: either failure must not
    // discard bytes the transport already handed back (#637).
    let captureFailure:
      | { readonly stage: "output" | "research"; readonly error: unknown }
      | undefined;
    if (run.output === "files" && result.outputFiles?.length) {
      try {
        draft.outputDigest = await context.evidence.putFiles(
          Object.fromEntries(
            result.outputFiles.map((file) => [file.name, file.content]),
          ),
        );
      } catch (error: unknown) {
        captureFailure = { stage: "output", error };
      }
    }
    if (result.researchArchive !== undefined) {
      try {
        if (
          result.researchArchive.byteLength === 0 ||
          result.researchArchive.byteLength > MAX_RESEARCH_ARCHIVE_BYTES
        )
          throw new ResearchArchiveSizeError();
        draft.researchArtifactDigest = await context.evidence.putFiles({
          "research.json": result.researchArchive,
        });
      } catch (error: unknown) {
        captureFailure ??= { stage: "research", error };
      }
    }
    // The Harness's own bookkeeping after the run: a throw here is recorded
    // as missing evidence, with its message in Private Evidence only.
    let stage = "receipt";
    try {
      const receipt = nativeRunReceiptSchema.parse(result.receipt);
      draft.result = result;
      draft.receipt = receipt;
      draft.wallTimeMs = receiptWallTimeMs(receipt);
      stage = "seal";
      draft.receiptDigest = await sealNativeRunReceipt(
        context.evidence,
        receipt,
      );
      stage = "read-paths";
      const readPathsDigest = await recordReadPaths(
        context.attachments,
        context.evidence,
        receipt.diagnosticArtifactDigest,
        dependencyMountPathsOf(run),
      );
      if (readPathsDigest !== undefined)
        draft.readPathsDigest = readPathsDigest;
      if (captureFailure !== undefined) {
        stage = captureFailure.stage;
        throw captureFailure.error;
      }
      if (
        receipt.runId !== run.runId ||
        receipt.targetSnapshotDigest !== input.snapshotDigest ||
        receipt.runtimeProfileDigest !== run.profile.digest
      )
        draft.failure = {
          reason: "policy",
          reasonDetail: "receipt-identity-mismatch",
        };
      else if (receipt.providerLimit !== undefined) {
        draft.outcome = "provider-limited";
        const failure = failureOf(receipt);
        if (failure !== undefined) draft.failure = failure;
      } else {
        const failure = failureOf(receipt);
        if (failure !== undefined) draft.failure = failure;
        else {
          stage = "admission";
          const admitted = await role.admit?.(result);
          if (admitted !== undefined) draft.failure = admitted;
          else draft.outcome = "completed";
        }
      }
    } catch (error: unknown) {
      draft.outcome = "failed";
      draft.failure = {
        reason: "evidence",
        reasonDetail:
          error instanceof ResearchArchiveSizeError
            ? "research-archive-size"
            : "post-run-threw",
      };
      // The store may be what failed: the finish is appended either way, with
      // whatever evidence could be written. The transport's receipt keeps its
      // own digest; a synthetic one stands in only when no receipt exists.
      const errorDigest = await context.evidence
        .putFiles({
          "role-run-error.json": canonicalJson({
            runId: run.runId,
            stage,
            message: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 4096),
          }),
        })
        .catch(() => undefined);
      if (errorDigest !== undefined) draft.errorDigest = errorDigest;
      if (draft.receipt === undefined) {
        draft.wallTimeMs = wallMs;
        const sealed = await sealNativeRunReceipt(
          context.evidence,
          synthetic("evidence", "post-run-threw", errorDigest).receipt,
        ).catch(() => undefined);
        if (sealed !== undefined) draft.receiptDigest = sealed;
      }
    }
  }
  const outcome: RoleOutcome = draft;
  const event = finishedEventFrom(base, {
    runId: outcome.runId,
    outcome: outcome.outcome,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
    ...(outcome.receipt === undefined ? {} : { receipt: outcome.receipt }),
    wallTimeMs: outcome.wallTimeMs,
    ...(outcome.receiptDigest === undefined
      ? {}
      : { receiptDigest: outcome.receiptDigest }),
    ...(outcome.readPathsDigest === undefined
      ? {}
      : { readPathsDigest: outcome.readPathsDigest }),
    counted: true,
    foundNew: false,
    heldBoundary: false,
    findingsRecorded: 0,
  });
  const finished = await context.ledger.append({
    ...event,
    artifacts: [
      ...(event.artifacts ?? []),
      ...(outcome.outputDigest === undefined
        ? []
        : [{ kind: "enumeration-output", digest: outcome.outputDigest }]),
      ...(outcome.researchArtifactDigest === undefined
        ? []
        : [
            {
              kind: "research-archive",
              digest: outcome.researchArtifactDigest,
            },
          ]),
      ...(outcome.errorDigest === undefined
        ? []
        : [{ kind: ROLE_RUN_ERROR_ARTIFACT, digest: outcome.errorDigest }]),
    ],
  });
  if (finished.status === "conflict")
    throw new Error("Discovery finish identity conflict");
  await owner.release().catch(() => undefined);
  return outcome;
}

type Enumeration =
  | {
      readonly status: "accepted";
      readonly partitions: readonly AssignedPartition[];
      readonly run: RoleOutcome;
    }
  | {
      readonly status: "stopped";
      readonly run: RoleOutcome | undefined;
      readonly outcome: TrialOutcome["outcome"];
      readonly failure: ReportFailure;
    };

const MISSING_INVENTORY_DIGEST = bytesDigest("");

/**
 * Runs one partitioned Trial: the enumerator with its send-backs, the shape
 * check, one tracer per partition under `maxParallel`, each failed tracer
 * retried once while the target wall allows, and the Trial's outcome for the
 * campaign's stop rules. Claims of every completed tracer are admitted
 * through the profile's recorder with their partition.
 */
export async function executePartitionedTrial(
  context: TrialContext,
  trial: PlannedTrial,
): Promise<TrialOutcome> {
  const plan = trial.partitioned;
  if (plan === undefined) throw new Error("The Trial is not partitioned");
  if (context.oneShotExecutor === undefined)
    throw new Error("A partitioned Trial needs a one-shot executor");
  if (trial.resumes !== undefined || trial.startRecordedAt !== undefined)
    throw new Error("A partitioned Trial is never resumed");
  const { input, clock } = context;
  const trialStart = clock().getTime();
  const deadline =
    trialStart + Math.min(plan.targetWallMs, PARTITIONED_TARGET_CEILING_MS);
  const remaining = () => deadline - clock().getTime();
  /** The wall of a run after the first: none below the start floor. */
  const wallFor = (roleWallMs: number) =>
    remaining() < ROLE_START_FLOOR_MS ? 0 : Math.min(roleWallMs, remaining());
  const base: EventBase = {
    schemaVersion: 1,
    campaignId: context.campaignId,
    snapshotDigest: input.snapshotDigest,
    get occurredAt() {
      return clock().toISOString();
    },
  };
  const draft: Draft<TrialOutcome> = {
    runId: trial.trialId,
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
  const noteLimit = (run: RoleOutcome) => {
    const limit = run.receipt?.providerLimit ?? run.failure?.providerLimit;
    if (limit !== undefined) draft.providerLimit ??= limit;
  };
  const settle = (run: RoleOutcome | undefined): TrialOutcome => {
    draft.wallTimeMs = clock().getTime() - trialStart;
    if (run?.receipt !== undefined) {
      draft.receipt = run.receipt;
      if (run.receiptDigest !== undefined)
        draft.receiptDigest = run.receiptDigest;
      if (run.readPathsDigest !== undefined)
        draft.readPathsDigest = run.readPathsDigest;
    }
    draft.counted =
      countsAsTrial({ ...run?.receipt, outcome: draft.outcome }) ||
      (draft.outcome !== "provider-limited" && draft.findingsRecorded > 0);
    return draft;
  };

  const enumeration = await enumerate(
    context,
    trial,
    plan,
    base,
    remaining,
    wallFor,
  );
  if (enumeration.run !== undefined) noteLimit(enumeration.run);
  if (enumeration.status === "stopped") {
    draft.outcome = enumeration.outcome;
    draft.failure = enumeration.failure;
    return settle(enumeration.run);
  }

  const partitions = enumeration.partitions;
  const of = partitions.length;
  const outcomes: RoleOutcome[] = [];
  let next = 0;
  const trace = async (partition: AssignedPartition): Promise<RoleOutcome> => {
    const firstRunId = `${trial.trialId}-p-${partition.id}`;
    const inputFiles: OneShotFile[] = [
      {
        name: PARTITION_INPUT_FILES.partition,
        content: canonicalJson({
          id: partition.id,
          label: partition.label,
          rows: partition.rows,
        }),
      },
    ];
    const assigned = await context.ledger.append({
      ...base,
      identity: `partition-assigned-${firstRunId}`,
      type: "partition-assigned",
      trialId: trial.trialId,
      partitionId: partition.id,
      ordinal: partition.ordinal,
      of,
      rowCount: partition.rows.length,
      scriptRowCount: partition.scriptRowCount,
      agentRowCount: partition.agentRowCount,
      assignmentDigest: partition.assignmentDigest,
      runId: firstRunId,
      definitionDigest: plan.definitionDigests.tracer,
    });
    if (assigned.status === "conflict")
      throw new Error("Partition assignment identity conflict");
    const attempt = async (runId: string) => {
      const run = await runRole(context, trial, base, {
        runId,
        runKind: "trace",
        plan: plan.trace,
        inputFiles,
        wallMs: wallFor(plan.trace.run.wallMs),
        role: { partitionId: partition.id },
        admit: async (result) => {
          if (result.attachment === undefined)
            return { reason: "schema", reasonDetail: "report-unreadable" };
          try {
            await recordReport(runId, result.attachment, partition.id);
            return undefined;
          } catch (error) {
            if (!(error instanceof DiscoveryReportError)) throw error;
            return { reason: "schema", reasonDetail: "report-unreadable" };
          }
        },
      });
      noteLimit(run);
      return run;
    };
    const first = await attempt(firstRunId);
    // A usage limit is the campaign's backoff, not a fresh sandbox at once;
    // a Harness-side failure (evidence) is not the sandbox's to repeat either.
    if (
      first.outcome !== "failed" ||
      first.failure?.reason === "evidence" ||
      context.signal?.aborted === true ||
      remaining() < ROLE_START_FLOOR_MS
    )
      return first;
    // One fresh sandbox; a second failure leaves the partition incomplete.
    // The separator is outside the partition id alphabet, so the retry's id
    // cannot be another partition's first run.
    return attempt(`${firstRunId}.retry1`);
  };
  const worker = async () => {
    while (next < of) {
      const partition = partitions[next++]!;
      outcomes.push(await trace(partition));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(plan.maxParallel, of) }, worker),
  );
  const completed = outcomes.filter((run) => run.outcome === "completed");
  if (completed.length > 0) {
    // Partial Trials count as completed; each incomplete partition's finish
    // carries its own reason.
    draft.outcome = "completed";
  } else {
    const limited = outcomes.find((run) => run.outcome === "provider-limited");
    draft.outcome = limited === undefined ? "failed" : "provider-limited";
    const failure = (limited ?? outcomes[0])?.failure;
    draft.failure = failure ?? {
      reason: "evidence",
      reasonDetail: "partitions-incomplete",
    };
  }
  return settle(enumeration.run);
}

/** The enumerator and its send-backs; ends with an accepted proposal or a stopped Trial. */
async function enumerate(
  context: TrialContext,
  trial: PlannedTrial,
  plan: PartitionedTrialPlan,
  base: EventBase,
  remaining: () => number,
  wallFor: (roleWallMs: number) => number,
): Promise<Enumeration> {
  let inputFiles: OneShotFile[] = [];
  let scriptRan = false;
  for (let resubmit = 0; ; resubmit++) {
    const runId =
      resubmit === 0 ? trial.trialId : `${trial.trialId}-r${resubmit}`;
    const run = await runRole(context, trial, base, {
      runId,
      runKind: "enumerate",
      plan: plan.enumerate,
      inputFiles,
      wallMs:
        resubmit === 0
          ? Math.min(plan.enumerate.run.wallMs, remaining())
          : wallFor(plan.enumerate.run.wallMs),
      role: { resubmit },
    });
    scriptRan ||= run.result?.scriptRan === true;
    if (run.outcome !== "completed" || run.result === undefined)
      return {
        status: "stopped",
        run,
        outcome: run.outcome,
        failure: run.failure ?? {
          reason: "evidence",
          reasonDetail: "no-output",
        },
      };
    const files = run.result.outputFiles ?? [];
    const submission = readEnumerationOutput(files);
    const validation =
      submission.parsedInventory !== undefined &&
      submission.parsedProposal !== undefined
        ? validatePartitionProposal(
            {
              inventory: submission.parsedInventory,
              proposal: submission.parsedProposal,
            },
            plan.limits,
          )
        : undefined;
    const rejections: SentBackRejection[] = [
      ...submission.rejections,
      ...(validation?.status === "rejected" ? validation.rejections : []),
    ];
    // The rows themselves stay in Private Evidence (invariant 8).
    // Counts are observed from the inventory even when no proposal arrived.
    const inventory =
      validation?.inventory ??
      (submission.parsedInventory === undefined
        ? undefined
        : collapseInventory(submission.parsedInventory));
    const accepted = validation?.status === "accepted";
    const reasons: string[] = [
      ...new Set<string>([
        ...submission.rejections.map((rejection) => rejection.reason),
        ...rejectionReasonTokens(
          validation?.status === "rejected" ? validation.rejections : [],
        ),
      ]),
    ];
    const decision =
      accepted || rejections.length === 0
        ? "accepted"
        : resubmitDecision({
            resubmits: resubmit,
            maxResubmits: plan.limits.maxResubmits,
          });
    if (decision === "resubmit") {
      // The send-back is checked against the input cap before a sandbox is
      // paid for; an unmountable one ends the Trial like an exhausted one.
      const sendBack: OneShotFile[] = [
        {
          name: PARTITION_INPUT_FILES.previous,
          content: canonicalJson({
            inventory: submission.inventory,
            partitions: submission.partitions,
          }),
        },
        {
          name: PARTITION_INPUT_FILES.sentBack,
          content: canonicalJson({ resubmit: resubmit + 1, rejections }),
        },
      ];
      if (admittedOneShotFiles(sendBack, ONE_SHOT_MAX_INPUT_BYTES)) {
        inputFiles = sendBack;
        continue;
      }
      reasons.push(SEND_BACK_OVERSIZE);
    }
    const recorded = await context.ledger.append({
      ...base,
      identity: `enumeration-${trial.trialId}`,
      type: "enumeration-recorded",
      trialId: trial.trialId,
      runId,
      accepted,
      resubmits: resubmit,
      ...(accepted || reasons.length === 0 ? {} : { rejectedReasons: reasons }),
      inventoryDigest:
        submission.parsedInventory === undefined
          ? MISSING_INVENTORY_DIGEST
          : canonicalDigest(submission.parsedInventory),
      ...(submission.parsedProposal === undefined
        ? {}
        : { partitionsDigest: canonicalDigest(submission.parsedProposal) }),
      scriptRan,
      scriptRowCount:
        inventory?.rows.filter((row) => row.origin === "script").length ?? 0,
      agentRowCount:
        inventory?.rows.filter((row) => row.origin === "agent").length ?? 0,
      duplicateRowCount: inventory?.duplicateRowCount ?? 0,
      partitionCount:
        validation?.status === "accepted"
          ? validation.partitions.length
          : (submission.parsedProposal?.partitions.length ?? 0),
      definitionDigest: plan.definitionDigests.enumerator,
      toolsDigest: plan.toolsDigest,
      rowSource: plan.rowSource,
      artifacts:
        run.outputDigest === undefined
          ? []
          : [{ kind: "enumeration-output", digest: run.outputDigest }],
    });
    if (recorded.status === "conflict")
      throw new Error("Enumeration record identity conflict");
    if (validation?.status === "accepted")
      return { status: "accepted", partitions: validation.partitions, run };
    return {
      status: "stopped",
      run,
      outcome: "failed",
      failure: { reason: "schema", reasonDetail: "enumeration-rejected" },
    };
  }
}
