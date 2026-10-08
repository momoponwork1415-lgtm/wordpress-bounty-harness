import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { LabHandle, LabProvisioner } from "../lab/index.js";
import type { Ledger } from "../ledger/index.js";
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

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** The fields every profile Finding carries; the rest stays profile-specific. */
export interface VerifiableFinding {
  readonly findingId: string;
  readonly snapshotDigest: string;
}

/** A fresh-container agent that repairs and refutes a recipe. It cannot confirm. */
export interface Verifier<Finding, Handle extends LabHandle> {
  attempt(input: {
    readonly finding: Finding;
    readonly lab: Handle;
  }): Promise<VerifierAttempt>;
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
    };

/** Harness-owned deterministic observation of a nonce canary. */
export interface Judge<Finding, Handle extends LabHandle> {
  readonly id: string;
  observe(input: {
    readonly finding: Finding;
    readonly lab: Handle;
    readonly recipeDigest: string;
  }): Promise<JudgeObservation>;
}
export type JudgeObservation =
  | { readonly status: "observed"; readonly evidenceDigest: string }
  | { readonly status: "not-observed" }
  | {
      readonly status: "incomplete";
      readonly reason: "precondition" | "observation" | "evidence";
      readonly nextStep: string;
    };

export interface JudgeSet<Finding, Handle extends LabHandle> {
  for(finding: Finding): Judge<Finding, Handle> | null;
}

type Incomplete = Extract<VerificationResultV1, { status: "incomplete" }>;
const incomplete = (
  reason: Incomplete["reason"],
  nextStep: string,
): Incomplete => ({ status: "incomplete", reason, nextStep });

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
  readonly clock?: () => Date;
};

export class Verification<
  Finding extends VerifiableFinding,
  Setup,
  Handle extends LabHandle,
  Reconstruction,
> {
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
  }

  /** Every failure path is incomplete; only a judge observation can confirm. */
  async verify(input: {
    readonly campaignId: string;
    readonly findingId: string;
    readonly verificationId: string;
    readonly snapshot: { readonly digest: string };
    readonly setup: Setup;
    readonly campaignLabSetupDigest: string;
    readonly reconstruction: Reconstruction;
  }): Promise<VerificationResultV1> {
    const campaignId = id.parse(input.campaignId);
    const findingId = id.parse(input.findingId);
    const verificationId = id.parse(input.verificationId);
    const snapshotDigest = digest.parse(input.snapshot.digest);
    let labSetupDigest = digest.parse(input.campaignLabSetupDigest);
    const finding = await this.#loadFinding(campaignId, findingId);

    const decide = async (): Promise<VerificationResultV1> => {
      if (finding === null)
        return incomplete(
          "precondition",
          "Record the finding with its private claim before verification",
        );
      if (finding.snapshotDigest !== snapshotDigest)
        return incomplete(
          "digest-mismatch",
          "Repeat verification against the finding snapshot",
        );
      const judge = this.#options.judges.for(finding);
      if (judge === null)
        return incomplete(
          "no-judge",
          "No Harness judge covers this impact; check it by hand",
        );
      const provisioned = await this.#options.lab
        .provision(input.snapshot, input.setup)
        .catch(() => null);
      if (provisioned === null || provisioned.status !== "ready")
        return incomplete(
          "provision",
          provisioned?.nextStep ?? "Provision a fresh Lab and repeat",
        );
      const lab = provisioned.handle;
      labSetupDigest = lab.setupDigest;
      let result: VerificationResultV1;
      try {
        result = await this.#judge(finding, judge, lab, input.reconstruction);
      } catch {
        result = incomplete(
          "evidence",
          "Verification stopped unexpectedly; repeat in a fresh Lab",
        );
      } finally {
        const removed = await this.#options.lab.teardown(lab).catch(() => null);
        if (removed?.status !== "removed")
          result = incomplete(
            "cleanup",
            removed?.nextStep ?? "Inspect and remove remaining Lab resources",
          );
      }
      return result;
    };

    const decided = await decide();
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
      result: decided,
    });
    if (appended.status === "conflict")
      throw new Error("Verification identity conflict");
    // The ledger may downgrade the result (digest or evidence); report what it kept.
    const recorded = this.#options.ledger
      .read({
        campaignId,
        findingId,
        type: "verification-finished",
        limit: 1000,
      })
      .find(
        ({ event }) =>
          event.type === "verification-finished" &&
          event.verificationId === verificationId,
      );
    if (recorded?.event.type !== "verification-finished")
      throw new Error("Verification was not recorded");
    return recorded.event.result;
  }

  async #judge(
    finding: Finding,
    judge: Judge<Finding, Handle>,
    lab: Handle,
    reconstruction: Reconstruction,
  ): Promise<VerificationResultV1> {
    if (lab.snapshotDigest !== finding.snapshotDigest)
      return incomplete(
        "digest-mismatch",
        "Provision the Lab from the finding snapshot",
      );
    const seeded = await this.#options.lab.seedCanaries(lab).catch(() => null);
    if (seeded?.status !== "seeded")
      return incomplete(
        "provision",
        seeded?.nextStep ?? "Seed canaries in a fresh Lab",
      );
    let attempt: VerifierAttempt;
    try {
      attempt = await this.#options.verifier.attempt({ finding, lab });
    } catch {
      return incomplete(
        "recipe",
        "The Verifier did not finish; repeat with a fresh Verifier",
      );
    }
    if (attempt.status === "incomplete")
      return incomplete(attempt.reason, attempt.nextStep);
    let observation: JudgeObservation;
    try {
      observation = await judge.observe({
        finding,
        lab,
        recipeDigest: attempt.recipeDigest,
      });
    } catch {
      return incomplete(
        "observation",
        "The judge could not observe the Lab; repeat in a fresh Lab",
      );
    }
    if (observation.status === "incomplete")
      return incomplete(observation.reason, observation.nextStep);
    if (observation.status === "observed")
      return publishReproductionPackage({
        store: this.#options.store,
        renderer: this.#options.renderer,
        findingSnapshotDigest: finding.snapshotDigest,
        labSnapshotDigest: lab.snapshotDigest,
        labSetupDigest: lab.setupDigest,
        judgeResult: {
          status: "runtime-confirmed",
          judgeId: judge.id,
          proofKind: "nonce-canary",
          evidenceDigest: observation.evidenceDigest,
        },
        reconstruction,
      });
    if (attempt.refutationDigest !== undefined)
      return {
        status: "contradicted",
        judgeId: judge.id,
        evidenceDigest: attempt.refutationDigest,
      };
    return incomplete(
      "observation",
      "The judge saw no canary and the Verifier wrote no refutation; repair the recipe and repeat",
    );
  }

  async #loadFinding(
    campaignId: string,
    findingId: string,
  ): Promise<Finding | null> {
    const recorded = this.#options.ledger
      .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
      .at(0);
    const reference = recorded?.event.artifacts.find(
      (artifact) => artifact.kind === "finding",
    );
    if (reference === undefined) return null;
    const file = await this.#options.store.readFile(
      reference.digest,
      "finding.json",
      1024 * 1024,
    );
    if (file.status !== "resolved") return null;
    try {
      const finding = this.#options.readFinding(
        JSON.parse(file.bytes.toString("utf8")) as unknown,
      );
      return finding.findingId === findingId ? finding : null;
    } catch {
      return null;
    }
  }
}
