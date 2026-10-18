import type { LedgerEventV1 } from "../ledger/index.js";
import type { VerificationResultV1 } from "./reproduction-package.js";

export type IncompleteReason = Extract<
  VerificationResultV1,
  { status: "incomplete" }
>["reason"];
type FinishedVerification = Extract<
  LedgerEventV1,
  { type: "verification-finished" }
>;

/**
 * ADR 0022 retry budget, shared by the runner (which retries) and the review
 * queue (which predicts what the runner will do). Counts include the attempt
 * that produced the current reason. `recipe` / `observation` get two automatic
 * retries on the same Lab Setup, `provision` one re-provision, `provider` one
 * retry on resume (2026-10-14 addendum), `precondition` only when the scenario
 * id changed; every other reason goes to a human without retry.
 */
export function shouldAutomaticallyRetryVerification(input: {
  readonly reason: IncompleteReason;
  readonly attemptsForReason: number;
  readonly sameLabSetup: boolean;
  /** null is a recorded default scenario; undefined means no scenario record. */
  readonly previousScenarioId?: string | null | undefined;
  readonly currentScenarioId?: string | null | undefined;
}): boolean {
  switch (input.reason) {
    case "recipe":
    case "observation":
      return input.sameLabSetup && input.attemptsForReason < 3;
    case "provision":
    case "provider":
      return input.sameLabSetup && input.attemptsForReason < 2;
    case "precondition":
      return (
        input.previousScenarioId !== undefined &&
        input.currentScenarioId !== undefined &&
        input.previousScenarioId !== input.currentScenarioId
      );
    default:
      return false;
  }
}

/** Attempts that share ADR 0022's budget key: Lab Setup digest, Verifier prompt version, reason. */
export function countAttemptsForReason(
  history: readonly FinishedVerification[],
  budget: {
    readonly labSetupDigest: string;
    readonly promptVersion: string | undefined;
    readonly reason: IncompleteReason;
  },
): number {
  return history.filter(
    (event) =>
      event.labSetupDigest === budget.labSetupDigest &&
      event.promptVersion === budget.promptVersion &&
      event.result.status === "incomplete" &&
      event.result.reason === budget.reason,
  ).length;
}
