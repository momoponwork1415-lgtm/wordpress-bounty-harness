import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { verificationResultV1Schema } from "../verification/reproduction-package.js";

/** The longest identity, campaign id or other id an event may carry. */
export const LEDGER_ID_MAX_LENGTH = 128;
const id = z.string().min(1).max(LEDGER_ID_MAX_LENGTH);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactRef = z.strictObject({ kind: id, digest });
/** A version string such as `3.3.1`; never free text. */
const versionToken = z.string().regex(/^[0-9A-Za-z.+_-]{1,64}$/);
/** A programme's decision on an external submission (#698). */
export const EXTERNAL_OUTCOMES = [
  "accepted",
  "rejected",
  "duplicate",
  "out-of-scope",
] as const;
/** An enum value a profile declared; never free text. */
const declaredToken = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
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
    /**
     * The runner dropped an automatic selection batch frozen under another
     * policy, which can never run under the current one (#302). campaignId is
     * the batch id. Its targets have no Trial, so selection admits them again.
     */
    type: z.literal("selection-batch-discarded"),
    /** The policy the batch was frozen under. */
    policyDigest: digest,
    /** The policy the runner selects under now. */
    currentPolicyDigest: digest,
    reason: z.enum(["policy-changed"]),
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
    /** The Lab setup digest; a resumed segment's fresh Lab must match it. */
    setupDigest: digest.optional(),
    scenario: z.strictObject({ id, digest }).optional(),
    reachability: z
      .strictObject({
        http: z.enum(["ok", "failed"]),
        database: z.enum(["ok", "failed", "not-exposed"]),
      })
      .optional(),
    failureStage: z.enum(["provision", "seed", "probe"]).optional(),
    reason: z.enum(["provision", "precondition", "reachability"]).optional(),
    /**
     * The profile's versioned base environment the Lab was built with (#699);
     * id and digest only, plus the origin this Finding's attacker stood at.
     */
    baseline: z
      .strictObject({
        id,
        digest,
        attackerOrigin: z.enum(["domestic", "foreign"]).optional(),
      })
      .optional(),
  }),
  event({
    type: z.literal("discovery-run-started"),
    runId: id,
    labId: id.optional(),
    labAttached: z.boolean().optional(),
    trialId: id.optional(),
    trialOrdinal: z.number().int().nonnegative().optional(),
    stage: z.enum(["screening", "deep-dive"]).optional(),
    /**
     * `enumerate` and `trace` are the two roles of a partitioned Trial (ADR
     * 0042): one run per role, under the same `trialId`.
     */
    runKind: z
      .enum(["explore", "continue", "child", "enumerate", "trace"])
      .optional(),
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
      /**
       * Redesign 2026-10-25 §5: sha256 of each human-written section of an
       * objective composed from fragments; absent on earlier events and on
       * single-file objectives.
       */
      sectionDigests: z
        .strictObject({
          objective: digest.optional(),
          strategy: digest.optional(),
          coordination: digest.optional(),
          persistence: digest.optional(),
        })
        .optional(),
      /** sha256 of the complete prompt text handed to the Root; absent before 2026-10-25. */
      inputDigest: digest.optional(),
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
      /**
       * ADR 0039: the Trial's launch mode; absent on events before 2026-10-25.
       * `partitioned` is the role-based Trial of ADR 0042.
       */
      mode: z.enum(["deep", "wide", "partitioned"]).optional(),
      /**
       * ADR 0042: the role this run plays in a partitioned Trial, the digest
       * of its definition file and of the tool files mounted for it, and for
       * a tracer its partition. `resubmit` counts an enumerator's send-backs.
       */
      role: z
        .strictObject({
          kind: declaredToken,
          definitionDigest: digest,
          toolsDigest: digest.optional(),
          partitionId: id.optional(),
          resubmit: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /**
       * Redesign 2026-10-25 §7: the values the Harness enforced and stated in
       * the Run parameters section; absent on earlier events.
       */
      wallMinutes: z.number().positive().optional(),
      minimumActiveMinutes: z.number().nonnegative().optional(),
      maxChildren: z.number().int().positive().optional(),
      lab: z
        .strictObject({
          mode: z.enum(["none", "attached"]),
          maxResets: z.number().int().nonnegative(),
          /** Attached Labs from Phase D2 on; absent on earlier events. */
          maxObservations: z.number().int().nonnegative().optional(),
        })
        .optional(),
      model: id.optional(),
      effort: id.optional(),
      /** ADR 0043: the exploration skills staged for the run, by id and file digest; absent when none. */
      skills: z.array(z.strictObject({ id, digest })).min(1).max(8).optional(),
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
    /**
     * What the Harness observed in the Trial's exploration Lab (ADR 0003,
     * 2026-10-25 addendum): exchanges that passed the Lab recorder and resets
     * through the control endpoint. Absent on Trials without one and on
     * earlier events; the capture itself is the `exploration-lab` artifact.
     */
    labObserved: z
      .strictObject({
        requests: z.number().int().nonnegative(),
        droppedRequests: z.number().int().nonnegative(),
        resets: z.number().int().nonnegative(),
        refusedResets: z.number().int().nonnegative(),
        /** Control answers that did not reach labctl after one retry. */
        droppedAnswers: z.number().int().nonnegative().optional(),
        /** Phase D2; absent on earlier events. */
        observations: z.number().int().nonnegative().optional(),
        refusedObservations: z.number().int().nonnegative().optional(),
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
    /** ADR 0042: the partition whose tracer reported it; absent outside partitioned Trials. */
    partition: id.optional(),
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
      "declared-precondition",
    ]),
    preconditionClass: id.optional(),
    /**
     * #613: the profile's declared values behind a `declared-precondition`
     * park, enum tokens only (invariant 8). Absent on every other park.
     */
    declaredPrecondition: z
      .strictObject({
        configurationClass: declaredToken.optional(),
        attackerInputPath: declaredToken.optional(),
        exploitTiming: declaredToken.optional(),
      })
      .optional(),
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
    /** ADR 0042: the partition whose tracer reported it; absent outside partitioned Trials. */
    partition: id.optional(),
  }),
  /**
   * ADR 0042: the enumerator's inventory and partition proposal, after the
   * Harness's shape check. One event per Trial, written when the proposal is
   * accepted or when the send-backs are exhausted. The counts are observed,
   * never judged: whether the tool scripts ran, how many rows each origin
   * gave, how many rows collapsed as duplicates.
   */
  event({
    type: z.literal("enumeration-recorded"),
    trialId: id,
    runId: id,
    accepted: z.boolean(),
    /** Proposals sent back before this one. */
    resubmits: z.number().int().nonnegative(),
    /** The distinct reasons of the last rejection; absent when accepted. */
    rejectedReasons: z.array(declaredToken).min(1).optional(),
    inventoryDigest: digest,
    /** Absent when the last proposal did not parse. */
    partitionsDigest: digest.optional(),
    scriptRan: z.boolean(),
    scriptRowCount: z.number().int().nonnegative(),
    agentRowCount: z.number().int().nonnegative(),
    duplicateRowCount: z.number().int().nonnegative(),
    partitionCount: z.number().int().nonnegative(),
    definitionDigest: digest,
    toolsDigest: digest,
    rowSource: z.enum(["agent", "script-only"]),
  }),
  /** ADR 0042: one accepted partition handed to one tracer run. */
  event({
    type: z.literal("partition-assigned"),
    trialId: id,
    partitionId: id,
    ordinal: z.number().int().nonnegative(),
    of: z.number().int().positive(),
    rowCount: z.number().int().positive(),
    scriptRowCount: z.number().int().nonnegative(),
    agentRowCount: z.number().int().nonnegative(),
    assignmentDigest: digest,
    /** The tracer run that received it. */
    runId: id,
    definitionDigest: digest,
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
    /** A historical submission outside Harness, not an authorization or verdict. */
    type: z.literal("submission-recorded-externally"),
    findingId: id,
    destination: id,
    submittedOn: z.iso.date(),
    recordedBy: id,
    /** #698: the newest public version when the submission was recorded. */
    latestVersionAtSubmission: z
      .strictObject({
        version: versionToken,
        observedAt: z.iso.datetime({ offset: true }),
        /** `operator`, or the public listing the profile declares it observed. */
        source: declaredToken,
      })
      .optional(),
    /** #698: the Finding's group keys when the submission was recorded. */
    sameRootKeys: z.array(digest).optional(),
  }),
  event({
    /**
     * #698: the decision a programme sent for an external submission, as the
     * owner received it; reasons and bodies stay in Private Evidence.
     */
    type: z.literal("submission-outcome-recorded"),
    findingId: id,
    destination: id,
    ticket: z.string().regex(/^[A-Za-z0-9._#-]{1,64}$/),
    outcome: z.enum(EXTERNAL_OUTCOMES),
    reasonCode: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional(),
    rewardUsd: z.number().nonnegative().max(1_000_000).optional(),
    decidedOn: z.iso.date(),
    recordedBy: id,
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
    /** A Lab is ready for a person's observation; session details stay in Private Evidence. */
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
    /**
     * #600: the Lab the person observed in, from the session receipt: the
     * attempt's own verification Lab kept up after it, or a fresh review Lab.
     * Absent on earlier events, which were all review Labs.
     */
    labKind: z.enum(["verification", "review"]).optional(),
    /**
     * #578: whether the person stated that the configuration they confirmed is
     * one an ordinary public site uses. Their statement with a short reason stays in Private
     * Evidence. Absent on earlier events and when the person did not state it.
     */
    configuration: z
      .strictObject({
        ordinaryPublicSite: z.boolean(),
        recordDigest: digest,
      })
      .optional(),
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
type FinishedRunEvent = Extract<
  LedgerEventV1,
  { type: "discovery-run-finished" }
>;

/**
 * Each attempt's end, from its runs' finishes (ADR 0033 / 0042). A Root's
 * attempt ends with its latest resume segment; a partitioned Trial's with its
 * enumeration record, its last enumerate finish and its tracer finishes.
 */
function classifyAttempts(
  attempts: readonly string[],
  runs: {
    readonly runKinds: ReadonlyMap<string, string>;
    readonly resumedBy: ReadonlyMap<string, string>;
    readonly finishedRuns: ReadonlyMap<string, FinishedRunEvent>;
    readonly enumerations: ReadonlyMap<
      string,
      Extract<LedgerEventV1, { type: "enumeration-recorded" }>
    >;
    readonly trialByRun: ReadonlyMap<string, string>;
    readonly candidateRuns: ReadonlySet<string>;
  },
): AttemptOutcomes {
  const counts = {
    completed: 0,
    completedWithoutCandidate: 0,
    incomplete: 0,
    incompleteByReason: Object.create(null) as Record<string, number>,
    providerLimited: 0,
    unfinished: 0,
  };
  const runsOfTrial = new Map<string, string[]>();
  for (const [runId, trialId] of runs.trialByRun)
    (runsOfTrial.get(trialId) ??
      runsOfTrial.set(trialId, []).get(trialId))!.push(runId);
  const reachedCandidate = (trialId: string) =>
    (runsOfTrial.get(trialId) ?? [trialId]).some((runId) =>
      runs.candidateRuns.has(runId),
    );
  const incomplete = (
    finish: FinishedRunEvent | undefined,
    reason?: string,
  ) => {
    counts.incomplete++;
    const key =
      reason ??
      (finish?.reason === undefined
        ? "unrecorded"
        : finish.reasonDetail === undefined
          ? finish.reason
          : `${finish.reason}/${finish.reasonDetail}`);
    counts.incompleteByReason[key] = (counts.incompleteByReason[key] ?? 0) + 1;
  };
  const completed = (trialId: string) => {
    counts.completed++;
    if (!reachedCandidate(trialId)) counts.completedWithoutCandidate++;
  };
  for (const runId of attempts) {
    const trialId = runs.trialByRun.get(runId) ?? runId;
    if (runs.runKinds.get(runId) === "enumerate") {
      const enumeration = runs.enumerations.get(trialId);
      if (enumeration?.accepted === false) {
        incomplete(undefined, "schema/enumeration-rejected");
        continue;
      }
      const enumerates = (runsOfTrial.get(trialId) ?? []).filter(
        (id) => runs.runKinds.get(id) === "enumerate",
      );
      const latest = runs.finishedRuns.get(enumerates.at(-1) ?? runId);
      if (latest === undefined) {
        counts.unfinished++;
        continue;
      }
      if (latest.outcome === "provider-limited") {
        counts.providerLimited++;
        continue;
      }
      if (latest.outcome !== "completed") {
        incomplete(latest);
        continue;
      }
      if (enumeration === undefined) {
        counts.unfinished++;
        continue;
      }
      const traces = (runsOfTrial.get(trialId) ?? []).flatMap((id) => {
        const finish = runs.finishedRuns.get(id);
        return runs.runKinds.get(id) === "trace" && finish !== undefined
          ? [finish]
          : [];
      });
      if (traces.some((finish) => finish.outcome === "completed"))
        completed(trialId);
      else if (traces.length === 0) counts.unfinished++;
      else if (traces.some((finish) => finish.outcome === "provider-limited"))
        counts.providerLimited++;
      else incomplete(traces[0]);
      continue;
    }
    let latestRun = runId;
    const seen = new Set<string>();
    while (runs.resumedBy.has(latestRun) && !seen.has(latestRun)) {
      seen.add(latestRun);
      latestRun = runs.resumedBy.get(latestRun)!;
    }
    const finish = runs.finishedRuns.get(latestRun);
    if (finish === undefined) counts.unfinished++;
    else if (finish.outcome === "completed") completed(trialId);
    else if (finish.outcome === "provider-limited") counts.providerLimited++;
    else incomplete(finish);
  }
  return { ...counts, incompleteByReason: { ...counts.incompleteByReason } };
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
  readonly submittedExternally: number;
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

/**
 * Each discovery attempt by how its Trial ended (ADR 0033 / 0042): a
 * completed attempt that reached no candidate is a genuine zero; an
 * incomplete one is not, and carries its reason. A partitioned Trial is
 * incomplete when its enumeration was rejected or no tracer completed.
 */
type AttemptOutcomes = {
  readonly completed: number;
  readonly completedWithoutCandidate: number;
  readonly incomplete: number;
  /** `reason` or `reason/reasonDetail` of each incomplete attempt. */
  readonly incompleteByReason: Readonly<Record<string, number>>;
  readonly providerLimited: number;
  /** Attempts whose latest run has no finish. */
  readonly unfinished: number;
};

export type CampaignFunnel = FunnelCounts & {
  readonly campaignId: string;
  /** In-scope Findings with no plugin-side group key, after a loaded legacy cache. */
  readonly unkeyedFindings: number;
  readonly discoveryAttempts: number;
  readonly attemptOutcomes: AttemptOutcomes;
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
  /** #698: externally submitted Findings by their latest recorded outcome. */
  readonly externalOutcomes: {
    readonly byOutcome: Readonly<
      Record<(typeof EXTERNAL_OUTCOMES)[number] | "none", number>
    >;
    readonly byReason: Readonly<Record<string, number>>;
  };
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
    submittedExternally: 0,
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
  readonly #findingGroupKeyCache: ReadonlyMap<string, readonly string[]>;

  constructor(options: {
    readonly databasePath: string;
    readonly artifactStore: PrivateArtifactStore;
    /** Open an existing ledger without initialization or append capability. */
    readonly readOnly?: boolean;
    /** Digest-only projection of legacy Finding keys from Private Evidence. */
    readonly findingGroupKeyCache?: ReadonlyMap<string, readonly string[]>;
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
    this.#findingGroupKeyCache = options.findingGroupKeyCache ?? new Map();
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

  /** Read a current event's keys or a versioned cache entry for an old event. */
  findingGroupKeyDigests(
    event: Extract<LedgerEventV1, { type: "finding-recorded" }>,
  ): readonly string[] {
    if (event.group !== undefined) return event.group.keys;
    const artifact = event.artifacts.find((ref) => ref.kind === "finding");
    return artifact === undefined
      ? []
      : (this.#findingGroupKeyCache.get(artifact.digest) ?? []);
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
    const runKinds = new Map<
      string,
      "explore" | "continue" | "child" | "enumerate" | "trace"
    >();
    /** Resume segments continue an earlier run's Trial; they are not new attempts (ADR 0036). */
    const resumeSegments = new Set<string>();
    /** A send-back continues the enumerate run's attempt (ADR 0042). */
    const resubmitRuns = new Set<string>();
    const resumedBy = new Map<string, string>();
    const finishedRuns = new Map<
      string,
      Extract<LedgerEventV1, { type: "discovery-run-finished" }>
    >();
    const enumerations = new Map<
      string,
      Extract<LedgerEventV1, { type: "enumeration-recorded" }>
    >();
    /** Runs that reached at least one candidate, normalized or held. */
    const candidateRuns = new Set<string>();
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
    const externalSubmissions = new Map<string, string>();
    const latestExternalOutcome = new Map<
      string,
      Extract<LedgerEventV1, { type: "submission-outcome-recorded" }>
    >();
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
          if (current.resumesRun !== undefined) {
            resumeSegments.add(current.runId);
            resumedBy.set(current.resumesRun, current.runId);
          }
          if (
            current.runKind === "enumerate" &&
            (current.configuration.role?.resubmit ?? 0) > 0
          )
            resubmitRuns.add(current.runId);
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
          finishedRuns.set(current.runId, current);
          break;
        case "enumeration-recorded":
          enumerations.set(current.trialId, current);
          break;
        case "candidate-normalized":
        case "candidate-held":
        case "candidate-rejected": {
          const boundary = `${current.runId}\0${current.candidateKind}`;
          const key = `${boundary}\0${current.candidateIndex}`;
          candidateKeys.add(key);
          if (current.type !== "candidate-rejected")
            candidateRuns.add(current.runId);
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
          if (current.derivationKind !== "fixed-version-control")
            candidateRuns.add(current.runId);
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
          candidateRuns.add(current.runId);
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
        case "submission-recorded-externally":
          externalSubmissions.set(current.findingId, current.snapshotDigest);
          break;
        case "submission-outcome-recorded":
          latestExternalOutcome.set(current.findingId, current);
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
    let unkeyedFindings = 0;
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
      if (this.findingGroupKeyDigests(finding).length === 0) unkeyedFindings++;
      const category = (byCategory[finding.category] ??= emptyCounts());
      for (const count of [totals, category, objective(finding.runId)]) {
        count.accepted++;
        count.raw++;
        const external =
          externalSubmissions.get(finding.findingId) === finding.snapshotDigest;
        if (external) {
          count.submitted++;
          count.submittedExternally++;
        }
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
        if (!external) count.submitted++;
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
    const externalOutcomes = {
      byOutcome: {
        accepted: 0,
        rejected: 0,
        duplicate: 0,
        "out-of-scope": 0,
        none: 0,
      },
      byReason: Object.create(null) as Record<string, number>,
    };
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
      if (parkedFindings.has(finding.findingId)) continue;
      if (externalSubmissions.get(finding.findingId) !== finding.snapshotDigest)
        continue;
      const latest = latestExternalOutcome.get(finding.findingId);
      if (latest?.snapshotDigest !== finding.snapshotDigest) {
        externalOutcomes.byOutcome.none++;
        continue;
      }
      externalOutcomes.byOutcome[latest.outcome]++;
      if (latest.reasonCode !== undefined)
        externalOutcomes.byReason[latest.reasonCode] =
          (externalOutcomes.byReason[latest.reasonCode] ?? 0) + 1;
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
    const attempts = [...startedRuns.entries()]
      .filter(
        ([runId, labId]) =>
          // ADR 0042: a partitioned Trial's attempt is its enumerate run; its
          // send-backs and tracer runs belong to that attempt, as children
          // do to a Root.
          runKinds.get(runId) !== "child" &&
          runKinds.get(runId) !== "trace" &&
          !resubmitRuns.has(runId) &&
          !resumeSegments.has(runId) &&
          (labByRun.get(runId) === "none" ||
            (labId !== undefined && readyLabs.has(labId))) &&
          !setupFailedRuns.has(runId),
      )
      .map(([runId]) => runId);
    const discoveryAttempts = attempts.length;
    const attemptOutcomes = classifyAttempts(attempts, {
      runKinds,
      resumedBy,
      finishedRuns,
      enumerations,
      trialByRun,
      candidateRuns,
    });
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
    const submittedFindingIds = [
      ...submittedFindingsByCandidate.values(),
      ...[...externalSubmissions]
        .filter(
          ([findingId, snapshotDigest]) =>
            !submissions.has(findingId) &&
            findings.get(findingId)?.snapshotDigest === snapshotDigest,
        )
        .map(([findingId]) => findingId),
    ];
    const humanByCategory = Object.fromEntries(
      Object.keys(byCategory).map((category) => {
        const inCategory = (findingId: string) =>
          findings.get(findingId)?.category === category;
        const submissionCount = submittedFindingIds.filter(inCategory).length;
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
      unkeyedFindings,
      discoveryAttempts,
      attemptOutcomes,
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
      externalOutcomes,
      ownerMinutesPerSubmission:
        submittedFindingIds.length === 0 || humanEffortEvents.length === 0
          ? null
          : Object.values(humanMinutesByAction).reduce(
              (sum, minutes) => sum + minutes,
              0,
            ) / submittedFindingIds.length,
      openedFindingsPerSubmission:
        submittedFindingIds.length === 0 ||
        !humanEffortEvents.some((event) => event.action === "read")
          ? null
          : openedFindings.size / submittedFindingIds.length,
      manualReproductionAgreement: agreement([...manualReproductions.values()]),
      humanMinutesByAction,
      humanByCategory,
      byCategory,
      byArm: { ...byArm },
      byObjective: { ...byObjective },
    };
  }
}
