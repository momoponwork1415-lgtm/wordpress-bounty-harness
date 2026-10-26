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
 * ADR 0022 retry budget, shared by the verification queues (which retry) and the
 * review queue (which predicts what they will do). Counts include the attempt
 * that produced the current reason. `recipe` gets two automatic retries on the
 * same Lab Setup, `provision` one re-provision, `provider` one retry on resume
 * (2026-10-14 addendum); every other reason goes to a human without retry.
 * `precondition` retried only on a changed Lab scenario, and scenarios were
 * removed in #353. `observation` came from the deleted judges and no longer
 * retries (#525, ADR 0040).
 */
export function shouldAutomaticallyRetryVerification(input: {
  readonly reason: IncompleteReason;
  readonly attemptsForReason: number;
  readonly sameLabSetup: boolean;
}): boolean {
  switch (input.reason) {
    case "recipe":
      return input.sameLabSetup && input.attemptsForReason < 3;
    case "provision":
    case "provider":
      return input.sameLabSetup && input.attemptsForReason < 2;
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
