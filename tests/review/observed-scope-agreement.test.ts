import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  Review,
  recordManualObservation,
  recordManualObservationLabReady,
  reviewExportV2Schema,
  type ReviewExportV2,
} from "../../src/review/index.js";
import type { ReviewRef } from "../../src/review/records.js";
import {
  createWordpressScopeEvaluator,
  loadWordpressScopePolicy,
} from "../../src/profiles/wordpress/scope-policy.js";
import { createWordPressScopeFacts } from "../../src/profiles/wordpress/scope-facts.js";
import {
  recordedReviewState,
  type RecordedReviewState,
} from "../support/recorded-review-state.js";

/**
 * #578: `review scope` and wbh-report's 書く前の確認 read the same records. The
 * human path of check 1 (an `awaiting-human-observation` attempt, the person's
 * `match` with its evidence available, their own `--reproduced match` after
 * the attempt) and check 4 (the latest `review scope` output is `in-scope`
 * in the export) are written here from the export the skill reads.
 */

type State = RecordedReviewState;
const LAB_SETUP = `sha256:${"d".repeat(64)}`;
/** Before the fixture's clock (RECORDED_AT), so the reviewer's records come after it. */
const ATTEMPT_AT = "2026-10-07T00:00:00.000Z";

async function awaitingAttempt(
  state: State,
): Promise<{ ref: ReviewRef; packageDigest: string }> {
  const verificationId = "observed-attempt-2";
  const packageDigest = await state.store.putFiles({
    "lab.json": "Synthetic review Lab package",
  });
  const evidenceDigest = await state.store.putFiles({
    "browser-dialog-observation.json": "Synthetic dialog",
  });
  const appended = await state.ledger.append({
    schemaVersion: 1,
    identity: verificationId,
    campaignId: state.campaignId,
    snapshotDigest: state.snapshotDigest,
    occurredAt: ATTEMPT_AT,
    type: "verification-finished",
    findingId: state.findings.sqli.findingId,
    verificationId,
    attempt: 2,
    labSetupDigest: LAB_SETUP,
    // Checked on the latest version, as `review reverify` records it.
    basis: {
      kind: "latest-version",
      findingSnapshotDigest: state.snapshotDigest,
    },
    evidenceCapture: "harness-captured",
    artifacts: [{ kind: "review-lab-reconstruction", digest: packageDigest }],
    result: {
      status: "incomplete",
      reason: "awaiting-human-observation",
      nextStep: "Observe in a new review Lab",
      evidenceDigest,
    },
  });
  if (appended.status !== "appended") throw new Error("attempt not appended");
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
  result: "match" | "mismatch",
  ordinaryPublicSite?: boolean,
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
    ...(ordinaryPublicSite === undefined
      ? {}
      : {
          configuration: {
            ordinaryPublicSite,
            reason: ordinaryPublicSite
              ? "Plugin defaults on a fresh install"
              : "Needed a developer-only debug setting",
          },
        }),
  });
}

async function reproduce(state: State, findingId: string) {
  const ran = await state.run(
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
    "match",
    "--by",
    "owner",
    "--reproduce-minutes",
    "1",
    "--minutes",
    "1",
  );
  expect(ran.code).toBe(0);
}

async function exported(state: State, findingId: string) {
  const ran = await state.run(
    "review",
    "export",
    "--campaign",
    state.campaignId,
    "--finding",
    findingId,
    "--version",
    "2",
  );
  expect(ran.code).toBe(0);
  return reviewExportV2Schema.parse(JSON.parse(ran.stdout));
}

/** wbh-report 書く前の確認 1, the human-observed path. */
function reportCheckOne(bundle: ReviewExportV2): boolean {
  const { verification, review } = bundle;
  return (
    verification !== null &&
    verification.status === "incomplete" &&
    verification.reason === "awaiting-human-observation" &&
    review.manualObservation?.result === "match" &&
    review.manualObservation.evidenceStatus === "available" &&
    review.humanReproduction?.result === "match" &&
    review.humanReproduction.recordedAt > verification.occurredAt
  );
}

/** The Wordfence line of `review scope`, or null when the CLI refused it. */
async function wordfenceScope(state: State, findingId: string) {
  const ran = await state.run(
    "review",
    "scope",
    "--campaign",
    state.campaignId,
    "--finding",
    findingId,
  );
  if (ran.code !== 0) return null;
  const line = ran.stdout
    .split("\n")
    .find((item) => item.startsWith("wordfence "));
  const match = /^wordfence (\S+) .*assessment (sha256:[a-f0-9]{64})$/.exec(
    line ?? "",
  );
  if (match === null) throw new Error(`Unexpected scope output: ${ran.stdout}`);
  return { status: match[1]!, assessmentId: match[2]! };
}

/** Both views of one ledger state, with the agreements the skill relies on. */
async function bothViews(state: State, findingId: string) {
  const scope = await wordfenceScope(state, findingId);
  const bundle = await exported(state, findingId);
  // Check 1 holds exactly when `review scope` has a basis to assess.
  expect(scope !== null).toBe(reportCheckOne(bundle));
  if (scope !== null) {
    // Check 4 finds the latest `review scope` output in the export.
    expect(
      bundle.review.scopeAssessments.find(
        (item) => item.assessmentId === `scope:${scope.assessmentId}`,
      )?.status,
    ).toBe(scope.status);
    // In scope exactly when the person stated an ordinary public site.
    expect(scope.status === "in-scope").toBe(
      bundle.review.manualObservation?.configuration?.ordinaryPublicSite ===
        true,
    );
  }
  return { scope, bundle };
}

describe("review scope agrees with wbh-report's pre-check (#578)", () => {
  it.each([
    [true, "in-scope"],
    [false, "out-of-scope"],
    [undefined, "ambiguous"],
  ] as const)(
    "a match the person stated ordinary=%s is %s on both sides",
    async (ordinaryPublicSite, status) => {
      const state = await recordedReviewState();
      const attempt = await awaitingAttempt(state);
      await observe(state, attempt, "match", ordinaryPublicSite);
      // Before the reviewer's own reproduction neither side proceeds.
      expect((await bothViews(state, attempt.ref.findingId)).scope).toBeNull();
      await reproduce(state, attempt.ref.findingId);
      const { scope, bundle } = await bothViews(state, attempt.ref.findingId);
      expect(scope?.status).toBe(status);
      expect(bundle.review.manualObservation?.configuration).toEqual(
        ordinaryPublicSite === undefined
          ? null
          : {
              ordinaryPublicSite,
              record: {
                digest: expect.stringMatching(/^sha256:/),
                path: expect.stringMatching(
                  /manual-observation-configuration\.json$/,
                ),
              },
            },
      );
    },
  );

  it("refuses scope on both sides after a mismatch", async () => {
    const state = await recordedReviewState();
    const attempt = await awaitingAttempt(state);
    await observe(state, attempt, "mismatch", true);
    expect((await bothViews(state, attempt.ref.findingId)).scope).toBeNull();
  });

  it("re-assesses a new observation and drafts only on its assessment", async () => {
    const state = await recordedReviewState();
    const attempt = await awaitingAttempt(state);
    const findingId = attempt.ref.findingId;
    await observe(state, attempt, "match", true);
    await reproduce(state, findingId);
    const first = await bothViews(state, findingId);
    expect(first.scope?.status).toBe("in-scope");

    // The person reopens the review Lab and states another configuration.
    await observe(state, attempt, "match", false);
    await reproduce(state, findingId);
    const second = await bothViews(state, findingId);
    expect(second.scope?.status).toBe("out-of-scope");
    expect(second.scope?.assessmentId).not.toBe(first.scope?.assessmentId);

    // `review draft` takes the latest assessment, which is no longer in scope,
    // and the earlier in-scope assessment cannot be drafted on either.
    const report = join(state.root, "report.md");
    await writeFile(report, "Synthetic report");
    const draft = await state.run(
      "review",
      "draft",
      "--campaign",
      state.campaignId,
      "--finding",
      findingId,
      "--programme",
      "wordfence",
      "--file",
      report,
    );
    expect(draft.code).not.toBe(0);
    expect(draft.stderr).toContain("No in-scope assessment for wordfence");
    const review = new Review({
      ledger: state.ledger,
      artifactStore: state.store,
      scopeEvaluator: createWordpressScopeEvaluator(
        await loadWordpressScopePolicy(),
      ),
      factsProvider: createWordPressScopeFacts({
        ledger: state.ledger,
        store: state.store,
      }),
    });
    await expect(
      review.saveDraft({
        assessmentId: first.scope!.assessmentId,
        content: "Synthetic report",
        preparedBy: "human",
      }),
    ).rejects.toThrow(
      "An in-scope assessment of the current observation is required",
    );

    // Back to an ordinary configuration: in scope again, and drafts.
    await observe(state, attempt, "match", true);
    await reproduce(state, findingId);
    const third = await bothViews(state, findingId);
    expect(third.scope?.status).toBe("in-scope");
    expect(third.scope?.assessmentId).not.toBe(first.scope?.assessmentId);
    const drafted = await state.run(
      "review",
      "draft",
      "--campaign",
      state.campaignId,
      "--finding",
      findingId,
      "--programme",
      "wordfence",
      "--file",
      report,
    );
    expect(drafted.code).toBe(0);
    expect(drafted.stdout).toMatch(/^candidate sha256:.* to wordfence$/);
  });
});
