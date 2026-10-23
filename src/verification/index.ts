import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner } from "../lab/index.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import {
  publishReproductionPackage,
  type ReproductionRenderer,
  type VerificationResultV1,
} from "./reproduction-package.js";

export {
  publishReproductionPackage,
  verificationResultV1Schema,
  type ReproductionRenderer,
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
  /** Profile classification, used only to select a reproduction template. */
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
    /** Earlier judge-owned route for a same-path version comparison. */
    readonly referenceRoute?: unknown;
    /**
     * Retakes the Harness-owned Lab state baseline from now. A Verifier whose
     * precondition setup precedes the attacker steps calls it once setup is
     * done, so what setup changed is neither diffed nor judged.
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

/** Harness-owned deterministic observation of a nonce canary. */
export interface Judge<Finding, Handle extends LabHandle> {
  readonly id: string;
  observe(input: {
    readonly finding: Finding;
    readonly lab: Handle;
    readonly recipeDigest: string;
    readonly referenceRoute?: unknown;
  }): Promise<JudgeObservation>;
}
export type JudgeObservation =
  | {
      readonly status: "observed";
      readonly evidenceDigest: string;
      readonly evidenceCapture?: "harness-captured" | "agent-authored";
      /** Facts the judge observed, e.g. attacker role and reached role. */
      readonly conditions: Readonly<Record<string, string>>;
    }
  | {
      readonly status: "not-observed";
      /** Negative evidence must come from a Harness-owned capture. */
      readonly evidenceCapture?: "harness-captured" | "agent-authored";
      readonly evidenceDigest?: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: "precondition" | "observation" | "evidence";
      readonly nextStep: string;
      readonly evidenceCapture?: "harness-captured" | "agent-authored";
      readonly evidenceDigest?: string;
    };

export interface JudgeSet<Finding, Handle extends LabHandle> {
  for(finding: Finding): Judge<Finding, Handle> | null;
  /** Optional profile fallback when no nonce judge can establish the claim. */
  readonly reproducer?: Reproducer<Finding, Handle>;
}

export interface Reproducer<Finding, Handle extends LabHandle> {
  readonly id: string;
  /** Whether this impact can be proven by this reproducer's evidence channel. */
  supports(finding: Finding): boolean;
  observe(input: {
    readonly finding: Finding;
    readonly lab: Handle;
    readonly recipeDigest: string;
    readonly referenceRoute?: unknown;
  }): Promise<ReproducerObservation>;
}
export type ReproducerObservation =
  | {
      readonly status: "observed";
      readonly evidenceDigest: string;
      readonly conditions: Readonly<Record<string, string>>;
    }
  | {
      readonly status: "not-observed";
      readonly evidenceDigest: string;
    }
  | {
      readonly status: "incomplete";
      readonly reason: "recipe" | "observation" | "evidence";
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
 * Verifier run (#186). The Verifier never receives it, and no judge reads it:
 * it is review material, not proof.
 */
export interface LabStateObserver<Handle extends LabHandle> {
  before(lab: Handle): Promise<LabStateCapture | null>;
  after(lab: Handle, before: LabStateCapture): Promise<LabStateDiffRecord>;
}

type Incomplete = Extract<VerificationResultV1, { status: "incomplete" }>;
type ReplayNeeded = {
  readonly status: "replay-needed";
  readonly attempt: Extract<VerifierAttempt, { status: "attempted" }>;
};
type VerificationRun<
  Finding extends VerifiableFinding,
  Setup,
  Handle extends LabHandle,
  Reconstruction,
> = {
  readonly campaignId: string;
  readonly verificationId: string;
  readonly finding: Finding;
  readonly record: FindingRecord;
  readonly snapshotDigest: string;
  readonly lab: Handle;
  readonly reconstruction: Reconstruction;
  readonly setup: Setup;
  readonly snapshot: { readonly digest: string };
  readonly referenceRoute: unknown;
  readonly basisKind: "latest-version" | "fixed-version" | undefined;
  readonly onCapture: (capture: "harness-captured" | "agent-authored") => void;
  /** Receives where the before / after Lab state diff went (#186). */
  readonly onStateDiff: (record: LabStateDiffRecord) => void;
  /** Receives the Verifier's stored recipe, review material whatever the judge says (#437). */
  readonly onRecipe: (recipeDigest: string) => void;
};
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
  Reconstruction,
> = {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
  readonly lab: LabProvisioner<Setup, Handle>;
  readonly verifier: Verifier<Finding, Handle>;
  readonly judges: JudgeSet<Finding, Handle>;
  /** Profile parser for the private Finding record. */
  readonly readFinding: (value: unknown) => Finding;
  readonly renderer: ReproductionRenderer<Reconstruction>;
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
  Reconstruction,
> {
  readonly promptVersion: string | undefined;
  readonly #options: VerificationOptions<
    Finding,
    Setup,
    Handle,
    Reconstruction
  >;

  constructor(
    options: VerificationOptions<Finding, Setup, Handle, Reconstruction>,
  ) {
    this.#options = options;
    this.promptVersion =
      options.promptVersion === undefined
        ? undefined
        : id.parse(options.promptVersion);
  }

  /** Failures stay incomplete; judges alone confirm, while captured scripts may reproduce. */
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
    readonly reconstruction: Reconstruction;
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
    let evidenceCapture: "harness-captured" | "agent-authored" | undefined;
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
      const judge = this.#options.judges.for(finding);
      if (judge === null && !this.#options.judges.reproducer?.supports(finding))
        return incomplete(
          "no-judge",
          "No standard reproduction runner is configured for this impact",
        );
      const provisioned = await this.#options.lab
        .provision(input.snapshot, input.setup, { purpose: "verification" })
        .catch(() => null);
      if (provisioned === null || provisioned.status !== "ready") {
        const reason =
          provisioned?.status === "incomplete" &&
          provisioned.reason === "precondition"
            ? "precondition"
            : "provision";
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
        });
        if (failed.status === "conflict")
          throw new Error("Verification Lab failure identity conflict");
        return incomplete(
          reason,
          provisioned?.nextStep ?? "Provision a fresh Lab and repeat",
        );
      }
      const lab = provisioned.handle;
      labSetupDigest = lab.setupDigest;
      reviewLabReady = lab.snapshotDigest === snapshotDigest;
      let result: VerificationResultV1 = incomplete(
        "evidence",
        "Verification stopped unexpectedly; repeat in a fresh Lab",
      );
      let replayAttempt: ReplayNeeded["attempt"] | undefined;
      let primaryLabRemoved = false;
      const run: VerificationRun<Finding, Setup, Handle, Reconstruction> = {
        campaignId,
        verificationId,
        finding,
        record,
        snapshotDigest,
        lab,
        reconstruction: input.reconstruction,
        setup: input.setup,
        snapshot: input.snapshot,
        referenceRoute: input.referenceRoute,
        basisKind: input.basis?.kind,
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
        const judged = await this.#judge(run, judge);
        if (judged.status === "replay-needed") replayAttempt = judged.attempt;
        else result = judged;
      } catch {
        result = incomplete(
          "evidence",
          "Verification stopped unexpectedly; repeat in a fresh Lab",
        );
      } finally {
        const removed = await this.#options.lab.teardown(lab).catch(() => null);
        if (removed?.status === "removed") primaryLabRemoved = true;
        else {
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
      // The provider's host lease permits only one verification Lab. Keep the
      // recipe and state-diff evidence, release the agent Lab, then replay.
      if (replayAttempt !== undefined && primaryLabRemoved) {
        try {
          result = await this.#replayInFreshLab(run, replayAttempt);
        } catch {
          result = incomplete(
            "evidence",
            "The fresh reproduction Lab stopped unexpectedly; repeat",
          );
        }
      }
      return result;
    };

    const decided = await decide();
    // A low-confidence observation can be checked by a person in a new Lab.
    // This is reconstruction material only; it never changes the judge result.
    let reviewLabDigest: string | undefined;
    if (
      reviewLabReady &&
      decided.status === "incomplete" &&
      decided.reason === "observation" &&
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
  async #judge(
    run: VerificationRun<Finding, Setup, Handle, Reconstruction>,
    judge: Judge<Finding, Handle> | null,
  ): Promise<VerificationResultV1 | ReplayNeeded> {
    const {
      campaignId,
      finding,
      record,
      snapshotDigest,
      lab,
      reconstruction,
      setup,
      snapshot,
      referenceRoute,
      basisKind,
      onCapture,
      onStateDiff,
    } = run;
    if (lab.snapshotDigest !== snapshotDigest)
      return incomplete(
        "digest-mismatch",
        "Provision the Lab from the snapshot under test",
      );
    const seeded = await this.#options.lab.seedCanaries(lab).catch(() => null);
    if (seeded?.status !== "seeded")
      return incomplete(
        "provision",
        seeded?.nextStep ?? "Seed canaries in a fresh Lab",
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
    if (judge === null) return { status: "replay-needed", attempt };
    let observation: JudgeObservation;
    try {
      observation = await judge.observe({
        finding,
        lab,
        recipeDigest: attempt.recipeDigest,
        ...(referenceRoute === undefined ? {} : { referenceRoute }),
      });
    } catch {
      return incomplete(
        "observation",
        "The judge could not observe the Lab; repeat in a fresh Lab",
      );
    }
    if (observation.status === "incomplete") {
      if (
        observation.reason === "observation" &&
        this.#options.judges.reproducer?.supports(finding) === true
      ) {
        return { status: "replay-needed", attempt };
      }
      if (observation.evidenceCapture !== undefined)
        onCapture(observation.evidenceCapture);
      return incomplete(
        observation.reason,
        observation.nextStep,
        attempt.refutationDigest,
        observation.evidenceDigest,
      );
    }
    if (observation.status === "observed") {
      if (observation.evidenceCapture !== undefined)
        onCapture(observation.evidenceCapture);
      return publishReproductionPackage({
        store: this.#options.store,
        renderer: this.#options.renderer,
        category: finding.impact ?? "unclassified",
        findingSnapshotDigest: snapshotDigest,
        labSnapshotDigest: lab.snapshotDigest,
        labSetupDigest: lab.setupDigest,
        judgeResult: {
          status: "runtime-confirmed",
          judgeId: judge.id,
          proofKind: "nonce-canary",
          conditions: observation.conditions,
          evidenceDigest: observation.evidenceDigest,
        },
        reconstruction,
        setup,
        snapshot,
      });
    }
    if (observation.evidenceCapture !== undefined)
      onCapture(observation.evidenceCapture);
    if (
      basisKind === "fixed-version" &&
      referenceRoute !== undefined &&
      observation.evidenceCapture === "harness-captured" &&
      observation.evidenceDigest !== undefined &&
      attempt.refutationDigest !== undefined
    )
      return {
        status: "contradicted",
        judgeId: judge.id,
        evidenceDigest: observation.evidenceDigest,
        refutationDigest: attempt.refutationDigest,
      };
    return incomplete(
      "observation",
      "The judge saw no canary without a captured fixed-version negative control; repair the recipe and repeat",
      attempt.refutationDigest,
      observation.evidenceCapture === "harness-captured"
        ? observation.evidenceDigest
        : undefined,
    );
  }

  /** The Verifier can modify its Lab; only a separately provisioned Lab may reproduce. */
  async #replayInFreshLab(
    run: VerificationRun<Finding, Setup, Handle, Reconstruction>,
    attempt: Extract<VerifierAttempt, { status: "attempted" }>,
  ): Promise<VerificationResultV1> {
    const provisioned = await this.#options.lab
      .provision(run.snapshot, run.setup, { purpose: "verification" })
      .catch(() => null);
    if (provisioned === null || provisioned.status !== "ready")
      return incomplete(
        "provision",
        provisioned?.nextStep ??
          "Provision a fresh reproduction Lab and repeat",
      );
    const replayLab = provisioned.handle;
    // A provider returning the agent's Lab has not supplied an independent run.
    if (replayLab.id === run.lab.id) {
      const removed = await this.#options.lab
        .teardown(replayLab)
        .catch(() => null);
      if (removed?.status !== "removed")
        return {
          ...incomplete(
            "cleanup",
            removed?.nextStep ?? "Inspect and remove the reproduction Lab",
          ),
          cleanupLabIds: [replayLab.id],
        };
      return incomplete(
        "provision",
        "Provision a distinct reproduction Lab before replaying the route",
      );
    }
    let result: VerificationResultV1 = incomplete(
      "evidence",
      "The fresh reproduction Lab stopped unexpectedly; repeat",
    );
    try {
      result = await this.#observeFreshLab(run, attempt, replayLab);
    } catch {
      result = incomplete(
        "evidence",
        "The fresh reproduction Lab stopped unexpectedly; repeat",
      );
    } finally {
      const removed = await this.#options.lab
        .teardown(replayLab)
        .catch(() => null);
      if (removed?.status !== "removed")
        result = {
          ...incomplete(
            "cleanup",
            removed?.nextStep ?? "Inspect and remove the reproduction Lab",
          ),
          cleanupLabIds: [replayLab.id],
        };
    }
    return result;
  }

  async #observeFreshLab(
    run: VerificationRun<Finding, Setup, Handle, Reconstruction>,
    attempt: Extract<VerifierAttempt, { status: "attempted" }>,
    replayLab: Handle,
  ): Promise<VerificationResultV1> {
    if (
      replayLab.snapshotDigest !== run.snapshotDigest ||
      replayLab.setupDigest !== run.lab.setupDigest ||
      canonicalJson(replayLab.scenario ?? null) !==
        canonicalJson(run.lab.scenario ?? null)
    )
      return incomplete(
        "digest-mismatch",
        "Recreate the reproduction Lab from the same Snapshot and setup",
      );
    const appended = await this.#options.ledger.append({
      schemaVersion: 1,
      identity: `verification-replay-lab-${run.verificationId}`,
      campaignId: run.campaignId,
      snapshotDigest: run.snapshotDigest,
      occurredAt: (this.#options.clock ?? (() => new Date()))().toISOString(),
      type: "lab-provisioned",
      labId: replayLab.id,
      status: "ready",
      purpose: "verification",
      ...(replayLab.scenario === undefined
        ? {}
        : { scenario: replayLab.scenario }),
    });
    if (appended.status === "conflict")
      return incomplete(
        "evidence",
        "The reproduction Lab ledger identity conflicts",
      );
    const seeded = await this.#options.lab
      .seedCanaries(replayLab)
      .catch(() => null);
    if (seeded?.status !== "seeded")
      return incomplete(
        "provision",
        seeded?.nextStep ?? "Seed canaries in a fresh reproduction Lab",
      );
    return this.#reproduce({ ...run, lab: replayLab }, attempt);
  }

  async #reproduce(
    run: VerificationRun<Finding, Setup, Handle, Reconstruction>,
    attempt: Extract<VerifierAttempt, { status: "attempted" }>,
  ): Promise<VerificationResultV1> {
    const {
      finding,
      snapshotDigest,
      lab,
      reconstruction,
      setup,
      snapshot,
      referenceRoute,
      basisKind,
      onCapture,
    } = run;
    const reproducer = this.#options.judges.reproducer;
    if (reproducer === undefined)
      return incomplete(
        "no-judge",
        "No standard reproduction runner is configured",
      );
    let observation: ReproducerObservation;
    try {
      observation = await reproducer.observe({
        finding,
        lab,
        recipeDigest: attempt.recipeDigest,
        ...(referenceRoute === undefined ? {} : { referenceRoute }),
      });
    } catch {
      return incomplete(
        "observation",
        "The standard reproduction failed in a fresh Lab",
      );
    }
    if (observation.status === "incomplete")
      return incomplete(observation.reason, observation.nextStep);
    onCapture("harness-captured");
    if (observation.status === "not-observed") {
      return incomplete(
        "observation",
        "The captured standard script did not reach the expected observation; a nonce judge is required to contradict the fixed-version claim",
        attempt.refutationDigest,
        observation.evidenceDigest,
      );
    }
    return publishReproductionPackage({
      store: this.#options.store,
      renderer: this.#options.renderer,
      category: finding.impact ?? "unclassified",
      findingSnapshotDigest: snapshotDigest,
      labSnapshotDigest: lab.snapshotDigest,
      labSetupDigest: lab.setupDigest,
      judgeResult: {
        status: "reproduced",
        reproducerId: reproducer.id,
        proofKind: "captured-script-observation",
        conditions: observation.conditions,
        evidenceDigest: observation.evidenceDigest,
      },
      reconstruction,
      setup,
      snapshot,
      negativeControl:
        basisKind === "latest-version"
          ? "unavailable-no-fixed-release"
          : "pending-fixed-version",
    });
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
