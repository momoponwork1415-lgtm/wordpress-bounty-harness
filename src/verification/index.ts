import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  provisionThrew,
  storeLabDiagnostic,
  type LabHandle,
  type LabProvisioner,
  type ProvisionIncomplete,
} from "../lab/index.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import type { VerificationResultV1 } from "./reproduction-package.js";

export {
  verificationResultV1Schema,
  type VerificationResultV1,
} from "./reproduction-package.js";
export {
  countAttemptsForReason,
  shouldAutomaticallyRetryVerification,
  type IncompleteReason,
} from "./retry-budget.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** The fields every profile Finding carries; the rest stays profile-specific. */
export interface VerifiableFinding {
  readonly findingId: string;
  readonly snapshotDigest: string;
  /** Profile classification; Verification itself does not read it. */
  readonly impact?: string;
}

/** The `finding-recorded` event Verification reloaded the Finding from. */
export type RecordedFinding = Extract<
  LedgerEventV1,
  { type: "finding-recorded" }
>;
type FindingRecord = RecordedFinding;
type VerifierRunEvent = Extract<
  LedgerEventV1,
  { type: "verifier-run-finished" }
>;

/**
 * A fresh-container agent that repairs and refutes a recipe. It cannot confirm.
 * Verification has already reloaded the Finding from Private Evidence, matched
 * its id to the record and its Snapshot digest to the Lab before `attempt`.
 */
export interface Verifier<Finding, Handle extends LabHandle> {
  attempt(input: {
    readonly campaignId: string;
    readonly finding: Finding;
    readonly lab: Handle;
    /** The campaign's `finding-recorded` event; carries only digest references. */
    readonly record: RecordedFinding;
    /** An earlier recorded route for a same-path version comparison. */
    readonly referenceRoute?: unknown;
    /**
     * Retakes the Harness-owned Lab state baseline from now. A Verifier whose
     * precondition setup precedes the attacker steps calls it once setup is
     * done, so what setup changed is neither captured nor diffed.
     */
    readonly restartObservation?: () => Promise<void>;
    /**
     * #699: this attempt's place among the Findings sharing one Lab, 1-based.
     * Absent when the Lab serves this Finding alone.
     */
    readonly batch?: { readonly position: number; readonly size: number };
  }): Promise<VerifierAttempt>;
  /**
   * #699: readies a Lab another Finding's attempt already used for `next`;
   * false when the Lab can no longer be trusted, so no further Finding is tried.
   */
  readyForNextAttempt?(
    lab: Handle,
    next: { readonly findingId: string },
  ): Promise<boolean>;
  /**
   * #699: the origin this Finding's attacker stands at under the Lab's
   * baseline, recorded on its `lab-provisioned`; undefined without one.
   */
  attackerOrigin?(
    lab: Handle,
    finding: Finding,
  ): "domestic" | "foreign" | undefined;
}

/** The transport receipt fields the ledger needs; the whole receipt goes to Private Evidence. */
export type VerifierRunReceipt = {
  readonly digest: string;
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly terminal: VerifierRunEvent["terminal"];
  readonly providerLimit?: VerifierRunEvent["providerLimit"];
};

/** Appends one `verifier-run-finished` event for a transport receipt, whatever the transport. */
export async function recordVerifierRun(input: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly clock: () => Date;
  readonly campaignId: string;
  readonly findingId: string;
  readonly promptDigest: string;
  readonly receipt: VerifierRunReceipt;
}): Promise<void> {
  const { receipt } = input;
  const receiptDigest = await input.store.putFiles({
    "receipt.json": canonicalJson(receipt),
  });
  const appended = await input.ledger.append({
    schemaVersion: 1,
    identity: `verifier-${receipt.digest}`,
    campaignId: input.campaignId,
    snapshotDigest: receipt.targetSnapshotDigest,
    occurredAt: input.clock().toISOString(),
    type: "verifier-run-finished",
    findingId: input.findingId,
    runId: receipt.runId,
    promptDigest: input.promptDigest,
    receiptDigest,
    terminal: receipt.terminal,
    ...(receipt.providerLimit === undefined
      ? {}
      : { providerLimit: receipt.providerLimit }),
    artifacts: [{ kind: "native-run-receipt", digest: receiptDigest }],
  });
  if (appended.status === "conflict")
    throw new Error("Verifier run identity conflict");
}
export type VerifierAttempt =
  | {
      readonly status: "attempted";
      readonly recipeDigest: string;
      readonly refutationDigest?: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: "precondition" | "recipe";
      readonly nextStep: string;
      /** #699: the Lab may not serve another Finding (its setup could not be closed). */
      readonly labUntrusted?: true;
    };

/** A transport receipt already recorded the failure; Verification preserves its cause. */
export class VerifierTransportIncompleteError extends Error {
  constructor(readonly reason: "provider" | "sandbox") {
    super(`Verifier transport incomplete: ${reason}`);
  }
}

/**
 * Harness-owned observation after a finished Verifier attempt (#525, ADR
 * 0040): the Lab's own HTTP capture and browser records, stored as review
 * material. It never decides; a person confirms the Finding in a Lab.
 */
export interface AttemptObserver<Finding, Handle extends LabHandle> {
  observe(input: {
    readonly finding: Finding;
    readonly lab: Handle;
    readonly recipeDigest: string;
  }): Promise<AttemptObservation>;
}
export type AttemptObservation =
  | {
      readonly status: "recorded";
      /** Holds the Harness HTTP capture; the browser record when one was taken. */
      readonly evidenceDigest: string;
    }
  | {
      /** The Harness capture is missing or damaged, so there is nothing to show a person. */
      readonly status: "incomplete";
      readonly reason: "evidence";
      readonly nextStep: string;
    };

/** An opaque Lab state the observer took before the Verifier ran; only its digest is generic. */
export type LabStateCapture = {
  readonly digest: string;
  readonly state: unknown;
};

/**
 * Where the before / after states and their diff went. A missing capture is a
 * missing artifact with a reason; it never changes the verification result.
 */
export type LabStateDiffRecord =
  | {
      readonly status: "captured";
      readonly artifacts: readonly {
        readonly kind:
          "lab-state-before" | "lab-state-after" | "lab-state-diff";
        readonly digest: string;
      }[];
    }
  | {
      readonly status: "missing";
      readonly reason: "before-capture" | "after-capture" | "store";
    };

/**
 * Harness-owned deterministic observation of the whole Lab state around the
 * Verifier run (#186). The Verifier never receives it: it is review
 * material, not proof.
 */
export interface LabStateObserver<Handle extends LabHandle> {
  before(lab: Handle): Promise<LabStateCapture | null>;
  after(lab: Handle, before: LabStateCapture): Promise<LabStateDiffRecord>;
}

type Incomplete = Extract<VerificationResultV1, { status: "incomplete" }>;

/** A recorded attempt's live Lab, kept for a person's observation (#600). */
export type HeldVerificationLab<Handle extends LabHandle> = {
  readonly lab: Handle;
  readonly ref: VerificationRef;
  /**
   * #699: every attempt in this Lab that waits for a person, in order, `ref`
   * first. Absent when the Lab holds one attempt.
   */
  readonly batch?: readonly VerificationRef[];
};
type VerificationRef = {
  readonly campaignId: string;
  readonly findingId: string;
  readonly verificationId: string;
  readonly snapshotDigest: string;
};

/** #699: one Finding of a shared-Lab run; `not-attempted` wrote nothing to the ledger. */
export type VerificationBatchOutcome =
  | {
      readonly findingId: string;
      readonly verificationId: string;
      readonly status: "recorded";
      readonly result: VerificationResultV1;
    }
  | {
      readonly findingId: string;
      readonly verificationId: string;
      readonly status: "not-attempted";
    };

/** The most Findings one Lab serves in turn (#699). */
export const MAX_FINDINGS_PER_LAB = 5;

type VerificationRun<
  Finding extends VerifiableFinding,
  Handle extends LabHandle,
> = {
  readonly campaignId: string;
  readonly finding: Finding;
  readonly record: FindingRecord;
  readonly snapshotDigest: string;
  readonly lab: Handle;
  readonly referenceRoute: unknown;
  readonly batch?: { readonly position: number; readonly size: number };
  readonly onCapture: (capture: "harness-captured") => void;
  /** Receives where the before / after Lab state diff went (#186). */
  readonly onStateDiff: (record: LabStateDiffRecord) => void;
  /** Receives the Verifier's stored recipe, review material whatever happens next (#437). */
  readonly onRecipe: (recipeDigest: string) => void;
};
/** What a person does next with a finished attempt; no Harness code confirms (#525). */
const AWAITING_HUMAN_OBSERVATION_NEXT_STEP =
  "Read the Harness capture and browser record, observe the held verification Lab if available, otherwise open a fresh review Lab, and record the human observation";
const incomplete = (
  reason: Incomplete["reason"],
  nextStep: string,
  refutationDigest?: string,
  evidenceDigest?: string,
): Incomplete => ({
  status: "incomplete",
  reason,
  nextStep,
  ...(refutationDigest === undefined ? {} : { refutationDigest }),
  ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
});
const isAwaiting = (result: VerificationResultV1) =>
  result.status === "incomplete" &&
  result.reason === "awaiting-human-observation";

export type VerificationOptions<
  Finding extends VerifiableFinding,
  Setup,
  Handle extends LabHandle,
> = {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly lab: LabProvisioner<Setup, Handle>;
  readonly verifier: Verifier<Finding, Handle>;
  /** Records what the Lab shows after a finished attempt; it never decides. */
  readonly observer: AttemptObserver<Finding, Handle>;
  /** Profile parser for the private Finding record. */
  readonly readFinding: (value: unknown) => Finding;
  /** Opaque, immutable Verifier instruction version for retry compatibility. */
  readonly promptVersion?: string;
  /** Optional before / after Lab state diff; absent, the event carries no diff field. */
  readonly stateObserver?: LabStateObserver<Handle>;
  readonly clock?: () => Date;
};

/** One Finding's verification request; shared fields live in `VerificationCommon`. */
type VerificationItem = {
  readonly findingId: string;
  readonly verificationId: string;
  /** One-based attempt number recorded with the verdict; absent for older callers. */
  readonly attempt?: number;
  /** Verification ID immediately preceding this attempt. */
  readonly retryOf?: string;
};
type VerificationCommon<Setup, Handle extends LabHandle> = {
  readonly campaignId: string;
  readonly snapshot: { readonly digest: string };
  /** Marks a version comparison; the Finding still belongs to this snapshot. */
  readonly basis?: {
    readonly kind: "latest-version" | "fixed-version";
    readonly findingSnapshotDigest: string;
  };
  readonly setup: Setup;
  readonly campaignLabSetupDigest: string;
  readonly referenceRoute?: unknown;
  /**
   * #600: keeps the Lab of an attempt recorded as
   * `incomplete(awaiting-human-observation)` for a person's observation.
   * Called after the event is in the ledger; the Lab is removed when it
   * returns or throws. Absent, the Lab is removed before recording.
   */
  readonly hold?: (held: HeldVerificationLab<Handle>) => Promise<void>;
};

/** What one Finding's attempt left for its `verification-finished` event. */
type ItemTrace = {
  labSetupDigest: string;
  evidenceCapture?: "harness-captured";
  labStateDiff?: LabStateDiffRecord;
  recipeDigest?: string;
  reviewLabReady: boolean;
};

export class Verification<
  Finding extends VerifiableFinding,
  Setup,
  Handle extends LabHandle,
> {
  readonly promptVersion: string | undefined;
  readonly #options: VerificationOptions<Finding, Setup, Handle>;

  constructor(options: VerificationOptions<Finding, Setup, Handle>) {
    this.#options = options;
    this.promptVersion =
      options.promptVersion === undefined
        ? undefined
        : id.parse(options.promptVersion);
  }

  /**
   * Every result is incomplete: a failure keeps its reason, and a finished
   * attempt waits for a person to observe it in a Lab (#525, ADR 0040).
   */
  async verify(
    input: VerificationCommon<Setup, Handle> & VerificationItem,
  ): Promise<VerificationResultV1> {
    const [outcome] = await this.#run(input, [input]);
    if (outcome?.status !== "recorded")
      throw new Error("Verification was not recorded");
    return outcome.result;
  }

  /**
   * #699: verifies up to five Findings of one Snapshot in turn in one Lab.
   * Each Finding gets its own `lab-provisioned` and `verification-finished`
   * events with the same Lab id. Once the Lab cannot be trusted, the rest are
   * `not-attempted` and leave nothing in the ledger.
   */
  async verifyBatch(
    input: Omit<
      VerificationCommon<Setup, Handle>,
      "basis" | "referenceRoute"
    > & {
      readonly items: readonly VerificationItem[];
    },
  ): Promise<readonly VerificationBatchOutcome[]> {
    const { items, ...common } = input;
    if (items.length < 1 || items.length > MAX_FINDINGS_PER_LAB)
      throw new Error(`One Lab verifies 1 to ${MAX_FINDINGS_PER_LAB} Findings`);
    if (new Set(items.map((item) => item.findingId)).size !== items.length)
      throw new Error("A Finding is named twice");
    return this.#run(common, items);
  }

  async #run(
    common: VerificationCommon<Setup, Handle>,
    requested: readonly VerificationItem[],
  ): Promise<VerificationBatchOutcome[]> {
    const campaignId = id.parse(common.campaignId);
    const snapshotDigest = digest.parse(common.snapshot.digest);
    const campaignLabSetupDigest = digest.parse(common.campaignLabSetupDigest);
    const items = requested.map((item) => ({
      findingId: id.parse(item.findingId),
      verificationId: id.parse(item.verificationId),
      attempt:
        item.attempt === undefined
          ? undefined
          : z.number().int().positive().parse(item.attempt),
      retryOf: item.retryOf === undefined ? undefined : id.parse(item.retryOf),
    }));
    const size = items.length;
    const clock = this.#options.clock ?? (() => new Date());
    let lab: Handle | undefined;
    let failed: ProvisionIncomplete | undefined;
    /** The Lab is removed or held; nothing else uses it. */
    let released = false;
    let held: Handle | undefined;
    let trusted = true;
    let used = false;
    const waiting: VerificationRef[] = [];
    const outcomes: VerificationBatchOutcome[] = [];

    const provision = async (): Promise<Handle | ProvisionIncomplete> => {
      if (lab !== undefined) return lab;
      if (failed !== undefined) return failed;
      const provisioned = await this.#options.lab
        .provision(common.snapshot, common.setup, { purpose: "verification" })
        .catch(provisionThrew);
      if (provisioned.status === "ready") return (lab = provisioned.handle);
      return (failed = provisioned);
    };

    const decide = async (
      item: (typeof items)[number],
      position: number,
      trace: ItemTrace,
    ): Promise<VerificationResultV1 | "not-attempted"> => {
      const { findingId, verificationId } = item;
      const loaded = await this.#loadFinding(campaignId, findingId);
      if (loaded === null)
        return incomplete(
          "precondition",
          "Record the finding with its private claim before verification",
        );
      const { finding, record } = loaded;
      if (
        finding.snapshotDigest !== snapshotDigest ||
        (common.basis !== undefined &&
          common.basis.findingSnapshotDigest !== snapshotDigest)
      )
        return incomplete(
          "digest-mismatch",
          "Repeat verification against the finding snapshot",
        );
      if (common.basis?.kind === "fixed-version") {
        const origin =
          record.derivedFromFindingId === undefined
            ? undefined
            : this.#options.ledger
                .read({
                  campaignId,
                  findingId: record.derivedFromFindingId,
                  type: "finding-recorded",
                  limit: 1,
                })
                .at(0)?.event;
        if (
          record.derivationKind !== "fixed-version-control" ||
          origin?.type !== "finding-recorded" ||
          origin.snapshotDigest === snapshotDigest
        )
          return incomplete(
            "precondition",
            "Record a fixed-version control Finding derived from a different Snapshot",
          );
      }
      const provisioned = await provision();
      if ("status" in provisioned) {
        await this.#recordLabFailure(
          campaignId,
          snapshotDigest,
          verificationId,
          findingId,
          provisioned,
        );
        return incomplete(provisioned.reason, provisioned.nextStep);
      }
      const current = provisioned;
      // A Lab another Finding used is readied first; one that cannot be is not trusted.
      if (used && this.#options.verifier.readyForNextAttempt !== undefined) {
        const ready = await this.#options.verifier
          .readyForNextAttempt(current, { findingId })
          .catch(() => false);
        if (!ready) {
          trusted = false;
          return "not-attempted";
        }
      }
      used = true;
      trace.labSetupDigest = current.setupDigest;
      trace.reviewLabReady = current.snapshotDigest === snapshotDigest;
      const run: VerificationRun<Finding, Handle> = {
        campaignId,
        finding,
        record,
        snapshotDigest,
        lab: current,
        referenceRoute: common.referenceRoute,
        ...(size > 1 ? { batch: { position, size } } : {}),
        onCapture: (capture) => {
          trace.evidenceCapture = capture;
        },
        onStateDiff: (diff) => {
          trace.labStateDiff = diff;
        },
        onRecipe: (recipe) => {
          trace.recipeDigest = recipe;
        },
      };
      const attackerOrigin = this.#options.verifier.attackerOrigin?.(
        current,
        finding,
      );
      try {
        const labEvent = await this.#options.ledger.append({
          schemaVersion: 1,
          identity: `verification-lab-${verificationId}`,
          campaignId,
          snapshotDigest,
          occurredAt: clock().toISOString(),
          type: "lab-provisioned",
          labId: current.id,
          status: "ready",
          purpose: "verification",
          setupDigest: current.setupDigest,
          ...(current.baseline === undefined
            ? {}
            : {
                baseline: {
                  id: current.baseline.id,
                  digest: current.baseline.digest,
                  ...(attackerOrigin === undefined ? {} : { attackerOrigin }),
                },
              }),
        });
        if (labEvent.status === "conflict")
          throw new Error("Verification Lab identity conflict");
        const attempted = await this.#attempt(run);
        if (attempted.untrusted) trusted = false;
        return attempted.result;
      } catch {
        trusted = false;
        return incomplete(
          "evidence",
          "Verification stopped unexpectedly; repeat in a fresh Lab",
        );
      }
    };

    /** Holds or removes the Lab before the last event that uses it is recorded. */
    const release = async (
      result: VerificationResultV1,
    ): Promise<VerificationResultV1> => {
      if (lab === undefined || released) return result;
      released = true;
      if (
        common.hold !== undefined &&
        trusted &&
        (isAwaiting(result) || waiting.length > 0)
      ) {
        // Removed after the person's observation, once the attempt is recorded.
        held = lab;
        return result;
      }
      const removed = await this.#options.lab.teardown(lab).catch(() => null);
      if (removed?.status === "removed") return result;
      const cleanupLabIds =
        result.status === "incomplete" ? (result.cleanupLabIds ?? []) : [];
      return {
        ...incomplete(
          "cleanup",
          removed?.nextStep ?? "Inspect and remove remaining Lab resources",
        ),
        cleanupLabIds: [...cleanupLabIds, lab.id],
      };
    };

    try {
      for (const [index, item] of items.entries()) {
        if (!trusted) {
          outcomes.push({
            findingId: item.findingId,
            verificationId: item.verificationId,
            status: "not-attempted",
          });
          continue;
        }
        const trace: ItemTrace = {
          labSetupDigest: campaignLabSetupDigest,
          reviewLabReady: false,
        };
        const decided = await decide(item, index + 1, trace);
        if (decided === "not-attempted") {
          outcomes.push({
            findingId: item.findingId,
            verificationId: item.verificationId,
            status: "not-attempted",
          });
          continue;
        }
        const last = index === size - 1 || !trusted;
        const result = last ? await release(decided) : decided;
        if (isAwaiting(result) && trace.reviewLabReady)
          waiting.push({
            campaignId,
            findingId: item.findingId,
            verificationId: item.verificationId,
            snapshotDigest,
          });
        outcomes.push({
          findingId: item.findingId,
          verificationId: item.verificationId,
          status: "recorded",
          result: await this.#record(common, item, trace, result, {
            campaignId,
            snapshotDigest,
          }),
        });
      }
    } catch (error) {
      const live = held ?? (released ? undefined : lab);
      if (live !== undefined)
        await this.#options.lab.teardown(live).catch(() => null);
      throw error;
    }
    if (lab !== undefined && !released) {
      // Only an untrusted Lab ends a run before its last Finding was recorded.
      released = true;
      const removed = await this.#options.lab.teardown(lab).catch(() => null);
      if (removed?.status !== "removed")
        throw new Error(
          `The verification Lab ${lab.id} was not removed: ${removed?.nextStep ?? "inspect and remove remaining Lab resources"}`,
        );
    }
    if (held !== undefined) {
      const kept = held;
      try {
        const [first] = waiting;
        if (first !== undefined)
          await common.hold!({
            lab: kept,
            ref: first,
            ...(waiting.length > 1 ? { batch: [...waiting] } : {}),
          });
      } finally {
        // The attempt is already recorded; a Lab left behind is `lab down`'s to remove.
        const removed = await this.#options.lab
          .teardown(kept)
          .catch(() => null);
        if (removed?.status !== "removed")
          throw new Error(
            `The held verification Lab ${kept.id} was not removed: ${removed?.nextStep ?? "inspect and remove remaining Lab resources"}`,
          );
      }
    }
    return outcomes;
  }

  /** A Lab that never became ready: its diagnostic in Private Evidence, its reason in the ledger. */
  async #recordLabFailure(
    campaignId: string,
    snapshotDigest: string,
    verificationId: string,
    findingId: string,
    provisioned: ProvisionIncomplete,
  ): Promise<void> {
    const occurredAt = (this.#options.clock ?? (() => new Date()))();
    const stage = provisioned.stage ?? "provision";
    // The exception and next step stay in Private Evidence (#284).
    const diagnosticDigest = await storeLabDiagnostic(
      this.#options.store,
      stage,
      provisioned,
    );
    if (stage === "seed") {
      // #699: the Lab started but its base environment did not hold.
      const labFailed = await this.#options.ledger.append({
        schemaVersion: 1,
        identity: `verification-lab-${verificationId}`,
        campaignId,
        snapshotDigest,
        occurredAt: occurredAt.toISOString(),
        type: "lab-provisioned",
        labId: provisioned.labId ?? verificationId,
        status: "failed",
        purpose: "verification",
        failureStage: "seed",
        reason: provisioned.reason,
        ...(provisioned.baseline === undefined
          ? {}
          : {
              baseline: {
                id: provisioned.baseline.id,
                digest: provisioned.baseline.digest,
              },
            }),
        artifacts: [{ kind: "lab-diagnostic", digest: diagnosticDigest }],
      });
      if (labFailed.status === "conflict")
        throw new Error("Verification Lab identity conflict");
    }
    const failed = await this.#options.ledger.append({
      schemaVersion: 1,
      identity: `verification-lab-failed-${verificationId}`,
      campaignId,
      snapshotDigest,
      occurredAt: occurredAt.toISOString(),
      type: "verification-lab-failed",
      findingId,
      verificationId,
      reason: provisioned.reason,
      artifacts: [{ kind: "lab-diagnostic", digest: diagnosticDigest }],
    });
    if (failed.status === "conflict")
      throw new Error("Verification Lab failure identity conflict");
  }

  /** Appends one Finding's `verification-finished` and returns what the ledger kept. */
  async #record(
    common: VerificationCommon<Setup, Handle>,
    item: {
      readonly findingId: string;
      readonly verificationId: string;
      readonly attempt: number | undefined;
      readonly retryOf: string | undefined;
    },
    trace: ItemTrace,
    decided: VerificationResultV1,
    parsed: { readonly campaignId: string; readonly snapshotDigest: string },
  ): Promise<VerificationResultV1> {
    const { campaignId, snapshotDigest } = parsed;
    const { findingId, verificationId, attempt, retryOf } = item;
    const { labSetupDigest, evidenceCapture, labStateDiff, recipeDigest } =
      trace;
    // A person checks a finished attempt in a new Lab built from this material.
    let reviewLabDigest: string | undefined;
    if (
      trace.reviewLabReady &&
      decided.status === "incomplete" &&
      decided.reason === "awaiting-human-observation" &&
      evidenceCapture === "harness-captured" &&
      decided.evidenceDigest !== undefined &&
      recipeDigest !== undefined
    ) {
      try {
        reviewLabDigest = await this.#options.store.putFiles({
          "lab.json": canonicalJson({
            schema: "review-lab-reconstruction/v1",
            snapshotDigest,
            labSetupDigest,
            setup: common.setup,
            snapshot: common.snapshot,
          }),
        });
      } catch {
        // Missing review material fails closed when a human asks to open it.
      }
    }
    // The recipe is review material by digest (#437); one the store lost stays out.
    const artifacts = [
      ...(reviewLabDigest === undefined
        ? []
        : [{ kind: "review-lab-reconstruction", digest: reviewLabDigest }]),
      ...(recipeDigest !== undefined &&
      (await this.#options.store.resolve(recipeDigest)).status === "resolved"
        ? [{ kind: "recipe", digest: recipeDigest }]
        : []),
      ...(labStateDiff?.status === "captured"
        ? labStateDiff.artifacts
        : []
      ).map((artifact) => ({ kind: artifact.kind, digest: artifact.digest })),
    ];
    const appended = await this.#options.ledger.append({
      schemaVersion: 1,
      identity: `verification-${verificationId}`,
      campaignId,
      snapshotDigest,
      occurredAt: (this.#options.clock ?? (() => new Date()))().toISOString(),
      type: "verification-finished",
      verificationId,
      findingId,
      labSetupDigest,
      ...(attempt === undefined ? {} : { attempt }),
      ...(retryOf === undefined ? {} : { retryOf }),
      ...(this.promptVersion === undefined
        ? {}
        : { promptVersion: this.promptVersion }),
      ...(common.basis === undefined
        ? {}
        : {
            basis: {
              kind: common.basis.kind,
              findingSnapshotDigest: digest.parse(
                common.basis.findingSnapshotDigest,
              ),
            },
          }),
      result: decided,
      ...(evidenceCapture === undefined ? {} : { evidenceCapture }),
      // The diff is review material by digest; a failed capture is recorded, never a verdict.
      ...(labStateDiff === undefined
        ? {}
        : labStateDiff.status === "captured"
          ? { labStateDiff: { status: "captured" as const } }
          : {
              labStateDiff: {
                status: "missing" as const,
                reason: labStateDiff.reason,
              },
            }),
      ...(artifacts.length === 0 ? {} : { artifacts }),
    });
    if (appended.status === "conflict")
      throw new Error("Verification identity conflict");
    // The ledger may downgrade the result (digest or evidence); report what it kept.
    const recorded = this.#options.ledger
      .readAll({ campaignId, findingId, type: "verification-finished" })
      .find(
        ({ event }) =>
          event.type === "verification-finished" &&
          event.verificationId === verificationId,
      );
    if (recorded?.event.type !== "verification-finished")
      throw new Error("Verification was not recorded");
    return recorded.event.result;
  }

  /** `snapshotDigest` is the snapshot under test: the Finding's own, or its target's latest. */
  async #attempt(run: VerificationRun<Finding, Handle>): Promise<{
    readonly result: VerificationResultV1;
    /** #699: the Verifier says the Lab may not serve another Finding. */
    readonly untrusted: boolean;
  }> {
    const result = await this.#attemptResult(run);
    return {
      result: "result" in result ? result.result : result,
      untrusted: "untrusted" in result,
    };
  }

  async #attemptResult(
    run: VerificationRun<Finding, Handle>,
  ): Promise<
    | VerificationResultV1
    | { readonly result: VerificationResultV1; readonly untrusted: true }
  > {
    const {
      campaignId,
      finding,
      record,
      snapshotDigest,
      lab,
      referenceRoute,
      batch,
      onCapture,
      onStateDiff,
    } = run;
    if (lab.snapshotDigest !== snapshotDigest)
      return incomplete(
        "digest-mismatch",
        "Provision the Lab from the snapshot under test",
      );
    // The observer sees the Lab before and after the Verifier; the Verifier sees neither capture.
    const observer = this.#options.stateObserver;
    let before =
      observer === undefined
        ? undefined
        : await observer.before(lab).catch(() => null);
    const observeAfter = async (): Promise<void> => {
      if (observer === undefined) return;
      if (before === null || before === undefined) {
        onStateDiff({ status: "missing", reason: "before-capture" });
        return;
      }
      onStateDiff(
        await observer.after(lab, before).catch((): LabStateDiffRecord => ({
          status: "missing",
          reason: "after-capture",
        })),
      );
    };
    let attempt: VerifierAttempt;
    try {
      attempt = await this.#options.verifier.attempt({
        campaignId,
        finding,
        lab,
        record,
        ...(referenceRoute === undefined ? {} : { referenceRoute }),
        ...(batch === undefined ? {} : { batch }),
        restartObservation: async () => {
          if (observer === undefined) return;
          before = await observer.before(lab).catch(() => null);
        },
      });
    } catch (error) {
      await observeAfter();
      if (error instanceof VerifierTransportIncompleteError)
        return incomplete(
          error.reason,
          `Repair the ${error.reason} transport and repeat with a fresh Verifier`,
        );
      return incomplete(
        "recipe",
        "The Verifier did not finish; repeat with a fresh Verifier",
      );
    }
    await observeAfter();
    if (attempt.status === "incomplete")
      return attempt.labUntrusted === true
        ? {
            result: incomplete(attempt.reason, attempt.nextStep),
            untrusted: true,
          }
        : incomplete(attempt.reason, attempt.nextStep);
    run.onRecipe(attempt.recipeDigest);
    let observation: AttemptObservation;
    try {
      observation = await this.#options.observer.observe({
        finding,
        lab,
        recipeDigest: attempt.recipeDigest,
      });
    } catch {
      return incomplete(
        "evidence",
        "The Harness could not record the Lab observation; repeat in a fresh Lab",
        attempt.refutationDigest,
      );
    }
    if (observation.status === "incomplete")
      return incomplete(
        observation.reason,
        observation.nextStep,
        attempt.refutationDigest,
      );
    onCapture("harness-captured");
    return incomplete(
      "awaiting-human-observation",
      AWAITING_HUMAN_OBSERVATION_NEXT_STEP,
      attempt.refutationDigest,
      observation.evidenceDigest,
    );
  }

  async #loadFinding(
    campaignId: string,
    findingId: string,
  ): Promise<{ finding: Finding; record: FindingRecord } | null> {
    const recorded = this.#options.ledger
      .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
      .at(0);
    const record = recorded?.event;
    if (record?.type !== "finding-recorded") return null;
    const reference = record.artifacts.find(
      (artifact) => artifact.kind === "finding",
    );
    if (reference === undefined) return null;
    const file = await this.#options.store.readJson(
      reference.digest,
      "finding.json",
      z.unknown(),
      1024 * 1024,
    );
    if (file.status !== "resolved") return null;
    try {
      // The profile's own reader is the schema here; it throws on a foreign shape.
      const finding = this.#options.readFinding(file.value);
      return finding.findingId === findingId ? { finding, record } : null;
    } catch {
      return null;
    }
  }
}
