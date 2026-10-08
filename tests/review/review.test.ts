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
        findingId: "finding-1",
        candidateId: "candidate-1",
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
