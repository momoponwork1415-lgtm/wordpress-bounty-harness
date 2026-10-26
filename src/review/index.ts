import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  readFindingGroups,
  type FindingGroup,
} from "../ledger/finding-groups.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import {
  countAttemptsForReason,
  shouldAutomaticallyRetryVerification,
} from "../verification/retry-budget.js";
import {
  currentReviewDecision,
  readDecisionHistory,
  type DecisionHistoryEntry,
} from "./decision-history.js";
import { currentManualObservation } from "./manual-observation.js";
import { openReproductionPackage } from "./reproduction-package.js";
import {
  submissionBasis,
  type BasisAnswer,
  type BasisUse,
  type SubmissionBasis,
} from "./submission-basis.js";

export {
  currentManualObservation,
  currentObservationVerification,
  MANUAL_LAB_RECEIPT_FILE,
  MANUAL_OBSERVATION_EVIDENCE_FILE,
  manualObservationEvidenceStatus,
  recordManualObservation,
  recordManualObservationLabReady,
} from "./manual-observation.js";

export type {
  BasisAnswer,
  BasisMissingReason,
  BasisUse,
  SubmissionBasis,
} from "./submission-basis.js";

export {
  exportReviewBundle,
  REVIEW_EXPORT_SCHEMA_ID,
  reviewExportV1Schema,
  stateDiffSummarySchema,
  type HttpEvidenceReader,
  type HttpEvidenceRecord,
  type ReviewExportV1,
  type StateDiffReader,
  type StateDiffSummary,
  type VerifierRecord,
  type VerifierRecordReader,
} from "./export.js";
export {
  exportReviewBundleV2,
  REVIEW_EXPORT_V2_SCHEMA_ID,
  reviewExportV2Schema,
  type ReviewExportV2,
} from "./manual-observation-export.js";

import {
  assessmentSchema,
  authorizationSchema,
  DEDUPE_NOTE_FILE,
  decisionRefSchema,
  digest,
  draftSchema,
  duplicateSchema,
  id,
  readReviewRecord,
  refSchema,
  REVIEW_RECORD_FILE,
  reviewDecisionV1Schema,
  scopeStatus,
  type DuplicateCheck,
  type ReviewDecisionRef,
  type ReviewDecisionV1,
  type ReviewRecordByKind,
  type ReviewRecordKind,
  type ReviewRef,
  type ScopeAssessment,
  type SubmissionDraft,
} from "./records.js";

export {
  DEDUPE_NOTE_FILE,
  readReviewRecord,
  REVIEW_RECORD_FILE,
  REVIEW_RECORD_MAX_BYTES,
  type DuplicateCheck,
  type ReviewDecisionRef,
  type ReviewDecisionV1,
  type ReviewRecordByKind,
  type ReviewRecordKind,
  type ReviewRecordRead,
  type ReviewRef,
  type ScopeAssessment,
} from "./records.js";

const scopeResult = z.strictObject({
  programmeId: id,
  status: scopeStatus.exclude(["incomplete"]),
  destination: id,
  reason: z.string().min(1).max(2000),
});
const MISSING_BASIS = "A matching evidence-backed verification is required";
const nonHumanActors = new Set(["ai", "agent", "automation", "system"]);
const humanActor = id
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && !nonHumanActors.has(value.toLowerCase()),
    "A named human actor is required",
  );

type Decision = ReviewDecisionV1["decision"];
type DecisionInput = {
  /** Without a verification ID, the Finding must be listed as `not-verified` (#436). */
  readonly ref: ReviewDecisionRef;
  readonly decision: Decision;
  readonly reasonCode: string;
  readonly openedEvidence: readonly string[];
  /** The wbh-dedupe result (#442); absent, the decision keeps the one in force. */
  readonly duplicate?: DuplicateResult;
  /** The skill's note behind that result; Review files it in Private Evidence. */
  readonly duplicateNote?: string;
  readonly decidedBy: string;
  /** Seconds the human spent, reported by the skill or CLI caller (ADR 0032 Q22). */
  readonly humanElapsedSeconds?: number;
};
type HumanEffortInput = {
  readonly campaignId?: string;
  readonly findingId?: string;
  readonly candidateId?: string;
  readonly action: "read" | "reproduce" | "submit" | "outcome";
  readonly minutes: number;
};
type HumanReproductionInput = {
  readonly ref: ReviewRef;
  readonly result: "match" | "mismatch" | "unavailable";
};
type HumanRecord = Extract<
  LedgerEventV1,
  { type: "human-effort-recorded" | "human-reproduction-recorded" }
>;
type PreparedDecision = {
  readonly record: ReviewDecisionV1;
  readonly duplicateNote?: string;
};
const humanMinutesSchema = z.number().finite().nonnegative().max(1440);
const duplicateNoteSchema = z.string().min(1).max(100_000);
export type ReviewItem = (
  | {
      readonly status: "runtime-confirmed" | "reproduced";
      readonly ref: ReviewRef;
      readonly category: string;
      readonly judgeId: string;
      /** What the judge itself observed (roles, configuration). */
      readonly conditions: Readonly<Record<string, string>>;
      readonly evidenceDigest: string;
      readonly reproductionPackageDigest: string;
      readonly decision: Decision | null;
    }
  | {
      /** In-scope Findings reach a human whatever the judge said (ADR 0031, #185). */
      readonly status: "contradicted";
      readonly ref: ReviewRef;
      readonly category: string;
      readonly judgeId: string;
      readonly evidenceDigest: string;
      readonly refutationDigest: string | null;
      readonly decision: Decision | null;
    }
  | {
      readonly status: "incomplete";
      readonly ref: ReviewRef;
      readonly category: string;
      readonly reason: string;
      readonly nextStep: string;
      readonly decision: Decision | null;
      /** A human's current Lab result is independent of the judge status. */
      readonly manualObservation?: {
        readonly result: "match" | "mismatch" | "unavailable";
        readonly recordedAt: string;
        readonly evidenceDigest: string;
        readonly sessionReceiptDigest: string;
      };
    }
  | {
      /** #436: no verification yet, so a decision can come before any Lab (ADR 0038 段 1). */
      readonly status: "not-verified";
      readonly ref: ReviewDecisionRef;
      readonly category: string;
      readonly decision: Decision | null;
    }
) & {
  /** #424: the overlap group; it orders the queue, while decisions stay per Finding. */
  readonly group: FindingGroup;
};
export type ReviewQueue = {
  readonly items: readonly ReviewItem[];
  readonly contradicted: number;
  readonly unverified: number;
  /** Latest `incomplete` per Finding whose ADR 0022 budget the runner will not retry on its own. */
  readonly incompleteByReason: Readonly<Record<string, number>>;
  /** Latest `incomplete` per Finding the runner still retries on the same Lab Setup and prompt version. */
  readonly retryPendingByReason: Readonly<Record<string, number>>;
  readonly preconditionClassCounts: Readonly<Record<string, number>>;
};
export type SubmissionDraftRef = Omit<SubmissionDraft, "content">;
export type ReviewView = {
  readonly verificationStatus:
    | "runtime-confirmed"
    | "reproduced"
    | "contradicted"
    | "incomplete"
    | "missing";
  readonly scopeAssessments: readonly ScopeAssessment[];
  readonly drafts: readonly SubmissionDraftRef[];
  readonly privateEvidenceDigests: readonly string[];
  readonly reproductionPackageDigest: string | null;
};
export type ExternalActionAdmission =
  | { readonly status: "authorized"; readonly authorizationId: string }
  | {
      readonly status: "not-authorized";
      readonly reason:
        | "candidate-or-draft-not-found"
        | "exact-authorization-required"
        | "superseded-draft"
        | "human-reviewed-draft-required"
        | "manual-reproduction-required"
        | "human-accept-required"
        | "stale-verification";
    };
export type DuplicateLookupResult =
  | { readonly status: "unavailable" | "no-match" }
  | { readonly status: "possible-match"; readonly reference: string };
/** What `review decide --duplicate` records from wbh-dedupe (#442): an `unavailable` may say why. */
export type DuplicateResult =
  | DuplicateLookupResult
  | { readonly status: "unavailable"; readonly reason: string };

export interface ProgrammeScopeEvaluator<TFacts = unknown> {
  readonly programmeIds: readonly string[];
  readonly policyDigest: string;
  assess(input: {
    readonly ref: ReviewRef;
    readonly facts: TFacts;
  }): Promise<readonly z.infer<typeof scopeResult>[]>;
}

/** Reads the Harness-owned records behind the basis; discovery claims are never scope facts. */
export interface ScopeFactsProvider<TFacts> {
  load(input: {
    readonly ref: ReviewRef;
    /** Review's `scope` basis for `ref` (`submissionBasis`); never built by the caller. */
    readonly basis: SubmissionBasis;
  }): Promise<TFacts>;
}

/** The #12 Wordfence history DB plugs in here; review never imports its storage. */
export interface DuplicateLookup {
  inspect(input: {
    readonly campaignId: string;
    readonly findingId: string;
  }): Promise<DuplicateLookupResult>;
}

export class Review<TFacts = unknown> {
  readonly #ledger: Ledger;
  readonly #store: PrivateArtifactStore;
  readonly #scopeEvaluator: ProgrammeScopeEvaluator<TFacts>;
  readonly #factsProvider: ScopeFactsProvider<TFacts>;
  readonly #duplicateLookup: DuplicateLookup | undefined;
  readonly #clock: () => Date;

  constructor(options: {
    readonly ledger: Ledger;
    readonly artifactStore: PrivateArtifactStore;
    readonly scopeEvaluator: ProgrammeScopeEvaluator<TFacts>;
    readonly factsProvider: ScopeFactsProvider<TFacts>;
    readonly duplicateLookup?: DuplicateLookup;
    readonly clock?: () => Date;
  }) {
    this.#ledger = options.ledger;
    this.#store = options.artifactStore;
    this.#scopeEvaluator = options.scopeEvaluator;
    this.#factsProvider = options.factsProvider;
    this.#duplicateLookup = options.duplicateLookup;
    this.#clock = options.clock ?? (() => new Date());
    const identities = z
      .array(id)
      .min(1)
      .parse([...options.scopeEvaluator.programmeIds]);
    if (new Set(identities).size !== identities.length)
      throw new Error("Programme identities must be unique");
    digest.parse(options.scopeEvaluator.policyDigest);
  }

  /** Every verified Finding inside the Programme Boundary reaches a human, `contradicted` included. */
  queue(input: { readonly campaignId?: string } = {}): ReviewQueue {
    const campaignId =
      input.campaignId === undefined ? undefined : id.parse(input.campaignId);
    const key = (event: { campaignId: string; findingId: string }) =>
      `${event.campaignId}\u0000${event.findingId}`;
    const inCampaign = (event: LedgerEventV1) =>
      campaignId === undefined || event.campaignId === campaignId;
    type FinishedVerification = Extract<
      LedgerEventV1,
      { type: "verification-finished" }
    >;
    const latestVerification = new Map<
      string,
      { sequence: number; event: FinishedVerification }
    >();
    const verificationHistory = new Map<string, FinishedVerification[]>();
    for (const { sequence, event } of this.#ledger.readAll({
      type: "verification-finished",
    }))
      if (event.type === "verification-finished" && inCampaign(event)) {
        latestVerification.set(key(event), { sequence, event });
        const history = verificationHistory.get(key(event)) ?? [];
        history.push(event);
        verificationHistory.set(key(event), history);
      }
    const decisionHistory = new Map<string, DecisionHistoryEntry[]>();
    for (const entry of readDecisionHistory(
      this.#ledger,
      campaignId === undefined ? {} : { campaignId },
    )) {
      const history = decisionHistory.get(key(entry.event)) ?? [];
      history.push(entry);
      decisionHistory.set(key(entry.event), history);
    }

    const items: ReviewItem[] = [];
    const parkedEvents = new Map<
      string,
      Extract<LedgerEventV1, { type: "finding-parked" }>
    >();
    for (const event of this.#ledger.activeParked(
      campaignId === undefined ? {} : { campaignId },
    ))
      if (inCampaign(event)) parkedEvents.set(key(event), event);
    const parked = new Set(parkedEvents.keys());
    const latestPreconditionClass = new Map<string, string>();
    for (const { event } of this.#ledger.readAll({
      type: "finding-precondition-classified",
    }))
      if (event.type === "finding-precondition-classified" && inCampaign(event))
        latestPreconditionClass.set(key(event), event.preconditionClass);
    const preconditionClassCounts: Record<string, number> = {
      default: 0,
      "common-usage": 0,
      "admin-configuration": 0,
      unknown: 0,
    };
    for (const event of parkedEvents.values()) {
      const classification =
        latestPreconditionClass.get(key(event)) ??
        event.preconditionClass ??
        "unknown";
      preconditionClassCounts[classification] =
        (preconditionClassCounts[classification] ?? 0) + 1;
    }
    const incompleteByReason: Record<string, number> = Object.create(null);
    const retryPendingByReason: Record<string, number> = Object.create(null);
    const groups = readFindingGroups(
      this.#ledger,
      campaignId === undefined ? {} : { campaignId },
    );
    let contradicted = 0;
    let unverified = 0;
    for (const { event: finding } of this.#ledger.readAll({
      type: "finding-recorded",
    })) {
      if (finding.type !== "finding-recorded" || !inCampaign(finding)) continue;
      if (finding.derivationKind === "fixed-version-control") continue;
      if (parked.has(key(finding))) continue;
      const classification =
        latestPreconditionClass.get(key(finding)) ??
        finding.preconditionClass ??
        "unknown";
      preconditionClassCounts[classification] =
        (preconditionClassCounts[classification] ?? 0) + 1;
      const verified = latestVerification.get(key(finding));
      const group = groups.of(finding.campaignId, finding.findingId);
      const decisions = decisionHistory.get(key(finding)) ?? [];
      if (verified === undefined) {
        unverified++;
        items.push({
          status: "not-verified",
          ref: {
            campaignId: finding.campaignId,
            findingId: finding.findingId,
            snapshotDigest: finding.snapshotDigest,
          },
          category: finding.category,
          decision: currentReviewDecision(decisions, finding)?.decision ?? null,
          group,
        });
        continue;
      }
      const { event, sequence } = verified;
      const ref = {
        campaignId: event.campaignId,
        findingId: event.findingId,
        verificationId: event.verificationId,
        snapshotDigest: event.snapshotDigest,
      };
      const decision =
        currentReviewDecision(decisions, ref, sequence)?.decision ?? null;
      const result = event.result;
      if (result.status === "contradicted") {
        contradicted++;
        items.push({
          status: result.status,
          ref,
          category: finding.category,
          judgeId: result.judgeId,
          evidenceDigest: result.evidenceDigest,
          refutationDigest: result.refutationDigest ?? null,
          decision,
          group,
        });
      } else if (
        result.status === "runtime-confirmed" ||
        result.status === "reproduced"
      )
        items.push({
          status: result.status,
          ref,
          category: finding.category,
          judgeId:
            result.status === "runtime-confirmed"
              ? result.judgeId
              : result.reproducerId,
          conditions: result.conditions,
          evidenceDigest: result.evidenceDigest,
          reproductionPackageDigest: result.reproductionPackageDigest,
          decision,
          group,
        });
      else {
        // The queue predicts the runner's next pass with nothing changed: same
        // Lab Setup, same prompt version.
        const pending = shouldAutomaticallyRetryVerification({
          reason: result.reason,
          attemptsForReason: countAttemptsForReason(
            verificationHistory.get(key(event)) ?? [],
            {
              labSetupDigest: event.labSetupDigest,
              promptVersion: event.promptVersion,
              reason: result.reason,
            },
          ),
          sameLabSetup: true,
        });
        const counts = pending ? retryPendingByReason : incompleteByReason;
        counts[result.reason] = (counts[result.reason] ?? 0) + 1;
        const manual =
          result.reason === "observation" ||
          result.reason === "awaiting-human-observation"
            ? currentManualObservation(this.#ledger, ref)
            : null;
        items.push({
          status: result.status,
          ref,
          category: finding.category,
          reason: result.reason,
          nextStep: result.nextStep,
          decision,
          ...(manual === null
            ? {}
            : {
                manualObservation: {
                  result: manual.result,
                  recordedAt: manual.occurredAt,
                  evidenceDigest: manual.evidenceDigest,
                  sessionReceiptDigest: manual.sessionReceiptDigest,
                },
              }),
          group,
        });
      }
    }
    return {
      items: groups.order(items, (item) => item.ref),
      contradicted,
      unverified,
      incompleteByReason,
      retryPendingByReason,
      preconditionClassCounts,
    };
  }

  /**
   * One human review operation. Validate all records before the first write;
   * keep the reproduction, its time, the decision and reading time in order.
   * This is not a transaction spanning SQLite and Private Evidence: an I/O
   * failure can still interrupt an already validated operation.
   */
  async recordDecision(
    input: Omit<DecisionInput, "humanElapsedSeconds"> & {
      readonly minutes?: number;
      readonly reproduction?: {
        readonly result: HumanReproductionInput["result"];
        readonly minutes?: number;
      };
    },
  ): Promise<ReviewDecisionV1> {
    const decidedBy =
      input.minutes !== undefined || input.reproduction !== undefined
        ? humanActor.parse(input.decidedBy)
        : input.decidedBy;
    const minutes = humanMinutesSchema.optional().parse(input.minutes);
    const reproduction =
      input.reproduction === undefined
        ? undefined
        : this.#prepareHumanReproduction({
            ref: refSchema.parse(input.ref),
            result: input.reproduction.result,
          });
    const reproductionEffort =
      input.reproduction?.minutes === undefined
        ? undefined
        : this.#prepareHumanEffort({
            campaignId: input.ref.campaignId,
            findingId: input.ref.findingId,
            action: "reproduce",
            minutes: input.reproduction.minutes,
          });
    const decision = await this.#prepareDecision({
      ...input,
      decidedBy,
      ...(minutes === undefined
        ? {}
        : { humanElapsedSeconds: Math.round(minutes * 60) }),
    });
    const readEffort =
      minutes === undefined
        ? undefined
        : this.#prepareHumanEffort({
            campaignId: decision.record.ref.campaignId,
            findingId: decision.record.ref.findingId,
            action: "read",
            minutes,
          });
    if (reproduction !== undefined) await this.#recordHumanEvent(reproduction);
    if (reproductionEffort !== undefined)
      await this.#recordHumanEvent(reproductionEffort);
    const recorded = await this.#persistDecision(decision);
    if (readEffort !== undefined) await this.#recordHumanEvent(readEffort);
    return recorded;
  }

  async decide(input: DecisionInput): Promise<ReviewDecisionV1> {
    return this.#persistDecision(await this.#prepareDecision(input));
  }

  async #prepareDecision(input: DecisionInput): Promise<PreparedDecision> {
    const ref = decisionRefSchema.parse(input.ref);
    if (input.duplicateNote !== undefined && input.duplicate === undefined)
      throw new Error("A dedupe note needs the result it supports");
    const { status, since } =
      ref.verificationId === undefined
        ? this.#unverifiedItem(ref)
        : this.#verificationItem({
            ...ref,
            verificationId: ref.verificationId,
          });
    const duplicateNote = duplicateNoteSchema
      .optional()
      .parse(input.duplicateNote);
    const trace = this.#traceOf(ref.campaignId, ref.findingId);
    const decidedAt = this.#clock();
    // A later decision (e.g. the one carrying `--reproduced`) must not erase stage 4.
    const duplicate: DuplicateCheck =
      input.duplicate === undefined
        ? ((await this.duplicateOf(ref)) ?? { status: "unavailable" })
        : duplicateSchema.parse({
            ...input.duplicate,
            checkedAt: decidedAt.toISOString(),
          });
    const record = reviewDecisionV1Schema.parse({
      schemaVersion: 1,
      ref,
      verificationStatus: status,
      decision: input.decision,
      reasonCode: input.reasonCode,
      duplicate,
      openedEvidence: [...input.openedEvidence],
      decidedBy: input.decidedBy,
      decidedAt: decidedAt.toISOString(),
      elapsedMs: Math.max(0, decidedAt.getTime() - Date.parse(since)),
      ...(input.humanElapsedSeconds === undefined
        ? {}
        : { humanElapsedSeconds: input.humanElapsedSeconds }),
      ...(trace === undefined ? {} : { trace }),
    });
    return {
      record,
      ...(duplicateNote === undefined ? {} : { duplicateNote }),
    };
  }

  async #persistDecision(
    prepared: PreparedDecision,
  ): Promise<ReviewDecisionV1> {
    const record =
      prepared.duplicateNote === undefined
        ? prepared.record
        : {
            ...prepared.record,
            duplicate: {
              ...prepared.record.duplicate,
              note: await this.#store.putFiles({
                [DEDUPE_NOTE_FILE]: prepared.duplicateNote,
              }),
            },
          };
    const { ref, trace, duplicate } = record;
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `review:${canonicalDigest(record)}`,
      campaignId: ref.campaignId,
      snapshotDigest: ref.snapshotDigest,
      occurredAt: record.decidedAt,
      type: "review-decided",
      findingId: ref.findingId,
      decision: record.decision,
      ...(ref.verificationId === undefined
        ? {}
        : { verificationId: ref.verificationId }),
      ...(record.humanElapsedSeconds === undefined
        ? {}
        : { humanElapsedSeconds: record.humanElapsedSeconds }),
      ...(trace?.runId === undefined ? {} : { runId: trace.runId }),
      ...(trace?.promptDigest === undefined
        ? {}
        : { promptDigest: trace.promptDigest }),
      artifacts: [
        { kind: "review-decision", digest: artifactDigest },
        ...(duplicate.note === undefined
          ? []
          : [{ kind: "dedupe-note", digest: duplicate.note }]),
      ],
    });
    if (appended.status === "conflict")
      throw new Error("Review decision ledger conflict");
    return record;
  }

  /** The recorded verification a decision names; an unfinished one only while it is the current item. */
  #verificationItem(ref: ReviewRef): {
    readonly status: ReviewDecisionV1["verificationStatus"];
    readonly since: string;
  } {
    const verification = this.#ledger
      .readAll({ type: "verification-finished" })
      .find(
        ({ event }) =>
          event.type === "verification-finished" &&
          event.campaignId === ref.campaignId &&
          event.findingId === ref.findingId &&
          event.verificationId === ref.verificationId &&
          event.snapshotDigest === ref.snapshotDigest,
      )?.event;
    if (verification?.type !== "verification-finished")
      throw new Error("Only recorded verifications are reviewed");
    if (
      (verification.result.status === "incomplete" ||
        verification.result.status === "contradicted") &&
      !this.queue({ campaignId: ref.campaignId }).items.some(
        (item) =>
          item.ref.findingId === ref.findingId &&
          item.ref.verificationId === ref.verificationId,
      )
    )
      throw new Error(
        `This ${verification.result.status} verification is not the current review item`,
      );
    return {
      status: verification.result.status,
      since: verification.occurredAt,
    };
  }

  /** #436: a decision before any verification, on a Finding the queue lists as `not-verified`. */
  #unverifiedItem(ref: ReviewDecisionRef): {
    readonly status: "not-verified";
    readonly since: string;
  } {
    const listed = this.queue({ campaignId: ref.campaignId }).items.some(
      (item) =>
        item.status === "not-verified" &&
        item.ref.findingId === ref.findingId &&
        item.ref.snapshotDigest === ref.snapshotDigest,
    );
    const finding = this.#ledger
      .read({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
        type: "finding-recorded",
        limit: 1,
      })
      .at(0)?.event;
    if (!listed || finding === undefined)
      throw new Error("This Finding is not an unverified review item");
    return { status: "not-verified", since: finding.occurredAt };
  }

  /**
   * The reason code of each listed item's decision, read from its private
   * record. An item whose record is unreadable (older events) has none.
   */
  async decisionReasons(
    items: readonly ReviewItem[],
  ): Promise<ReadonlyMap<ReviewItem, string>> {
    const reasons = new Map<ReviewItem, string>();
    for (const item of items) {
      if (item.decision === null) continue;
      const event = currentReviewDecision(
        readDecisionHistory(this.#ledger, item.ref),
        item.ref,
      );
      if (event === null) continue;
      const read = await readReviewRecord(
        this.#store,
        event,
        "review-decision",
      );
      if (read.status === "read") reasons.set(item, read.record.reasonCode);
    }
    return reasons;
  }

  /** #442: the stage-4 result in force for a Finding, as its latest decision carries it. */
  async duplicateOf(input: {
    readonly campaignId: string;
    readonly findingId: string;
  }): Promise<DuplicateCheck | null> {
    const latest = readDecisionHistory(this.#ledger, {
      campaignId: id.parse(input.campaignId),
      findingId: id.parse(input.findingId),
    }).at(-1)?.event;
    if (latest === undefined) return null;
    const read = await readReviewRecord(this.#store, latest, "review-decision");
    return read.status === "read" ? read.record.duplicate : null;
  }

  async assessScope(input: {
    readonly ref: ReviewRef;
  }): Promise<readonly ScopeAssessment[]> {
    const ref = refSchema.parse(input.ref);
    const basis = this.#requireBasis(ref, "scope");
    const existing = (await this.#scopeAssessments(ref)).filter(
      (item) => item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (existing.length > 0) {
      const byProgramme = new Map(
        existing.map((item) => [item.programmeId, item]),
      );
      if (byProgramme.size !== existing.length)
        throw new Error("Duplicate programme assessment");
      for (const programmeId of this.#scopeEvaluator.programmeIds) {
        if (!byProgramme.has(programmeId)) {
          byProgramme.set(
            programmeId,
            await this.#persistAssessment(ref, {
              programmeId,
              status: "incomplete",
              destination: programmeId,
              reason: "scope-recording-interrupted",
            }),
          );
        }
      }
      return this.#scopeEvaluator.programmeIds.map((programmeId) =>
        byProgramme.get(programmeId)!,
      );
    }

    let results: readonly z.infer<typeof scopeResult>[];
    let failed = false;
    try {
      const facts = await this.#factsProvider.load({ ref, basis });
      results = z
        .array(scopeResult)
        .parse(await this.#scopeEvaluator.assess({ ref, facts }));
      const expected = new Set(this.#scopeEvaluator.programmeIds);
      const actual = new Set(results.map((item) => item.programmeId));
      if (
        results.length !== expected.size ||
        actual.size !== expected.size ||
        [...expected].some((name) => !actual.has(name))
      ) {
        throw new Error(
          "Every configured programme must be assessed exactly once",
        );
      }
    } catch {
      failed = true;
      results = this.#scopeEvaluator.programmeIds.map((programmeId) => ({
        programmeId,
        status: "ambiguous" as const,
        destination: programmeId,
        reason: "scope-evaluation-failed",
      }));
    }
    const assessments: ScopeAssessment[] = [];
    for (const item of results) {
      assessments.push(
        await this.#persistAssessment(ref, {
          programmeId: item.programmeId,
          status: failed ? "incomplete" : item.status,
          destination: item.destination,
          reason: item.reason,
        }),
      );
    }
    return assessments;
  }

  async #persistAssessment(
    ref: ReviewRef,
    item: {
      readonly programmeId: string;
      readonly status: ScopeAssessment["status"];
      readonly destination: string;
      readonly reason: string;
    },
  ): Promise<ScopeAssessment> {
    const record = assessmentSchema.parse({
      id: canonicalDigest({
        ref,
        policyDigest: this.#scopeEvaluator.policyDigest,
        ...item,
      }),
      ref,
      policyDigest: this.#scopeEvaluator.policyDigest,
      ...item,
      assessedAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `scope:${record.id}`,
      campaignId: ref.campaignId,
      snapshotDigest: ref.snapshotDigest,
      occurredAt: record.assessedAt,
      type: "scope-assessed",
      findingId: ref.findingId,
      programmeId: record.programmeId,
      status: record.status,
      artifacts: [{ kind: "review-scope", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Scope assessment ledger conflict");
    return record;
  }

  async saveDraft(input: {
    readonly assessmentId: string;
    readonly content: string;
    readonly preparedBy: "ai" | "human";
  }): Promise<SubmissionDraftRef> {
    const assessmentId = digest.parse(input.assessmentId);
    const assessment = (await this.#allAssessments({ assessmentId })).find(
      (item) => item.id === assessmentId,
    );
    if (
      assessment?.status !== "in-scope" ||
      assessment.policyDigest !== this.#scopeEvaluator.policyDigest
    )
      throw new Error("An in-scope assessment is required");
    const basis = this.submissionBasis({ ref: assessment.ref, use: "draft" });
    if (basis.status === "missing")
      throw new Error(
        basis.reason === "superseded"
          ? "A current verification is required before drafting"
          : MISSING_BASIS,
      );
    const prior = (await this.#allDrafts(assessment.ref)).filter(
      (item) => item.assessmentId === assessmentId,
    );
    const revision = Math.max(0, ...prior.map((item) => item.revision)) + 1;
    const content = z.string().min(1).max(100_000).parse(input.content);
    const preparedBy = z.enum(["ai", "human"]).parse(input.preparedBy);
    const draftDigest = canonicalDigest({
      assessmentId,
      revision,
      content,
      preparedBy,
    });
    const candidateId = canonicalDigest({
      assessmentId,
      draftDigest,
      destination: assessment.destination,
    });
    const record = draftSchema.parse({
      assessmentId,
      candidateId,
      digest: draftDigest,
      revision,
      destination: assessment.destination,
      content,
      preparedBy,
      createdAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `draft:${draftDigest}`,
      campaignId: assessment.ref.campaignId,
      snapshotDigest: assessment.ref.snapshotDigest,
      occurredAt: record.createdAt,
      type: "draft-saved",
      findingId: assessment.ref.findingId,
      candidateId,
      revisionDigest: draftDigest,
      artifacts: [{ kind: "review-draft", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Submission Draft ledger conflict");
    const { content: _content, ...publicRef } = record;
    return publicRef;
  }

  async authorizeExternalAction(input: {
    readonly candidateId: string;
    readonly draftDigest: string;
    readonly destination: string;
    readonly authorizedBy: string;
  }): Promise<void> {
    const candidateId = digest.parse(input.candidateId);
    const draftDigest = digest.parse(input.draftDigest);
    const destination = id.parse(input.destination);
    const authorizedBy = humanActor.parse(input.authorizedBy);
    const draft = (
      await this.#allDrafts({ candidateId, revisionDigest: draftDigest })
    ).find(
      (item) =>
        item.candidateId === candidateId &&
        item.digest === draftDigest &&
        item.destination === destination,
    );
    if (draft === undefined)
      throw new Error("An exact Submission Candidate and Draft are required");
    const assessment = (
      await this.#allAssessments({ assessmentId: draft.assessmentId })
    ).find(
      (item) =>
        item.id === draft.assessmentId &&
        item.status === "in-scope" &&
        item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (assessment === undefined)
      throw new Error("An in-scope assessment is required");
    const gate = await this.#finalReviewGate(draft, assessment, authorizedBy);
    if (typeof gate === "string")
      throw new Error(`Final human review is required: ${gate}`);
    const record = authorizationSchema.parse({
      candidateId,
      draftDigest,
      destination,
      authorizedBy,
      authorizedAt: this.#clock().toISOString(),
    });
    const artifactDigest = await this.#storeRecord(record);
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `authorization:${canonicalDigest({ record, finalReviewSequence: gate })}`,
      campaignId: assessment.ref.campaignId,
      snapshotDigest: assessment.ref.snapshotDigest,
      occurredAt: record.authorizedAt,
      type: "external-action-authorized",
      candidateId,
      revisionDigest: draftDigest,
      destination,
      artifacts: [{ kind: "review-authorization", digest: artifactDigest }],
    });
    if (appended.status === "conflict")
      throw new Error("Authorization ledger conflict");
  }

  async admitExternalAction(input: {
    readonly candidateId: string;
    readonly draftDigest: string;
    readonly destination: string;
  }): Promise<ExternalActionAdmission> {
    const candidateId = digest.parse(input.candidateId);
    const draftDigest = digest.parse(input.draftDigest);
    const destination = id.parse(input.destination);
    const draft = (
      await this.#allDrafts({ candidateId, revisionDigest: draftDigest })
    ).find(
      (item) =>
        item.candidateId === candidateId &&
        item.digest === draftDigest &&
        item.destination === destination,
    );
    if (draft === undefined)
      return {
        status: "not-authorized",
        reason: "candidate-or-draft-not-found",
      };
    const assessment = (
      await this.#allAssessments({ assessmentId: draft.assessmentId })
    ).find(
      (item) =>
        item.id === draft.assessmentId &&
        item.status === "in-scope" &&
        item.policyDigest === this.#scopeEvaluator.policyDigest,
    );
    if (assessment === undefined)
      return {
        status: "not-authorized",
        reason: "exact-authorization-required",
      };
    const latest = Math.max(
      ...(await this.#allDrafts(assessment.ref))
        .filter((item) => item.assessmentId === draft.assessmentId)
        .map((item) => item.revision),
    );
    if (draft.revision !== latest)
      return { status: "not-authorized", reason: "superseded-draft" };
    const authorization = this.#ledger
      .readAll({ type: "external-action-authorized" })
      .filter(
        ({ event }) =>
          event.type === "external-action-authorized" &&
          event.candidateId === candidateId &&
          event.revisionDigest === draftDigest &&
          event.destination === destination,
      )
      .at(-1);
    if (authorization === undefined)
      return {
        status: "not-authorized",
        reason: "exact-authorization-required",
      };
    const authorizationRecord = await this.#readRecord(
      authorization.event,
      "review-authorization",
    );
    const gate = await this.#finalReviewGate(
      draft,
      assessment,
      authorizationRecord.authorizedBy,
    );
    if (typeof gate === "string")
      return { status: "not-authorized", reason: gate };
    return authorization.sequence > gate
      ? { status: "authorized", authorizationId: authorization.event.identity }
      : { status: "not-authorized", reason: "exact-authorization-required" };
  }

  /** Returns the final decision sequence only after the human steps are in order. */
  async #finalReviewGate(
    draft: SubmissionDraft,
    assessment: ScopeAssessment,
    reviewer: string,
  ): Promise<
    | "superseded-draft"
    | "human-reviewed-draft-required"
    | "manual-reproduction-required"
    | "human-accept-required"
    | "stale-verification"
    | number
  > {
    const latestRevision = Math.max(
      ...(await this.#allDrafts(assessment.ref))
        .filter((item) => item.assessmentId === draft.assessmentId)
        .map((item) => item.revision),
    );
    if (draft.revision !== latestRevision) return "superseded-draft";
    if (draft.preparedBy !== "human") return "human-reviewed-draft-required";
    const basis = this.submissionBasis({
      ref: assessment.ref,
      use: "authorize",
    });
    if (basis.status === "missing")
      return basis.reason === "superseded"
        ? "stale-verification"
        : "manual-reproduction-required";
    const manual = basis.basis.reproduction;
    if (manual === null) return "manual-reproduction-required";

    const saved = this.#ledger
      .readAll({
        campaignId: assessment.ref.campaignId,
        findingId: assessment.ref.findingId,
        type: "draft-saved",
      })
      .find(
        ({ event }) =>
          event.type === "draft-saved" &&
          event.candidateId === draft.candidateId &&
          event.revisionDigest === draft.digest,
      );
    if (saved === undefined || manual.sequence >= saved.sequence)
      return "human-reviewed-draft-required";
    const decision = this.#ledger
      .readAll({
        campaignId: assessment.ref.campaignId,
        findingId: assessment.ref.findingId,
        type: "review-decided",
      })
      .at(-1);
    if (
      decision?.event.type !== "review-decided" ||
      decision.sequence <= saved.sequence ||
      decision.sequence <= manual.sequence ||
      decision.event.decision !== "accept" ||
      decision.event.verificationId !== assessment.ref.verificationId ||
      decision.event.snapshotDigest !== assessment.ref.snapshotDigest
    )
      return "human-accept-required";
    const reviewRecord = await readReviewRecord(
      this.#store,
      decision.event,
      "review-decision",
    );
    const reviewedBy =
      reviewRecord.status === "read"
        ? humanActor.safeParse(reviewRecord.record.decidedBy)
        : null;
    return reviewRecord.status === "read" &&
      reviewRecord.record.duplicate.status === "no-match" &&
      reviewedBy?.success === true &&
      reviewedBy.data === reviewer
      ? decision.sequence
      : "human-accept-required";
  }

  /**
   * Basis or not for one review step, and why not (ADR 0040). Every caller
   * that takes a Finding toward submission asks here; see `BasisUse`.
   */
  submissionBasis(input: {
    readonly ref: ReviewRef;
    readonly use: BasisUse;
  }): BasisAnswer {
    return submissionBasis(this.#ledger, input.ref, input.use);
  }

  #requireBasis(ref: ReviewRef, use: BasisUse): SubmissionBasis {
    const answer = this.submissionBasis({ ref, use });
    if (answer.status === "missing") throw new Error(MISSING_BASIS);
    return answer.basis;
  }

  /** Records that the human submitted this exact authorized draft; Harness sends nothing. */
  async recordSubmission(input: {
    readonly candidateId: string;
    readonly draftDigest: string;
    readonly destination: string;
  }): Promise<void> {
    const admission = await this.admitExternalAction(input);
    if (admission.status !== "authorized")
      throw new Error(`Submission is not authorized: ${admission.reason}`);
    const draft = (
      await this.#allDrafts({
        candidateId: input.candidateId,
        revisionDigest: input.draftDigest,
      })
    ).find(
      (item) =>
        item.candidateId === input.candidateId &&
        item.digest === input.draftDigest,
    );
    const assessment =
      draft === undefined
        ? undefined
        : (
            await this.#allAssessments({ assessmentId: draft.assessmentId })
          ).find((item) => item.id === draft.assessmentId);
    if (assessment === undefined)
      throw new Error("Submission Candidate has no assessment");
    const recordedAt = this.#clock().toISOString();
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `submission:${input.candidateId}:${input.destination}`,
      campaignId: assessment.ref.campaignId,
      snapshotDigest: assessment.ref.snapshotDigest,
      occurredAt: recordedAt,
      type: "submission-recorded",
      findingId: assessment.ref.findingId,
      candidateId: input.candidateId,
    });
    if (appended.status === "conflict")
      throw new Error("Submission ledger conflict");
  }

  async recordOutcome(input: {
    readonly candidateId: string;
    readonly outcome: Extract<
      LedgerEventV1,
      { type: "submission-outcome" }
    >["outcome"];
    /** Bounty in USD as the programme reported it. */
    readonly rewardUsd?: number;
  }): Promise<void> {
    const candidateId = id.parse(input.candidateId);
    const rewardUsd = z
      .number()
      .nonnegative()
      .max(1_000_000)
      .optional()
      .parse(input.rewardUsd);
    const submission = this.#ledger
      .readAll({ type: "submission-recorded" })
      .find(
        ({ event }) =>
          event.type === "submission-recorded" &&
          event.candidateId === candidateId,
      )?.event;
    if (submission === undefined)
      throw new Error("Record the submission before its outcome");
    const appended = await this.#ledger.append({
      schemaVersion: 1,
      identity: `outcome:${candidateId}:${input.outcome}:${rewardUsd ?? "none"}`,
      campaignId: submission.campaignId,
      snapshotDigest: submission.snapshotDigest,
      occurredAt: this.#clock().toISOString(),
      type: "submission-outcome",
      candidateId,
      outcome: input.outcome,
      ...(rewardUsd === undefined ? {} : { rewardUsd }),
    });
    if (appended.status === "conflict")
      throw new Error("Outcome ledger conflict");
  }

  /** One append-only receipt for work the owner actually completed. */
  async recordHumanEffort(input: HumanEffortInput): Promise<void> {
    await this.#recordHumanEvent(this.#prepareHumanEffort(input));
  }

  #prepareHumanEffort(input: HumanEffortInput): HumanRecord {
    const minutes = humanMinutesSchema.parse(input.minutes);
    const candidateEvent =
      input.candidateId === undefined
        ? undefined
        : this.#ledger
            .readAll({ type: "submission-recorded" })
            .find(
              ({ event }) =>
                event.type === "submission-recorded" &&
                event.candidateId === input.candidateId,
            )?.event;
    const candidate =
      candidateEvent?.type === "submission-recorded"
        ? candidateEvent
        : undefined;
    const campaignId = candidate?.campaignId ?? id.parse(input.campaignId);
    const findingId = candidate?.findingId ?? input.findingId;
    const finding =
      findingId === undefined
        ? undefined
        : this.#ledger
            .readAll({ type: "finding-recorded" })
            .find(
              ({ event }) =>
                event.type === "finding-recorded" &&
                event.campaignId === campaignId &&
                event.findingId === findingId,
            )?.event;
    if (findingId !== undefined && finding?.type !== "finding-recorded")
      throw new Error("Human effort must refer to a recorded Finding");
    const snapshotDigest = finding?.snapshotDigest ?? candidate?.snapshotDigest;
    if (snapshotDigest === undefined)
      throw new Error("Human effort needs a recorded Snapshot");
    return {
      schemaVersion: 1,
      identity: `human-effort:${randomUUID()}`,
      campaignId,
      snapshotDigest,
      occurredAt: this.#clock().toISOString(),
      type: "human-effort-recorded",
      ...(findingId === undefined ? {} : { findingId }),
      action: input.action,
      minutes,
      artifacts: [],
    };
  }

  async recordHumanReproduction(input: HumanReproductionInput): Promise<void> {
    await this.#recordHumanEvent(this.#prepareHumanReproduction(input));
  }

  #prepareHumanReproduction(input: HumanReproductionInput): HumanRecord {
    const result = z
      .enum(["match", "mismatch", "unavailable"])
      .parse(input.result);
    const ref = refSchema.parse(input.ref);
    const basis = this.#requireBasis(ref, "reproduce");
    return {
      schemaVersion: 1,
      identity: `human-reproduction:${randomUUID()}`,
      campaignId: ref.campaignId,
      snapshotDigest: ref.snapshotDigest,
      occurredAt: this.#clock().toISOString(),
      type: "human-reproduction-recorded",
      findingId: ref.findingId,
      verificationId: ref.verificationId,
      reproductionPackageDigest: basis.packageDigest,
      result,
      artifacts: [],
    };
  }

  async #recordHumanEvent(event: HumanRecord): Promise<void> {
    const appended = await this.#ledger.append(event);
    if (appended.status !== "appended")
      throw new Error(
        event.type === "human-effort-recorded"
          ? "Human effort ledger conflict"
          : "Human reproduction ledger conflict",
      );
  }

  async inspectDuplicate(input: {
    readonly campaignId: string;
    readonly findingId: string;
  }): Promise<DuplicateLookupResult> {
    const request = z
      .strictObject({ campaignId: id, findingId: id })
      .parse(input);
    return this.#duplicateLookup?.inspect(request) ?? { status: "unavailable" };
  }

  async openReproductionPackage(input: { readonly ref: ReviewRef }) {
    const ref = refSchema.parse(input.ref);
    const basis = this.#requireBasis(ref, "reproduce");
    // A review Lab package opens with `lab up --for-review`, not here.
    if (basis.kind !== "judge-era") throw new Error(MISSING_BASIS);
    return openReproductionPackage(this.#store, basis.verification.result);
  }

  async inspect(input: {
    readonly campaignId: string;
    readonly findingId: string;
  }): Promise<ReviewView> {
    const query = z
      .strictObject({ campaignId: id, findingId: id })
      .parse(input);
    const verifications = this.#ledger.readAll({
      ...query,
      type: "verification-finished",
    });
    const verification = verifications.at(-1);
    const assessments = (await this.#allAssessments(query)).filter(
      (item) =>
        item.ref.campaignId === query.campaignId &&
        item.ref.findingId === query.findingId,
    );
    const assessmentIds = new Set(assessments.map((item) => item.id));
    const drafts = (await this.#allDrafts(query))
      .filter((item) => assessmentIds.has(item.assessmentId))
      .map(({ content: _content, ...reference }) => reference);
    const candidateIds = new Set(drafts.map((draft) => draft.candidateId));
    // Keep the historical type order and duplicate references. Authorization
    // events have no Finding ID; their drafts establish that relationship.
    const privateEvidenceDigests = [
      ...verifications,
      ...this.#ledger.readAll({ ...query, type: "scope-assessed" }),
      ...this.#ledger.readAll({ ...query, type: "draft-saved" }),
      ...this.#ledger
        .readAll({
          campaignId: query.campaignId,
          type: "external-action-authorized",
        })
        .filter(
          ({ event }) =>
            event.type === "external-action-authorized" &&
            candidateIds.has(event.candidateId),
        ),
    ].flatMap(({ event }) =>
      event.artifacts.map((artifact) => artifact.digest),
    );
    return {
      verificationStatus:
        verification?.event.type === "verification-finished"
          ? verification.event.result.status
          : "missing",
      scopeAssessments: assessments,
      drafts,
      privateEvidenceDigests,
      reproductionPackageDigest:
        verification?.event.type === "verification-finished" &&
        (verification.event.result.status === "runtime-confirmed" ||
          verification.event.result.status === "reproduced")
          ? verification.event.result.reproductionPackageDigest
          : null,
    };
  }

  /** The discovery run that produced the Finding and the prompt digest it ran with. */
  #traceOf(
    campaignId: string,
    findingId: string,
  ): { runId?: string; promptDigest?: string } | undefined {
    const finding = this.#ledger
      .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
      .at(0)?.event;
    if (finding?.type !== "finding-recorded") return undefined;
    const run = this.#ledger
      .readAll({ type: "discovery-run-started" })
      .find(
        ({ event }) =>
          event.type === "discovery-run-started" &&
          event.campaignId === campaignId &&
          event.runId === finding.runId,
      )?.event;
    const promptDigest =
      run?.type === "discovery-run-started"
        ? run.configuration.promptDigest
        : undefined;
    return {
      runId: finding.runId,
      ...(promptDigest === undefined ? {} : { promptDigest }),
    };
  }

  async #storeRecord(record: object): Promise<string> {
    return this.#store.putFiles({
      [REVIEW_RECORD_FILE]: canonicalJson(record),
    });
  }

  /** Review's own records are required reading; a missing one is an error, not a null. */
  async #readRecord<K extends ReviewRecordKind>(
    event: LedgerEventV1,
    kind: K,
  ): Promise<ReviewRecordByKind[K]> {
    const read = await readReviewRecord(this.#store, event, kind);
    if (read.status === "unreferenced")
      throw new Error("Private Evidence reference is missing");
    if (read.status === "unavailable")
      throw new Error("Private Evidence is unavailable");
    return read.record;
  }

  async #allAssessments(
    input: {
      readonly campaignId?: string;
      readonly findingId?: string;
      readonly assessmentId?: string;
    } = {},
  ): Promise<ScopeAssessment[]> {
    const { assessmentId, campaignId, findingId } = input;
    const entries = this.#ledger.readAll({
      ...(campaignId === undefined ? {} : { campaignId }),
      ...(findingId === undefined ? {} : { findingId }),
      type: "scope-assessed",
    });
    const exact =
      assessmentId === undefined
        ? undefined
        : entries.find(
            ({ event }) => event.identity === `scope:${assessmentId}`,
          );
    // Preserve records with identities outside the current writer convention.
    return Promise.all(
      (exact === undefined ? entries : [exact]).map(({ event }) =>
        this.#readRecord(event, "review-scope"),
      ),
    );
  }

  async #scopeAssessments(ref: ReviewRef): Promise<ScopeAssessment[]> {
    return (await this.#allAssessments(ref)).filter(
      (item) =>
        item.ref.findingId === ref.findingId &&
        item.ref.campaignId === ref.campaignId &&
        item.ref.snapshotDigest === ref.snapshotDigest &&
        item.ref.verificationId === ref.verificationId,
    );
  }

  async #allDrafts(
    input: {
      readonly campaignId?: string;
      readonly findingId?: string;
      readonly candidateId?: string;
      readonly revisionDigest?: string;
    } = {},
  ): Promise<SubmissionDraft[]> {
    const { candidateId, revisionDigest, campaignId, findingId } = input;
    return Promise.all(
      this.#ledger
        .readAll({
          ...(campaignId === undefined ? {} : { campaignId }),
          ...(findingId === undefined ? {} : { findingId }),
          type: "draft-saved",
        })
        .filter(
          ({ event }) =>
            event.type === "draft-saved" &&
            (candidateId === undefined || event.candidateId === candidateId) &&
            (revisionDigest === undefined ||
              event.revisionDigest === revisionDigest),
        )
        .map(({ event }) => this.#readRecord(event, "review-draft")),
    );
  }
}
