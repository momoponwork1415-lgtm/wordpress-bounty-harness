import { describe, expect, it } from "vitest";

import type { LedgerEventV1 } from "../../src/ledger/index.js";
import {
  countAttemptsForReason,
  shouldAutomaticallyRetryVerification,
  type IncompleteReason,
} from "../../src/verification/retry-budget.js";

const labSetup = `sha256:${"b".repeat(64)}`;
const otherSetup = `sha256:${"c".repeat(64)}`;

describe("ADR 0022 retry budget", () => {
  // One row per reason: automatic retries left after 1, 2, 3 attempts on the same Lab Setup.
  it.each<{ reason: IncompleteReason; retryAfter: readonly boolean[] }>([
    { reason: "recipe", retryAfter: [true, true, false] },
    { reason: "observation", retryAfter: [false, false, false] },
    { reason: "provision", retryAfter: [true, false, false] },
    { reason: "provider", retryAfter: [true, false, false] },
    { reason: "evidence", retryAfter: [false, false, false] },
    { reason: "cleanup", retryAfter: [false, false, false] },
    { reason: "digest-mismatch", retryAfter: [false, false, false] },
    { reason: "no-judge", retryAfter: [false, false, false] },
    { reason: "awaiting-human-observation", retryAfter: [false, false, false] },
    { reason: "sandbox", retryAfter: [false, false, false] },
  ])("$reason: attempts 1..3 -> $retryAfter", ({ reason, retryAfter }) => {
    expect(
      retryAfter.map((_, index) =>
        shouldAutomaticallyRetryVerification({
          reason,
          attemptsForReason: index + 1,
          sameLabSetup: true,
        }),
      ),
    ).toEqual(retryAfter);
    expect(
      shouldAutomaticallyRetryVerification({
        reason,
        attemptsForReason: 1,
        sameLabSetup: false,
      }),
    ).toBe(false);
  });

  it.each([
    { previous: "a", current: "b", retry: true },
    { previous: "a", current: "a", retry: false },
    { previous: null, current: "b", retry: true },
    { previous: null, current: null, retry: false },
    { previous: undefined, current: "b", retry: false },
    { previous: "a", current: undefined, retry: false },
  ])(
    "precondition: scenario $previous -> $current retries $retry",
    ({ previous, current, retry }) => {
      for (const attemptsForReason of [1, 5])
        expect(
          shouldAutomaticallyRetryVerification({
            reason: "precondition",
            attemptsForReason,
            sameLabSetup: true,
            previousScenarioId: previous,
            currentScenarioId: current,
          }),
        ).toBe(retry);
    },
  );

  it("counts attempts per Lab Setup digest, prompt version and reason", () => {
    const base = {
      schemaVersion: 1 as const,
      type: "verification-finished" as const,
      campaignId: "campaign-1",
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      findingId: "finding-1",
      occurredAt: "2026-10-08T00:00:00Z",
      artifacts: [],
    };
    const incomplete = (
      verificationId: string,
      reason: IncompleteReason,
      labSetupDigest: string,
      promptVersion?: string,
    ): Extract<LedgerEventV1, { type: "verification-finished" }> => ({
      ...base,
      identity: verificationId,
      verificationId,
      labSetupDigest,
      ...(promptVersion === undefined ? {} : { promptVersion }),
      result: { status: "incomplete", reason, nextStep: "Retry" },
    });
    const history = [
      incomplete("v1", "recipe", labSetup, "p1"),
      incomplete("v2", "recipe", labSetup, "p1"),
      incomplete("v3", "observation", labSetup, "p1"),
      incomplete("v4", "recipe", otherSetup, "p1"),
      incomplete("v5", "recipe", labSetup, "p2"),
      incomplete("v6", "recipe", labSetup),
    ];
    const count = (
      reason: IncompleteReason,
      labSetupDigest: string,
      promptVersion: string | undefined,
    ) =>
      countAttemptsForReason(history, {
        reason,
        labSetupDigest,
        promptVersion,
      });
    expect(count("recipe", labSetup, "p1")).toBe(2);
    expect(count("observation", labSetup, "p1")).toBe(1);
    expect(count("recipe", otherSetup, "p1")).toBe(1);
    expect(count("recipe", labSetup, "p2")).toBe(1);
    expect(count("recipe", labSetup, undefined)).toBe(1);
    expect(count("provision", labSetup, "p1")).toBe(0);
  });
});
