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
  it("records later-wave direct children and keeps older three-child events readable", async () => {
    const { ledger } = await fixture();
    for (const admitted of [3, 4, 5]) {
      await ledger.append({
        ...common(`children-${admitted}`),
        type: "discovery-run-finished",
        runId: `run-${admitted}`,
        outcome: "completed",
        costUsd: "unavailable",
        wallTimeMs: 1,
        childThreadsObserved: admitted,
        childThreadsAdmitted: admitted,
      });
    }
    expect(
      ledger
        .read({ type: "discovery-run-finished" })
        .map(({ event }) =>
          event.type === "discovery-run-finished"
            ? event.childThreadsAdmitted
            : undefined,
        ),
    ).toEqual([3, 4, 5]);
  });

  it("measures owner time and opened findings per distinct submission across categories", async () => {
    const { ledger } = await fixture();
    for (const [findingId, category] of [
      ["finding-a", "sqli"],
      ["finding-b", "stored-xss"],
    ] as const)
      await ledger.append({
        ...common(`record-${findingId}`),
        type: "finding-recorded",
        findingId,
        runId: "run-1",
        category,
      });
    for (const [identity, findingId, action, minutes] of [
      ["read-a", "finding-a", "read", 10],
      ["reproduce-a", "finding-a", "reproduce", 20],
      ["read-b", "finding-b", "read", 5],
    ] as const)
      await ledger.append({
        ...common(identity),
        type: "human-effort-recorded",
        findingId,
        action,
        minutes,
      });
    for (const [identity, findingId, result] of [
      ["manual-a", "finding-a", "match"],
      ["manual-b", "finding-b", "mismatch"],
    ] as const)
      await ledger.append({
        ...common(identity),
        type: "human-reproduction-recorded",
        findingId,
        verificationId: "verification-1",
        reproductionPackageDigest: revision,
        result,
      });
    for (const candidateId of ["candidate-a1", "candidate-a2"])
      await ledger.append({
        ...common(`submission-${candidateId}`),
        type: "submission-recorded",
        findingId: "finding-a",
        candidateId,
      });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      ownerMinutesPerSubmission: 17.5,
      openedFindingsPerSubmission: 1,
      manualReproductionAgreement: 0.5,
      humanByCategory: {
        sqli: {
          ownerMinutesPerSubmission: 15,
          openedFindingsPerSubmission: 0.5,
          manualReproductionAgreement: 1,
        },
        "stored-xss": {
          ownerMinutesPerSubmission: null,
          openedFindingsPerSubmission: null,
          manualReproductionAgreement: 0,
        },
      },
    });
  });

  it("reads a legacy discovery event with a continuation prompt digest", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("legacy-discovery-start"),
      type: "discovery-run-started",
      runId: "run-legacy",
      labId: "lab-legacy",
      history: { mode: "none" },
      configuration: {
        promptVariant: "objective-v5",
        assignmentUnit: "route",
        continuationPromptDigest: revision,
      },
    });
    await ledger.append({
      ...common("legacy-discovery-finish"),
      type: "discovery-run-finished",
      runId: "run-legacy",
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 1,
      researchArtifact: { digest: proof, truncated: true },
      continuation: {
        mode: "thread-resume",
        injected: true,
        entriesHandedBack: 3,
        remainingMinutes: 26.5,
        reason: "coverage-incomplete",
      },
    });
    await ledger.append({
      ...common("legacy-finding"),
      type: "finding-recorded",
      findingId: "legacy-finding",
      runId: "run-legacy",
      category: "stored-xss",
      continuationOrdinal: 1,
    });
    await ledger.append({
      ...common("legacy-lead"),
      type: "lead-recorded",
      leadId: "legacy-lead",
      runId: "run-legacy",
      trialId: "trial-legacy",
      missingEdge: "consumer",
      primitive: "write",
      storageKind: "option",
      continuationOrdinal: 1,
      artifacts: [{ kind: "lead", digest: proof }],
    });
    expect(ledger.read({ type: "discovery-run-started" })).toMatchObject([
      {
        event: {
          configuration: { continuationPromptDigest: revision },
        },
      },
    ]);
    expect(ledger.read({ type: "discovery-run-finished" })).toMatchObject([
      {
        event: {
          continuation: { mode: "thread-resume" },
          researchArtifact: { digest: proof, truncated: true },
        },
      },
    ]);
    expect(ledger.read({ type: "finding-recorded" })).toMatchObject([
      { event: { continuationOrdinal: 1 } },
    ]);
    expect(ledger.read({ type: "lead-recorded" })).toMatchObject([
      { event: { continuationOrdinal: 1 } },
    ]);
  });

  it("records versioned package documents while reading older verification events", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("finding-template"),
      type: "finding-recorded",
      findingId: "finding-template",
      runId: "run-1",
      category: "stored-xss",
    });
    const oldResult = {
      status: "runtime-confirmed" as const,
      judgeId: "judge",
      proofKind: "nonce-canary" as const,
      evidenceDigest: proof,
      reproductionPackageDigest: proof,
    };
    const commonVerification = {
      type: "verification-finished" as const,
      findingId: "finding-template",
      labSetupDigest: labSetup,
    };
    await ledger.append({
      ...common("old-verification"),
      ...commonVerification,
      verificationId: "old-verification",
      result: oldResult,
    });
    const acceptanceCriteria = {
      id: "stored-xss-criteria",
      version: 1,
      digest: revision,
    };
    const reproductionTemplate = {
      id: "reproduction-template",
      version: 1,
      digest: labSetup,
    };
    await ledger.append({
      ...common("new-verification"),
      ...commonVerification,
      verificationId: "new-verification",
      result: { ...oldResult, acceptanceCriteria, reproductionTemplate },
    });
    const events = ledger.read({ type: "verification-finished" });
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toMatchObject({ result: oldResult });
    expect(events[1]?.event).toMatchObject({
      result: { acceptanceCriteria, reproductionTemplate },
    });
  });

  it("records the Trial's launch mode and still reads starts without one (ADR 0039)", async () => {
    const { ledger } = await fixture();
    await ledger.append({
      ...common("wide-start"),
      type: "discovery-run-started",
      runId: "run-wide",
      labId: "lab-wide",
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v11-wide",
        mode: "wide",
      },
    });
    await ledger.append({
      ...common("old-start"),
      type: "discovery-run-started",
      runId: "run-old",
      labId: "lab-old",
      history: { mode: "none" },
      configuration: { promptVariant: "wp2shell-bounty-v8" },
    });
    const starts = ledger
      .read({ type: "discovery-run-started" })
      .map(({ event }) =>
        event.type === "discovery-run-started" ? event.configuration : null,
      );
    expect(starts[0]).toMatchObject({ mode: "wide" });
    expect(starts[1]).not.toHaveProperty("mode");
    await expect(
      ledger.append({
        ...common("bad-start"),
        type: "discovery-run-started",
        runId: "run-bad",
        labId: "lab-bad",
        history: { mode: "none" },
        configuration: {
          promptVariant: "wp2shell-bounty-v8",
          mode: "screening" as never,
        },
      }),
    ).rejects.toThrow();
  });

  it("counts boundary candidates once across rejection and replay, with classified holds and token rates", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    await ledger.append({
      ...common("start"),
      type: "discovery-run-started",
      runId: "run-1",
      labId: "lab-1",
      history: { mode: "none" },
      configuration: { promptVariant: "objective-v5", assignmentUnit: "route" },
    });
    await ledger.append({
      ...common("finish"),
      type: "discovery-run-finished",
      runId: "run-1",
      outcome: "completed",
      costUsd: "unavailable",
      wallTimeMs: 3_600_000,
      usage: {
        inputTokens: 1_250_000,
        cachedInputTokens: 250_000,
        outputTokens: 100,
        reasoningOutputTokens: 10,
      },
    });
    await ledger.append({
      ...common("old-rejection"),
      type: "candidate-rejected",
      runId: "run-1",
      candidateKind: "finding",
      candidateIndex: 0,
      reason: "schema",
      impact: "access-control",
    });
    await ledger.append({
      ...common("replay-normalized"),
      type: "candidate-normalized",
      runId: "run-1",
      candidateKind: "finding",
      candidateIndex: 0,
      changes: [],
    });
    await ledger.append({
      ...common("lead-normalized"),
      type: "candidate-normalized",
      runId: "run-1",
      candidateKind: "lead",
      candidateIndex: 0,
      changes: [],
    });
    await ledger.append({
      ...common("lead-held"),
      type: "candidate-held",
      runId: "run-1",
      candidateKind: "lead",
      candidateIndex: 0,
      issuePaths: ["sourceTrace"],
      primitive: "write",
      missingEdge: "render",
    });
    await ledger.append({
      ...common("finding"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "access-control",
    });
    await ledger.append({
      ...common("verified"),
      type: "verification-finished",
      verificationId: "verification-1",
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
    const funnel = ledger.funnel("campaign-1");
    expect(funnel).toMatchObject({
      reached: 2,
      accepted: 1,
      held: 1,
      raw: 1,
      confirmed: 1,
      noncachedInputTokens: 1_000_000,
      confirmedPerMillionInputTokens: 1,
      confirmedPerAgentWallHour: 1,
      verificationAttempts: { "finding-1": 1 },
      byCategory: {
        "access-control": { reached: 1, accepted: 1, held: 0 },
        "lead:write/render": { reached: 1, accepted: 0, held: 1 },
      },
      byObjective: {
        "objective-v5": {
          reached: 2,
          accepted: 1,
          held: 1,
          confirmedPerMillionInputTokens: 1,
          confirmedPerAgentWallHour: 1,
        },
      },
    });
  });

  it("counts a parked Finding outside the Programme Boundary apart from raw and accepted (#185)", async () => {
    const { ledger } = await fixture();
    const snapshot = `sha256:${"a".repeat(64)}`;
    const common = (identity: string) => ({
      schemaVersion: 1 as const,
      identity,
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-13T00:00:00Z",
      artifacts: [],
    });
    await ledger.append({
      ...common("normalized"),
      type: "candidate-normalized",
      runId: "run-1",
      candidateKind: "finding",
      candidateIndex: 0,
      changes: [],
    });
    await ledger.append({
      ...common("parked"),
      type: "finding-parked",
      findingId: "finding-1",
      runId: "run-1",
      category: "other",
      reason: "outside-programme-boundary",
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      reached: 1,
      accepted: 0,
      held: 0,
      parked: 1,
      raw: 0,
      verified: 0,
    });
    expect(ledger.funnel("campaign-1").byCategory["other"]).toMatchObject({
      parked: 1,
      raw: 0,
    });
    expect(ledger.read({ type: "finding-parked" })).toHaveLength(1);
  });

  it("restores only a matching precondition park after the Finding is recorded", async () => {
    const { ledger, artifactStore } = await fixture();
    const snapshot = `sha256:${"a".repeat(64)}`;
    const findingDigest = await evidence(artifactStore);
    const base = (identity: string) => ({
      schemaVersion: 1 as const,
      identity,
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-24T00:00:00Z",
      artifacts: [{ kind: "finding", digest: findingDigest }],
    });
    await ledger.append({
      ...base("normalized"),
      type: "candidate-normalized",
      runId: "run-1",
      candidateKind: "finding",
      candidateIndex: 0,
      changes: [],
    });
    await ledger.append({
      ...base("parked"),
      type: "finding-parked",
      findingId: "finding-1",
      runId: "run-1",
      category: "stored-xss",
      reason: "admin-configuration-precondition",
      preconditionClass: "admin-configuration",
    });
    await ledger.append({
      ...base("recorded"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "stored-xss",
      preconditionClass: "unknown",
    });
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
    expect(ledger.funnel("campaign-1")).toMatchObject({ parked: 1, raw: 0 });
    await ledger.append({
      ...base("wrong-recorded-identity"),
      type: "finding-park-restored",
      findingId: "finding-1",
      parkedIdentity: "parked",
      recordedIdentity: "different",
      reason: "admission-correction",
    });
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
    await ledger.append({
      ...base("restored"),
      type: "finding-park-restored",
      findingId: "finding-1",
      parkedIdentity: "parked",
      recordedIdentity: "recorded",
      reason: "admission-correction",
    });
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(0);
    expect(ledger.funnel("campaign-1")).toMatchObject({
      reached: 1,
      accepted: 1,
      parked: 0,
      raw: 1,
    });
    expect(ledger.read({ type: "finding-parked" })).toHaveLength(1);
  });

  it("never restores a Programme Boundary park even with a matching marker", async () => {
    const { ledger, artifactStore } = await fixture();
    const findingDigest = await evidence(artifactStore);
    const base = (identity: string) => ({
      ...common(identity),
      artifacts: [{ kind: "finding" as const, digest: findingDigest }],
    });
    await ledger.append({
      ...base("scope-parked"),
      type: "finding-parked",
      findingId: "finding-1",
      runId: "run-1",
      category: "other",
      reason: "outside-programme-boundary",
    });
    await ledger.append({
      ...base("scope-recorded"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "other",
    });
    await ledger.append({
      ...base("forged-restoration"),
      type: "finding-park-restored",
      findingId: "finding-1",
      parkedIdentity: "scope-parked",
      recordedIdentity: "scope-recorded",
      reason: "admission-correction",
    });
    expect(ledger.activeParked({ campaignId: "campaign-1" })).toHaveLength(1);
    expect(ledger.funnel("campaign-1")).toMatchObject({ parked: 1, raw: 0 });
  });

  it("counts accepted legacy candidates even when another index was rejected first", async () => {
    const { ledger } = await fixture();
    await ledger.append({
      ...common("rejected"),
      type: "candidate-rejected",
      runId: "run-1",
      candidateKind: "finding",
      candidateIndex: 0,
      reason: "schema",
    });
    await ledger.append({
      ...common("accepted"),
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "access-control",
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      reached: 2,
      accepted: 1,
      held: 1,
      byCategory: {
        unclassified: { reached: 1, held: 1 },
        "access-control": { reached: 1, accepted: 1 },
      },
    });
  });
  it("reads discovery events written before upstream broker counters existed", async () => {
    const { ledger } = await fixture();
    await ledger.append({
      ...common("run-with-legacy-broker-metrics"),
      type: "discovery-run-finished",
      runId: "run-1",
      outcome: "failed",
      costUsd: "unavailable",
      wallTimeMs: 100,
      brokerMetrics: {
        forwardedRequests: 3,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
    });
    expect(
      ledger.read({ type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({
      brokerMetrics: { forwardedRequests: 3 },
    });
  });

  it("keeps old snapshot events readable and records optional dependency digests", async () => {
    const { ledger } = await fixture();
    await ledger.append({
      ...common("snapshot-old"),
      type: "snapshot-frozen",
      sourceDigest: snapshot,
    });
    await ledger.append({
      ...common("snapshot-core"),
      type: "snapshot-frozen",
      sourceDigest: snapshot,
      dependencyDigests: [otherSnapshot],
    });
    const events = ledger
      .read({ type: "snapshot-frozen" })
      .map(({ event }) => event);
    expect(events[0]).not.toHaveProperty("dependencyDigests");
    expect(events[1]).toMatchObject({ dependencyDigests: [otherSnapshot] });
  });

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

  it("readAll returns every event past the page size, in sequence, with filters", async () => {
    const { ledger } = await fixture();
    const total = 1003;
    for (let index = 0; index < total; index++)
      await ledger.append({
        ...common(
          `snapshot-${index}`,
          snapshot,
          index % 2 === 0 ? "campaign-even" : "campaign-odd",
        ),
        type: "snapshot-frozen",
        sourceDigest: snapshot,
      });
    await ledger.append({
      ...common("selection-1", snapshot, "campaign-even"),
      type: "target-selected",
      selectionId: "selection-1",
      artifacts: [],
    });
    expect(ledger.read()).toHaveLength(100);
    expect(ledger.read({ limit: 1000 })).toHaveLength(1000);
    const all = ledger.readAll();
    expect(all).toHaveLength(total + 1);
    expect(all.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: total + 1 }, (_, index) => index + 1),
    );
    expect(all.at(-1)?.event.type).toBe("target-selected");
    const even = ledger.readAll({
      campaignId: "campaign-even",
      type: "snapshot-frozen",
    });
    expect(even).toHaveLength(Math.ceil(total / 2));
    expect(
      even.every(
        ({ event }) =>
          event.type === "snapshot-frozen" &&
          event.campaignId === "campaign-even",
      ),
    ).toBe(true);
    expect(ledger.readAll({ type: "target-selected" })).toHaveLength(1);
  }, 30_000);

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

  it("requires a new-snapshot Finding for a version comparison", async () => {
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
      result: { status: "incomplete", reason: "digest-mismatch" },
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
      result: { status: "incomplete", reason: "digest-mismatch" },
    });
    expect(
      await ledger.append({
        ...common("finding-on-latest", otherSnapshot),
        type: "finding-recorded",
        findingId: "finding-2",
        runId: "reverify-1",
        category: "injection",
        derivedFromFindingId: "finding-1",
        derivationKind: "latest-version",
      }),
    ).toMatchObject({ status: "appended" });
    await ledger.append({
      ...reverify("derived-verification", otherSnapshot),
      findingId: "finding-2",
    });
    expect(
      ledger
        .read({ findingId: "finding-2" })
        .find((record) => record.event.identity === "derived-verification")
        ?.event,
    ).toMatchObject({ result: { status: "runtime-confirmed" } });
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
      incompleteDepth: 0,
      byLab: {
        attached: { runs: 2, findings: 4, confirmed: 1 },
        none: { runs: 0, findings: 0, confirmed: 0 },
      },
      verificationLabFailed: 0,
      runCount: 2,
      knownCostUsd: 0,
      unpricedRuns: 2,
      wallTimeMs: 1200,
      noncachedInputTokens: 0,
      unavailableInputRuns: 1,
      confirmedPerMillionInputTokens: null,
      confirmedPerAgentWallHour: 3000,
      verificationAttempts: {
        "finding-1": 1,
        "finding-2": 1,
        "finding-3": 1,
        "finding-4": 1,
      },
      reached: 4,
      accepted: 4,
      held: 0,
      parked: 0,
      raw: 4,
      verified: 4,
      confirmed: 1,
      reproduced: 0,
      contradicted: 1,
      incomplete: 2,
      reviewed: 3,
      inScope: 1,
      inScopeByProgramme: { "programme-1": 1, "programme-2": 0 },
      outcomesByKind: { triaged: 1 },
      byArm: {},
      byObjective: {
        "short-objective": {
          runs: 1,
          reached: 4,
          accepted: 4,
          held: 0,
          parked: 0,
          raw: 4,
          verified: 4,
          confirmed: 1,
          reproduced: 0,
          contradicted: 1,
          incomplete: 2,
          reviewed: 3,
          inScope: 1,
          submitted: 1,
          outcome: 1,
          noncachedInputTokens: 0,
          unavailableInputRuns: 1,
          wallTimeMs: 1200,
          confirmedPerMillionInputTokens: null,
          confirmedPerAgentWallHour: 3000,
        },
        "wp2shell-derived": {
          runs: 1,
          reached: 0,
          accepted: 0,
          held: 0,
          parked: 0,
          raw: 0,
          verified: 0,
          confirmed: 0,
          reproduced: 0,
          contradicted: 0,
          incomplete: 0,
          reviewed: 0,
          inScope: 0,
          submitted: 0,
          outcome: 0,
          noncachedInputTokens: 0,
          unavailableInputRuns: 0,
          wallTimeMs: 0,
          confirmedPerMillionInputTokens: null,
          confirmedPerAgentWallHour: null,
        },
      },
      rewardUsd: 0,
      ownerMinutesPerSubmission: null,
      openedFindingsPerSubmission: null,
      manualReproductionAgreement: null,
      humanMinutesByAction: { read: 0, reproduce: 0, submit: 0, outcome: 0 },
      humanByCategory: {
        injection: {
          ownerMinutesPerSubmission: null,
          openedFindingsPerSubmission: null,
          manualReproductionAgreement: null,
        },
        "access-control": {
          ownerMinutesPerSubmission: null,
          openedFindingsPerSubmission: null,
          manualReproductionAgreement: null,
        },
      },
      submitted: 1,
      outcome: 1,
      byCategory: {
        injection: {
          reached: 2,
          accepted: 2,
          held: 0,
          parked: 0,
          raw: 2,
          verified: 2,
          confirmed: 1,
          reproduced: 0,
          contradicted: 1,
          incomplete: 0,
          reviewed: 1,
          inScope: 1,
          submitted: 1,
          outcome: 1,
        },
        "access-control": {
          reached: 2,
          accepted: 2,
          held: 0,
          parked: 0,
          raw: 2,
          verified: 2,
          confirmed: 0,
          reproduced: 0,
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

  it("still reads old assignment and ablation-arm run events and counts them per arm", async () => {
    const { ledger } = await fixture();
    for (const [runId, configuration] of [
      [
        "assigned-run",
        {
          assignmentUnit: "entry-point",
          assignment: { partition: 0, of: 2, planDigest: revision },
          arms: { history: "b", prompt: "a" },
        },
      ],
      [
        "single-axis-run",
        { assignmentUnit: "plugin", axis: "history", arm: "a" },
      ],
    ] as const)
      expect(
        await ledger.append({
          ...common(`start-${runId}`),
          type: "discovery-run-started",
          runId,
          labId: "lab-1",
          history: { mode: "none" },
          configuration: { promptVariant: "v5", ...configuration },
        }),
      ).toEqual({ status: "appended" });
    expect(ledger.funnel("campaign-1").byArm).toEqual({
      "history:a": { runs: 1, findings: 0, confirmed: 0 },
      "history:b": { runs: 1, findings: 0, confirmed: 0 },
      "prompt:a": { runs: 1, findings: 0, confirmed: 0 },
      "history:b+prompt:a": { runs: 1, findings: 0, confirmed: 0 },
    });
  });

  it("still reads old report-recovery events and accepts runs without an assignment unit", async () => {
    const { ledger } = await fixture();
    expect(
      await ledger.append({
        ...common("discovery-report-recovered-run-old-wordpress-candidate-v1"),
        type: "discovery-report-recovered",
        runId: "run-old",
        sourceDiagnosticDigest: revision,
        reportArtifactDigest: labSetup,
        parserVersion: "wordpress-candidate-v1",
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...common("start-run-new"),
        type: "discovery-run-started",
        runId: "run-new",
        history: { mode: "none" },
        configuration: { promptVariant: "wp2shell-bounty-v8" },
      }),
    ).toEqual({ status: "appended" });
    expect(
      ledger.read({ campaignId: "campaign-1" }).map(({ event }) => event.type),
    ).toEqual(["discovery-report-recovered", "discovery-run-started"]);
  });

  it("still reads old entry-index runs with catalog history, coverage artifacts and incomplete(depth) (ADR 0034)", async () => {
    const { ledger, artifactStore } = await fixture();
    const coverage = await evidence(artifactStore);
    expect(
      await ledger.append({
        ...common("start-indexed-run"),
        type: "discovery-run-started",
        runId: "indexed-run",
        labId: "lab-1",
        trialId: "indexed-run",
        trialOrdinal: 0,
        runKind: "explore",
        history: { mode: "catalog", digest: snapshot, recordIds: ["public-1"] },
        configuration: {
          promptVariant: "wp2shell-bounty-v6",
          promptDigest: revision,
          contractDigest: labSetup,
          assignmentUnit: "plugin",
          entryIndex: { enabled: true, digest: otherSnapshot },
        },
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...common("finish-indexed-run"),
        type: "discovery-run-finished",
        runId: "indexed-run",
        outcome: "failed",
        reason: "depth",
        costUsd: "unavailable",
        wallTimeMs: 1,
        artifacts: [{ kind: "coverage", digest: coverage }],
      }),
    ).toEqual({ status: "appended" });
    const [started] = ledger.read({ type: "discovery-run-started" });
    expect(started?.event).toMatchObject({
      history: { mode: "catalog", recordIds: ["public-1"] },
      configuration: { entryIndex: { enabled: true, digest: otherSnapshot } },
    });
    const [finished] = ledger.read({ type: "discovery-run-finished" });
    expect(finished?.event).toMatchObject({
      outcome: "failed",
      reason: "depth",
      artifacts: [{ kind: "coverage", digest: coverage }],
    });
    expect(ledger.funnel("campaign-1").incompleteDepth).toBe(1);
  });

  it("separates attached and source-only Trials and counts verification Lab failures", async () => {
    const { ledger } = await fixture();
    await ledger.append({
      ...common("lab-attached"),
      type: "lab-provisioned",
      labId: "lab-attached",
      status: "ready",
      purpose: "discovery",
    });
    for (const [runId, labAttached] of [
      ["attached-run", true],
      ["source-run", false],
    ] as const)
      await ledger.append({
        ...common(`start-${runId}`),
        type: "discovery-run-started",
        runId,
        ...(labAttached ? { labId: "lab-attached" } : {}),
        labAttached,
        history: { mode: "none" },
        configuration: { promptVariant: "v5", assignmentUnit: "plugin" },
      });
    await ledger.append({
      ...common("verify-lab-failed"),
      type: "verification-lab-failed",
      findingId: "finding-1",
      verificationId: "verification-1",
      reason: "provision",
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      discoveryAttempts: 2,
      byLab: { attached: { runs: 1 }, none: { runs: 1 } },
      verificationLabFailed: 1,
    });
  });

  it("counts a resumed segment's Trial once while old runs keep their counts (ADR 0036)", async () => {
    const { ledger } = await fixture();
    const start = (
      runId: string,
      extra: Record<string, unknown> = {},
      promptVariant = "wp2shell-bounty-v8",
    ) =>
      ledger.append({
        ...common(`start-${runId}`),
        type: "discovery-run-started",
        runId,
        trialId: extra.trialId === undefined ? runId : String(extra.trialId),
        trialOrdinal: 0,
        runKind: "explore",
        labAttached: false,
        history: { mode: "none" },
        configuration: { promptVariant, assignmentUnit: "plugin" },
        ...extra,
      });
    const finish = (
      runId: string,
      outcome: "failed" | "completed",
      wallTimeMs: number,
    ) =>
      ledger.append({
        ...common(`finish-${runId}`),
        type: "discovery-run-finished",
        runId,
        outcome,
        costUsd: "unavailable",
        wallTimeMs,
        ...(outcome === "failed"
          ? { reason: "provider", reasonDetail: "provider-cyber-policy" }
          : {}),
        artifacts: [],
      });
    // An older explore run without any resume field counts as before.
    expect(await start("old-run", {}, "wp2shell-bounty-v5")).toEqual({
      status: "appended",
    });
    await finish("old-run", "completed", 1_000);
    expect(await start("refused-run")).toEqual({ status: "appended" });
    await finish("refused-run", "failed", 2_000);
    expect(
      await start("refused-run-resume", {
        trialId: "refused-run",
        resumesRun: "refused-run",
        resumeSegment: 1,
      }),
    ).toEqual({ status: "appended" });
    await finish("refused-run-resume", "completed", 3_000);
    const [, , resumed] = ledger
      .read({ type: "discovery-run-started" })
      .map(({ event }) => event);
    expect(resumed).toMatchObject({
      runId: "refused-run-resume",
      resumesRun: "refused-run",
      resumeSegment: 1,
    });
    const funnel = ledger.funnel("campaign-1");
    expect(funnel).toMatchObject({
      discoveryAttempts: 2,
      runCount: 3,
      wallTimeMs: 6_000,
      byLab: { none: { runs: 2 }, attached: { runs: 0 } },
    });
    expect(funnel.byObjective["wp2shell-bounty-v8"]).toMatchObject({
      runs: 1,
      wallTimeMs: 5_000,
    });
    expect(funnel.byObjective["wp2shell-bounty-v5"]).toMatchObject({
      runs: 1,
      wallTimeMs: 1_000,
    });
    // Both finishes stay readable; the refusal is still a stop.
    expect(ledger.stops({ campaignId: "campaign-1" })).toMatchObject([
      {
        type: "discovery-run-finished",
        fields: {
          outcome: "failed",
          reason: "provider",
          reasonDetail: "provider-cyber-policy",
        },
        count: 1,
        explore: 1,
      },
    ]);
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

describe("Ledger optional fields added for review material (#186)", () => {
  it("accepts verification events with and without a Lab state diff and decisions with Q22 fields", async () => {
    const { ledger, artifactStore } = await fixture();
    const proof = await evidence(artifactStore);
    const result = {
      status: "incomplete" as const,
      reason: "observation" as const,
      nextStep: "Review the diff",
    };
    await ledger.append({
      ...common("verification-old"),
      type: "verification-finished",
      verificationId: "verification-old",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result,
    });
    await ledger.append({
      ...common("verification-captured"),
      type: "verification-finished",
      verificationId: "verification-captured",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result,
      labStateDiff: { status: "captured" },
      artifacts: [{ kind: "lab-state-diff", digest: proof }],
    });
    await ledger.append({
      ...common("verification-missing"),
      type: "verification-finished",
      verificationId: "verification-missing",
      findingId: "finding-1",
      labSetupDigest: labSetup,
      result,
      labStateDiff: { status: "missing", reason: "before-capture" },
    });
    // A digest the store does not hold is still refused, whatever the kind.
    await expect(
      ledger.append({
        ...common("verification-dangling"),
        type: "verification-finished",
        verificationId: "verification-dangling",
        findingId: "finding-1",
        labSetupDigest: labSetup,
        result,
        labStateDiff: { status: "captured" },
        artifacts: [{ kind: "lab-state-diff", digest: revision }],
      }),
    ).rejects.toThrow();
    await ledger.append({
      ...common("decision-old"),
      type: "review-decided",
      findingId: "finding-1",
      decision: "defer",
    });
    await ledger.append({
      ...common("decision-traced"),
      type: "review-decided",
      findingId: "finding-1",
      decision: "accept",
      humanElapsedSeconds: 600,
      verificationId: "verification-captured",
      runId: "run-1",
      promptDigest: revision,
    });
    await expect(
      ledger.append({
        ...common("decision-too-long"),
        type: "review-decided",
        findingId: "finding-1",
        decision: "accept",
        humanElapsedSeconds: 604_801,
      }),
    ).rejects.toThrow();
    const events = ledger
      .read({ type: "verification-finished" })
      .map(({ event }) =>
        event.type === "verification-finished" ? event.labStateDiff : null,
      );
    expect(events).toEqual([
      undefined,
      { status: "captured" },
      { status: "missing", reason: "before-capture" },
    ]);
    expect(ledger.read({ type: "review-decided" })).toHaveLength(2);
  });
});

describe("verification attempt metadata (#107)", () => {
  it("reads legacy events, records retry links, and counts attempts without changing verdict counts", async () => {
    const { ledger } = await fixture();
    for (const findingId of ["finding-a", "finding-b"])
      await ledger.append({
        ...common(`record-${findingId}`),
        type: "finding-recorded",
        findingId,
        runId: "run-1",
        category: "sqli",
      });
    for (const [verificationId, findingId, metadata] of [
      ["a1", "finding-a", {}],
      [
        "a2",
        "finding-a",
        { attempt: 2, retryOf: "a1", promptVersion: "verifier-v7" },
      ],
      ["b1", "finding-b", { attempt: 1 }],
    ] as const)
      await ledger.append({
        ...common(verificationId),
        type: "verification-finished",
        verificationId,
        findingId,
        labSetupDigest: labSetup,
        ...metadata,
        result: { status: "incomplete", reason: "recipe", nextStep: "Retry" },
      });
    const events = ledger.read({ type: "verification-finished" });
    expect(events[0]?.event).not.toHaveProperty("attempt");
    expect(events[0]?.event).not.toHaveProperty("retryOf");
    expect(events[0]?.event).not.toHaveProperty("promptVersion");
    expect(events[1]?.event).toMatchObject({
      verificationId: "a2",
      attempt: 2,
      retryOf: "a1",
      promptVersion: "verifier-v7",
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      verificationAttempts: { "finding-a": 2, "finding-b": 1 },
      raw: 2,
      verified: 2,
      incomplete: 2,
    });
    await expect(
      ledger.append({
        ...common("zero-attempt"),
        type: "verification-finished",
        verificationId: "verification-zero",
        findingId: "finding-a",
        labSetupDigest: labSetup,
        attempt: 0,
        result: { status: "incomplete", reason: "recipe", nextStep: "Retry" },
      }),
    ).rejects.toThrow();
  });
});

describe("Ledger capture fields added for the Trial timeline (A2, #212)", () => {
  it("reads events written before the fields and stores them when present", async () => {
    const { ledger } = await fixture();
    const finished = {
      type: "discovery-run-finished" as const,
      outcome: "completed" as const,
      costUsd: "unavailable" as const,
      wallTimeMs: 1,
    };
    expect(
      await ledger.append({
        ...common("old-finish"),
        ...finished,
        runId: "run-old",
      }),
    ).toEqual({ status: "appended" });
    expect(
      await ledger.append({
        ...common("old-finding"),
        type: "finding-recorded",
        findingId: "finding-old",
        runId: "run-old",
        category: "injection",
      }),
    ).toEqual({ status: "appended" });
    await ledger.append({
      ...common("new-finish"),
      ...finished,
      runId: "run-child",
      agentRole: "child",
      agentType: "general-purpose",
      delegationDigest: snapshot,
      delegationLength: 42,
    });
    await ledger.append({
      ...common("new-root-finish"),
      ...finished,
      runId: "run-root",
      agentRole: "root",
      firstFinalReportAt: "2026-10-08T00:40:00.000Z",
      candidatesAfterFirstFinalReport: 3,
    });
    await ledger.append({
      ...common("new-finding"),
      type: "finding-recorded",
      findingId: "finding-new",
      runId: "run-child",
      trialId: "trial-1",
      category: "injection",
    });
    const events = ledger.read({}).map(({ event }) => event);
    expect(events[0]).not.toHaveProperty("agentRole");
    expect(events[1]).not.toHaveProperty("trialId");
    expect(events[2]).toMatchObject({ delegationLength: 42 });
    expect(events[3]).toMatchObject({ candidatesAfterFirstFinalReport: 3 });
    expect(events[4]).toMatchObject({ trialId: "trial-1" });
  });

  it("treats a retried append that differs only in occurredAt as the event already recorded", async () => {
    const { ledger } = await fixture();
    const finding = {
      ...common("finding-retry"),
      type: "finding-recorded" as const,
      findingId: "finding-retry",
      runId: "run-1",
      category: "injection",
    };
    expect(await ledger.append(finding)).toEqual({ status: "appended" });
    expect(
      await ledger.append({ ...finding, occurredAt: "2026-10-09T00:00:00Z" }),
    ).toEqual({ status: "existing" });
    expect(
      await ledger.append({
        ...finding,
        occurredAt: "2026-10-09T00:00:00Z",
        runId: "run-2",
      }),
    ).toEqual({ status: "conflict" });
    expect(ledger.read({})[0]?.event.occurredAt).toBe("2026-10-08T00:00:00Z");
  });
});
