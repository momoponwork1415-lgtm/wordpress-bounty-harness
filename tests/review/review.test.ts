import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { Review } from "../../src/review/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const labSetup = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  scopeEvaluator = {
    programmeIds: ["wordfence", "patchstack"],
    policyDigest: `sha256:${"d".repeat(64)}`,
    assess: async () => [
      {
        programmeId: "wordfence",
        status: "in-scope" as const,
        destination: "wordfence",
        reason: "qualified",
      },
      {
        programmeId: "patchstack",
        status: "out-of-scope" as const,
        destination: "patchstack",
        reason: "threshold",
      },
    ],
  },
) {
  const directory = await mkdtemp(join(tmpdir(), "review-"));
  directories.push(directory);
  const artifactStore = new PrivateArtifactStore({
    rootDirectory: join(directory, "private"),
    maxEntries: 10,
    maxBytes: 100_000,
  });
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore,
  });
  const staging = await artifactStore.stage();
  await writeFile(
    join(staging.contentDirectory, "proof.txt"),
    "nonce canary observed",
  );
  const proof = await measureCanonicalSourceTree(staging.contentDirectory, {
    maxEntries: 10,
    maxBytes: 100_000,
  });
  await artifactStore.commit(proof.digest, staging);
  const packageStaging = await artifactStore.stage();
  await writeFile(
    join(packageStaging.contentDirectory, "manual.md"),
    "GET /test\n",
  );
  await writeFile(
    join(packageStaging.contentDirectory, "reproduce.py"),
    "import requests\n",
  );
  await writeFile(
    join(packageStaging.contentDirectory, "lab.json"),
    JSON.stringify({ wordpressVersion: "6.8" }),
  );
  await writeFile(
    join(packageStaging.contentDirectory, "evidence.json"),
    JSON.stringify({ judgeEvidenceDigest: proof.digest }),
  );
  const reproduction = await measureCanonicalSourceTree(
    packageStaging.contentDirectory,
    {
      maxEntries: 10,
      maxBytes: 100_000,
    },
  );
  await artifactStore.commit(reproduction.digest, packageStaging);
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-08T00:00:00Z",
  };
  await ledger.append({
    ...base,
    identity: "finding-1",
    type: "finding-recorded",
    findingId: "finding-1",
    runId: "run-1",
    category: "sqli",
  });
  await ledger.append({
    ...base,
    identity: "verification-1",
    type: "verification-finished",
    verificationId: "verification-1",
    findingId: "finding-1",
    labSetupDigest: labSetup,
    result: {
      status: "runtime-confirmed",
      judgeId: "sqli-canary",
      proofKind: "nonce-canary",
      evidenceDigest: proof.digest,
      reproductionPackageDigest: reproduction.digest,
    },
  });
  return {
    ledger,
    artifactStore,
    review: new Review({
      ledger,
      artifactStore,
      scopeEvaluator,
      factsProvider: { load: async () => ({ category: "sqli" }) },
      clock: () => new Date("2026-10-08T01:00:00Z"),
    }),
    directory,
  };
}

const ref = {
  campaignId: "campaign-1",
  findingId: "finding-1",
  verificationId: "verification-1",
  snapshotDigest: snapshot,
};

describe("review public interface", () => {
  it("excludes a later parked Finding and counts its latest precondition class", async () => {
    const { review, ledger } = await fixture();
    const base = {
      schemaVersion: 1 as const,
      campaignId: ref.campaignId,
      snapshotDigest: snapshot,
      occurredAt: "2026-10-08T01:00:00Z",
      findingId: ref.findingId,
    };
    await ledger.append({
      ...base,
      identity: "classified-admin",
      type: "finding-precondition-classified",
      preconditionClass: "admin-configuration",
    });
    await ledger.append({
      ...base,
      identity: "parked-admin",
      type: "finding-parked",
      runId: "run-1",
      category: "sqli",
      reason: "admin-configuration-precondition",
      preconditionClass: "admin-configuration",
    });
    const queue = review.queue({ campaignId: ref.campaignId });
    expect(queue.items).toHaveLength(0);
    expect(queue.preconditionClassCounts).toMatchObject({
      "admin-configuration": 1,
      unknown: 0,
    });
    expect(ledger.funnel(ref.campaignId)).toMatchObject({
      parked: 1,
      raw: 0,
      accepted: 0,
    });
  });

  it("opens the confirmed reproduction package through the review interface", async () => {
    const { review } = await fixture();
    const opened = await review.openReproductionPackage({ ref });
    expect(opened).toMatchObject({ status: "opened", manual: "GET /test\n" });
    expect(
      await review.inspect({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
      }),
    ).toMatchObject({
      reproductionPackageDigest: expect.stringMatching(/^sha256:/),
    });
  });
  it("inspects the latest verification after retrying the same Finding", async () => {
    const { review, ledger } = await fixture();
    const original = ledger.read({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })[0]?.event;
    if (original?.type !== "verification-finished")
      throw new Error("missing original verification");
    const base = {
      schemaVersion: 1 as const,
      campaignId: ref.campaignId,
      snapshotDigest: snapshot,
      labSetupDigest: labSetup,
      findingId: ref.findingId,
      type: "verification-finished" as const,
    };
    await ledger.append({
      ...base,
      identity: "verification-retry-incomplete",
      verificationId: "verification-retry-incomplete",
      occurredAt: "2026-10-08T00:00:01Z",
      result: {
        status: "incomplete",
        reason: "precondition",
        nextStep: "Use a different Lab scenario",
      },
    });
    expect(
      await review.inspect({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
      }),
    ).toMatchObject({
      verificationStatus: "incomplete",
      reproductionPackageDigest: null,
    });
    await ledger.append({
      ...base,
      identity: "verification-retry-confirmed",
      verificationId: "verification-retry-confirmed",
      occurredAt: "2026-10-08T00:00:02Z",
      result: original.result,
    });
    expect(
      await review.inspect({
        campaignId: ref.campaignId,
        findingId: ref.findingId,
      }),
    ).toMatchObject({
      verificationStatus: "runtime-confirmed",
      reproductionPackageDigest:
        original.result.status === "runtime-confirmed"
          ? original.result.reproductionPackageDigest
          : null,
    });
  });

  it("evaluates each configured programme once and retains a confirmed finding when scope fails", async () => {
    const { review, ledger } = await fixture();
    const assessments = await review.assessScope({ ref });
    expect(
      assessments.map(({ programmeId, status }) => [programmeId, status]),
    ).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "out-of-scope"],
    ]);
    expect(ledger.read({ type: "scope-assessed" })).toHaveLength(2);

    const failed = await fixture({
      programmeIds: ["wordfence", "patchstack"],
      policyDigest: `sha256:${"d".repeat(64)}`,
      assess: async () => {
        throw new Error("policy unavailable");
      },
    });
    expect(
      (await failed.review.assessScope({ ref })).map(({ status }) => status),
    ).toEqual(["incomplete", "incomplete"]);
    expect(
      failed.ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({ result: { status: "runtime-confirmed" } });
  });

  it("binds a private draft revision and human authorization to the exact candidate and destination", async () => {
    const { review, ledger } = await fixture();
    const [assessment] = await review.assessScope({ ref });
    if (assessment === undefined) throw new Error("missing assessment");
    const draft = await review.saveDraft({
      assessmentId: assessment.id,
      content: "Private report text",
      preparedBy: "ai",
    });
    expect(draft.revision).toBe(1);
    expect(
      (
        await review.admitExternalAction({
          candidateId: draft.candidateId,
          draftDigest: draft.digest,
          destination: "wordfence",
        })
      ).status,
    ).toBe("not-authorized");
    await review.authorizeExternalAction({
      candidateId: draft.candidateId,
      draftDigest: draft.digest,
      destination: "wordfence",
      authorizedBy: "human-1",
    });
    expect(
      await review.admitExternalAction({
        candidateId: draft.candidateId,
        draftDigest: draft.digest,
        destination: "wordfence",
      }),
    ).toMatchObject({ status: "authorized" });
    expect(
      (
        await review.admitExternalAction({
          candidateId: draft.candidateId,
          draftDigest: draft.digest,
          destination: "patchstack",
        })
      ).status,
    ).toBe("not-authorized");
    const second = await review.saveDraft({
      assessmentId: assessment.id,
      content: "Revised private report",
      preparedBy: "human",
    });
    expect(second.revision).toBe(2);
    expect(
      (
        await review.admitExternalAction({
          candidateId: second.candidateId,
          draftDigest: second.digest,
          destination: "wordfence",
        })
      ).status,
    ).toBe("not-authorized");
    expect(
      (
        await review.admitExternalAction({
          candidateId: draft.candidateId,
          draftDigest: draft.digest,
          destination: "wordfence",
        })
      ).status,
    ).toBe("not-authorized");
    expect(JSON.stringify(ledger.read({ type: "draft-saved" }))).not.toContain(
      "Private report text",
    );
    expect(
      await review.inspect({
        campaignId: "campaign-1",
        findingId: "finding-1",
      }),
    ).toMatchObject({
      verificationStatus: "runtime-confirmed",
      drafts: [{ revision: 1 }, { revision: 2 }],
    });
  });

  it("rejects admission without a confirmed verification and exposes a duplicate-lookup seam", async () => {
    const { review, ledger } = await fixture();
    await expect(
      review.assessScope({
        ref: { ...ref, snapshotDigest: `sha256:${"c".repeat(64)}` },
      }),
    ).rejects.toThrow();
    expect(ledger.read({ type: "scope-assessed" })).toHaveLength(0);
    expect(
      await review.inspectDuplicate({
        campaignId: "campaign-1",
        findingId: "finding-1",
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("does not create a candidate from an out-of-scope assessment", async () => {
    const { review } = await fixture();
    const assessments = await review.assessScope({ ref });
    await expect(
      review.saveDraft({
        assessmentId: assessments[1]!.id,
        content: "Draft",
        preparedBy: "ai",
      }),
    ).rejects.toThrow("in-scope");
  });

  it("requires a matching human reproduction of the current reproduced package before drafting", async () => {
    const { review, ledger } = await fixture();
    const original = ledger.read({ type: "verification-finished" })[0]?.event;
    if (
      original?.type !== "verification-finished" ||
      original.result.status !== "runtime-confirmed"
    )
      throw new Error("missing fixture verification");
    await ledger.append({
      schemaVersion: 1,
      identity: "verification-2",
      campaignId: ref.campaignId,
      snapshotDigest: ref.snapshotDigest,
      occurredAt: "2026-10-08T00:30:00Z",
      type: "verification-finished",
      findingId: ref.findingId,
      verificationId: "verification-2",
      labSetupDigest: labSetup,
      result: {
        status: "reproduced",
        reproducerId: "standard-python-v1",
        proofKind: "captured-script-observation",
        conditions: { observedVia: "canary-row-read" },
        evidenceDigest: original.result.evidenceDigest,
        reproductionPackageDigest: original.result.reproductionPackageDigest,
        negativeControl: "pending-fixed-version",
      },
      evidenceCapture: "harness-captured",
    });
    const reproducedRef = { ...ref, verificationId: "verification-2" };
    const [assessment] = await review.assessScope({ ref: reproducedRef });
    if (assessment === undefined) throw new Error("missing assessment");
    const draft = () =>
      review.saveDraft({
        assessmentId: assessment.id,
        content: "Synthetic report",
        preparedBy: "ai",
      });
    await expect(draft()).rejects.toThrow("manual reproduction");
    await review.recordHumanReproduction({
      ref: reproducedRef,
      result: "mismatch",
    });
    await expect(draft()).rejects.toThrow("manual reproduction");
    await review.recordHumanReproduction({
      ref: reproducedRef,
      result: "match",
    });
    await expect(draft()).resolves.toMatchObject({ revision: 1 });
    expect(ledger.read({ type: "human-reproduction-recorded" })).toHaveLength(
      2,
    );
  });

  it("marks malformed programme coverage incomplete without changing verification", async () => {
    const { review, ledger } = await fixture({
      programmeIds: ["wordfence", "patchstack"],
      policyDigest: `sha256:${"d".repeat(64)}`,
      assess: async () => [
        {
          programmeId: "wordfence",
          status: "in-scope" as const,
          destination: "wordfence",
          reason: "qualified",
        },
        {
          programmeId: "wordfence",
          status: "in-scope" as const,
          destination: "wordfence",
          reason: "duplicate",
        },
      ],
    });
    expect(
      (await review.assessScope({ ref })).map(({ status }) => status),
    ).toEqual(["incomplete", "incomplete"]);
    expect(
      ledger.read({ type: "verification-finished" })[0]?.event,
    ).toMatchObject({ result: { status: "runtime-confirmed" } });
  });

  it("requires a new scope assessment when the policy digest changes", async () => {
    const { review, ledger, artifactStore } = await fixture();
    const [first] = await review.assessScope({ ref });
    if (first === undefined) throw new Error("missing assessment");
    const draft = await review.saveDraft({
      assessmentId: first.id,
      content: "Private report",
      preparedBy: "ai",
    });
    await review.authorizeExternalAction({
      candidateId: draft.candidateId,
      draftDigest: draft.digest,
      destination: "wordfence",
      authorizedBy: "human-1",
    });
    const refreshed = new Review({
      ledger,
      artifactStore,
      scopeEvaluator: {
        programmeIds: ["wordfence", "patchstack"],
        policyDigest: `sha256:${"e".repeat(64)}`,
        assess: async () => [
          {
            programmeId: "wordfence",
            status: "in-scope" as const,
            destination: "wordfence",
            reason: "qualified",
          },
          {
            programmeId: "patchstack",
            status: "out-of-scope" as const,
            destination: "patchstack",
            reason: "threshold",
          },
        ],
      },
      factsProvider: { load: async () => ({}) },
    });
    expect(
      (
        await refreshed.admitExternalAction({
          candidateId: draft.candidateId,
          draftDigest: draft.digest,
          destination: "wordfence",
        })
      ).status,
    ).toBe("not-authorized");
    const next = await refreshed.assessScope({ ref });
    expect(next[0]?.id).not.toBe(first.id);
  });
});

async function queueFixture() {
  const context = await fixture();
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
    occurredAt: "2026-10-08T00:00:00Z",
  };
  for (const [findingId, category] of [
    ["finding-2", "account-takeover"],
    ["finding-3", "stored-xss"],
    ["finding-4", "other"],
  ] as const)
    await context.ledger.append({
      ...base,
      identity: findingId,
      type: "finding-recorded",
      findingId,
      runId: "run-1",
      category,
    });
  await context.ledger.append({
    ...base,
    identity: "verification-2",
    type: "verification-finished",
    verificationId: "verification-2",
    findingId: "finding-2",
    labSetupDigest: labSetup,
    result: {
      status: "incomplete",
      reason: "observation",
      nextStep: "Repair the recipe and repeat",
    },
  });
  const refutation = await context.artifactStore.putFiles({
    "refutation.md": "Synthetic refutation\n",
  });
  await context.ledger.append({
    ...base,
    identity: "verification-3",
    type: "verification-finished",
    verificationId: "verification-3",
    findingId: "finding-3",
    labSetupDigest: labSetup,
    result: {
      status: "contradicted",
      judgeId: "synthetic",
      evidenceDigest: refutation,
    },
  });
  return context;
}

describe("review queue and decisions", () => {
  it("lists evidence-backed, contradicted, pending incomplete and unverified items", async () => {
    const { review } = await queueFixture();
    const queue = review.queue({ campaignId: "campaign-1" });
    expect(queue.contradicted).toBe(1);
    expect(queue.unverified).toBe(1);
    expect(queue.incompleteByReason).toEqual({});
    expect(queue.retryPendingByReason).toEqual({ observation: 1 });
    expect(queue.items).toEqual([
      expect.objectContaining({
        status: "runtime-confirmed",
        category: "sqli",
        ref,
        judgeId: "sqli-canary",
        conditions: {},
        evidenceDigest: expect.stringMatching(/^sha256:/),
        reproductionPackageDigest: expect.stringMatching(/^sha256:/),
        decision: null,
      }),
      expect.objectContaining({
        status: "incomplete",
        reason: "observation",
        ref: expect.objectContaining({ findingId: "finding-2" }),
      }),
      expect.objectContaining({
        status: "contradicted",
        ref: expect.objectContaining({ findingId: "finding-3" }),
      }),
      // #436: a Finding with no verification yet is listed, so it can be decided before its Lab.
      {
        status: "not-verified",
        ref: {
          campaignId: "campaign-1",
          findingId: "finding-4",
          snapshotDigest: snapshot,
        },
        category: "other",
        decision: null,
        group: { id: "finding-4", size: 1, representative: true },
      },
    ]);
  });

  it("records a reject before any verification and lists it with its reason (#436)", async () => {
    const { review, ledger } = await queueFixture();
    const unverified = {
      campaignId: "campaign-1",
      findingId: "finding-4",
      snapshotDigest: snapshot,
    };
    const recorded = await review.decide({
      ref: unverified,
      decision: "reject",
      reasonCode: "out-of-scope",
      openedEvidence: [],
      decidedBy: "operator",
    });
    expect(recorded).toMatchObject({
      ref: unverified,
      verificationStatus: "not-verified",
      reasonCode: "out-of-scope",
      elapsedMs: 3_600_000,
    });
    expect(recorded.ref).not.toHaveProperty("verificationId");
    const [event] = ledger.read({ type: "review-decided" });
    expect(event?.event).not.toHaveProperty("verificationId");
    const queue = review.queue({ campaignId: "campaign-1" });
    const item = queue.items.find((it) => it.ref.findingId === "finding-4");
    expect(item).toMatchObject({ status: "not-verified", decision: "reject" });
    expect((await review.decisionReasons(queue.items)).get(item!)).toBe(
      "out-of-scope",
    );
    // The count of unverified Findings and the funnel stay as they were.
    expect(queue.unverified).toBe(1);
    expect(ledger.funnel("campaign-1").reviewed).toBe(0);
    // A verified Finding is decided only on its verification.
    await expect(
      review.decide({
        ref: { ...unverified, findingId: "finding-1" },
        decision: "reject",
        reasonCode: "out-of-scope",
        openedEvidence: [],
        decidedBy: "operator",
      }),
    ).rejects.toThrow("not an unverified review item");
  });

  it("puts a contradicted Finding in the queue with the judge and its evidence digest", async () => {
    const { review, artifactStore } = await queueFixture();
    const refutation = await artifactStore.putFiles({
      "refutation.md": "Synthetic refutation\n",
    });
    const item = review
      .queue({ campaignId: "campaign-1" })
      .items.find((candidate) => candidate.ref.findingId === "finding-3");
    expect(item).toEqual({
      status: "contradicted",
      ref: {
        ...ref,
        findingId: "finding-3",
        verificationId: "verification-3",
      },
      category: "stored-xss",
      judgeId: "synthetic",
      evidenceDigest: refutation,
      refutationDigest: null,
      decision: null,
      group: { id: "finding-3", size: 1, representative: true },
    });
  });

  it("lists exhausted observation failures for human review", async () => {
    const { review, ledger } = await queueFixture();
    for (const attempt of [2, 3])
      await ledger.append({
        schemaVersion: 1,
        identity: `observation-retry-${attempt}`,
        campaignId: ref.campaignId,
        snapshotDigest: ref.snapshotDigest,
        occurredAt: `2026-10-08T00:0${attempt}:00Z`,
        type: "verification-finished",
        findingId: "finding-2",
        verificationId: `verification-2-${attempt}`,
        labSetupDigest: labSetup,
        result: {
          status: "incomplete",
          reason: "observation",
          nextStep: "Capture the effect",
        },
      });
    const queue = review.queue({ campaignId: ref.campaignId });
    expect(queue.incompleteByReason).toEqual({ observation: 1 });
    expect(queue.retryPendingByReason).toEqual({});
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        status: "incomplete",
        reason: "observation",
        ref: expect.objectContaining({ findingId: "finding-2" }),
      }),
    );
  });

  // Same ADR 0022 budget as the runner: the attempt count includes the current one.
  it.each([
    { reason: "recipe", additional: 3 },
    { reason: "provision", additional: 2 },
    { reason: "provider", additional: 2 },
    { reason: "no-judge", additional: 1 },
    { reason: "sandbox", additional: 1 },
    { reason: "evidence", additional: 1 },
    { reason: "cleanup", additional: 1 },
    { reason: "digest-mismatch", additional: 1 },
  ] as const)(
    "lists $reason after its retry budget",
    async ({ reason, additional }) => {
      const { review, ledger } = await queueFixture();
      const first = ledger.read({
        findingId: "finding-2",
        type: "verification-finished",
      })[0]?.event;
      if (first?.type !== "verification-finished") throw new Error("missing");
      for (let attempt = 1; attempt <= additional; attempt++)
        await ledger.append({
          ...first,
          identity: `${reason}-${attempt}`,
          verificationId: `${reason}-${attempt}`,
          result: { status: "incomplete", reason, nextStep: "Retry" },
        });
      const queue = review.queue({ campaignId: ref.campaignId });
      expect(queue.incompleteByReason).toEqual({ [reason]: 1 });
      expect(queue.retryPendingByReason).toEqual({});
      expect(queue.items).toContainEqual(
        expect.objectContaining({ status: "incomplete", reason }),
      );
    },
  );

  it.each([
    { reason: "recipe", additional: 2 },
    // The fixture already holds one observation attempt.
    { reason: "observation", additional: 1 },
    { reason: "provision", additional: 1 },
    { reason: "provider", additional: 1 },
  ] as const)(
    "keeps $reason pending while the runner still retries it",
    async ({ reason, additional }) => {
      const { review, ledger } = await queueFixture();
      const first = ledger.read({
        findingId: "finding-2",
        type: "verification-finished",
      })[0]?.event;
      if (first?.type !== "verification-finished") throw new Error("missing");
      for (let attempt = 1; attempt <= additional; attempt++)
        await ledger.append({
          ...first,
          identity: `${reason}-${attempt}`,
          verificationId: `${reason}-${attempt}`,
          result: { status: "incomplete", reason, nextStep: "Retry" },
        });
      const queue = review.queue({ campaignId: ref.campaignId });
      expect(queue.incompleteByReason).toEqual({});
      expect(queue.retryPendingByReason).toEqual({ [reason]: 1 });
    },
  );

  it("keeps separate reason, Lab Setup and prompt version retry budgets", async () => {
    const { review, ledger } = await queueFixture();
    const first = ledger.read({
      findingId: "finding-2",
      type: "verification-finished",
    })[0]?.event;
    if (first?.type !== "verification-finished") throw new Error("missing");
    for (const [name, reason, setup, promptVersion] of [
      ["recipe-1", "recipe", labSetup, undefined],
      ["recipe-2", "recipe", labSetup, undefined],
      ["recipe-new-lab", "recipe", `sha256:${"c".repeat(64)}`, undefined],
      ["recipe-new-lab-2", "recipe", `sha256:${"c".repeat(64)}`, undefined],
      ["recipe-new-lab-3", "recipe", `sha256:${"c".repeat(64)}`, undefined],
      ["recipe-new-prompt", "recipe", `sha256:${"c".repeat(64)}`, "v2"],
    ] as const) {
      await ledger.append({
        ...first,
        identity: name,
        verificationId: name,
        labSetupDigest: setup,
        ...(promptVersion === undefined ? {} : { promptVersion }),
        result: { status: "incomplete", reason, nextStep: "Retry" },
      });
      const { retryPendingByReason, incompleteByReason } = review.queue({
        campaignId: ref.campaignId,
      });
      if (name === "recipe-2")
        expect(retryPendingByReason).toEqual({ recipe: 1 });
      if (name === "recipe-new-lab-3") {
        expect(retryPendingByReason).toEqual({});
        expect(incompleteByReason).toEqual({ recipe: 1 });
      }
    }
    const queue = review.queue({ campaignId: ref.campaignId });
    expect(queue.incompleteByReason).toEqual({});
    expect(queue.retryPendingByReason).toEqual({ recipe: 1 });
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        status: "incomplete",
        reason: "recipe",
        ref: expect.objectContaining({ verificationId: "recipe-new-prompt" }),
      }),
    );
  });

  it("never predicts a precondition retry: the runner alone sees a scenario change", async () => {
    const { review, ledger } = await queueFixture();
    for (const [findingId, nextScenarioId] of [
      ["finding-2", undefined],
      ["finding-4", "private-post-v1"],
    ] as const)
      await ledger.append({
        schemaVersion: 1,
        identity: `precondition-${findingId}`,
        campaignId: ref.campaignId,
        snapshotDigest: ref.snapshotDigest,
        occurredAt: "2026-10-08T00:05:00Z",
        type: "verification-finished",
        findingId,
        verificationId: `precondition-${findingId}`,
        labSetupDigest: labSetup,
        result: {
          status: "incomplete",
          reason: "precondition",
          nextStep:
            nextScenarioId === undefined
              ? "No ordinary Lab scenario covers this prerequisite"
              : "Try the private post scenario",
          ...(nextScenarioId === undefined ? {} : { nextScenarioId }),
        },
      });
    const queue = review.queue({ campaignId: ref.campaignId });
    expect(queue.incompleteByReason).toEqual({ precondition: 2 });
    expect(queue.retryPendingByReason).toEqual({});
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        status: "incomplete",
        reason: "precondition",
        ref: expect.objectContaining({ findingId: "finding-2" }),
      }),
    );
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        status: "incomplete",
        reason: "precondition",
        ref: expect.objectContaining({ findingId: "finding-4" }),
      }),
    );
  });

  it("records a decision with reason, opened evidence, duplicate result and elapsed time", async () => {
    const { review, ledger, artifactStore } = await queueFixture();
    const [confirmed] = review.queue({ campaignId: "campaign-1" }).items;
    if (confirmed?.status !== "runtime-confirmed") throw new Error("missing");
    const decision = await review.decide({
      ref,
      decision: "accept",
      reasonCode: "reproduced-by-hand",
      openedEvidence: [confirmed.reproductionPackageDigest],
      duplicate: { status: "no-match" },
      decidedBy: "operator",
    });
    expect(decision).toMatchObject({
      schemaVersion: 1,
      decision: "accept",
      reasonCode: "reproduced-by-hand",
      duplicate: { status: "no-match" },
      elapsedMs: 3_600_000,
    });
    const [recorded] = ledger.read({ type: "review-decided" });
    expect(recorded?.event).toMatchObject({
      type: "review-decided",
      findingId: "finding-1",
      decision: "accept",
    });
    const stored = await artifactStore.readFile(
      recorded!.event.artifacts[0]!.digest,
      "record.json",
      10_000,
    );
    expect(stored.status).toBe("resolved");
    expect(review.queue({ campaignId: "campaign-1" }).items[0]).toMatchObject({
      decision: "accept",
    });
    expect(ledger.funnel("campaign-1").reviewed).toBe(1);
  });

  it("records a decision on a contradicted item and refuses unknown verifications", async () => {
    const { review } = await queueFixture();
    const contradictedRef = {
      ...ref,
      findingId: "finding-3",
      verificationId: "verification-3",
    };
    const recorded = await review.decide({
      ref: contradictedRef,
      decision: "reject",
      reasonCode: "judge-contradicted",
      openedEvidence: [],
      decidedBy: "operator",
    });
    expect(recorded.verificationStatus).toBe("contradicted");
    expect(
      review
        .queue({ campaignId: "campaign-1" })
        .items.find((item) => item.ref.findingId === "finding-3"),
    ).toMatchObject({ decision: "reject" });
    await expect(
      review.decide({
        ref: { ...contradictedRef, verificationId: "verification-unknown" },
        decision: "accept",
        reasonCode: "manual",
        openedEvidence: [],
        decidedBy: "operator",
      }),
    ).rejects.toThrow();
  });
});

describe("review submission records", () => {
  it("records a human submission only for an exactly authorized draft, then its outcome", async () => {
    const { review, ledger } = await fixture();
    await review.decide({
      ref,
      decision: "accept",
      reasonCode: "reproduced-by-hand",
      openedEvidence: [],
      decidedBy: "operator",
    });
    const [assessment] = await review.assessScope({ ref });
    const draft = await review.saveDraft({
      assessmentId: assessment!.id,
      content: "Private report text",
      preparedBy: "human",
    });
    const submission = {
      candidateId: draft.candidateId,
      draftDigest: draft.digest,
      destination: "wordfence",
    };
    await expect(review.recordSubmission(submission)).rejects.toThrow();
    await expect(
      review.recordOutcome({
        candidateId: draft.candidateId,
        outcome: "triaged",
      }),
    ).rejects.toThrow();
    await review.authorizeExternalAction({
      ...submission,
      authorizedBy: "human-1",
    });
    await review.recordSubmission(submission);
    await review.recordOutcome({
      candidateId: draft.candidateId,
      outcome: "triaged",
    });
    expect(ledger.funnel("campaign-1")).toMatchObject({
      reviewed: 1,
      inScope: 1,
      submitted: 1,
      outcome: 1,
    });
    expect(ledger.read({ type: "submission-outcome" })[0]?.event).toMatchObject(
      {
        candidateId: draft.candidateId,
        outcome: "triaged",
      },
    );
  });
});

describe("review decision traceability (ADR 0032 Q22)", () => {
  it("records the human's elapsed seconds and traces the decision to the run and prompt", async () => {
    const { review, ledger } = await fixture();
    const promptDigest = `sha256:${"e".repeat(64)}`;
    await ledger.append({
      schemaVersion: 1,
      identity: "run-1-started",
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
      occurredAt: "2026-10-07T23:00:00Z",
      type: "discovery-run-started",
      runId: "run-1",
      labId: "lab-1",
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v3",
        promptDigest,
        assignmentUnit: "whole",
      },
    });
    const decision = await review.decide({
      ref,
      decision: "defer",
      reasonCode: "needs-manual-check",
      openedEvidence: [],
      decidedBy: "operator",
      humanElapsedSeconds: 420,
    });
    expect(decision).toMatchObject({
      humanElapsedSeconds: 420,
      trace: { runId: "run-1", promptDigest },
    });
    const event = ledger.read({ type: "review-decided" })[0]?.event;
    if (event?.type !== "review-decided") throw new Error("missing event");
    expect(event).toMatchObject({
      findingId: "finding-1",
      decision: "defer",
      humanElapsedSeconds: 420,
      verificationId: "verification-1",
      runId: "run-1",
      promptDigest,
    });
  });

  it("leaves the optional fields out when the caller supplies no elapsed time and no run is known", async () => {
    const { review, ledger } = await fixture();
    const decision = await review.decide({
      ref,
      decision: "accept",
      reasonCode: "reproduced-by-hand",
      openedEvidence: [],
      decidedBy: "operator",
    });
    expect("humanElapsedSeconds" in decision).toBe(false);
    // The Finding's run id is known from finding-recorded even without a run-started event.
    expect(decision.trace).toEqual({ runId: "run-1" });
    const event = ledger.read({ type: "review-decided" })[0]?.event;
    if (event?.type !== "review-decided") throw new Error("missing event");
    expect("humanElapsedSeconds" in event).toBe(false);
    expect("promptDigest" in event).toBe(false);
    expect(event.runId).toBe("run-1");
    expect(event.verificationId).toBe("verification-1");
  });
});
