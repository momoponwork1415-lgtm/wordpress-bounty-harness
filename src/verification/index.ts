import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import {
  provisionThrew,
  storeLabDiagnostic,
  type LabHandle,
  type LabProvisioner,
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
  }): Promise<VerifierAttempt>;
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
  readonly canaryIssued?: VerifierRunEvent["canaryIssued"];
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
    ...(input.canaryIssued === undefined
      ? {}
      : { canaryIssued: input.canaryIssued }),
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
      readonly nextScenarioId?: string;
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
  readonly onCapture: (capture: "harness-captured") => void;
  /** Receives where the before / after Lab state diff went (#186). */
  readonly onStateDiff: (record: LabStateDiffRecord) => void;
  /** Receives the Verifier's stored recipe, review material whatever happens next (#437). */
  readonly onRecipe: (recipeDigest: string) => void;
};
/** What a person does next with a finished attempt; no Harness code confirms (#525). */
const AWAITING_HUMAN_OBSERVATION_NEXT_STEP =
  "Open a fresh review Lab, read the Harness capture and browser record, and record the human observation";
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
  async verify(input: {
    readonly campaignId: string;
    readonly findingId: string;
    readonly verificationId: string;
    /** One-based attempt number recorded with the verdict; absent for older callers. */
    readonly attempt?: number;
    /** Verification ID immediately preceding this attempt. */
    readonly retryOf?: string;
    readonly snapshot: { readonly digest: string };
    /** Marks a version comparison; the Finding still belongs to this snapshot. */
    readonly basis?: {
      readonly kind: "latest-version" | "fixed-version";
      readonly findingSnapshotDigest: string;
    };
    readonly setup: Setup;
    readonly campaignLabSetupDigest: string;
    readonly referenceRoute?: unknown;
  }): Promise<VerificationResultV1> {
    const campaignId = id.parse(input.campaignId);
    const findingId = id.parse(input.findingId);
    const verificationId = id.parse(input.verificationId);
    const attempt =
      input.attempt === undefined
        ? undefined
        : z.number().int().positive().parse(input.attempt);
    const retryOf =
      input.retryOf === undefined ? undefined : id.parse(input.retryOf);
    const snapshotDigest = digest.parse(input.snapshot.digest);
    let labSetupDigest = digest.parse(input.campaignLabSetupDigest);
    let evidenceCapture: "harness-captured" | undefined;
    let labStateDiff: LabStateDiffRecord | undefined;
    let recipeDigest: string | undefined;
    let reviewLabReady = false;
    const loaded = await this.#loadFinding(campaignId, findingId);

    const decide = async (): Promise<VerificationResultV1> => {
      if (loaded === null)
        return incomplete(
          "precondition",
          "Record the finding with its private claim before verification",
        );
      const { finding, record } = loaded;
      if (
        finding.snapshotDigest !== snapshotDigest ||
        (input.basis !== undefined &&
          input.basis.findingSnapshotDigest !== snapshotDigest)
      )
        return incomplete(
          "digest-mismatch",
          "Repeat verification against the finding snapshot",
        );
      if (input.basis?.kind === "fixed-version") {
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
      const provisioned = await this.#options.lab
        .provision(input.snapshot, input.setup, { purpose: "verification" })
        .catch(provisionThrew);
      if (provisioned.status !== "ready") {
        const reason = provisioned.reason;
        // The exception and next step stay in Private Evidence (#284).
        const diagnosticDigest = await storeLabDiagnostic(
          this.#options.store,
          "provision",
          provisioned,
        );
        const failed = await this.#options.ledger.append({
          schemaVersion: 1,
          identity: `verification-lab-failed-${verificationId}`,
          campaignId,
          snapshotDigest,
          occurredAt: (
            this.#options.clock ?? (() => new Date())
          )().toISOString(),
          type: "verification-lab-failed",
          findingId,
          verificationId,
          reason,
          artifacts: [{ kind: "lab-diagnostic", digest: diagnosticDigest }],
        });
        if (failed.status === "conflict")
          throw new Error("Verification Lab failure identity conflict");
        return incomplete(reason, provisioned.nextStep);
      }
      const lab = provisioned.handle;
      labSetupDigest = lab.setupDigest;
      reviewLabReady = lab.snapshotDigest === snapshotDigest;
      let result: VerificationResultV1 = incomplete(
        "evidence",
        "Verification stopped unexpectedly; repeat in a fresh Lab",
      );
      const run: VerificationRun<Finding, Handle> = {
        campaignId,
        finding,
        record,
        snapshotDigest,
        lab,
        referenceRoute: input.referenceRoute,
        onCapture: (capture) => {
          evidenceCapture = capture;
        },
        onStateDiff: (record) => {
          labStateDiff = record;
        },
        onRecipe: (digest) => {
          recipeDigest = digest;
        },
      };
      try {
        const labEvent = await this.#options.ledger.append({
          schemaVersion: 1,
          identity: `verification-lab-${verificationId}`,
          campaignId,
          snapshotDigest,
          occurredAt: (
            this.#options.clock ?? (() => new Date())
          )().toISOString(),
          type: "lab-provisioned",
          labId: lab.id,
          status: "ready",
          purpose: "verification",
          ...(lab.scenario === undefined ? {} : { scenario: lab.scenario }),
        });
        if (labEvent.status === "conflict")
          throw new Error("Verification Lab identity conflict");
        result = await this.#attempt(run);
      } catch {
        result = incomplete(
          "evidence",
          "Verification stopped unexpectedly; repeat in a fresh Lab",
        );
      } finally {
        const removed = await this.#options.lab.teardown(lab).catch(() => null);
        if (removed?.status !== "removed") {
          const cleanupLabIds =
            result.status === "incomplete" ? (result.cleanupLabIds ?? []) : [];
          result = {
            ...incomplete(
              "cleanup",
              removed?.nextStep ?? "Inspect and remove remaining Lab resources",
            ),
            cleanupLabIds: [...cleanupLabIds, lab.id],
          };
        }
      }
      return result;
    };

    const decided = await decide();
    // A person checks a finished attempt in a new Lab built from this material.
    let reviewLabDigest: string | undefined;
    if (
      reviewLabReady &&
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
            setup: input.setup,
            snapshot: input.snapshot,
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
      ...(input.basis === undefined
        ? {}
        : {
            basis: {
              kind: input.basis.kind,
              findingSnapshotDigest: digest.parse(
                input.basis.findingSnapshotDigest,
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
  async #attempt(
    run: VerificationRun<Finding, Handle>,
  ): Promise<VerificationResultV1> {
    const {
      campaignId,
      finding,
      record,
      snapshotDigest,
      lab,
      referenceRoute,
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
      return {
        ...incomplete(attempt.reason, attempt.nextStep),
        ...(attempt.nextScenarioId === undefined
          ? {}
          : { nextScenarioId: attempt.nextScenarioId }),
      };
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
