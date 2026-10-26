import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RECORDED_AT,
  recordedReviewState,
  type RecordedReviewState,
} from "../support/recorded-review-state.js";

type State = RecordedReviewState;

const append = async (
  state: State,
  event: Parameters<State["ledger"]["append"]>[0],
) => {
  const result = await state.ledger.append(event);
  if (result.status !== "appended")
    throw new Error(`${event.type} not appended`);
};

async function decide(
  state: State,
  findingId: string,
  decision: string,
  reason: string,
  duplicate?: string,
) {
  const decided = await state.run(
    "review",
    "decide",
    "--campaign",
    state.campaignId,
    "--finding",
    findingId,
    "--decision",
    decision,
    "--reason",
    reason,
    ...(duplicate === undefined ? [] : ["--duplicate", duplicate]),
  );
  if (decided.code !== 0) throw new Error(decided.stderr);
}

/**
 * The recorded SQL injection verified again: the attempt waits for a person,
 * who recorded a match in a review Lab (receipt and evidence in Private
 * Evidence).
 */
async function reverifyWithObservation(state: State): Promise<void> {
  const findingId = state.findings.sqli.findingId;
  const verificationId = "observed-attempt-2";
  const labSetupDigest = `sha256:${"d".repeat(64)}`;
  const packageDigest = await state.store.putFiles({
    "lab.json": "Synthetic review Lab package",
  });
  await append(state, {
    schemaVersion: 1,
    identity: verificationId,
    campaignId: state.campaignId,
    snapshotDigest: state.snapshotDigest,
    occurredAt: RECORDED_AT,
    type: "verification-finished",
    findingId,
    verificationId,
    attempt: 2,
    labSetupDigest,
    evidenceCapture: "harness-captured",
    artifacts: [{ kind: "review-lab-reconstruction", digest: packageDigest }],
    result: {
      status: "incomplete",
      reason: "awaiting-human-observation",
      nextStep: "Observe in a new review Lab",
    },
  });
  const receipt = await state.store.putFiles({
    "manual-lab-session.json": "Synthetic receipt",
  });
  const evidence = await state.store.putFiles({
    "manual-observation-evidence.bin": "Synthetic evidence",
  });
  const common = {
    schemaVersion: 1 as const,
    campaignId: state.campaignId,
    findingId,
    verificationId,
    snapshotDigest: state.snapshotDigest,
    labSetupDigest,
    packageDigest,
    sessionReceiptDigest: receipt,
    occurredAt: RECORDED_AT,
  };
  await append(state, {
    ...common,
    identity: "observed-ready",
    type: "manual-observation-lab-ready",
    artifacts: [{ kind: "manual-lab-session", digest: receipt }],
  });
  await append(state, {
    ...common,
    identity: "observed-match",
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

/**
 * `campaign-2` in the same ledger records both Findings under the same IDs,
 * unverified, each with one decision whose private record cannot be read: an
 * older event that references none, and one whose record is missing.
 */
async function sameNamedFindingsElsewhere(state: State): Promise<void> {
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-2",
    snapshotDigest: state.snapshotDigest,
    occurredAt: RECORDED_AT,
  };
  const findings = [state.findings.accountTakeover, state.findings.sqli];
  for (const finding of findings)
    await append(state, {
      ...base,
      identity: `campaign-2-finding-${finding.findingId}`,
      type: "finding-recorded",
      findingId: finding.findingId,
      runId: state.runId,
      trialId: state.runId,
      category: finding.category,
      preconditionClass: "default",
      artifacts: [],
    });
  await append(state, {
    ...base,
    identity: "campaign-2-old-decision",
    type: "review-decided",
    findingId: state.findings.accountTakeover.findingId,
    decision: "reject",
    artifacts: [],
  });
  const lost = await state.store.putFiles({
    "record.json": "Lost review record",
  });
  await append(state, {
    ...base,
    identity: "campaign-2-missing-record",
    type: "review-decided",
    findingId: state.findings.sqli.findingId,
    decision: "defer",
    artifacts: [{ kind: "review-decision", digest: lost }],
  });
  await rm(state.store.contentPath(lost), { recursive: true });
}

/** The listing with the temporary state directory replaced, so it can be pinned. */
async function listing(state: State, ...argv: string[]) {
  const listed = await state.run("review", ...argv);
  expect(listed.code).toBe(0);
  expect(listed.stderr).toBe("");
  return listed.stdout.replaceAll(state.root, "<root>");
}

/** `review` prints exactly what it printed before Review assembled the listing (#494). */
describe("review listing on recorded history", () => {
  it("prints reasons from the current target and duplicates from the latest decision", async () => {
    const state = await recordedReviewState();
    const { accountTakeover, sqli } = state.findings;
    await decide(
      state,
      accountTakeover.findingId,
      "accept",
      "reproduced-by-hand",
      "possible-match:CVE-2026-0001",
    );
    await decide(state, sqli.findingId, "defer", "needs-lab", "no-match");
    await reverifyWithObservation(state);
    await sameNamedFindingsElsewhere(state);

    // After the new attempt the SQL injection has no current decision, but its
    // stage-4 result stays; campaign-2's records are unreadable.
    expect(await listing(state)).toMatchInlineSnapshot(`
      "runtime-confirmed  campaign-1  finding sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  account-takeover
        verification recorded-verification-account-takeover  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  1 finding(s)  representative
        observer: synthetic-recorded-judge
        observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator
        evidence: sha256:f27e4c78979a5c9d120ddd1fea6ce29139eacffe8a7e9eb2d5a894521877ddb3
        reproduction package: sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f (<root>/state/private-evidence/sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f/content)
        decision: accept (reproduced-by-hand)
        duplicate: possible-match  CVE-2026-0001  checked 2026-10-08T00:00:00.000Z
      incomplete  campaign-1  finding sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  sqli
        verification observed-attempt-2  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  1 finding(s)  representative
        reason: awaiting-human-observation
        next: Observe in a new review Lab
        manual observation: match (evidence available; receipt sha256:5a7eb7a693330bd14fe33aa39c246b4e514dfaf6fe19dbccd278c8d65d1ab1bf, evidence sha256:9457c96104255926dc753c6b5e0a77161c7022d72af922317703d0ce5c9bbc19)
        decision: none
        duplicate: no-match  checked 2026-10-08T00:00:00.000Z
      not-verified  campaign-2  finding sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  account-takeover
        verification none  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  1 finding(s)  representative
        decision: reject
        duplicate: none
      not-verified  campaign-2  finding sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  sqli
        verification none  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  1 finding(s)  representative
        decision: defer
        duplicate: none
      incomplete by reason: awaiting-human-observation 1
      precondition class: admin-configuration 0, common-usage 0, default 4, unknown 0
      retry candidates by reason: none
      contradicted: 0  unverified: 2"
    `);

    await decide(state, sqli.findingId, "defer", "awaiting-observation");
    expect(await listing(state, "--campaign", state.campaignId))
      .toMatchInlineSnapshot(`
      "runtime-confirmed  campaign-1  finding sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  account-takeover
        verification recorded-verification-account-takeover  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  1 finding(s)  representative
        observer: synthetic-recorded-judge
        observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator
        evidence: sha256:f27e4c78979a5c9d120ddd1fea6ce29139eacffe8a7e9eb2d5a894521877ddb3
        reproduction package: sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f (<root>/state/private-evidence/sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f/content)
        decision: accept (reproduced-by-hand)
        duplicate: possible-match  CVE-2026-0001  checked 2026-10-08T00:00:00.000Z
      incomplete  campaign-1  finding sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  sqli
        verification observed-attempt-2  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  1 finding(s)  representative
        reason: awaiting-human-observation
        next: Observe in a new review Lab
        manual observation: match (evidence available; receipt sha256:5a7eb7a693330bd14fe33aa39c246b4e514dfaf6fe19dbccd278c8d65d1ab1bf, evidence sha256:9457c96104255926dc753c6b5e0a77161c7022d72af922317703d0ce5c9bbc19)
        decision: defer (awaiting-observation)
        duplicate: no-match  checked 2026-10-08T00:00:00.000Z
      incomplete by reason: awaiting-human-observation 1
      precondition class: admin-configuration 0, common-usage 0, default 2, unknown 0
      retry candidates by reason: none
      contradicted: 0  unverified: 0"
    `);
    expect(await listing(state, "--campaign", "campaign-2"))
      .toMatchInlineSnapshot(`
      "not-verified  campaign-2  finding sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  account-takeover
        verification none  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  1 finding(s)  representative
        decision: reject
        duplicate: none
      not-verified  campaign-2  finding sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  sqli
        verification none  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  1 finding(s)  representative
        decision: defer
        duplicate: none
      incomplete by reason: none
      precondition class: admin-configuration 0, common-usage 0, default 2, unknown 0
      retry candidates by reason: none
      contradicted: 0  unverified: 2"
    `);
  });

  it("prints an unavailable observation and an empty queue", async () => {
    const state = await recordedReviewState();
    await reverifyWithObservation(state);
    const evidence = state.ledger
      .readAll({ type: "manual-observation-recorded" })
      .at(0)?.event;
    if (evidence?.type !== "manual-observation-recorded")
      throw new Error("No observation");
    await rm(state.store.contentPath(evidence.evidenceDigest), {
      recursive: true,
    });
    expect(await listing(state, "--campaign", state.campaignId))
      .toMatchInlineSnapshot(`
      "runtime-confirmed  campaign-1  finding sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  account-takeover
        verification recorded-verification-account-takeover  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:33ecad54d6ee10dee4097cfd5843ed7c5fc26db0891b9854fed4219e3ad28aa8  1 finding(s)  representative
        observer: synthetic-recorded-judge
        observed: attackerRole=subscriber defaultSettings=true observedVia=session reachedRole=administrator
        evidence: sha256:f27e4c78979a5c9d120ddd1fea6ce29139eacffe8a7e9eb2d5a894521877ddb3
        reproduction package: sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f (<root>/state/private-evidence/sha256:14c08a70c095ca081e10c9025acf60a23f95b0d76c3d3043ae5f39626d13468f/content)
        decision: none
        duplicate: none
      incomplete  campaign-1  finding sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  sqli
        verification observed-attempt-2  snapshot sha256:5555555555555555555555555555555555555555555555555555555555555555
        group sha256:2e904700837603d50955d6486a636ab65fdbb3caaecc4a983ddfcc9e258cac66  1 finding(s)  representative
        reason: awaiting-human-observation
        next: Observe in a new review Lab
        manual observation: match (evidence unavailable; receipt sha256:5a7eb7a693330bd14fe33aa39c246b4e514dfaf6fe19dbccd278c8d65d1ab1bf, evidence sha256:9457c96104255926dc753c6b5e0a77161c7022d72af922317703d0ce5c9bbc19)
        decision: none
        duplicate: none
      incomplete by reason: awaiting-human-observation 1
      precondition class: admin-configuration 0, common-usage 0, default 2, unknown 0
      retry candidates by reason: none
      contradicted: 0  unverified: 0"
    `);
    expect(await listing(state, "--campaign", "campaign-empty"))
      .toMatchInlineSnapshot(`
      "review queue is empty
      incomplete by reason: none
      precondition class: admin-configuration 0, common-usage 0, default 0, unknown 0
      retry candidates by reason: none
      contradicted: 0  unverified: 0"
    `);
  });
});
