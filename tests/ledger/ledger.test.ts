import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const otherSnapshot = `sha256:${"b".repeat(64)}`;
const labSetup = `sha256:${"c".repeat(64)}`;
const revision = `sha256:${"d".repeat(64)}`;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ledger-"));
  directories.push(directory);
  const artifactStore = new PrivateArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    maxEntries: 10,
    maxBytes: 1024,
  });
  return {
    ledger: new Ledger({
      databasePath: join(directory, "ledger.sqlite"),
      artifactStore,
    }),
    artifactStore,
    databasePath: join(directory, "ledger.sqlite"),
  };
}

function common(
  identity: string,
  snapshotDigest = snapshot,
  campaignId = "campaign-1",
) {
  return {
    schemaVersion: 1 as const,
    identity,
    campaignId,
    snapshotDigest,
    occurredAt: "2026-10-08T00:00:00Z",
  };
}

async function evidence(store: PrivateArtifactStore): Promise<string> {
  const staging = await store.stage();
  await writeFile(
    join(staging.contentDirectory, "proof.txt"),
    "nonce canary observed",
  );
  const measured = await measureCanonicalSourceTree(staging.contentDirectory, {
    maxEntries: 10,
    maxBytes: 1024,
  });
  const result = await store.commit(measured.digest, staging);
  expect(result.status).not.toBe("conflict");
  return measured.digest;
}

describe("Ledger public interface", () => {
  it("appends durably, keeps the first identity immutable, and reads in sequence", async () => {
    const { ledger, artifactStore, databasePath } = await fixture();
    const ref = await evidence(artifactStore);
    const selection = {
      ...common("selection-1"),
      type: "target-selected" as const,
      selectionId: "selection-1",
      artifacts: [{ kind: "selection-record", digest: ref }],
    };
    expect(await ledger.append(selection)).toEqual({ status: "appended" });
    expect(await ledger.append(selection)).toEqual({ status: "existing" });
    expect(
      await ledger.append({ ...selection, selectionId: "different-selection" }),
    ).toEqual({ status: "conflict" });
    expect(
      await ledger.append({
        ...selection,
        artifacts: [{ kind: "missing", digest: otherSnapshot }],
      }),
    ).toEqual({ status: "conflict" });
    await ledger.append({
      ...common("snapshot-1"),
      type: "snapshot-frozen",
      sourceDigest: snapshot,
    });
    const reopened = new Ledger({ databasePath, artifactStore });
    const first = reopened.read({ campaignId: "campaign-1", limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]?.event).toEqual({
      ...selection,
      artifacts: selection.artifacts,
    });
    if (first[0] === undefined) throw new Error("Missing first ledger event");
    expect(reopened.read({ afterSequence: first[0].sequence })).toMatchObject([
      { event: { type: "snapshot-frozen" } },
    ]);
    expect(reopened.read({ type: "target-selected" })).toHaveLength(1);
    expect("delete" in ledger).toBe(false);
    await expect(
      ledger.append({
        ...selection,
        identity: "invalid-reference",
        artifacts: [{ kind: "missing", digest: otherSnapshot }],
      }),
    ).rejects.toThrow("Private artifact is unavailable");
    expect(ledger.read({ campaignId: "campaign-1" })).toHaveLength(2);
  });

  it("records a mismatched or ungrounded judgment as incomplete", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("finding-1"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "injection",
    });
    expect(
      await ledger.append({
        ...common("finding-1-replacement", otherSnapshot),
        type: "finding-recorded",
        findingId: "finding-1",
        runId: "run-2",
        category: "injection",
      }),
    ).toEqual({ status: "conflict" });
    const mismatched = {
      ...common("verification-1", otherSnapshot),
      type: "verification-finished" as const,
      verificationId: "verification-1",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result: {
        status: "runtime-confirmed" as const,
        judgeId: "judge-1",
        proofKind: "nonce-canary" as const,
        evidenceDigest: proof,
        reproductionPackageDigest: proof,
      },
    };
    expect(await ledger.append(mismatched)).toEqual({ status: "appended" });
    expect(await ledger.append(mismatched)).toEqual({ status: "existing" });
    const recorded = ledger.read({ type: "verification-finished" });
    expect(recorded[0]?.event).toMatchObject({
      snapshotDigest: otherSnapshot,
      result: { status: "incomplete", reason: "digest-mismatch" },
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      raw: 1,
      verified: 1,
      confirmed: 0,
      incomplete: 1,
    });
    await ledger.append({
      ...common("verification-without-finding"),
      type: "verification-finished",
      verificationId: "verification-without-finding",
      findingId: "not-recorded",
      labSetupDigest: labSetup,
      result: {
        status: "contradicted",
        judgeId: "judge-1",
        evidenceDigest: proof,
      },
    });
    expect(ledger.read({ findingId: "not-recorded" })[0]?.event).toMatchObject({
      result: { status: "incomplete", reason: "precondition" },
    });
    await ledger.append({
      ...common("verification-without-evidence"),
      type: "verification-finished",
      verificationId: "verification-without-evidence",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result: {
        status: "runtime-confirmed",
        judgeId: "judge-1",
        proofKind: "nonce-canary",
        evidenceDigest: otherSnapshot,
        reproductionPackageDigest: proof,
      },
    });
    expect(ledger.read({ findingId: "finding-1" }).at(-1)?.event).toMatchObject(
      {
        result: { status: "incomplete", reason: "evidence" },
      },
    );
    await ledger.append({
      ...common("verification-without-package"),
      type: "verification-finished",
      verificationId: "verification-without-package",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result: {
        status: "runtime-confirmed",
        judgeId: "judge-1",
        proofKind: "nonce-canary",
        evidenceDigest: proof,
        reproductionPackageDigest: otherSnapshot,
      },
    });
    expect(ledger.read({ findingId: "finding-1" }).at(-1)?.event).toMatchObject(
      {
        result: { status: "incomplete", reason: "evidence" },
      },
    );
  });

  it("admits a latest-version re-verification only against the finding's snapshot and a snapshot frozen in the campaign", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("finding-1"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "injection",
    });
    const reverify = (identity: string, findingSnapshotDigest = snapshot) => ({
      ...common(identity, otherSnapshot),
      type: "verification-finished" as const,
      verificationId: identity,
      findingId: "finding-1",
      labSetupDigest: labSetup,
      basis: { kind: "latest-version" as const, findingSnapshotDigest },
      result: {
        status: "runtime-confirmed" as const,
        judgeId: "judge-1",
        proofKind: "nonce-canary" as const,
        evidenceDigest: proof,
        reproductionPackageDigest: proof,
      },
    });
    const latest = (identity: string) =>
      ledger
        .read({ findingId: "finding-1" })
        .find((record) => record.event.identity === identity)?.event;

    await ledger.append(reverify("before-freeze"));
    expect(latest("before-freeze")).toMatchObject({
      result: { status: "incomplete", reason: "precondition" },
    });
    await ledger.append({
      ...common("latest-frozen", otherSnapshot),
      type: "snapshot-frozen",
      sourceDigest: otherSnapshot,
    });
    await ledger.append(reverify("wrong-basis", otherSnapshot));
    expect(latest("wrong-basis")).toMatchObject({
      result: { status: "incomplete", reason: "digest-mismatch" },
    });
    await ledger.append(reverify("on-latest"));
    expect(latest("on-latest")).toMatchObject({
      snapshotDigest: otherSnapshot,
      basis: { kind: "latest-version", findingSnapshotDigest: snapshot },
      result: { status: "runtime-confirmed" },
    });
  });

  it("derives the complete campaign and category funnel without counting setup failures", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("lab-ready"),
      type: "lab-provisioned",
      labId: "lab-1",
      status: "ready",
    });
    await ledger.append({
      ...common("lab-failed"),
      type: "lab-provisioned",
      labId: "lab-2",
      status: "failed",
    });
    await ledger.append({
      ...common("run-1-started"),
      type: "discovery-run-started",
      runId: "run-1",
      labId: "lab-1",
      history: { mode: "catalog", digest: snapshot, recordIds: ["public-1"] },
      configuration: {
        promptVariant: "short-objective",
        assignmentUnit: "route",
      },
    });
    await ledger.append({
      ...common("run-2-started"),
      type: "discovery-run-started",
      runId: "run-2",
      labId: "lab-2",
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-derived",
        assignmentUnit: "file",
      },
    });
    await ledger.append({
      ...common("run-1-finished"),
      type: "discovery-run-finished",
      runId: "run-1",
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 1200,
    });
    await ledger.append({
      ...common("run-2-finished"),
      type: "discovery-run-finished",
      runId: "run-2",
      outcome: "setup-failed",
      costUsd: "unavailable",
      wallTimeMs: 0,
    });
    for (const [findingId, category] of [
      ["finding-1", "injection"],
      ["finding-2", "injection"],
      ["finding-3", "access-control"],
      ["finding-4", "access-control"],
    ] as const) {
      await ledger.append({
        ...common(`${findingId}-recorded`),
        type: "finding-recorded",
        findingId,
        runId: "run-1",
        category,
      });
    }
    await ledger.append({
      ...common("verified-1"),
      type: "verification-finished",
      verificationId: "verified-1",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result: {
        status: "runtime-confirmed",
        judgeId: "judge",
        proofKind: "nonce-canary",
        evidenceDigest: proof,
        reproductionPackageDigest: proof,
      },
    });
    await ledger.append({
      ...common("verified-2"),
      type: "verification-finished",
      verificationId: "verified-2",
      findingId: "finding-2",
      labSetupDigest: labSetup,
      result: {
        status: "contradicted",
        judgeId: "judge",
        evidenceDigest: proof,
      },
    });
    await ledger.append({
      ...common("verified-3"),
      type: "verification-finished",
      verificationId: "verified-3",
      findingId: "finding-3",
      labSetupDigest: labSetup,
      result: {
        status: "incomplete",
        reason: "observation",
        nextStep: "Repeat the observation",
      },
    });
    await ledger.append({
      ...common("verified-4", otherSnapshot),
      type: "verification-finished",
      verificationId: "verified-4",
      findingId: "finding-4",
      labSetupDigest: labSetup,
      result: {
        status: "contradicted",
        judgeId: "judge",
        evidenceDigest: proof,
      },
    });
    for (const findingId of ["finding-1", "finding-3", "finding-4"]) {
      await ledger.append({
        ...common(`${findingId}-reviewed`),
        type: "review-decided",
        findingId,
        decision: "accept",
      });
    }
    await ledger.append({
      ...common("scope-1"),
      type: "scope-assessed",
      findingId: "finding-1",
      programmeId: "programme-1",
      status: "in-scope",
    });
    await ledger.append({
      ...common("scope-1-other-programme"),
      type: "scope-assessed",
      findingId: "finding-1",
      programmeId: "programme-2",
      status: "out-of-scope",
    });
    await ledger.append({
      ...common("scope-3"),
      type: "scope-assessed",
      findingId: "finding-3",
      programmeId: "programme-1",
      status: "ambiguous",
    });
    await ledger.append({
      ...common("scope-4"),
      type: "scope-assessed",
      findingId: "finding-4",
      programmeId: "programme-1",
      status: "out-of-scope",
    });
    await ledger.append({
      ...common("draft-1"),
      type: "draft-saved",
      findingId: "finding-1",
      candidateId: "candidate-1",
      revisionDigest: revision,
    });
    await ledger.append({
      ...common("authorization-1"),
      type: "external-action-authorized",
      candidateId: "candidate-1",
      revisionDigest: revision,
      destination: "destination-1",
    });
    await ledger.append({
      ...common("submission-1"),
      type: "submission-recorded",
      findingId: "finding-1",
      candidateId: "candidate-1",
    });
    await ledger.append({
      ...common("outcome-1"),
      type: "submission-outcome",
      candidateId: "candidate-1",
      outcome: "triaged",
    });
    await ledger.append({
      ...common("other-campaign-finding", snapshot, "campaign-2"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "other-run",
      category: "injection",
    });

    expect(ledger.funnel("campaign-1")).toEqual({
      campaignId: "campaign-1",
      discoveryAttempts: 1,
      runCount: 2,
      knownCostUsd: 0,
      unpricedRuns: 2,
      wallTimeMs: 1200,
      raw: 4,
      verified: 4,
      confirmed: 1,
      contradicted: 1,
      incomplete: 2,
      reviewed: 3,
      inScope: 1,
      inScopeByProgramme: { "programme-1": 1, "programme-2": 0 },
      outcomesByKind: { triaged: 1 },
      byArm: {},
      rewardUsd: 0,
      submitted: 1,
      outcome: 1,
      byCategory: {
        injection: {
          raw: 2,
          verified: 2,
          confirmed: 1,
          contradicted: 1,
          incomplete: 0,
          reviewed: 1,
          inScope: 1,
          submitted: 1,
          outcome: 1,
        },
        "access-control": {
          raw: 2,
          verified: 2,
          confirmed: 0,
          contradicted: 0,
          incomplete: 2,
          reviewed: 2,
          inScope: 0,
          submitted: 0,
          outcome: 0,
        },
      },
    });
    expect(ledger.funnel("campaign-2")).toMatchObject({ raw: 1, verified: 0 });
    expect(
      ledger.read({ type: "discovery-run-started" })[0]?.event,
    ).toMatchObject({
      configuration: {
        promptVariant: "short-objective",
        assignmentUnit: "route",
      },
      history: { mode: "catalog" },
    });
  });

  it("records a Finding reference only to a catalog record given to that run", async () => {
    const { ledger } = await fixture();
    expect(
      await ledger.append({
        ...common("run-history"),
        type: "discovery-run-started",
        runId: "run-history",
        labId: "lab-1",
        history: { mode: "catalog", digest: snapshot, recordIds: ["public-1"] },
        configuration: {
          promptVariant: "short-objective",
          assignmentUnit: "route",
        },
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...common("run-history-duplicate"),
        type: "discovery-run-started",
        runId: "run-history",
        labId: "lab-1",
        history: { mode: "none" },
        configuration: {
          promptVariant: "short-objective",
          assignmentUnit: "route",
        },
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await ledger.append({
        ...common("finding-history"),
        type: "finding-recorded",
        findingId: "finding-history",
        runId: "run-history",
        category: "sql-injection",
        historyRecordId: "public-1",
      }),
    ).toEqual({ status: "appended" });
    expect(
      ledger.read({ findingId: "finding-history" })[0]?.event,
    ).toMatchObject({
      historyRecordId: "public-1",
    });
    expect(
      await ledger.append({
        ...common("finding-unknown-history"),
        type: "finding-recorded",
        findingId: "finding-unknown-history",
        runId: "run-history",
        category: "sql-injection",
        historyRecordId: "not-shown",
      }),
    ).toEqual({ status: "conflict" });
  });
});
