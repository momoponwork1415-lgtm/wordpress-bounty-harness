import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { verificationResultV1Schema } from "../verification/reproduction-package.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactRef = z.strictObject({ kind: id, digest });
const base = z.strictObject({
  schemaVersion: z.literal(1),
  identity: id,
  campaignId: id,
  snapshotDigest: digest,
  occurredAt: z.iso.datetime({ offset: true }),
  artifacts: z.array(artifactRef).default([]),
});

const tokens = z.union([
  z.number().int().nonnegative(),
  z.literal("unavailable"),
]);

const event = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...base.shape, ...shape });

/** LedgerEvent v1 carries only routing metadata and private artifact digests. */
export const ledgerEventV1Schema = z.discriminatedUnion("type", [
  event({
    type: z.literal("target-selected"),
    selectionId: id,
    /** Absent in historical events; a new selection may record its planned prompt. */
    promptVariant: id.optional(),
    /** The selection policy's fallback band (1-based) that admitted the target; absent for the primary band. */
    cascadeStep: z.number().int().positive().optional(),
  }),
  event({
    /** Bind a campaign to one immutable automatic selection before its first target. */
    type: z.literal("selection-batch-bound"),
    selectionBatchId: id,
    policyDigest: digest,
    selectionIds: z.array(id).min(1).max(10),
  }),
  event({
    type: z.literal("snapshot-frozen"),
    sourceDigest: digest,
    dependencyDigests: z.array(digest).optional(),
  }),
  event({
    type: z.literal("lab-provisioned"),
    labId: id,
    status: z.enum(["ready", "failed"]),
    purpose: z.enum(["discovery", "verification"]).optional(),
    scenario: z.strictObject({ id, digest }).optional(),
    reachability: z
      .strictObject({
        http: z.enum(["ok", "failed"]),
        database: z.enum(["ok", "failed", "not-exposed"]),
      })
      .optional(),
    failureStage: z.enum(["provision", "seed", "probe"]).optional(),
    reason: z.enum(["provision", "precondition", "reachability"]).optional(),
  }),
  event({
    type: z.literal("discovery-run-started"),
    runId: id,
    labId: id.optional(),
    labAttached: z.boolean().optional(),
    trialId: id.optional(),
    trialOrdinal: z.number().int().nonnegative().optional(),
    stage: z.enum(["screening", "deep-dive"]).optional(),
    runKind: z.enum(["explore", "continue", "child"]).optional(),
    continuationOf: id.optional(),
    parentRunId: id.optional(),
    /**
     * Operator-triggered resume of a refused Root thread (ADR 0036): the run
     * this segment continues, and its 1-based segment index. The original
     * run's `failed` finish stays; the funnel counts the Trial once.
     */
    resumesRun: id.optional(),
    resumeSegment: z.number().int().positive().optional(),
    history: z.union([
      z.strictObject({ mode: z.literal("none") }),
      z.strictObject({
        mode: z.literal("catalog"),
        digest,
        recordIds: z.array(id),
      }),
    ]),
    configuration: z.strictObject({
      promptVariant: id,
      promptDigest: digest.optional(),
      objectiveDigest: digest.optional(),
      contractDigest: digest.optional(),
      /** Legacy Trial field; retained so append-only ledgers remain readable. */
      continuationPromptDigest: digest.optional(),
      trustBoundaryVersion: id.optional(),
      sourcePack: z
        .strictObject({ dependency: z.enum(["mounted", "none"]) })
        .optional(),
      /** Legacy, read only: written until the assignment mode was removed (2026-10-18). */
      assignmentUnit: id.optional(),
      entryIndex: z
        .union([
          z.strictObject({ enabled: z.literal(true), digest }),
          z.strictObject({ enabled: z.literal(false) }),
        ])
        .optional(),
      agentPath: id.optional(),
      /** The runtime the campaign's share assigned this target to; written only when the share is configured. */
      runtime: z.enum(["codex-native/v1", "claude-code/v1"]).optional(),
      assignment: z
        .strictObject({
          partition: z.number().int().nonnegative(),
          of: z.number().int().positive(),
          planDigest: digest,
          indexDigest: digest.optional(),
          componentDigest: digest.optional(),
        })
        .optional(),
      labAccess: z
        .strictObject({ database: z.enum(["read-only", "none"]) })
        .optional(),
      /** ADR 0039: the Trial's launch mode; absent on events before 2026-10-25. */
      mode: z.enum(["deep", "wide"]).optional(),
      axis: z.literal("history").optional(),
      arm: z.enum(["a", "b"]).optional(),
      arms: z
        .strictObject({
          history: z.enum(["a", "b"]).optional(),
          prompt: z.enum(["a", "b"]).optional(),
          continuation: z.enum(["a", "b"]).optional(),
        })
        .optional(),
    }),
  }),
  event({
    type: z.literal("verification-lab-failed"),
    findingId: id,
    verificationId: id,
    reason: z.enum(["provision", "precondition"]),
  }),
  event({
    type: z.literal("discovery-run-finished"),
    runId: id,
    /** `provider-limited`: the subscription refused the run; the campaign's Trial policy decides whether the started attempt consumes its budget. */
    outcome: z.enum([
      "completed",
      "failed",
      "setup-failed",
      "provider-limited",
    ]),
    costUsd: z.union([z.number().nonnegative(), z.literal("unavailable")]),
    wallTimeMs: z.number().int().nonnegative(),
    reason: z
      .enum([
        "provider",
        "schema",
        "sandbox",
        "policy",
        "evidence",
        "wall",
        "operator",
        "depth",
        /** The host process died mid-run; `campaign resume` sealed its leftovers (ADR 0036). */
        "interrupted",
      ])
      .optional(),
    reasonDetail: z
      .string()
      .regex(/^[a-z0-9][a-z0-9:_-]{0,127}$/)
      .optional(),
    providerLimit: z.enum(["rate-limit", "quota"]).optional(),
    /** Legacy within-Trial continuation receipt. */
    continuation: z
      .strictObject({
        mode: z.literal("thread-resume"),
        injected: z.boolean(),
        entriesHandedBack: z.number().int().nonnegative(),
        remainingMinutes: z.number().nonnegative(),
        reason: z.enum(["coverage-incomplete", "report-unavailable"]),
      })
      .optional(),
    /** Lower-bound counts inferred from completed command events, not agent claims. */
    observed: z
      .strictObject({
        toolCalls: z.number().int().nonnegative(),
        filesRead: z.number().int().nonnegative(),
        uniqueFilesRead: z.number().int().nonnegative(),
        labRequests: z.number().int().nonnegative(),
        dbQueries: z.number().int().nonnegative(),
      })
      .optional(),
    /** Unique direct children seen and admitted by a cooperative Root run. */
    childThreadsObserved: z.number().int().nonnegative().optional(),
    childThreadsAdmitted: z.number().int().nonnegative().max(255).optional(),
    brokerMetrics: z
      .strictObject({
        forwardedRequests: z.number().int().nonnegative(),
        requestLimitExceeded: z.number().int().nonnegative(),
        unauthorizedRequests: z.number().int().nonnegative(),
        upstreamSuccess: z.number().int().nonnegative().optional(),
        upstreamClientError: z.number().int().nonnegative().optional(),
        upstreamServerError: z.number().int().nonnegative().optional(),
        relayFailures: z.number().int().nonnegative().optional(),
        responseLimitExceeded: z.number().int().nonnegative().optional(),
      })
      .optional(),
    sandboxExitCode: z.number().int().optional(),
    diagnosticArtifactDigest: digest.optional(),
    /** Trial-local notes are Private Evidence; the ledger retains only their archive digest. */
    researchArtifact: z
      .strictObject({ digest, truncated: z.boolean() })
      .optional(),
    /** Provider-reported tokens; absent when the transport returned no receipt. */
    usage: z
      .strictObject({
        inputTokens: tokens,
        cachedInputTokens: tokens,
        outputTokens: tokens,
        reasoningOutputTokens: tokens,
      })
      .optional(),
    /** Copied from the run's receipt; absent on events before 2026-10-25 (A2). */
    agentRole: z.enum(["root", "child"]).optional(),
    agentType: z.string().min(1).max(128).optional(),
    delegationDigest: z.union([digest, z.literal("unavailable")]).optional(),
    delegationLength: z.number().int().nonnegative().optional(),
    firstFinalReportAt: z.iso.datetime({ offset: true }).optional(),
    candidatesAfterFirstFinalReport: z.number().int().nonnegative().optional(),
  }),
  event({
    type: z.literal("discovery-concluded"),
    stoppedBy: z.enum([
      "screened-no-candidate",
      "no-new-finding",
      "output-boundary",
      "max-runs",
      "plans-exhausted",
    ]),
  }),
  /** The campaign stopped early; rerunning it with the same id resumes it. */
  event({
    type: z.literal("campaign-stopped"),
    /** Keep the historical cap reason readable; an incomplete attempt remains resumable. */
    reason: z.enum([
      "provider-limit",
      "incomplete",
      "daily-run-cap",
      "screened-no-candidate",
      /** An operator asked the campaign to drain at the next target boundary. */
      "operator",
    ]),
    /** Failed Lab teardown ids; historical stop events have no ids. */
    cleanupLabIds: z.array(id).min(1).max(2).optional(),
    /**
     * A provider limit that stopped only this runtime's targets (2026-10-20).
     * Absent, as in every older event, the limit stopped the whole campaign.
     */
    runtime: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
  }),
  /**
   * A target was left behind by an error. Before a snapshot exists, the
   * snapshot digest is the digest of the selection record.
   */
  event({
    type: z.literal("target-skipped"),
    selectionId: id,
    stage: z.enum(["freeze", "discovery", "verification"]),
    /** Optional so historical skip events remain readable. */
    reason: z
      .enum([
        "dns",
        "connect-timeout",
        "request-timeout",
        "network",
        "http-response",
        "source-mismatch",
        "quota-exceeded",
        "invalid-archive",
        "deferred",
        /** The provider refused the Trial without a usage limit (e.g. cyber_policy). */
        "provider-refused",
        /** The Trial failed on wall, schema, CLI exit or broker policy. */
        "run-failed",
        "other",
      ])
      .optional(),
  }),
  event({
    /** Before a Snapshot exists, snapshotDigest is the immutable selection record's digest. */
    type: z.literal("evaluation-case-blocked"),
    caseId: id,
    stage: z.enum(["source", "dependency", "lab"]),
    reason: z.enum([
      "source-acquisition-unavailable",
      "dependency-snapshot-unavailable",
      "external-service-unavailable",
      "normal-use-setup-unavailable",
    ]),
  }),
  event({
    type: z.literal("candidate-rejected"),
    runId: id,
    candidateKind: z.enum(["finding", "lead"]),
    candidateIndex: z.number().int().nonnegative(),
    reason: z.enum(["schema", "identity"]),
    impact: id.optional(),
    primitive: id.optional(),
    missingEdge: id.optional(),
  }),
  event({
    type: z.literal("candidate-normalized"),
    runId: id,
    candidateKind: z.enum(["finding", "lead"]),
    candidateIndex: z.number().int().nonnegative(),
    parserVersion: id.optional(),
    changes: z.array(
      z.strictObject({
        path: z.string().max(256),
        operation: id,
      }),
    ),
  }),
  event({
    type: z.literal("candidate-held"),
    runId: id,
    candidateKind: z.enum(["finding", "lead"]),
    candidateIndex: z.number().int().nonnegative(),
    parserVersion: id.optional(),
    issuePaths: z.array(z.string().max(256)),
    /** Zod issue codes, index-aligned with issuePaths; absent on events before 2026-10-20. */
    issueCodes: z.array(id).optional(),
    impact: id.optional(),
    primitive: id.optional(),
    missingEdge: id.optional(),
  }),
  event({
    type: z.literal("finding-recorded"),
    findingId: id,
    runId: id,
    /** The Trial the run belongs to; absent on events before 2026-10-25 (A2). */
    trialId: id.optional(),
    category: id,
    preconditionClass: id.optional(),
    continuationOrdinal: z.number().int().nonnegative().optional(),
    historyRecordId: id.optional(),
    /** A fresh-snapshot hypothesis derived from an earlier Finding. */
    derivedFromFindingId: id.optional(),
    derivationKind: z
      .enum(["latest-version", "fixed-version-control"])
      .optional(),
    /**
     * #424: the overlap group at admission (its first Finding) and the digests
     * of the profile keys it is built from. Absent on events before 2026-10-21.
     */
    group: z.strictObject({ id, keys: z.array(digest) }).optional(),
  }),
  /** A Finding held outside the active verification and review queues. */
  event({
    type: z.literal("finding-parked"),
    findingId: id,
    runId: id,
    category: id,
    reason: z.enum([
      "outside-programme-boundary",
      "admin-configuration-precondition",
    ]),
    preconditionClass: id.optional(),
  }),
  /** Correct an admission-time precondition park without deleting its audit event. */
  event({
    type: z.literal("finding-park-restored"),
    findingId: id,
    parkedIdentity: id,
    recordedIdentity: id,
    reason: z.literal("admission-correction"),
  }),
  event({
    type: z.literal("finding-precondition-classified"),
    findingId: id,
    preconditionClass: id,
  }),
  event({
    type: z.literal("lead-recorded"),
    leadId: id,
    runId: id,
    trialId: id,
    missingEdge: id,
    primitive: id,
    storageKind: id,
    continuationOrdinal: z.number().int().nonnegative().optional(),
  }),
  /** A schema-only child failure was reinterpreted from its immutable private rollout. */
  event({
    type: z.literal("child-report-recovered"),
    runId: id,
    sourceDiagnosticDigest: digest,
    reportArtifactDigest: digest,
    parserVersion: id,
  }),
  event({
    type: z.literal("discovery-report-recovered"),
    runId: id,
    sourceDiagnosticDigest: digest,
    reportArtifactDigest: digest,
    parserVersion: id,
  }),
  event({
    type: z.literal("verifier-run-finished"),
    findingId: id,
    runId: id,
    promptDigest: digest,
    receiptDigest: digest,
    terminal: z.enum(["completed", "incomplete"]),
    canaryIssued: z
      .enum(["execution", "script", "principal", "sql"])
      .optional(),
    /** The provider's usage limit that ended this Verifier run, if any. */
    providerLimit: z.enum(["rate-limit", "quota"]).optional(),
  }),
  event({
    type: z.literal("verification-finished"),
    verificationId: id,
    findingId: id,
    labSetupDigest: digest,
    /** One-based verification attempt; absent in historical events. */
    attempt: z.number().int().positive().optional(),
    /** Previous verificationId when this is a retry. */
    retryOf: id.optional(),
    /** Pinned Verifier instruction version; absent in historical events. */
    promptVersion: id.optional(),
    /** Present for a version comparison using a Finding bound to this snapshot. */
    basis: z
      .strictObject({
        kind: z.enum(["latest-version", "fixed-version"]),
        findingSnapshotDigest: digest,
      })
      .optional(),
    result: verificationResultV1Schema,
    evidenceCapture: z.enum(["harness-captured", "agent-authored"]).optional(),
    /**
     * Before / after Lab state diff around the Verifier run (#186). `captured`
     * points at `lab-state-before` / `lab-state-after` / `lab-state-diff`
     * artifacts; `missing` keeps the reason. Absent on older events.
     */
    labStateDiff: z
      .discriminatedUnion("status", [
        z.strictObject({ status: z.literal("captured") }),
        z.strictObject({
          status: z.literal("missing"),
          reason: z.enum(["before-capture", "after-capture", "store"]),
        }),
      ])
      .optional(),
  }),
  event({
    /** A person explicitly opened one review item; listing the queue does not count. */
    type: z.literal("review-item-opened"),
    findingId: id,
    verificationId: id,
  }),
  event({
    type: z.literal("review-decided"),
    findingId: id,
    decision: z.enum(["accept", "reject", "defer"]),
    /** Seconds the human spent on this item, as the skill or CLI caller reported (ADR 0032 Q22). */
    humanElapsedSeconds: z.number().int().nonnegative().max(604_800).optional(),
    /** Traceability back to the exact verification, discovery run and prompt (ADR 0032 Q22). */
    verificationId: id.optional(),
    runId: id.optional(),
    promptDigest: digest.optional(),
  }),
  event({
    type: z.literal("scope-assessed"),
    findingId: id,
    programmeId: id,
    status: z.enum(["in-scope", "out-of-scope", "ambiguous", "incomplete"]),
  }),
  event({
    type: z.literal("draft-saved"),
    findingId: id,
    candidateId: id,
    revisionDigest: digest,
  }),
  event({
    type: z.literal("external-action-authorized"),
    candidateId: id,
    revisionDigest: digest,
    destination: id,
  }),
  // A separate submission receipt lets the funnel distinguish sent from authorized.
  event({
    type: z.literal("submission-recorded"),
    findingId: id,
    candidateId: id,
  }),
  event({
    type: z.literal("submission-outcome"),
    candidateId: id,
    outcome: z.enum([
      "triaged",
      "resolved",
      "duplicate",
      "informative",
      "not-applicable",
      "rejected",
    ]),
    /** Bounty paid in USD, when the programme reported one. */
    rewardUsd: z.number().nonnegative().max(1_000_000).optional(),
  }),
  event({
    type: z.literal("human-effort-recorded"),
    findingId: id.optional(),
    action: z.enum(["read", "reproduce", "submit", "outcome"]),
    minutes: z.number().finite().nonnegative().max(1440),
  }),
  event({
    type: z.literal("human-reproduction-recorded"),
    findingId: id,
    verificationId: id,
    reproductionPackageDigest: digest,
    result: z.enum(["match", "mismatch", "unavailable"]),
  }),
  event({
    /** A fresh manual Lab reached ready; session details stay in Private Evidence. */
    type: z.literal("manual-observation-lab-ready"),
    findingId: id,
    verificationId: id,
    labSetupDigest: digest,
    packageDigest: digest,
    sessionReceiptDigest: digest,
  }),
  event({
    /** Human observation of an incomplete attempt, never a judge verdict. */
    type: z.literal("manual-observation-recorded"),
    findingId: id,
    verificationId: id,
    labSetupDigest: digest,
    packageDigest: digest,
    sessionReceiptDigest: digest,
    evidenceDigest: digest,
    result: z.enum(["match", "mismatch", "unavailable"]),
    recordedBy: id,
  }),
]);

export type LedgerEventV1 = z.infer<typeof ledgerEventV1Schema>;
export type LedgerEventInput = z.input<typeof ledgerEventV1Schema>;
export type LedgerReadQuery = {
  readonly campaignId?: string;
  readonly type?: LedgerEventV1["type"];
  readonly findingId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
  /** Events at or after this instant (ISO 8601). */
  readonly since?: string;
};
/** `readAll` takes the same filters as `read`; it pages by sequence itself. */
export type LedgerReadAllQuery = Omit<
  LedgerReadQuery,
  "limit" | "afterSequence"
>;
/** One group of `ledger stops`: an event type, its grouping fields and how many. */
export type StopRow = {
  readonly type:
    | "discovery-run-finished"
    | "target-skipped"
    | "lab-provisioned"
    | "campaign-stopped";
  readonly fields: Readonly<Record<string, string>>;
  readonly count: number;
  /** discovery-run-finished only: runs started as explore, and runs that ended within 60 s. */
  readonly explore?: number;
  readonly within60s?: number;
};
/**
 * One resumed segment for `ledger resumes` (ADR 0036): the stop it resumed and
 * how it ended. `outcome` is absent while the segment has no finish.
 */
export type ResumeRow = {
  readonly campaignId: string;
  readonly runId: string;
  readonly resumesRun: string;
  readonly segment: number;
  readonly startedAt: string;
  readonly runtime?: string;
  /** The finish of the segment it resumed. */
  readonly resumed: {
    readonly outcome?: string;
    readonly reason?: string;
    readonly reasonDetail?: string;
  };
  readonly outcome?: string;
  readonly reason?: string;
  readonly reasonDetail?: string;
  readonly wallTimeMs?: number;
};
export type LedgerRecord = {
  readonly sequence: number;
  readonly event: LedgerEventV1;
};

type ParkedFinding = Extract<LedgerEventV1, { type: "finding-parked" }>;

const findingKey = (event: { campaignId: string; findingId: string }) =>
  `${event.campaignId}\0${event.findingId}`;

/** Historical parks remain in the ledger; a matching correction activates the recorded Finding. */
function activeParkedFromEvents(
  events: readonly LedgerEventV1[],
): ParkedFinding[] {
  const parked = new Map<string, ParkedFinding>();
  const recorded = new Map<
    string,
    Extract<LedgerEventV1, { type: "finding-recorded" }>
  >();
  const recordedFindingKeys = new Set<string>();
  const parkedBeforeRecording = new Map<string, boolean>();
  for (const event of events) {
    if (event.type === "finding-recorded") {
      recorded.set(event.identity, event);
      recordedFindingKeys.add(findingKey(event));
    }
    if (event.type === "finding-parked") {
      parked.set(findingKey(event), event);
      parkedBeforeRecording.set(
        findingKey(event),
        !recordedFindingKeys.has(findingKey(event)),
      );
    }
    if (event.type !== "finding-park-restored") continue;
    const earlier = parked.get(findingKey(event));
    const admitted = recorded.get(event.recordedIdentity);
    if (
      earlier?.identity === event.parkedIdentity &&
      earlier.reason !== "outside-programme-boundary" &&
      parkedBeforeRecording.get(findingKey(event)) === true &&
      admitted?.campaignId === event.campaignId &&
      admitted.findingId === event.findingId &&
      admitted.snapshotDigest === event.snapshotDigest &&
      admitted.runId === earlier.runId &&
      admitted.category === earlier.category &&
      admitted.artifacts.some((artifact) =>
        earlier.artifacts.some(
          (prior) =>
            prior.kind === "finding" &&
            artifact.kind === "finding" &&
            prior.digest === artifact.digest,
        ),
      ) &&
      event.artifacts.some((artifact) =>
        earlier.artifacts.some(
          (prior) =>
            prior.kind === "finding" &&
            artifact.kind === "finding" &&
            prior.digest === artifact.digest,
        ),
      ) &&
      earlier.snapshotDigest === event.snapshotDigest
    )
      parked.delete(findingKey(event));
  }
  return [...parked.values()];
}
export type FunnelCounts = {
  readonly reached: number;
  readonly accepted: number;
  readonly held: number;
  /** Findings outside the Programme Boundary; not in accepted or raw (#185). */
  readonly parked: number;
  readonly raw: number;
  readonly verified: number;
  readonly confirmed: number;
  readonly reproduced: number;
  readonly contradicted: number;
  readonly incomplete: number;
  readonly reviewed: number;
  readonly inScope: number;
  readonly submitted: number;
  readonly outcome: number;
};
const usageFields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
export type UsageField = (typeof usageFields)[number];

/** Provider-reported tokens of discovery runs, per target and UTC day of the run's end. */
export type UsageRow = {
  readonly day: string;
  readonly selectionId: string | null;
  readonly runs: number;
  readonly tokens: Readonly<Record<UsageField, number>>;
  /** Runs that did not report the field; their tokens are not in the total. */
  readonly unavailable: Readonly<Record<UsageField, number>>;
};

export type CampaignFunnel = FunnelCounts & {
  readonly campaignId: string;
  readonly discoveryAttempts: number;
  readonly incompleteDepth: number;
  readonly byLab: Readonly<Record<"attached" | "none", ArmCounts>>;
  readonly verificationLabFailed: number;
  readonly runCount: number;
  readonly knownCostUsd: number;
  readonly unpricedRuns: number;
  readonly wallTimeMs: number;
  readonly noncachedInputTokens: number;
  readonly unavailableInputRuns: number;
  readonly confirmedPerMillionInputTokens: number | null;
  readonly confirmedPerAgentWallHour: number | null;
  /** Number of recorded verification events per Finding, including historical events. */
  readonly verificationAttempts: Readonly<Record<string, number>>;
  /** Reviewed, non-contradicted findings judged in-scope, per assessed programme. */
  readonly inScopeByProgramme: Readonly<Record<string, number>>;
  /** Candidates by their latest recorded outcome. */
  readonly outcomesByKind: Readonly<Record<string, number>>;
  /** Sum of each candidate's latest reported reward. */
  readonly rewardUsd: number;
  /** Null until a submission supplies the denominator. */
  readonly ownerMinutesPerSubmission: number | null;
  readonly openedFindingsPerSubmission: number | null;
  readonly manualReproductionAgreement: number | null;
  readonly humanMinutesByAction: Readonly<
    Record<"read" | "reproduce" | "submit" | "outcome", number>
  >;
  readonly humanByCategory: Readonly<
    Record<
      string,
      {
        readonly ownerMinutesPerSubmission: number | null;
        readonly openedFindingsPerSubmission: number | null;
        readonly manualReproductionAgreement: number | null;
      }
    >
  >;
  readonly byCategory: Readonly<Record<string, FunnelCounts>>;
  /** Runs and their Findings per ablation arm, keyed `<axis>:<arm>`. */
  readonly byArm: Readonly<Record<string, ArmCounts>>;
  readonly byObjective: Readonly<Record<string, FunnelSlice>>;
};
export type FunnelSlice = FunnelCounts & {
  readonly runs: number;
  readonly noncachedInputTokens: number;
  readonly unavailableInputRuns: number;
  readonly wallTimeMs: number;
  readonly confirmedPerMillionInputTokens: number | null;
  readonly confirmedPerAgentWallHour: number | null;
};
type MutableSlice = { -readonly [K in keyof FunnelSlice]: FunnelSlice[K] };
export type ArmCounts = {
  readonly runs: number;
  readonly findings: number;
  readonly confirmed: number;
};

const querySchema = z.strictObject({
  campaignId: id.optional(),
  type: z
    .enum(ledgerEventV1Schema.options.map(({ shape }) => shape.type.value))
    .optional(),
  findingId: id.optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
});

/** `read`'s maximum `limit`; `readAll` pages at this size. */
const READ_ALL_PAGE = 1000;

const SINCE_CLAUSE =
  "julianday(json_extract(event_json, '$.occurredAt')) >= julianday(?)";

function scopeClauses(query: {
  readonly campaignId?: string | undefined;
  readonly since?: string | undefined;
}): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.campaignId !== undefined) {
    clauses.push("campaign_id = ?");
    params.push(id.parse(query.campaignId));
  }
  if (query.since !== undefined) {
    clauses.push(SINCE_CLAUSE);
    params.push(z.iso.datetime({ offset: true }).parse(query.since));
  }
  return { clauses, params };
}

const storedRow = z.strictObject({
  sequence: z.number().int().positive(),
  identity: z.string(),
  input_digest: digest,
  event_json: z.string(),
});

const recordedTime = z.object({ occurredAt: z.string() });

/**
 * #212: events carry the time they were recorded, so a retried append of the
 * same fact differs only in `occurredAt`; that is the event already stored.
 */
function priorStatus(
  row: unknown,
  parsed: LedgerEventV1,
  inputDigest: string,
): "existing" | "conflict" {
  const stored = storedRow.parse(row);
  if (stored.input_digest === inputDigest) return "existing";
  const recordedAt = recordedTime.safeParse(JSON.parse(stored.event_json)).data
    ?.occurredAt;
  return recordedAt !== undefined &&
    stored.input_digest ===
      canonicalDigest({ ...parsed, occurredAt: recordedAt })
    ? "existing"
    : "conflict";
}

type Counts = { -readonly [K in keyof FunnelCounts]: number };

function emptyCounts(): Counts {
  return {
    reached: 0,
    accepted: 0,
    held: 0,
    parked: 0,
    raw: 0,
    verified: 0,
    confirmed: 0,
    reproduced: 0,
    contradicted: 0,
    incomplete: 0,
    reviewed: 0,
    inScope: 0,
    submitted: 0,
    outcome: 0,
  };
}

function findingIdOf(value: LedgerEventV1): string | null {
  return "findingId" in value ? (value.findingId ?? null) : null;
}

/** The only operations on a ledger are append, read and a derived funnel view. */
export class Ledger {
  readonly #db: DatabaseSync;
  readonly #artifacts: PrivateArtifactStore;
  readonly #readOnly: boolean;

  constructor(options: {
    readonly databasePath: string;
    readonly artifactStore: PrivateArtifactStore;
    /** Open an existing ledger without initialization or append capability. */
    readonly readOnly?: boolean;
  }) {
    this.#readOnly = options.readOnly ?? false;
    this.#db = new DatabaseSync(options.databasePath, {
      readOnly: this.#readOnly,
    });
    // Several discovery processes append to the shared ledger. Node's SQLite
    // connection defaults to zero wait time, so a concurrent writer otherwise
    // turns a short transaction into a failed Trial.
    this.#db.exec("PRAGMA busy_timeout = 30000");
    this.#artifacts = options.artifactStore;
    if (this.#readOnly) return;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL UNIQUE,
        campaign_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        finding_id TEXT,
        input_digest TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_campaign_sequence
        ON ledger_events (campaign_id, sequence);
    `);
  }

  async append(
    candidate: LedgerEventInput,
  ): Promise<{ readonly status: "appended" | "existing" | "conflict" }> {
    if (this.#readOnly) throw new Error("Cannot append to a read-only ledger");
    const parsed = ledgerEventV1Schema.parse(candidate);
    if (
      parsed.type === "lead-recorded" &&
      !parsed.artifacts.some((artifact) => artifact.kind === "lead")
    )
      throw new Error("A Lead must reference Private Evidence");
    const inputDigest = canonicalDigest(parsed);
    const prior = this.#db
      .prepare(
        "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE identity = ?",
      )
      .get(parsed.identity);
    if (prior !== undefined)
      return { status: priorStatus(prior, parsed, inputDigest) };
    for (const ref of parsed.artifacts) {
      const resolution = await this.#artifacts.resolve(ref.digest);
      if (
        resolution.status !== "resolved" ||
        resolution.artifact.digest !== ref.digest
      ) {
        throw new Error(`Private artifact is unavailable: ${ref.digest}`);
      }
    }
    let evidenceAvailable = true;
    if (
      parsed.type === "verification-finished" &&
      "evidenceDigest" in parsed.result &&
      parsed.result.evidenceDigest !== undefined
    ) {
      const resolution = await this.#artifacts.resolve(
        parsed.result.evidenceDigest,
      );
      evidenceAvailable =
        resolution.status === "resolved" &&
        resolution.artifact.digest === parsed.result.evidenceDigest;
      if (
        parsed.result.status === "runtime-confirmed" ||
        parsed.result.status === "reproduced"
      ) {
        const packageResolution = await this.#artifacts.resolve(
          parsed.result.reproductionPackageDigest,
        );
        evidenceAvailable &&=
          packageResolution.status === "resolved" &&
          packageResolution.artifact.digest ===
            parsed.result.reproductionPackageDigest;
      }
    }
    if (
      parsed.type === "verification-finished" &&
      "refutationDigest" in parsed.result &&
      parsed.result.refutationDigest !== undefined
    ) {
      const refutation = await this.#artifacts.resolve(
        parsed.result.refutationDigest,
      );
      evidenceAvailable &&=
        refutation.status === "resolved" &&
        refutation.artifact.digest === parsed.result.refutationDigest;
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare(
          "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE identity = ?",
        )
        .get(parsed.identity);
      if (existing !== undefined) {
        const status = priorStatus(existing, parsed, inputDigest);
        this.#db.exec("COMMIT");
        return { status };
      }

      if (parsed.type === "discovery-run-started") {
        const previousRuns = this.#db
          .prepare(
            "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'discovery-run-started' ORDER BY sequence",
          )
          .all(parsed.campaignId);
        if (
          previousRuns.some((row) => {
            const previous = ledgerEventV1Schema.parse(
              JSON.parse(
                z.object({ event_json: z.string() }).parse(row).event_json,
              ) as unknown,
            );
            return (
              previous.type === "discovery-run-started" &&
              previous.runId === parsed.runId
            );
          })
        ) {
          this.#db.exec("COMMIT");
          return { status: "conflict" };
        }
      }

      if (parsed.type === "finding-recorded") {
        if (
          (parsed.derivedFromFindingId === undefined) !==
          (parsed.derivationKind === undefined)
        ) {
          this.#db.exec("COMMIT");
          return { status: "conflict" };
        }
        if (parsed.derivedFromFindingId !== undefined) {
          const source = this.#db
            .prepare(
              "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'finding-recorded' AND finding_id = ? ORDER BY sequence LIMIT 1",
            )
            .get(parsed.campaignId, parsed.derivedFromFindingId);
          const origin =
            source === undefined
              ? null
              : ledgerEventV1Schema.parse(
                  JSON.parse(
                    z.object({ event_json: z.string() }).parse(source)
                      .event_json,
                  ) as unknown,
                );
          if (
            origin?.type !== "finding-recorded" ||
            origin.snapshotDigest === parsed.snapshotDigest ||
            parsed.historyRecordId !== undefined
          ) {
            this.#db.exec("COMMIT");
            return { status: "conflict" };
          }
        }
        if (parsed.historyRecordId !== undefined) {
          const runRow = this.#db
            .prepare(
              "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'discovery-run-started' ORDER BY sequence",
            )
            .all(parsed.campaignId)
            .map((row) =>
              ledgerEventV1Schema.parse(
                JSON.parse(
                  z.object({ event_json: z.string() }).parse(row).event_json,
                ) as unknown,
              ),
            )
            .find(
              (event) =>
                event.type === "discovery-run-started" &&
                event.runId === parsed.runId,
            );
          if (
            runRow?.type !== "discovery-run-started" ||
            runRow.snapshotDigest !== parsed.snapshotDigest ||
            runRow.history.mode !== "catalog" ||
            !runRow.history.recordIds.includes(parsed.historyRecordId)
          ) {
            this.#db.exec("COMMIT");
            return { status: "conflict" };
          }
        }
        const previousFinding = this.#db
          .prepare(
            "SELECT sequence FROM ledger_events WHERE campaign_id = ? AND event_type = 'finding-recorded' AND finding_id = ? LIMIT 1",
          )
          .get(parsed.campaignId, parsed.findingId);
        if (previousFinding !== undefined) {
          this.#db.exec("COMMIT");
          return { status: "conflict" };
        }
      }

      let recorded: LedgerEventV1 = parsed;
      if (parsed.type === "verification-finished") {
        const finding = this.#db
          .prepare(
            "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'finding-recorded' AND finding_id = ? ORDER BY sequence LIMIT 1",
          )
          .get(parsed.campaignId, parsed.findingId);
        const findingEvent =
          finding === undefined
            ? null
            : ledgerEventV1Schema.parse(
                JSON.parse(
                  z.object({ event_json: z.string() }).parse(finding)
                    .event_json,
                ) as unknown,
              );
        // Every verdict must bind the Finding to this exact frozen snapshot.
        const latestFrozen =
          parsed.basis === undefined ||
          this.#db
            .prepare(
              "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'snapshot-frozen'",
            )
            .all(parsed.campaignId)
            .some(
              (row) =>
                ledgerEventV1Schema.parse(
                  JSON.parse(
                    z.object({ event_json: z.string() }).parse(row).event_json,
                  ) as unknown,
                ).snapshotDigest === parsed.snapshotDigest,
            );
        if (
          findingEvent?.type !== "finding-recorded" ||
          findingEvent.snapshotDigest !== parsed.snapshotDigest ||
          (parsed.basis !== undefined &&
            parsed.basis.findingSnapshotDigest !== parsed.snapshotDigest)
        ) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason:
                findingEvent === null ? "precondition" : "digest-mismatch",
              nextStep:
                findingEvent === null
                  ? "Record the finding before verification"
                  : "Repeat verification against the finding snapshot",
            },
          };
        } else if (!latestFrozen) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason: "precondition",
              nextStep:
                "Freeze the selected version in this campaign before re-verifying",
            },
          };
        } else if (!evidenceAvailable) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason: "evidence",
              nextStep: "Restore verification evidence and repeat verification",
            },
          };
        }
      }
      this.#db
        .prepare(
          "INSERT INTO ledger_events (identity, campaign_id, event_type, finding_id, input_digest, event_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          recorded.identity,
          recorded.campaignId,
          recorded.type,
          findingIdOf(recorded),
          inputDigest,
          canonicalJson(recorded),
        );
      this.#db.exec("COMMIT");
      return { status: "appended" };
    } catch (error: unknown) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  read(query: LedgerReadQuery = {}): readonly LedgerRecord[] {
    const parsed = querySchema.parse(query);
    const clauses = ["sequence > ?"];
    const params: (string | number)[] = [parsed.afterSequence ?? 0];
    if (parsed.campaignId !== undefined) {
      clauses.push("campaign_id = ?");
      params.push(parsed.campaignId);
    }
    if (parsed.type !== undefined) {
      clauses.push("event_type = ?");
      params.push(parsed.type);
    }
    if (parsed.findingId !== undefined) {
      clauses.push("finding_id = ?");
      params.push(parsed.findingId);
    }
    if (parsed.since !== undefined) {
      clauses.push(SINCE_CLAUSE);
      params.push(parsed.since);
    }
    const rows = this.#db
      .prepare(
        `SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...params, parsed.limit ?? 100);
    return rows.map((row) => {
      const stored = storedRow.parse(row);
      return {
        sequence: stored.sequence,
        event: ledgerEventV1Schema.parse(
          JSON.parse(stored.event_json) as unknown,
        ),
      };
    });
  }

  /** Every matching event in sequence order; pages through `read` until exhausted. */
  readAll(query: LedgerReadAllQuery = {}): readonly LedgerRecord[] {
    const records: LedgerRecord[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.read({ ...query, afterSequence, limit: READ_ALL_PAGE });
      records.push(...page);
      if (page.length < READ_ALL_PAGE) return records;
      afterSequence = page[page.length - 1]!.sequence;
    }
  }

  /** The currently parked Findings, after append-only admission corrections. */
  activeParked(
    query: { readonly campaignId?: string } = {},
  ): readonly ParkedFinding[] {
    return activeParkedFromEvents(
      this.readAll(query).map(({ event }) => event),
    );
  }

  usage(query: { readonly campaignId?: string } = {}): readonly UsageRow[] {
    const campaign =
      query.campaignId === undefined ? undefined : id.parse(query.campaignId);
    const rows = this.#db
      .prepare(
        campaign === undefined
          ? "SELECT event_json FROM ledger_events WHERE event_type IN ('target-selected', 'discovery-run-finished') ORDER BY sequence"
          : "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type IN ('target-selected', 'discovery-run-finished') ORDER BY sequence",
      )
      .all(...(campaign === undefined ? [] : [campaign]));
    const selections = new Map<string, string>();
    const totals = new Map<
      string,
      {
        day: string;
        selectionId: string | null;
        runs: number;
        tokens: Record<UsageField, number>;
        unavailable: Record<UsageField, number>;
      }
    >();
    for (const row of rows) {
      const event = ledgerEventV1Schema.parse(
        JSON.parse(
          z.object({ event_json: z.string() }).parse(row).event_json,
        ) as unknown,
      );
      const target = `${event.campaignId} ${event.snapshotDigest}`;
      if (event.type === "target-selected") {
        if (!selections.has(target)) selections.set(target, event.selectionId);
        continue;
      }
      // A run that never reached the provider used nothing.
      if (
        event.type !== "discovery-run-finished" ||
        event.outcome === "setup-failed"
      )
        continue;
      const day = new Date(event.occurredAt).toISOString().slice(0, 10);
      const selectionId = selections.get(target) ?? null;
      const key = `${day} ${selectionId ?? event.snapshotDigest}`;
      const zero = () =>
        Object.fromEntries(usageFields.map((field) => [field, 0])) as Record<
          UsageField,
          number
        >;
      const total = totals.get(key) ?? {
        day,
        selectionId,
        runs: 0,
        tokens: zero(),
        unavailable: zero(),
      };
      totals.set(key, total);
      total.runs++;
      for (const field of usageFields) {
        const value = event.usage?.[field] ?? "unavailable";
        if (value === "unavailable") total.unavailable[field]++;
        else total.tokens[field] += value;
      }
    }
    return [...totals.values()].sort(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        (left.selectionId ?? "").localeCompare(right.selectionId ?? ""),
    );
  }

  /** Groups the reasons runs, targets, Labs and campaigns stopped, from existing fields only. */
  stops(
    query: { readonly campaignId?: string; readonly since?: string } = {},
  ): readonly StopRow[] {
    const { clauses, params } = scopeClauses(query);
    const rows = this.#db
      .prepare(
        `SELECT event_json FROM ledger_events WHERE event_type IN ('discovery-run-started', 'discovery-run-finished', 'target-skipped', 'lab-provisioned', 'campaign-stopped')${clauses.map((clause) => ` AND ${clause}`).join("")} ORDER BY sequence`,
      )
      .all(...params);
    const runKinds = new Map<string, string | undefined>();
    const groups = new Map<
      string,
      {
        type: StopRow["type"];
        fields: Record<string, string>;
        count: number;
        explore: number;
        within60s: number;
      }
    >();
    const add = (
      type: StopRow["type"],
      fields: Record<string, string | undefined>,
      explore = false,
      within60s = false,
    ): void => {
      const kept = Object.fromEntries(
        Object.entries(fields).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      const key = `${type} ${JSON.stringify(kept)}`;
      const group = groups.get(key) ?? {
        type,
        fields: kept,
        count: 0,
        explore: 0,
        within60s: 0,
      };
      groups.set(key, group);
      group.count++;
      if (explore) group.explore++;
      if (within60s) group.within60s++;
    };
    for (const row of rows) {
      const event = ledgerEventV1Schema.parse(
        JSON.parse(
          z.object({ event_json: z.string() }).parse(row).event_json,
        ) as unknown,
      );
      switch (event.type) {
        case "discovery-run-started":
          runKinds.set(`${event.campaignId} ${event.runId}`, event.runKind);
          break;
        case "discovery-run-finished":
          if (event.outcome === "completed") break;
          add(
            event.type,
            {
              outcome: event.outcome,
              reason: event.reason,
              reasonDetail: event.reasonDetail,
              providerLimit: event.providerLimit,
            },
            runKinds.get(`${event.campaignId} ${event.runId}`) === "explore",
            event.wallTimeMs <= 60_000,
          );
          break;
        case "target-skipped":
          add(event.type, {
            stage: event.stage,
            reason: event.reason ?? "unrecorded",
          });
          break;
        case "lab-provisioned":
          if (event.status !== "failed") break;
          add(event.type, {
            status: event.status,
            failureStage: event.failureStage,
            reason: event.reason,
          });
          break;
        case "campaign-stopped":
          add(event.type, { reason: event.reason, runtime: event.runtime });
          break;
      }
    }
    return [...groups.values()].map((group) =>
      group.type === "discovery-run-finished"
        ? group
        : { type: group.type, fields: group.fields, count: group.count },
    );
  }

  /**
   * Every resumed segment, in ledger order, with the stop it resumed and its
   * own finish, from existing fields only. `since` keeps segments started at
   * or after that instant.
   */
  resumes(
    query: { readonly campaignId?: string; readonly since?: string } = {},
  ): readonly ResumeRow[] {
    const { clauses, params } = scopeClauses({ campaignId: query.campaignId });
    const since =
      query.since === undefined
        ? undefined
        : Date.parse(z.iso.datetime({ offset: true }).parse(query.since));
    const rows = this.#db
      .prepare(
        `SELECT event_json FROM ledger_events WHERE event_type IN ('discovery-run-started', 'discovery-run-finished')${clauses.map((clause) => ` AND ${clause}`).join("")} ORDER BY sequence`,
      )
      .all(...params);
    const segments: Extract<
      LedgerEventV1,
      { type: "discovery-run-started" }
    >[] = [];
    const finishes = new Map<
      string,
      Extract<LedgerEventV1, { type: "discovery-run-finished" }>
    >();
    for (const row of rows) {
      const event = ledgerEventV1Schema.parse(
        JSON.parse(
          z.object({ event_json: z.string() }).parse(row).event_json,
        ) as unknown,
      );
      if (event.type === "discovery-run-finished")
        finishes.set(`${event.campaignId} ${event.runId}`, event);
      else if (
        event.type === "discovery-run-started" &&
        event.resumesRun !== undefined &&
        (since === undefined || Date.parse(event.occurredAt) >= since)
      )
        segments.push(event);
    }
    const stop = (
      finished:
        Extract<LedgerEventV1, { type: "discovery-run-finished" }> | undefined,
    ) =>
      finished === undefined
        ? {}
        : {
            outcome: finished.outcome,
            ...(finished.reason === undefined
              ? {}
              : { reason: finished.reason }),
            ...(finished.reasonDetail === undefined
              ? {}
              : { reasonDetail: finished.reasonDetail }),
          };
    return segments.map((segment) => {
      const finished = finishes.get(`${segment.campaignId} ${segment.runId}`);
      return {
        campaignId: segment.campaignId,
        runId: segment.runId,
        resumesRun: segment.resumesRun!,
        segment: segment.resumeSegment ?? 0,
        startedAt: segment.occurredAt,
        ...(segment.configuration.runtime === undefined
          ? {}
          : { runtime: segment.configuration.runtime }),
        resumed: stop(
          finishes.get(`${segment.campaignId} ${segment.resumesRun}`),
        ),
        ...stop(finished),
        ...(finished === undefined ? {} : { wallTimeMs: finished.wallTimeMs }),
      };
    });
  }

  /** One campaign's funnel, or every campaign's events since an instant. */
  funnel(
    campaignId: string | undefined,
    query: { readonly since?: string } = {},
  ): CampaignFunnel {
    if (campaignId === undefined && query.since === undefined)
      throw new Error("A funnel needs a campaign or a since instant");
    const campaign = campaignId === undefined ? "*" : id.parse(campaignId);
    const { clauses, params } = scopeClauses({
      campaignId,
      since: query.since,
    });
    const rows = this.#db
      .prepare(
        `SELECT sequence, identity, input_digest, event_json FROM ledger_events${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`} ORDER BY sequence`,
      )
      .all(...params);
    const events = rows.map((row) =>
      ledgerEventV1Schema.parse(
        JSON.parse(storedRow.parse(row).event_json) as unknown,
      ),
    );
    const readyLabs = new Set<string>();
    const startedRuns = new Map<string, string | undefined>();
    const labByRun = new Map<string, "attached" | "none">();
    let verificationLabFailed = 0;
    const runKinds = new Map<string, "explore" | "continue" | "child">();
    /** Resume segments continue an earlier run's Trial; they are not new attempts (ADR 0036). */
    const resumeSegments = new Set<string>();
    const trialByRun = new Map<string, string>();
    const runArms = new Map<string, string[]>();
    const objectiveByRun = new Map<string, string>();
    const candidateKeys = new Set<string>();
    const heldKeys = new Set<string>();
    const legacyReached: { runId: string; category: string }[] = [];
    const candidateCategory = new Map<string, string>();
    const normalizationSeen = new Set<string>();
    const verificationAttempts: Record<string, number> = Object.create(null);
    let noncachedInputTokens = 0;
    let unavailableInputRuns = 0;
    let knownCostUsd = 0;
    let unpricedRuns = 0;
    let wallTimeMs = 0;
    const setupFailedRuns = new Set<string>();
    const findings = new Map<
      string,
      Extract<LedgerEventV1, { type: "finding-recorded" }>
    >();
    const parkedFindings = new Map<
      string,
      Extract<LedgerEventV1, { type: "finding-parked" }>
    >();
    const verifications = new Map<
      string,
      Extract<LedgerEventV1, { type: "verification-finished" }>
    >();
    const reviews = new Set<string>();
    const scopes = new Map<string, Map<string, string>>();
    const submissions = new Map<string, string>();
    const submittedFindingsByCandidate = new Map<string, string>();
    const outcomes = new Set<string>();
    const latestOutcome = new Map<
      string,
      Extract<LedgerEventV1, { type: "submission-outcome" }>
    >();
    const humanMinutesByAction = {
      read: 0,
      reproduce: 0,
      submit: 0,
      outcome: 0,
    };
    const humanEffortEvents: Extract<
      LedgerEventV1,
      { type: "human-effort-recorded" }
    >[] = [];
    const openedFindings = new Set<string>();
    const manualReproductions = new Map<
      string,
      "match" | "mismatch" | "unavailable"
    >();

    for (const current of events) {
      switch (current.type) {
        case "lab-provisioned":
          if (current.status === "ready") readyLabs.add(current.labId);
          break;
        case "discovery-run-started":
          startedRuns.set(current.runId, current.labId);
          labByRun.set(
            current.runId,
            current.labAttached === false ? "none" : "attached",
          );
          runKinds.set(current.runId, current.runKind ?? "explore");
          if (current.resumesRun !== undefined)
            resumeSegments.add(current.runId);
          trialByRun.set(current.runId, current.trialId ?? current.runId);
          objectiveByRun.set(
            current.runId,
            current.configuration.promptVariant,
          );
          if ((current.runKind ?? "explore") !== "explore") break;
          if (current.configuration.arms !== undefined) {
            const arms = (
              ["history", "prompt", "continuation"] as const
            ).flatMap((axis) => {
              const arm = current.configuration.arms?.[axis];
              return arm === undefined ? [] : [`${axis}:${arm}`];
            });
            if (arms.length > 1) arms.push(arms.join("+"));
            runArms.set(current.runId, arms);
          } else if (
            current.configuration.axis !== undefined &&
            current.configuration.arm !== undefined
          )
            runArms.set(current.runId, [
              `${current.configuration.axis}:${current.configuration.arm}`,
            ]);
          break;
        case "verification-lab-failed":
          verificationLabFailed++;
          break;
        case "discovery-run-finished":
          if (current.costUsd === "unavailable") unpricedRuns++;
          else knownCostUsd += current.costUsd;
          wallTimeMs += current.wallTimeMs;
          if (current.outcome !== "setup-failed") {
            const input = current.usage?.inputTokens;
            const cached = current.usage?.cachedInputTokens;
            if (
              input === undefined ||
              input === "unavailable" ||
              cached === undefined ||
              cached === "unavailable" ||
              cached > input
            )
              unavailableInputRuns++;
            else noncachedInputTokens += input - cached;
          }
          if (current.outcome === "setup-failed")
            setupFailedRuns.add(current.runId);
          break;
        case "candidate-normalized":
        case "candidate-held":
        case "candidate-rejected": {
          const boundary = `${current.runId}\0${current.candidateKind}`;
          const key = `${boundary}\0${current.candidateIndex}`;
          candidateKeys.add(key);
          if (current.type === "candidate-normalized") {
            normalizationSeen.add(boundary);
            heldKeys.delete(key);
            candidateCategory.delete(key);
          } else {
            heldKeys.add(key);
            candidateCategory.set(
              key,
              current.candidateKind === "finding"
                ? (current.impact ?? "unclassified")
                : `lead:${current.primitive ?? "unclassified"}/${current.missingEdge ?? "unclassified"}`,
            );
          }
          break;
        }
        case "finding-recorded":
          if (
            current.derivationKind !== "fixed-version-control" &&
            !normalizationSeen.has(`${current.runId}\0finding`)
          )
            legacyReached.push({
              runId: current.runId,
              category: current.category,
            });
          if (!findings.has(current.findingId))
            findings.set(current.findingId, current);
          break;
        case "lead-recorded":
          if (!normalizationSeen.has(`${current.runId}\0lead`))
            legacyReached.push({
              runId: current.runId,
              category: `lead:${current.primitive}/${current.missingEdge}`,
            });
          break;
        case "verification-finished":
          verificationAttempts[current.findingId] =
            (verificationAttempts[current.findingId] ?? 0) + 1;
          verifications.set(current.findingId, current);
          break;
        case "review-decided":
          reviews.add(current.findingId);
          break;
        case "scope-assessed": {
          const byProgramme =
            scopes.get(current.findingId) ?? new Map<string, string>();
          byProgramme.set(current.programmeId, current.status);
          scopes.set(current.findingId, byProgramme);
          break;
        }
        case "submission-recorded":
          submissions.set(current.findingId, current.candidateId);
          submittedFindingsByCandidate.set(
            current.candidateId,
            current.findingId,
          );
          break;
        case "submission-outcome":
          outcomes.add(current.candidateId);
          latestOutcome.set(current.candidateId, current);
          break;
        case "human-effort-recorded":
          humanEffortEvents.push(current);
          humanMinutesByAction[current.action] += current.minutes;
          if (current.action === "read" && current.findingId !== undefined)
            openedFindings.add(current.findingId);
          break;
        case "human-reproduction-recorded":
          manualReproductions.set(current.findingId, current.result);
          break;
      }
    }

    for (const parked of activeParkedFromEvents(events))
      parkedFindings.set(parked.findingId, parked);

    const inScopeByProgramme: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
      if (parkedFindings.has(finding.findingId)) continue;
      const status = verifications.get(finding.findingId)?.result.status;
      if (
        status === undefined ||
        status === "contradicted" ||
        !reviews.has(finding.findingId)
      )
        continue;
      for (const [programmeId, scope] of scopes.get(finding.findingId) ?? [])
        inScopeByProgramme[programmeId] =
          (inScopeByProgramme[programmeId] ?? 0) +
          (scope === "in-scope" ? 1 : 0);
    }
    const totals = emptyCounts();
    const byCategory: Record<string, Counts> = Object.create(null) as Record<
      string,
      Counts
    >;
    const byObjective: Record<string, MutableSlice> = Object.create(
      null,
    ) as Record<string, MutableSlice>;
    const objective = (runId: string): MutableSlice => {
      const name = objectiveByRun.get(runId) ?? "unclassified";
      return (byObjective[name] ??= {
        ...emptyCounts(),
        runs: 0,
        noncachedInputTokens: 0,
        unavailableInputRuns: 0,
        wallTimeMs: 0,
        confirmedPerMillionInputTokens: null,
        confirmedPerAgentWallHour: null,
      });
    };
    for (const runId of startedRuns.keys())
      if (!resumeSegments.has(runId)) objective(runId).runs++;
    for (const event of events) {
      if (event.type !== "discovery-run-finished") continue;
      const slice = objective(event.runId);
      slice.wallTimeMs += event.wallTimeMs;
      if (event.outcome === "setup-failed") continue;
      const input = event.usage?.inputTokens;
      const cached = event.usage?.cachedInputTokens;
      if (
        input === undefined ||
        input === "unavailable" ||
        cached === undefined ||
        cached === "unavailable" ||
        cached > input
      )
        slice.unavailableInputRuns++;
      else slice.noncachedInputTokens += input - cached;
    }
    for (const key of candidateKeys) {
      const runId = key.split("\0", 1)[0]!;
      totals.reached++;
      objective(runId).reached++;
      if (!heldKeys.has(key)) continue;
      totals.held++;
      objective(runId).held++;
      const category = candidateCategory.get(key) ?? "unclassified";
      const counts = (byCategory[category] ??= emptyCounts());
      counts.reached++;
      counts.held++;
    }
    for (const { runId, category } of legacyReached) {
      totals.reached++;
      objective(runId).reached++;
      (byCategory[category] ??= emptyCounts()).reached++;
    }
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
      if (parkedFindings.has(finding.findingId)) continue;
      const category = (byCategory[finding.category] ??= emptyCounts());
      for (const count of [totals, category, objective(finding.runId)]) {
        count.accepted++;
        count.raw++;
        const verification = verifications.get(finding.findingId);
        if (verification === undefined) continue;
        count.verified++;
        const status = verification.result.status;
        if (status === "runtime-confirmed") count.confirmed++;
        else if (status === "reproduced") count.reproduced++;
        else if (status === "contradicted") count.contradicted++;
        else count.incomplete++;
        if (status === "contradicted" || !reviews.has(finding.findingId))
          continue;
        count.reviewed++;
        const inScope = [
          ...(scopes.get(finding.findingId)?.values() ?? []),
        ].includes("in-scope");
        if (!inScope) continue;
        count.inScope++;
        const candidateId = submissions.get(finding.findingId);
        if (candidateId === undefined) continue;
        count.submitted++;
        if (outcomes.has(candidateId)) count.outcome++;
      }
    }
    const leads = new Map<
      string,
      Extract<LedgerEventV1, { type: "lead-recorded" }>
    >();
    for (const event of events)
      if (event.type === "lead-recorded" && !leads.has(event.leadId))
        leads.set(event.leadId, event);
    for (const lead of leads.values()) {
      const category = `lead:${lead.primitive}/${lead.missingEdge}`;
      for (const count of [
        totals,
        (byCategory[category] ??= emptyCounts()),
        objective(lead.runId),
      ])
        count.accepted++;
    }
    for (const parked of parkedFindings.values()) {
      for (const count of [
        totals,
        (byCategory[parked.category] ??= emptyCounts()),
        objective(parked.runId),
      ])
        count.parked++;
    }
    for (const counts of [
      totals,
      ...Object.values(byCategory),
      ...Object.values(byObjective),
    ]) {
      // A normalized candidate may have no later admission, hold or parking event.
      counts.reached = Math.max(
        counts.reached,
        counts.accepted + counts.held + counts.parked,
      );
    }
    const classifiedReached = Object.values(byCategory).reduce(
      (sum, counts) => sum + counts.reached,
      0,
    );
    if (classifiedReached < totals.reached)
      (byCategory.unclassified ??= emptyCounts()).reached +=
        totals.reached - classifiedReached;
    const rate = (
      confirmed: number,
      tokens: number,
      missing: number,
      wall: number,
    ) => ({
      token:
        missing === 0 && tokens > 0 ? (confirmed * 1_000_000) / tokens : null,
      wall: wall > 0 ? (confirmed * 3_600_000) / wall : null,
    });
    for (const slice of Object.values(byObjective)) {
      const rates = rate(
        slice.confirmed,
        slice.noncachedInputTokens,
        slice.unavailableInputRuns,
        slice.wallTimeMs,
      );
      slice.confirmedPerMillionInputTokens = rates.token;
      slice.confirmedPerAgentWallHour = rates.wall;
    }
    const campaignRates = rate(
      totals.confirmed,
      noncachedInputTokens,
      unavailableInputRuns,
      wallTimeMs,
    );
    const outcomesByKind: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    let rewardUsd = 0;
    for (const latest of latestOutcome.values()) {
      outcomesByKind[latest.outcome] =
        (outcomesByKind[latest.outcome] ?? 0) + 1;
      rewardUsd += latest.rewardUsd ?? 0;
    }
    const byArm: Record<
      string,
      { runs: number; findings: number; confirmed: number }
    > = Object.create(null) as Record<
      string,
      { runs: number; findings: number; confirmed: number }
    >;
    for (const arms of runArms.values())
      for (const arm of arms)
        (byArm[arm] ??= { runs: 0, findings: 0, confirmed: 0 }).runs++;
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
      for (const arm of runArms.get(
        trialByRun.get(finding.runId) ?? finding.runId,
      ) ?? []) {
        const counts = byArm[arm]!;
        counts.findings++;
        if (
          verifications.get(finding.findingId)?.result.status ===
          "runtime-confirmed"
        )
          counts.confirmed++;
      }
    }
    const byLab: Record<
      "attached" | "none",
      { -readonly [K in keyof ArmCounts]: number }
    > = {
      attached: { runs: 0, findings: 0, confirmed: 0 },
      none: { runs: 0, findings: 0, confirmed: 0 },
    };
    for (const [runId, lab] of labByRun)
      if (runKinds.get(runId) === "explore" && !resumeSegments.has(runId))
        byLab[lab].runs++;
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
      const lab = labByRun.get(trialByRun.get(finding.runId) ?? finding.runId);
      if (lab === undefined) continue;
      byLab[lab].findings++;
      if (
        verifications.get(finding.findingId)?.result.status ===
        "runtime-confirmed"
      )
        byLab[lab].confirmed++;
    }
    const discoveryAttempts = [...startedRuns.entries()].filter(
      ([runId, labId]) =>
        runKinds.get(runId) !== "child" &&
        !resumeSegments.has(runId) &&
        (labByRun.get(runId) === "none" ||
          (labId !== undefined && readyLabs.has(labId))) &&
        !setupFailedRuns.has(runId),
    ).length;
    const incompleteDepth = events.filter(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.outcome === "failed" &&
        event.reason === "depth" &&
        runKinds.get(event.runId) === "explore",
    ).length;
    const agreement = (
      values: readonly ("match" | "mismatch" | "unavailable")[],
    ) => {
      const comparable = values.filter((value) => value !== "unavailable");
      return comparable.length === 0
        ? null
        : comparable.filter((value) => value === "match").length /
            comparable.length;
    };
    const humanByCategory = Object.fromEntries(
      Object.keys(byCategory).map((category) => {
        const inCategory = (findingId: string) =>
          findings.get(findingId)?.category === category;
        const submissionCount = [
          ...submittedFindingsByCandidate.values(),
        ].filter(inCategory).length;
        const minutes = events.reduce(
          (sum, event) =>
            event.type === "human-effort-recorded" &&
            event.findingId !== undefined &&
            inCategory(event.findingId)
              ? sum + event.minutes
              : sum,
          0,
        );
        const effortCount = humanEffortEvents.filter(
          (event) =>
            event.findingId !== undefined && inCategory(event.findingId),
        ).length;
        const readCount = humanEffortEvents.filter(
          (event) =>
            event.action === "read" &&
            event.findingId !== undefined &&
            inCategory(event.findingId),
        ).length;
        const opened = [...openedFindings].filter(inCategory).length;
        const manual = [...manualReproductions.entries()]
          .filter(([findingId]) => inCategory(findingId))
          .map(([, result]) => result);
        return [
          category,
          {
            ownerMinutesPerSubmission:
              submissionCount === 0 || effortCount === 0
                ? null
                : minutes / submissionCount,
            openedFindingsPerSubmission:
              submissionCount === 0 || readCount === 0
                ? null
                : opened / submissionCount,
            manualReproductionAgreement: agreement(manual),
          },
        ];
      }),
    );
    return {
      campaignId: campaign,
      discoveryAttempts,
      incompleteDepth,
      byLab,
      verificationLabFailed,
      runCount: startedRuns.size,
      knownCostUsd,
      unpricedRuns,
      wallTimeMs,
      noncachedInputTokens,
      unavailableInputRuns,
      confirmedPerMillionInputTokens: campaignRates.token,
      confirmedPerAgentWallHour: campaignRates.wall,
      verificationAttempts: { ...verificationAttempts },
      ...totals,
      inScopeByProgramme: { ...inScopeByProgramme },
      outcomesByKind,
      rewardUsd,
      ownerMinutesPerSubmission:
        submittedFindingsByCandidate.size === 0 ||
        humanEffortEvents.length === 0
          ? null
          : Object.values(humanMinutesByAction).reduce(
              (sum, minutes) => sum + minutes,
              0,
            ) / submittedFindingsByCandidate.size,
      openedFindingsPerSubmission:
        submittedFindingsByCandidate.size === 0 ||
        !humanEffortEvents.some((event) => event.action === "read")
          ? null
          : openedFindings.size / submittedFindingsByCandidate.size,
      manualReproductionAgreement: agreement([...manualReproductions.values()]),
      humanMinutesByAction,
      humanByCategory,
      byCategory,
      byArm: { ...byArm },
      byObjective: { ...byObjective },
    };
  }
}
