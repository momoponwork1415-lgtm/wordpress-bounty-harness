import { describe, expect, it } from "vitest";

import {
  recordManualObservation,
  recordManualObservationLabReady,
} from "../../src/review/index.js";
import {
  submissionBasis,
  type BasisAnswer,
  type BasisUse,
} from "../../src/review/submission-basis.js";
import type { ReviewRef } from "../../src/review/records.js";
import {
  RECORDED_AT,
  recordedReviewState,
  type RecordedReviewState,
} from "../support/recorded-review-state.js";

const USES = ["reproduce", "scope", "draft", "authorize"] as const;
const OTHER_SNAPSHOT = `sha256:${"e".repeat(64)}`;
const LAB_SETUP = `sha256:${"d".repeat(64)}`;

type State = RecordedReviewState;
type Answers = Record<BasisUse, string>;

/** `basis` or the missing reason, for each review step. */
function answers(state: State, ref: ReviewRef): Answers {
  const show = (answer: BasisAnswer) =>
    answer.status === "basis" ? answer.basis.kind : answer.reason;
  return Object.fromEntries(
    USES.map((use) => [use, show(submissionBasis(state.ledger, ref, use))]),
  ) as Answers;
}

function judgeEraRef(state: State): ReviewRef {
  return {
    campaignId: state.campaignId,
    findingId: state.findings.accountTakeover.findingId,
    verificationId: state.findings.accountTakeover.verificationId!,
    snapshotDigest: state.snapshotDigest,
  };
}

const append = async (
  state: State,
  event: Parameters<State["ledger"]["append"]>[0],
) => {
  const result = await state.ledger.append(event);
  if (result.status !== "appended")
    throw new Error(`${event.type} not appended`);
};

/**
 * A second attempt on the recorded SQL injection that waits for a person's
 * observation, with the sealed review Lab package (ADR 0040).
 */
async function awaitingAttempt(
  state: State,
  options: {
    readonly verificationId?: string;
    readonly reason?: "awaiting-human-observation" | "observation";
    readonly capture?: "harness-captured" | "agent-authored";
  } = {},
): Promise<{ ref: ReviewRef; packageDigest: string }> {
  const verificationId = options.verificationId ?? "observed-attempt-2";
  const packageDigest = await state.store.putFiles({
    "lab.json": `Synthetic review Lab package for ${verificationId}`,
  });
  const observationDigest = await state.store.putFiles({
    "browser-dialog-observation.json": "Synthetic dialog",
  });
  await append(state, {
    schemaVersion: 1,
    identity: verificationId,
    campaignId: state.campaignId,
    snapshotDigest: state.snapshotDigest,
    occurredAt: RECORDED_AT,
    type: "verification-finished",
    findingId: state.findings.sqli.findingId,
    verificationId,
    attempt: 2,
    labSetupDigest: LAB_SETUP,
    evidenceCapture: options.capture ?? "harness-captured",
    artifacts: [{ kind: "review-lab-reconstruction", digest: packageDigest }],
    result: {
      status: "incomplete",
      reason: options.reason ?? "awaiting-human-observation",
      nextStep: "Observe in a new review Lab",
      evidenceDigest: observationDigest,
    },
  });
  return {
    ref: {
      campaignId: state.campaignId,
      findingId: state.findings.sqli.findingId,
      verificationId,
      snapshotDigest: state.snapshotDigest,
    },
    packageDigest,
  };
}

/** A named person's `review observe` in a fresh review Lab. */
async function observe(
  state: State,
  attempt: { ref: ReviewRef; packageDigest: string },
  result: "match" | "mismatch" | "unavailable",
): Promise<void> {
  const receipt = await recordManualObservationLabReady({
    ledger: state.ledger,
    store: state.store,
    ref: attempt.ref,
    packageDigest: attempt.packageDigest,
    sessionLabel: "wbh-review-net",
  });
  await recordManualObservation({
    ledger: state.ledger,
    store: state.store,
    ref: attempt.ref,
    packageDigest: attempt.packageDigest,
    sessionReceiptDigest: receipt,
    evidence: new TextEncoder().encode("Human saw the dialog"),
    result,
    recordedBy: "owner",
  });
}

/**
 * Ledger rows a person's `match` would leave, appended directly: the
 * recording commands refuse an attempt without a Harness capture.
 */
async function forgedMatch(
  state: State,
  attempt: { ref: ReviewRef; packageDigest: string },
): Promise<void> {
  const receipt = await state.store.putFiles({
    "manual-lab-session.json": "forged receipt",
  });
  const evidence = await state.store.putFiles({
    "manual-observation-evidence.bin": "forged evidence",
  });
  const common = {
    schemaVersion: 1 as const,
    campaignId: attempt.ref.campaignId,
    findingId: attempt.ref.findingId,
    verificationId: attempt.ref.verificationId,
    snapshotDigest: attempt.ref.snapshotDigest,
    labSetupDigest: LAB_SETUP,
    packageDigest: attempt.packageDigest,
    sessionReceiptDigest: receipt,
    occurredAt: RECORDED_AT,
  };
  await append(state, {
    ...common,
    identity: "forged-ready",
    type: "manual-observation-lab-ready",
    artifacts: [{ kind: "manual-lab-session", digest: receipt }],
  });
  await append(state, {
    ...common,
    identity: "forged-observation",
    type: "manual-observation-recorded",
    evidenceDigest: evidence,
    result: "match",
    recordedBy: "owner",
    artifacts: [
      { kind: "manual-lab-session", digest: receipt },
      { kind: "manual-observation-evidence", digest: evidence },
    ],
  });
}

/** The reviewer's own `review decide --reproduced` through the CLI. */
async function reproduce(
  state: State,
  findingId: string,
  result: "match" | "mismatch" | "unavailable",
) {
  return state.run(
    "review",
    "decide",
    "--campaign",
    state.campaignId,
    "--finding",
    findingId,
    "--decision",
    "defer",
    "--reason",
    "manual-reproduction",
    "--reproduced",
    result,
    "--by",
    "owner",
    "--reproduce-minutes",
    "1",
    "--minutes",
    "1",
  );
}

async function anotherAttempt(state: State, findingId: string) {
  await append(state, {
    schemaVersion: 1,
    identity: `later-attempt-${findingId}`,
    campaignId: state.campaignId,
    snapshotDigest: state.snapshotDigest,
    occurredAt: RECORDED_AT,
    type: "verification-finished",
    findingId,
    verificationId: `later-attempt-${findingId}`,
    attempt: 3,
    labSetupDigest: LAB_SETUP,
    artifacts: [],
    result: { status: "incomplete", reason: "evidence", nextStep: "Retry" },
  });
}

const basisEverywhere: Answers = {
  reproduce: "human-observed",
  scope: "human-observed",
  draft: "human-observed",
  authorize: "human-observed",
};

describe("submission basis (ADR 0040, invariants 3, 5, 7)", () => {
  const cases: readonly {
    readonly name: string;
    readonly arrange: (state: State) => Promise<ReviewRef>;
    readonly expected: Answers;
  }[] = [
    {
      name: "judge-era confirmed result before the reviewer reproduced it",
      arrange: async (state) => judgeEraRef(state),
      expected: {
        reproduce: "judge-era",
        scope: "judge-era",
        draft: "judge-era",
        authorize: "no-reproduction-match",
      },
    },
    {
      name: "judge-era confirmed result the reviewer reproduced as match",
      arrange: async (state) => {
        expect(
          (
            await reproduce(
              state,
              state.findings.accountTakeover.findingId,
              "match",
            )
          ).code,
        ).toBe(0);
        return judgeEraRef(state);
      },
      expected: {
        reproduce: "judge-era",
        scope: "judge-era",
        draft: "judge-era",
        authorize: "judge-era",
      },
    },
    {
      name: "judge-era result after a later attempt keeps scope, not draft",
      arrange: async (state) => {
        await anotherAttempt(state, state.findings.accountTakeover.findingId);
        return judgeEraRef(state);
      },
      expected: {
        reproduce: "judge-era",
        scope: "judge-era",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "no attempt with this verification ID",
      arrange: async (state) => ({
        ...judgeEraRef(state),
        verificationId: "never-recorded",
      }),
      // Draft and authorization ask for the current attempt first.
      expected: {
        reproduce: "no-verification",
        scope: "no-verification",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "judge-era result on another Snapshot",
      arrange: async (state) => ({
        ...judgeEraRef(state),
        snapshotDigest: OTHER_SNAPSHOT,
      }),
      expected: {
        reproduce: "snapshot-mismatch",
        scope: "snapshot-mismatch",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "observed result on another Snapshot",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        return { ...attempt.ref, snapshotDigest: OTHER_SNAPSHOT };
      },
      expected: {
        reproduce: "snapshot-mismatch",
        scope: "snapshot-mismatch",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "incomplete attempt that does not await a human observation",
      arrange: async (state) => ({
        campaignId: state.campaignId,
        findingId: state.findings.sqli.findingId,
        verificationId: state.findings.sqli.verificationId!,
        snapshotDigest: state.snapshotDigest,
      }),
      expected: {
        reproduce: "not-awaiting-human-observation",
        scope: "not-awaiting-human-observation",
        draft: "not-awaiting-human-observation",
        authorize: "not-awaiting-human-observation",
      },
    },
    {
      name: "old incomplete(observation) a person observed as match",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state, { reason: "observation" });
        await observe(state, attempt, "match");
        return attempt.ref;
      },
      expected: {
        reproduce: "not-awaiting-human-observation",
        scope: "not-awaiting-human-observation",
        draft: "not-awaiting-human-observation",
        authorize: "not-awaiting-human-observation",
      },
    },
    {
      name: "attempt without a Harness capture",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state, {
          capture: "agent-authored",
        });
        await forgedMatch(state, attempt);
        return attempt.ref;
      },
      expected: {
        reproduce: "no-harness-capture",
        scope: "no-harness-capture",
        draft: "no-harness-capture",
        authorize: "no-harness-capture",
      },
    },
    {
      name: "captured attempt nobody observed yet",
      arrange: async (state) => (await awaitingAttempt(state)).ref,
      expected: {
        reproduce: "no-human-match",
        scope: "no-human-match",
        draft: "no-human-match",
        authorize: "no-human-match",
      },
    },
    {
      name: "captured attempt a person observed as mismatch",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "mismatch");
        return attempt.ref;
      },
      expected: {
        reproduce: "no-human-match",
        scope: "no-human-match",
        draft: "no-human-match",
        authorize: "no-human-match",
      },
    },
    {
      name: "match recorded for an older review Lab receipt",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        // A newer review Lab became ready; the old receipt's match no longer counts.
        await recordManualObservationLabReady({
          ledger: state.ledger,
          store: state.store,
          ref: attempt.ref,
          packageDigest: attempt.packageDigest,
          sessionLabel: "wbh-review-net-2",
        });
        return attempt.ref;
      },
      expected: {
        reproduce: "no-human-match",
        scope: "no-human-match",
        draft: "no-human-match",
        authorize: "no-human-match",
      },
    },
    {
      name: "observed as match before the reviewer's own reproduction",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        return attempt.ref;
      },
      expected: {
        reproduce: "human-observed",
        scope: "no-reproduction-match",
        draft: "no-reproduction-match",
        authorize: "no-reproduction-match",
      },
    },
    {
      name: "observed as match, reviewer's latest reproduction is mismatch",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        expect(
          (await reproduce(state, attempt.ref.findingId, "match")).code,
        ).toBe(0);
        expect(
          (await reproduce(state, attempt.ref.findingId, "mismatch")).code,
        ).toBe(0);
        return attempt.ref;
      },
      expected: {
        reproduce: "human-observed",
        scope: "no-reproduction-match",
        draft: "no-reproduction-match",
        authorize: "no-reproduction-match",
      },
    },
    {
      name: "observed and reproduced as match",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        expect(
          (await reproduce(state, attempt.ref.findingId, "match")).code,
        ).toBe(0);
        return attempt.ref;
      },
      expected: basisEverywhere,
    },
    {
      name: "observed and reproduced, then a later attempt",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        await reproduce(state, attempt.ref.findingId, "match");
        await anotherAttempt(state, attempt.ref.findingId);
        return attempt.ref;
      },
      expected: {
        reproduce: "superseded",
        scope: "superseded",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "observed and reproduced, then a newer latest-version Finding",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        await reproduce(state, attempt.ref.findingId, "match");
        await append(state, {
          schemaVersion: 1,
          identity: "latest-version-finding",
          campaignId: state.campaignId,
          snapshotDigest: OTHER_SNAPSHOT,
          occurredAt: RECORDED_AT,
          type: "finding-recorded",
          findingId: "latest-version-finding",
          runId: state.runId,
          category: "sqli",
          derivedFromFindingId: attempt.ref.findingId,
          derivationKind: "latest-version",
        });
        return attempt.ref;
      },
      expected: {
        reproduce: "superseded",
        scope: "superseded",
        draft: "superseded",
        authorize: "superseded",
      },
    },
    {
      name: "observed and reproduced, then parked",
      arrange: async (state) => {
        const attempt = await awaitingAttempt(state);
        await observe(state, attempt, "match");
        await reproduce(state, attempt.ref.findingId, "match");
        await append(state, {
          schemaVersion: 1,
          identity: "parked-sqli",
          campaignId: state.campaignId,
          snapshotDigest: state.snapshotDigest,
          occurredAt: RECORDED_AT,
          type: "finding-parked",
          findingId: attempt.ref.findingId,
          runId: state.runId,
          category: "sqli",
          reason: "outside-programme-boundary",
        });
        return attempt.ref;
      },
      expected: {
        reproduce: "parked",
        scope: "parked",
        draft: "parked",
        authorize: "parked",
      },
    },
  ];

  it.each(cases)("$name", async ({ arrange, expected }) => {
    const state = await recordedReviewState();
    const ref = await arrange(state);
    expect(answers(state, ref)).toEqual(expected);
  });

  it("returns the package, the person's observation and the reviewer's reproduction", async () => {
    const state = await recordedReviewState();
    const attempt = await awaitingAttempt(state);
    await observe(state, attempt, "match");
    await reproduce(state, attempt.ref.findingId, "match");
    const answer = submissionBasis(state.ledger, attempt.ref, "authorize");
    expect(answer).toMatchObject({
      status: "basis",
      basis: {
        kind: "human-observed",
        packageDigest: attempt.packageDigest,
        current: true,
        verification: { verificationId: attempt.ref.verificationId },
        observation: { result: "match", recordedBy: "owner" },
        reproduction: { result: "match" },
      },
    });
    const judgeEra = submissionBasis(state.ledger, judgeEraRef(state), "scope");
    expect(judgeEra).toMatchObject({
      status: "basis",
      basis: {
        kind: "judge-era",
        packageDigest: state.findings.accountTakeover.reproductionPackageDigest,
        reproduction: null,
      },
    });
  });
});

/**
 * The only behaviour change: the CLI's own check and the scope facts read
 * Review's basis, so they refuse what Review's gate refused one step later.
 */
describe("the CLI refuses what Review's gate refuses", () => {
  const scopeRecorded = (state: State) =>
    state.ledger.readAll({
      campaignId: state.campaignId,
      type: "scope-assessed",
    }).length;

  it("does not assess scope or save a draft before the reviewer's --reproduced match", async () => {
    const state = await recordedReviewState();
    const attempt = await awaitingAttempt(state);
    await observe(state, attempt, "match");
    const finding = [
      "--campaign",
      state.campaignId,
      "--finding",
      attempt.ref.findingId,
    ];
    // Before: the CLI passed it on and Review threw (exit 1). Now a usage error.
    const scoped = await state.run("review", "scope", ...finding);
    expect(scoped.code).toBe(2);
    expect(scoped.stderr).toContain(
      "Scope is assessed only for evidence-backed findings",
    );
    const drafted = await state.run(
      "review",
      "draft",
      ...finding,
      "--programme",
      "wordfence",
      "--file",
      "/nonexistent",
    );
    expect(drafted.code).toBe(2);
    expect(drafted.stderr).toContain(
      "A confirmed verification is required for a draft",
    );
    expect(scopeRecorded(state)).toBe(0);

    expect((await reproduce(state, attempt.ref.findingId, "match")).code).toBe(
      0,
    );
    const assessed = await state.run("review", "scope", ...finding);
    expect(assessed.code).toBe(0);
    expect(scopeRecorded(state)).toBeGreaterThan(0);
  });

  it("does not record a reproduction or assess scope without a Harness capture", async () => {
    const state = await recordedReviewState();
    const attempt = await awaitingAttempt(state, { capture: "agent-authored" });
    await forgedMatch(state, attempt);
    const queue = await state.run("review", "--campaign", state.campaignId);
    // The listing still shows the recorded match; it is not a basis.
    expect(queue.stdout).toContain("manual observation: match");
    const reproduced = await reproduce(state, attempt.ref.findingId, "match");
    expect(reproduced.code).toBe(2);
    expect(reproduced.stderr).toContain(
      "Only an evidence-backed package can be reproduced",
    );
    expect(
      state.ledger.readAll({
        campaignId: state.campaignId,
        type: "human-reproduction-recorded",
      }),
    ).toHaveLength(0);
    const scoped = await state.run(
      "review",
      "scope",
      "--campaign",
      state.campaignId,
      "--finding",
      attempt.ref.findingId,
    );
    expect(scoped.code).toBe(2);
    expect(scopeRecorded(state)).toBe(0);
  });
});
