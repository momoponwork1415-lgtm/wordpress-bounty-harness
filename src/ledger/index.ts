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
  }),
  event({
    /** Bind a campaign to one immutable automatic selection before its first target. */
    type: z.literal("selection-batch-bound"),
    selectionBatchId: id,
    policyDigest: digest,
    selectionIds: z.array(id).min(1).max(5),
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
    labId: id,
    trialId: id.optional(),
    trialOrdinal: z.number().int().nonnegative().optional(),
    stage: z.enum(["screening", "deep-dive"]).optional(),
    runKind: z.enum(["explore", "continue", "child"]).optional(),
    continuationOf: id.optional(),
    parentRunId: id.optional(),
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
      assignmentUnit: id,
      entryIndex: z
        .union([
          z.strictObject({ enabled: z.literal(true), digest }),
          z.strictObject({ enabled: z.literal(false) }),
        ])
        .optional(),
      agentPath: id.optional(),
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
      .enum(["provider", "schema", "sandbox", "policy", "evidence"])
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
    childThreadsAdmitted: z.number().int().nonnegative().max(3).optional(),
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
    /** Provider-reported tokens; absent when the transport returned no receipt. */
    usage: z
      .strictObject({
        inputTokens: tokens,
        cachedInputTokens: tokens,
        outputTokens: tokens,
        reasoningOutputTokens: tokens,
      })
      .optional(),
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
    ]),
  }),
  /**
   * A target was left behind by an error. Before a snapshot exists, the
   * snapshot digest is the digest of the selection record.
   */
  event({
    type: z.literal("target-skipped"),
    selectionId: id,
    stage: z.enum(["freeze", "discovery", "verification"]),
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
    impact: id.optional(),
    primitive: id.optional(),
    missingEdge: id.optional(),
  }),
  event({
    type: z.literal("finding-recorded"),
    findingId: id,
    runId: id,
    category: id,
    continuationOrdinal: z.number().int().nonnegative().optional(),
    historyRecordId: id.optional(),
    /** A fresh-snapshot hypothesis derived from an earlier Finding. */
    derivedFromFindingId: id.optional(),
    derivationKind: z
      .enum(["latest-version", "fixed-version-control"])
      .optional(),
  }),
  /** A Finding whose impact lies outside the Programme Boundary; kept, never verified (#185). */
  event({
    type: z.literal("finding-parked"),
    findingId: id,
    runId: id,
    category: id,
    reason: z.literal("outside-programme-boundary"),
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
    canaryIssued: z.enum(["execution", "script", "principal"]).optional(),
  }),
  event({
    type: z.literal("verification-finished"),
    verificationId: id,
    findingId: id,
    labSetupDigest: digest,
    /** Present for a version comparison using a Finding bound to this snapshot. */
    basis: z
      .strictObject({
        kind: z.enum(["latest-version", "fixed-version"]),
        findingSnapshotDigest: digest,
      })
      .optional(),
    result: verificationResultV1Schema,
    evidenceCapture: z.enum(["harness-captured", "agent-authored"]).optional(),
  }),
  event({
    type: z.literal("review-decided"),
    findingId: id,
    decision: z.enum(["accept", "reject", "defer"]),
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
]);

export type LedgerEventV1 = z.infer<typeof ledgerEventV1Schema>;
export type LedgerEventInput = z.input<typeof ledgerEventV1Schema>;
export type LedgerReadQuery = {
  readonly campaignId?: string;
  readonly type?: LedgerEventV1["type"];
  readonly findingId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
};
export type LedgerRecord = {
  readonly sequence: number;
  readonly event: LedgerEventV1;
};
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
  readonly runCount: number;
  readonly knownCostUsd: number;
  readonly unpricedRuns: number;
  readonly wallTimeMs: number;
  readonly noncachedInputTokens: number;
  readonly unavailableInputRuns: number;
  readonly confirmedPerMillionInputTokens: number | null;
  readonly confirmedPerAgentWallHour: number | null;
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
    .enum([
      "target-selected",
      "selection-batch-bound",
      "snapshot-frozen",
      "lab-provisioned",
      "discovery-run-started",
      "discovery-run-finished",
      "discovery-concluded",
      "campaign-stopped",
      "target-skipped",
      "candidate-rejected",
      "candidate-normalized",
      "candidate-held",
      "finding-recorded",
      "finding-parked",
      "lead-recorded",
      "child-report-recovered",
      "discovery-report-recovered",
      "verifier-run-finished",
      "verification-finished",
      "review-decided",
      "scope-assessed",
      "draft-saved",
      "external-action-authorized",
      "submission-recorded",
      "submission-outcome",
      "human-effort-recorded",
      "human-reproduction-recorded",
    ])
    .optional(),
  findingId: id.optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

const storedRow = z.strictObject({
  sequence: z.number().int().positive(),
  identity: z.string(),
  input_digest: digest,
  event_json: z.string(),
});

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

  constructor(options: {
    readonly databasePath: string;
    readonly artifactStore: PrivateArtifactStore;
  }) {
    this.#db = new DatabaseSync(options.databasePath);
    this.#artifacts = options.artifactStore;
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
    if (prior !== undefined) {
      return {
        status:
          storedRow.parse(prior).input_digest === inputDigest
            ? "existing"
            : "conflict",
      };
    }
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
        const status =
          storedRow.parse(existing).input_digest === inputDigest
            ? "existing"
            : "conflict";
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

  funnel(campaignId: string): CampaignFunnel {
    const campaign = id.parse(campaignId);
    const rows = this.#db
      .prepare(
        "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE campaign_id = ? ORDER BY sequence",
      )
      .all(campaign);
    const events = rows.map((row) =>
      ledgerEventV1Schema.parse(
        JSON.parse(storedRow.parse(row).event_json) as unknown,
      ),
    );
    const readyLabs = new Set<string>();
    const startedRuns = new Map<string, string>();
    const runKinds = new Map<string, "explore" | "continue" | "child">();
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
          runKinds.set(current.runId, current.runKind ?? "explore");
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
        case "finding-parked":
          if (!parkedFindings.has(current.findingId))
            parkedFindings.set(current.findingId, current);
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

    const inScopeByProgramme: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    for (const finding of findings.values()) {
      if (finding.derivationKind === "fixed-version-control") continue;
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
    for (const runId of startedRuns.keys()) objective(runId).runs++;
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
    const discoveryAttempts = [...startedRuns.entries()].filter(
      ([runId, labId]) =>
        runKinds.get(runId) !== "child" &&
        readyLabs.has(labId) &&
        !setupFailedRuns.has(runId),
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
