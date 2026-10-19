import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import type { PlannedDiscoveryRun } from "./campaign.js";
import type {
  DiscoveryResumeInput,
  DiscoveryTransportRun,
  InterruptedRunRecovery,
} from "./codex-native-agent-runtime.js";
import {
  executeTrial,
  type TrialContext,
  type TrialOutcome,
} from "./execute-trial.js";
import {
  readNativeRunReceipt,
  type NativeRunSession,
} from "./native-run-receipts.js";
import type { ProviderAttachmentStore } from "./provider-research-report.js";

type StartedEvent = Extract<LedgerEventV1, { type: "discovery-run-started" }>;
type FinishedEvent = Extract<LedgerEventV1, { type: "discovery-run-finished" }>;

/** A resumed segment needs at least this much of the Trial wall left. */
export const RESUME_WALL_FLOOR_MS = 5 * 60_000;
/** The runner always performs the resume turn; the loop floor below cannot be zero. */
const RESUME_MINIMUM_ACTIVE_FLOOR_MS = 1_000;

/**
 * Why a run is not resumable. Each is a deterministic reading of the ledger
 * and Private Evidence; none writes an event (ADR 0036).
 */
export type ResumeRefusalReason =
  | "run-unknown"
  | "run-unfinished"
  | "run-alive"
  | "superseded"
  | "not-an-exploration"
  | "already-resumed"
  | "run-completed"
  | "lab-attached"
  | "snapshot-digest-differs"
  | "prompt-version-differs"
  | "resume-paragraph-missing"
  | "receipt-unavailable"
  | "session-unrecorded"
  | "runtime-profile-differs"
  | "wall-exhausted"
  | "session-evidence-missing";

export type ResumePlan = {
  /** The first segment of the chain. */
  readonly originalRunId: string;
  /** The segment being continued: the latest one, which the operator named. */
  readonly resumesRun: string;
  readonly trialId: string;
  readonly trialOrdinal: number;
  /** 1 for the first resume of a Trial. */
  readonly segment: number;
  /** Wall the earlier segments consumed, from their finish events. */
  readonly consumedWallMs: number;
  readonly remainingWallMs: number;
  /** What is left of the Trial's active minimum; at least one resume turn runs. */
  readonly minimumActiveMs: number;
  readonly configuration: PlannedDiscoveryRun["configuration"];
  readonly resume: DiscoveryResumeInput;
  /** False when the earlier segment left no notes archive to restore. */
  readonly researchRestored: boolean;
};

export type ResumeAssessment =
  | {
      readonly status: "refused";
      readonly reason: ResumeRefusalReason;
      readonly detail?: string;
    }
  | { readonly status: "resumable"; readonly plan: ResumePlan };

const researchArchiveSchema = z.looseObject({
  kind: z.literal("research-directory-archive"),
  schemaVersion: z.literal(1),
  entries: z.array(
    z.union([
      z.looseObject({ path: z.string(), type: z.literal("directory") }),
      z.looseObject({
        path: z.string(),
        type: z.literal("file"),
        contentBase64: z.string(),
        truncated: z.literal(true).optional(),
      }),
    ]),
  ),
});

/** The Root rollout as sealed, without the Harness process diagnostic appended after a failure. */
export function sessionFileContentFromDiagnostic(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line) as unknown;
      if (
        typeof event === "object" &&
        event !== null &&
        (event as Record<string, unknown>).type === "sandbox_process_diagnostic"
      )
        continue;
    } catch {
      // A partial last line of an interrupted rollout stays as the CLI left it.
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function configurationOf(
  started: StartedEvent,
): PlannedDiscoveryRun["configuration"] {
  const { configuration } = started;
  return {
    promptVariant: configuration.promptVariant,
    ...(configuration.promptDigest === undefined
      ? {}
      : { promptDigest: configuration.promptDigest }),
    ...(configuration.objectiveDigest === undefined
      ? {}
      : { objectiveDigest: configuration.objectiveDigest }),
    ...(configuration.contractDigest === undefined
      ? {}
      : { contractDigest: configuration.contractDigest }),
    ...(configuration.trustBoundaryVersion === undefined
      ? {}
      : { trustBoundaryVersion: configuration.trustBoundaryVersion }),
    ...(configuration.sourcePack === undefined
      ? {}
      : { sourcePack: configuration.sourcePack }),
    ...(configuration.labAccess === undefined
      ? {}
      : { labAccess: configuration.labAccess }),
  };
}

/**
 * The later exploration of the same campaign, Snapshot and Trial ordinal that
 * a campaign started from scratch after `run` stopped without a finish (the
 * runner's restart does this). Resume segments do not supersede. `starts` are
 * in ledger order.
 */
export function supersedingRun(
  starts: readonly StartedEvent[],
  run: StartedEvent,
): StartedEvent | undefined {
  const index = starts.findIndex(
    (event) => event.campaignId === run.campaignId && event.runId === run.runId,
  );
  return starts
    .slice(index + 1)
    .find(
      (event) =>
        event.campaignId === run.campaignId &&
        event.snapshotDigest === run.snapshotDigest &&
        (event.runKind ?? "explore") === "explore" &&
        event.resumesRun === undefined &&
        (event.trialOrdinal ?? 0) === (run.trialOrdinal ?? 0),
    );
}

/** What sealing an interrupted run did; a refusal wrote nothing. */
export type InterruptedRunRecording =
  | { readonly status: "recorded" }
  | {
      readonly status: "refused";
      readonly reason: Extract<
        ResumeRefusalReason,
        "run-alive" | "session-evidence-missing" | "runtime-profile-differs"
      >;
      readonly detail?: string;
    };

/**
 * Seals a run whose host process died before its finish (ADR 0036, 2026-10-19
 * second addendum): the executor reads back what the run's sandbox left on
 * disk, and the finish is appended for the original run id with the reason
 * `interrupted`, child and Root reports recorded as a failed run's are. The
 * leftover directories are removed once sealed. Nothing is executed.
 */
export async function recordInterruptedRun(
  context: Omit<TrialContext, "runWallTimeMs" | "seen" | "executor">,
  executor: {
    recoverInterrupted(
      run: DiscoveryTransportRun,
      startedAt: string,
    ): Promise<InterruptedRunRecovery>;
  },
  started: StartedEvent,
  run: Omit<DiscoveryTransportRun, "campaignInput" | "runId" | "expiresAt">,
): Promise<InterruptedRunRecording> {
  const transportRun = {
    ...run,
    runId: started.runId,
    expiresAt: started.occurredAt,
  };
  const recovery = await executor.recoverInterrupted(
    {
      ...transportRun,
      campaignInput: {
        ...context.input,
        promptDigest:
          started.configuration.promptDigest ?? context.input.promptDigest,
      },
    },
    started.occurredAt,
  );
  if (recovery.status === "alive")
    return { status: "refused", reason: "run-alive" };
  if (recovery.status === "absent")
    return { status: "refused", reason: "session-evidence-missing" };
  if (recovery.status === "runtime-profile-differs")
    return {
      status: "refused",
      reason: "runtime-profile-differs",
      detail: recovery.detail,
    };
  await executeTrial(
    {
      ...context,
      executor: { execute: async () => recovery.result },
      seen: new Set(),
    },
    {
      trialId: started.trialId ?? started.runId,
      trialOrdinal: started.trialOrdinal ?? 0,
      explore: { run: transportRun, configuration: configurationOf(started) },
      startRecordedAt: started.occurredAt,
    },
  );
  await recovery.discard();
  return { status: "recorded" };
}

/** The chain the run belongs to, oldest first; `resumesRun` links each segment to the one before. */
function segmentChain(
  starts: ReadonlyMap<string, StartedEvent>,
  runId: string,
): StartedEvent[] {
  const chain: StartedEvent[] = [];
  const visited = new Set<string>();
  let current = starts.get(runId);
  while (current !== undefined && !visited.has(current.runId)) {
    visited.add(current.runId);
    chain.unshift(current);
    current =
      current.resumesRun === undefined
        ? undefined
        : starts.get(current.resumesRun);
  }
  return chain;
}

/**
 * Decides, from the ledger and Private Evidence alone, whether the named run
 * is the latest segment of a Trial that the provider refused, and gathers what
 * a new segment needs. Nothing here chooses what the agent explores next.
 */
export async function assessTrialResume(options: {
  readonly ledger: Pick<Ledger, "readAll">;
  readonly evidence: Pick<PrivateArtifactStore, "readJson">;
  readonly attachments: Pick<ProviderAttachmentStore, "readByDigest">;
  readonly campaignId: string;
  readonly runId: string;
  /** The Snapshot the operator's campaign configuration froze again. */
  readonly snapshotDigest: string;
  /** The current objective prompt's digest and text; the resume paragraph must be part of it. */
  readonly promptDigest: string;
  readonly prompt: string;
  readonly resumePrompt: string;
  readonly profileDigest: string;
  /** The Trial's wall and active minimum, shared across segments. */
  readonly wallTimeMs: number;
  readonly minimumActiveMs: number;
  /**
   * Seals a run that has a start but no finish because its host process died
   * (`recordInterruptedRun`). Absent, such a run is `run-unfinished`.
   */
  readonly recoverInterrupted?: (
    started: StartedEvent,
  ) => Promise<InterruptedRunRecording>;
}): Promise<ResumeAssessment> {
  const refused = (
    reason: ResumeRefusalReason,
    detail?: string,
  ): ResumeAssessment => ({
    status: "refused",
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
  const starts = new Map<string, StartedEvent>();
  for (const { event } of options.ledger.readAll({
    campaignId: options.campaignId,
    type: "discovery-run-started",
  }))
    if (event.type === "discovery-run-started") starts.set(event.runId, event);
  const readFinishes = () => {
    const finishes = new Map<string, FinishedEvent>();
    for (const { event } of options.ledger.readAll({
      campaignId: options.campaignId,
      type: "discovery-run-finished",
    }))
      if (event.type === "discovery-run-finished")
        finishes.set(event.runId, event);
    return finishes;
  };
  let finishes = readFinishes();

  const started = starts.get(options.runId);
  if (started === undefined) return refused("run-unknown");
  if ((started.runKind ?? "explore") !== "explore")
    return refused("not-an-exploration", started.runKind);
  const later = [...starts.values()].find(
    (event) => event.resumesRun === options.runId,
  );
  if (later !== undefined) return refused("already-resumed", later.runId);
  if (started.labAttached !== false || started.labId !== undefined)
    return refused("lab-attached");
  if (started.snapshotDigest !== options.snapshotDigest)
    return refused("snapshot-digest-differs", started.snapshotDigest);
  if (started.configuration.promptDigest !== options.promptDigest)
    return refused(
      "prompt-version-differs",
      started.configuration.promptDigest ?? "unrecorded",
    );
  if (
    options.resumePrompt.length === 0 ||
    !options.prompt.includes(options.resumePrompt)
  )
    return refused("resume-paragraph-missing");
  // Checked after the static rules above, so a refusal there writes nothing.
  if (!finishes.has(options.runId)) {
    if (options.recoverInterrupted === undefined)
      return refused("run-unfinished");
    const superseding = supersedingRun([...starts.values()], started);
    if (superseding !== undefined)
      return refused("superseded", superseding.runId);
    const recorded = await options.recoverInterrupted(started);
    if (recorded.status === "refused")
      return refused(recorded.reason, recorded.detail);
    finishes = readFinishes();
  }
  const finished = finishes.get(options.runId);
  if (finished === undefined) return refused("run-unfinished");
  // A run that stopped for any reason can be resumed (owner decision
  // 2026-10-19, ADR 0036 addendum); one that completed has nothing to continue.
  if (finished.outcome === "completed") return refused("run-completed");

  const receiptReference = finished.artifacts.find(
    (artifact) => artifact.kind === "native-run-receipt",
  );
  const receipt =
    receiptReference === undefined
      ? undefined
      : await readNativeRunReceipt(options.evidence, receiptReference.digest);
  if (receipt === undefined) return refused("receipt-unavailable");
  if (receipt.session === undefined) return refused("session-unrecorded");
  if (receipt.runtimeProfileDigest !== options.profileDigest)
    return refused("runtime-profile-differs", receipt.runtimeProfileDigest);

  const chain = segmentChain(starts, options.runId);
  const consumedWallMs = chain.reduce(
    (sum, segment) => sum + (finishes.get(segment.runId)?.wallTimeMs ?? 0),
    0,
  );
  const remainingWallMs = options.wallTimeMs - consumedWallMs;
  if (remainingWallMs < RESUME_WALL_FLOOR_MS)
    return refused("wall-exhausted", `${consumedWallMs}ms consumed`);

  const sessions = await restoreSessionFiles(
    options.attachments,
    receipt.session,
  );
  if (sessions === undefined) return refused("session-evidence-missing");
  const research = await restoreResearch(
    options.attachments,
    finished.researchArtifact?.digest,
  );
  const original = chain[0] ?? started;
  return {
    status: "resumable",
    plan: {
      originalRunId: original.runId,
      resumesRun: options.runId,
      trialId: started.trialId ?? original.runId,
      trialOrdinal: started.trialOrdinal ?? 0,
      segment: chain.length,
      consumedWallMs,
      remainingWallMs,
      minimumActiveMs: Math.max(
        RESUME_MINIMUM_ACTIVE_FLOOR_MS,
        options.minimumActiveMs - consumedWallMs,
      ),
      configuration: configurationOf(started),
      resume: {
        threadId: receipt.session.rootThreadId,
        segment: chain.length,
        sessions,
        research: research ?? [],
      },
      researchRestored: research !== undefined,
    },
  };
}

async function restoreSessionFiles(
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  session: NativeRunSession,
): Promise<DiscoveryResumeInput["sessions"] | undefined> {
  const files: DiscoveryResumeInput["sessions"][number][] = [];
  for (const file of session.files) {
    const stored = await attachments.readByDigest(
      "diagnostic",
      file.diagnosticArtifactDigest,
    );
    if (stored.status !== "resolved") return undefined;
    const raw = stored.bytes.toString("utf8");
    files.push({
      path: file.path,
      threadId: file.threadId,
      kind: file.kind,
      diagnosticArtifactDigest: file.diagnosticArtifactDigest,
      content:
        file.kind === "root" ? sessionFileContentFromDiagnostic(raw) : raw,
    });
  }
  if (!files.some((file) => file.kind === "root" && file.content.length > 0))
    return undefined;
  return files;
}

/** Complete files of the notes archive; a missing or unreadable archive restores nothing. */
async function restoreResearch(
  attachments: Pick<ProviderAttachmentStore, "readByDigest">,
  digest: string | undefined,
): Promise<DiscoveryResumeInput["research"] | undefined> {
  if (digest === undefined) return undefined;
  const stored = await attachments.readByDigest("research", digest);
  if (stored.status !== "resolved") return undefined;
  let archive: z.infer<typeof researchArchiveSchema>;
  try {
    archive = researchArchiveSchema.parse(
      JSON.parse(stored.bytes.toString("utf8")) as unknown,
    );
  } catch {
    return undefined;
  }
  return archive.entries.flatMap((entry) =>
    entry.type === "file" && entry.truncated === undefined
      ? [{ path: entry.path, contentBase64: entry.contentBase64 }]
      : [],
  );
}

/**
 * Runs the planned segment through `executeTrial`: a new run id under the same
 * Trial, the remaining wall, the restored session, and the pinned resume
 * paragraph as the first turn. Start and finish events are appended as usual.
 */
export async function executeTrialResume(
  context: Omit<TrialContext, "runWallTimeMs" | "seen">,
  plan: ResumePlan,
  run: Omit<
    DiscoveryTransportRun,
    "campaignInput" | "runId" | "minimumActiveMs" | "resume" | "expiresAt"
  > & { readonly runId: string },
): Promise<TrialOutcome> {
  if (run.resumePrompt === undefined)
    throw new Error("A resumed segment needs the pinned resume paragraph");
  const transportRun = {
    ...run,
    minimumActiveMs: plan.minimumActiveMs,
    resume: plan.resume,
    expiresAt: new Date(
      context.clock().getTime() + plan.remainingWallMs,
    ).toISOString(),
  };
  return executeTrial(
    { ...context, runWallTimeMs: plan.remainingWallMs, seen: new Set() },
    {
      trialId: plan.trialId,
      trialOrdinal: plan.trialOrdinal,
      explore: { run: transportRun, configuration: plan.configuration },
      resumes: { runId: plan.resumesRun, segment: plan.segment },
    },
  );
}
