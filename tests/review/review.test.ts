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
  it("lists confirmed items with evidence and incomplete items with next steps, and counts contradicted", async () => {
    const { review } = await queueFixture();
    const queue = review.queue({ campaignId: "campaign-1" });
    expect(queue.contradicted).toBe(1);
    expect(queue.unverified).toBe(1);
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
        category: "account-takeover",
        reason: "observation",
        nextStep: "Repair the recipe and repeat",
        decision: null,
      }),
    ]);
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

  it("refuses decisions on contradicted or unknown verifications", async () => {
    const { review } = await queueFixture();
    await expect(
      review.decide({
        ref: {
          ...ref,
          findingId: "finding-3",
          verificationId: "verification-3",
        },
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
