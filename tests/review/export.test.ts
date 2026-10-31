import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import {
  exportReviewBundle,
  Review,
  REVIEW_EXPORT_SCHEMA_ID,
  reviewExportV1Schema,
  type HttpEvidenceReader,
  type HttpEvidenceRecord,
  type StateDiffReader,
  type StateDiffSummary,
} from "../../src/review/index.js";

const snapshot = `sha256:${"a".repeat(64)}`;
const labSetup = `sha256:${"b".repeat(64)}`;
const promptDigest = `sha256:${"c".repeat(64)}`;
const scenarioDigest = `sha256:${"d".repeat(64)}`;

/** Sentinels that must never reach the exported bundle. */
const PAYLOAD = "PAYLOAD-SENTINEL-0d9f";
const RESPONSE_BODY = "RESPONSE-BODY-SENTINEL-7b21";
const QUERY_VALUE = "query-value-sentinel-33af";
const OPTION_VALUE = "option-value-sentinel-91c0";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const emptySummary: StateDiffSummary = {
  settings: { added: [], removed: [], changed: [] },
  principals: { added: [], removed: [], changed: [] },
  tables: { added: [], removed: [], changed: [] },
};

async function fixture(
  options: {
    readonly verification?:
      "incomplete" | "confirmed" | "contradicted" | "none";
    readonly labStateDiff?: "captured" | "missing" | "absent";
    readonly reader?: StateDiffReader;
    /**
     * `bare` appends a decision and a scope assessment with no private record,
     * as older ledgers hold them; `none` leaves review events to `Review`.
     */
    readonly review?: "bare" | "none";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-export-"));
  directories.push(root);
  const evidenceDirectory = join(root, "private-evidence");
  const store = new PrivateArtifactStore({
    rootDirectory: evidenceDirectory,
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const base = {
    schemaVersion: 1 as const,
    campaignId: "campaign-1",
    snapshotDigest: snapshot,
  };
  const selection = await store.putFiles({
    "target-selection.json": canonicalJson({
      targetId: "wporg:synthetic",
      slug: "synthetic",
      version: "1.2",
      activeInstallations: 120_000,
    }),
  });
  await ledger.append({
    ...base,
    identity: "selected-1",
    occurredAt: "2026-10-08T00:00:00Z",
    type: "target-selected",
    selectionId: "wporg:synthetic@1.2",
    artifacts: [{ kind: "target-selection", digest: selection }],
  });
  // A later campaign observed a newer release of the same target.
  await ledger.append({
    ...base,
    campaignId: "campaign-2",
    snapshotDigest: `sha256:${"e".repeat(64)}`,
    identity: "selected-2",
    occurredAt: "2026-10-12T00:00:00Z",
    type: "target-selected",
    selectionId: "wporg:synthetic@1.3",
  });
  await ledger.append({
    ...base,
    identity: "run-1-started",
    occurredAt: "2026-10-08T00:01:00Z",
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
  const finding = await store.putFiles({
    "finding.json": canonicalJson({
      claim: "An unauthenticated request writes a site option",
      attackerPosition: "unauthenticated",
      impact: "options-update",
      brokenProperty: "Only administrators change site options",
      configurationPrecondition: "default",
      configurationClass: "default",
      attackerInputPath: "direct-request",
      exploitTiming: "any-time",
      sourceTrace: [
        { file: "includes/handler.php", function: "save", line: 12 },
      ],
      existingControls: "none",
      labObservations: `Sent ${PAYLOAD} and the option changed`,
      privateRecipeReference: PAYLOAD,
    }),
  });
  await ledger.append({
    ...base,
    identity: "finding-1",
    occurredAt: "2026-10-08T00:30:00Z",
    type: "finding-recorded",
    findingId: "finding-1",
    runId: "run-1",
    category: "options-update",
    artifacts: [{ kind: "finding", digest: finding }],
  });
  if (options.verification === "none")
    return { ledger, store, evidenceDirectory };

  await ledger.append({
    ...base,
    identity: "verification-lab-verification-1",
    occurredAt: "2026-10-08T01:00:00Z",
    type: "lab-provisioned",
    labId: "lab-2",
    status: "ready",
    purpose: "verification",
    scenario: { id: "ordinary-blog", digest: scenarioDigest },
  });
  // The HTTP record itself is profile-owned and reaches export only through
  // HttpEvidenceReader; the artifact holds a body sentinel export must not read.
  const evidence = await store.putFiles({
    "http-record": `${PAYLOAD} ${RESPONSE_BODY}`,
    "canary-observation.json": canonicalJson({ fired: false }),
  });
  const refutation = await store.putFiles({
    "refutation.md":
      "The canary did not fire; the option changed but the nonce check held.\n",
  });
  const recipe = await store.putFiles({
    "route.json": canonicalJson({ steps: [{ body: PAYLOAD }] }),
  });
  const before = await store.putFiles({
    "lab-state.json": canonicalJson({
      options: [{ name: "x", value: OPTION_VALUE }],
    }),
  });
  const after = await store.putFiles({
    "lab-state.json": canonicalJson({
      options: [{ name: "x", value: "changed" }],
    }),
  });
  const diff = await store.putFiles({
    "lab-state-diff.json": canonicalJson({
      changed: [{ name: "x", before: OPTION_VALUE }],
    }),
  });
  const labStateDiff = options.labStateDiff ?? "captured";
  await ledger.append({
    ...base,
    identity: "verification-1",
    occurredAt: "2026-10-08T01:10:00Z",
    type: "verification-finished",
    verificationId: "verification-1",
    findingId: "finding-1",
    labSetupDigest: labSetup,
    evidenceCapture: "harness-captured",
    result:
      options.verification === "confirmed"
        ? {
            status: "runtime-confirmed",
            judgeId: "option-canary",
            proofKind: "nonce-canary",
            evidenceDigest: evidence,
            reproductionPackageDigest: recipe,
            conditions: { attackerRole: "unauthenticated" },
          }
        : options.verification === "contradicted"
          ? {
              status: "contradicted",
              judgeId: "option-canary",
              evidenceDigest: evidence,
              refutationDigest: refutation,
            }
          : {
              status: "incomplete",
              reason: "observation",
              nextStep: "Review the option diff by hand",
              evidenceDigest: evidence,
              refutationDigest: refutation,
            },
    ...(labStateDiff === "captured"
      ? {
          labStateDiff: { status: "captured" },
          artifacts: [
            { kind: "recipe", digest: recipe },
            { kind: "lab-state-before", digest: before },
            { kind: "lab-state-after", digest: after },
            { kind: "lab-state-diff", digest: diff },
          ],
        }
      : labStateDiff === "missing"
        ? {
            labStateDiff: { status: "missing", reason: "after-capture" },
            artifacts: [{ kind: "recipe", digest: recipe }],
          }
        : { artifacts: [{ kind: "recipe", digest: recipe }] }),
  });
  if ((options.review ?? "bare") === "bare") {
    await ledger.append({
      ...base,
      identity: "decision-1",
      occurredAt: "2026-10-08T02:00:00Z",
      type: "review-decided",
      findingId: "finding-1",
      decision: "defer",
      humanElapsedSeconds: 540,
      verificationId: "verification-1",
      runId: "run-1",
      promptDigest,
    });
    await ledger.append({
      ...base,
      identity: "scope-1",
      occurredAt: "2026-10-08T02:01:00Z",
      type: "scope-assessed",
      findingId: "finding-1",
      programmeId: "wordfence",
      status: "in-scope",
    });
  }
  return { ledger, store, evidenceDirectory, diffDigest: diff, evidence };
}

const ref = {
  campaignId: "campaign-1",
  findingId: "finding-1",
  verificationId: "verification-1",
  snapshotDigest: snapshot,
};

/** The same Review that writes the records the export reads back. */
function reviewOver(
  ledger: Ledger,
  store: PrivateArtifactStore,
  clock = () => new Date("2026-10-09T00:00:00Z"),
): Review {
  return new Review({
    ledger,
    artifactStore: store,
    scopeEvaluator: {
      programmeIds: ["wordfence"],
      policyDigest: `sha256:${"9".repeat(64)}`,
      assess: async () => [
        {
          programmeId: "wordfence",
          status: "in-scope",
          destination: "wordfence",
          reason: "qualified",
        },
      ],
    },
    factsProvider: { load: async () => ({}) },
    clock,
  });
}

const reader = (summary: StateDiffSummary | null): StateDiffReader => ({
  read: async () => summary,
});

/** A profile reader handing over method, address and status; addresses still carry query values. */
const httpReader = (
  store: PrivateArtifactStore,
  exchanges: HttpEvidenceRecord["exchanges"] | null = [
    {
      method: "POST",
      address: `/wp-admin/admin-ajax.php?action=save&token=${QUERY_VALUE}`,
      status: 200,
    },
    { method: "GET", address: "/", status: 200 },
  ],
): HttpEvidenceReader => ({
  read: async (digest) =>
    exchanges === null
      ? null
      : {
          source: "harness-captured",
          path: join(store.contentPath(digest), "http-record"),
          exchanges,
        },
});

describe("review export", () => {
  it("builds a versioned bundle with review material and paths, never bodies or payloads", async () => {
    const { ledger, store, evidenceDirectory, diffDigest, evidence } =
      await fixture();
    const bundle = await exportReviewBundle({
      ledger,
      store,
      campaignId: "campaign-1",
      findingId: "finding-1",
      stateDiff: reader({
        ...emptySummary,
        settings: {
          added: [],
          removed: [],
          changed: [{ key: "x", beforeDigest: "aa", afterDigest: "bb" }],
        },
      }),
      httpEvidence: httpReader(store),
      clock: () => new Date("2026-10-08T03:00:00Z"),
    });
    expect(reviewExportV1Schema.parse(bundle)).toEqual(bundle);
    expect(bundle.schema).toBe(REVIEW_EXPORT_SCHEMA_ID);
    expect(bundle.target).toEqual({
      selectionId: "wporg:synthetic@1.2",
      targetId: "wporg:synthetic",
      activeInstallations: 120_000,
      versions: {
        explored: "1.2",
        latestKnown: "1.3",
        latestKnownAt: "2026-10-12T00:00:00Z",
        sameAsExplored: false,
        latestObserved: null,
      },
    });
    expect(bundle.finding).toMatchObject({
      category: "options-update",
      claim: "An unauthenticated request writes a site option",
      attackerPosition: "unauthenticated",
      impact: "options-update",
      brokenProperty: "Only administrators change site options",
      configurationPrecondition: "default",
      // #613: the declared enum values travel with the Finding.
      configurationClass: "default",
      attackerInputPath: "direct-request",
      exploitTiming: "any-time",
      sourceTrace: [
        { file: "includes/handler.php", function: "save", line: 12 },
      ],
      runId: "run-1",
      promptVariant: "wp2shell-bounty-v3",
      promptDigest,
    });
    expect(bundle.finding.path).toMatch(
      /private-evidence\/sha256:[a-f0-9]{64}\/content\/finding\.json$/,
    );
    expect(bundle.verification).toMatchObject({
      verificationId: "verification-1",
      status: "incomplete",
      reason: "observation",
      nextStep: "Review the option diff by hand",
      judgeId: null,
      conditions: null,
      evidenceCapture: "harness-captured",
      labSetupDigest: labSetup,
      scenario: { id: "ordinary-blog", digest: scenarioDigest },
      // #699: a Lab recorded before the baseline has none.
      baseline: null,
      attempts: 1,
      verifierRuns: [],
    });
    // Method, path and status only; query parameter names, not values.
    expect(bundle.http).toEqual({
      source: "harness-captured",
      path: join(evidenceDirectory, evidence!, "content", "http-record"),
      exchanges: [
        {
          method: "POST",
          path: "/wp-admin/admin-ajax.php",
          queryKeys: ["action", "token"],
          status: 200,
        },
        { method: "GET", path: "/", queryKeys: [], status: 200 },
      ],
      truncated: false,
    });
    // Review caps the rows and says so; a profile reader without a record means unavailable.
    const many = await exportReviewBundle({
      ledger,
      store,
      campaignId: "campaign-1",
      findingId: "finding-1",
      httpEvidence: httpReader(
        store,
        Array.from({ length: 501 }, (_, index) => ({
          method: "GET",
          address: `/page/${index}`,
          status: 200,
        })),
      ),
    });
    expect(many.http.exchanges).toHaveLength(500);
    expect(many.http.truncated).toBe(true);
    expect(
      (
        await exportReviewBundle({
          ledger,
          store,
          campaignId: "campaign-1",
          findingId: "finding-1",
          httpEvidence: httpReader(store, null),
        })
      ).http,
    ).toEqual({
      source: "unavailable",
      path: null,
      exchanges: [],
      truncated: false,
    });
    expect(bundle.refutation).toMatchObject({
      text: expect.stringContaining("The canary did not fire"),
      truncated: false,
    });
    expect(bundle.labStateDiff).toEqual({
      status: "captured",
      path: join(evidenceDirectory, diffDigest!, "content"),
      summary: {
        ...emptySummary,
        settings: {
          added: [],
          removed: [],
          changed: [{ key: "x", beforeDigest: "aa", afterDigest: "bb" }],
        },
      },
    });
    expect(bundle.review).toEqual({
      externalSubmissions: [],
      decisions: [
        {
          decision: "defer",
          occurredAt: "2026-10-08T02:00:00Z",
          humanElapsedSeconds: 540,
        },
      ],
      scopeAssessments: [
        {
          assessmentId: "scope-1",
          programmeId: "wordfence",
          status: "in-scope",
        },
      ],
      // A decision event without its private record keeps the codes null.
      decision: {
        decision: "defer",
        reasonCode: null,
        duplicate: null,
        decidedAt: "2026-10-08T02:00:00Z",
      },
      duplicate: null,
      humanReproduction: null,
      latestReverification: null,
      latestDraft: null,
      labSetup: { digest: labSetup, ordinaryActivationDefaults: null },
    });
    expect(bundle.privateEvidence.directory).toBe(evidenceDirectory);
    expect(bundle.privateEvidence.artifacts.map((a) => a.kind).sort()).toEqual([
      "finding",
      "judge-evidence",
      "lab-state-after",
      "lab-state-before",
      "lab-state-diff",
      "recipe",
      "refutation",
      "target-selection",
    ]);
    for (const artifact of bundle.privateEvidence.artifacts)
      expect(artifact.path).toBe(
        join(evidenceDirectory, artifact.digest, "content"),
      );

    const serialized = canonicalJson(bundle);
    for (const sentinel of [PAYLOAD, RESPONSE_BODY, QUERY_VALUE, OPTION_VALUE])
      expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain("labObservations");
    expect(serialized).not.toContain("privateRecipeReference");
  });

  it("reports a missing or unreadable state diff and an unverified Finding without failing", async () => {
    const missing = await fixture({ labStateDiff: "missing" });
    expect(
      (
        await exportReviewBundle({
          ...missing,
          campaignId: "campaign-1",
          findingId: "finding-1",
        })
      ).labStateDiff,
    ).toEqual({ status: "missing", reason: "after-capture" });

    const unreadable = await fixture();
    expect(
      (
        await exportReviewBundle({
          ...unreadable,
          campaignId: "campaign-1",
          findingId: "finding-1",
          stateDiff: reader(null),
        })
      ).labStateDiff,
    ).toEqual({ status: "missing", reason: "store" });

    const older = await fixture({ labStateDiff: "absent" });
    expect(
      (
        await exportReviewBundle({
          ...older,
          campaignId: "campaign-1",
          findingId: "finding-1",
        })
      ).labStateDiff,
    ).toEqual({ status: "unavailable" });

    const unverified = await fixture({ verification: "none" });
    const bundle = await exportReviewBundle({
      ...unverified,
      campaignId: "campaign-1",
      findingId: "finding-1",
      // Without a recorded recipe the profile reader is never asked.
      verifierRecord: { read: () => Promise.reject(new Error("no recipe")) },
    });
    expect(bundle.verification).toBeNull();
    expect(bundle.http).toEqual({
      source: "unavailable",
      path: null,
      exchanges: [],
      truncated: false,
    });
    expect(bundle.refutation).toBeNull();
    expect(bundle.observations).toBeNull();
    expect(bundle.labStateDiff).toEqual({ status: "unavailable" });
    expect(bundle.review).toEqual({
      externalSubmissions: [],
      decisions: [],
      scopeAssessments: [],
      decision: null,
      duplicate: null,
      humanReproduction: null,
      latestReverification: null,
      latestDraft: null,
      labSetup: null,
    });
  });

  it("carries the judge conditions and reproduction package reference for a confirmed Finding", async () => {
    const confirmed = await fixture({ verification: "confirmed" });
    const bundle = await exportReviewBundle({
      ...confirmed,
      campaignId: "campaign-1",
      findingId: "finding-1",
      stateDiff: reader(emptySummary),
    });
    expect(bundle.verification).toMatchObject({
      status: "runtime-confirmed",
      judgeId: "option-canary",
      conditions: { attackerRole: "unauthenticated" },
      reason: null,
    });
    expect(
      bundle.privateEvidence.artifacts.some(
        (a) => a.kind === "reproduction-package",
      ),
    ).toBe(true);
    expect(canonicalJson(bundle)).not.toContain(PAYLOAD);
  });

  it("exports a contradicted Finding with its judge, evidence and refutation", async () => {
    const contradicted = await fixture({ verification: "contradicted" });
    const bundle = await exportReviewBundle({
      ...contradicted,
      campaignId: "campaign-1",
      findingId: "finding-1",
      stateDiff: reader(emptySummary),
    });
    expect(bundle.verification).toMatchObject({
      status: "contradicted",
      judgeId: "option-canary",
      conditions: null,
      reason: null,
    });
    expect(bundle.privateEvidence.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "judge-evidence",
        digest: contradicted.evidence,
      }),
    );
    expect(bundle.refutation?.text).toContain("nonce check held");
    expect(canonicalJson(bundle)).not.toContain(PAYLOAD);
  });

  it("refuses a Finding the campaign never recorded", async () => {
    const { ledger, store } = await fixture();
    await expect(
      exportReviewBundle({
        ledger,
        store,
        campaignId: "campaign-1",
        findingId: "finding-9",
      }),
    ).rejects.toThrow("The finding is not recorded in this campaign");
  });

  it("fills the decision, reproduction, reverification, draft and newest release", async () => {
    const { ledger, store } = await fixture({
      verification: "confirmed",
      review: "none",
    });
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: snapshot,
    };
    // The decision and the drafts are Review's own records, written by Review.
    const review = reviewOver(ledger, store);
    await review.decide({
      ref,
      decision: "accept",
      reasonCode: "accepted",
      openedEvidence: [],
      duplicate: { status: "possible-match", reference: "CVE-1" },
      decidedBy: "owner",
    });
    const [assessment] = await review.assessScope({ ref });
    await review.saveDraft({
      assessmentId: assessment!.id,
      content: "First draft",
      preparedBy: "ai",
    });
    const second = await review.saveDraft({
      assessmentId: assessment!.id,
      content: "Second draft",
      preparedBy: "ai",
    });
    const latest = `sha256:${"f".repeat(64)}`;
    const confirmed = ledger
      .readAll({
        campaignId: "campaign-1",
        findingId: "finding-1",
        type: "verification-finished",
      })
      .at(-1)?.event;
    if (
      confirmed?.type !== "verification-finished" ||
      confirmed.result.status !== "runtime-confirmed"
    )
      throw new Error("Expected a confirmed fixture");
    for (const event of [
      {
        ...base,
        identity: "reproduced-1",
        occurredAt: "2026-10-09T01:00:00Z",
        type: "human-reproduction-recorded" as const,
        findingId: "finding-1",
        verificationId: "verification-1",
        reproductionPackageDigest: confirmed.result.reproductionPackageDigest,
        result: "match" as const,
      },
      {
        ...base,
        identity: "effort-1",
        occurredAt: "2026-10-09T01:00:00Z",
        type: "human-effort-recorded" as const,
        findingId: "finding-1",
        action: "reproduce" as const,
        minutes: 35,
      },
      {
        ...base,
        snapshotDigest: latest,
        identity: "finding-2",
        occurredAt: "2026-10-10T00:00:00Z",
        type: "finding-recorded" as const,
        findingId: "finding-2",
        runId: "run-1",
        category: "options-update",
        derivedFromFindingId: "finding-1",
        derivationKind: "latest-version" as const,
      },
      {
        ...base,
        snapshotDigest: latest,
        identity: "verification-2",
        occurredAt: "2026-10-10T01:00:00Z",
        type: "verification-finished" as const,
        verificationId: "verification-2",
        findingId: "finding-2",
        labSetupDigest: labSetup,
        basis: {
          kind: "latest-version" as const,
          findingSnapshotDigest: snapshot,
        },
        result: {
          status: "incomplete" as const,
          reason: "recipe" as const,
          nextStep: "Repeat",
        },
      },
    ]) {
      expect((await ledger.append(event)).status).toBe("appended");
      if (event.type === "human-effort-recorded") {
        const beforeLatestVersion = await exportReviewBundle({
          ledger,
          store,
          campaignId: "campaign-1",
          findingId: "finding-1",
        });
        expect(beforeLatestVersion.review.humanReproduction).toMatchObject({
          result: "match",
          minutes: 35,
        });
      }
    }
    const exported = (observe: () => Promise<never | object>) =>
      exportReviewBundle({
        ledger,
        store,
        campaignId: "campaign-1",
        findingId: "finding-1",
        observeLatestVersion: observe as never,
      });
    const bundle = await exported(async () => ({
      version: "1.4",
      observedAt: "2026-10-14T00:00:00Z",
    }));
    expect(bundle.target.versions.latestObserved).toEqual({
      version: "1.4",
      observedAt: "2026-10-14T00:00:00Z",
    });
    expect(bundle.review).toMatchObject({
      decision: {
        decision: "accept",
        reasonCode: "accepted",
        duplicate: "possible-match:CVE-1",
        decidedAt: "2026-10-09T00:00:00.000Z",
      },
      // The latest-version derived Finding supersedes this historical match.
      humanReproduction: null,
      latestReverification: {
        verificationId: "verification-2",
        findingId: "finding-2",
        status: "incomplete",
        basis: "latest-version",
      },
      latestDraft: {
        digest: second.digest,
        revision: 2,
        preparedBy: "ai",
        programme: "wordfence",
      },
    });
    // A failed observation is null, not an error.
    const failed = await exported(async () => {
      throw new Error("offline");
    });
    expect(failed.target.versions.latestObserved).toBeNull();
  });

  it("keeps the last historical decision in export after the queue decision expires", async () => {
    const { ledger, store } = await fixture({
      verification: "confirmed",
      review: "none",
    });
    const review = reviewOver(ledger, store);
    await review.decide({
      ref,
      decision: "defer",
      reasonCode: "needs-review",
      duplicate: { status: "no-match" },
      openedEvidence: [],
      decidedBy: "owner",
    });
    expect(
      review.queue({ campaignId: ref.campaignId }).items[0]?.decision,
    ).toBe("defer");
    await ledger.append({
      schemaVersion: 1,
      identity: "later-verification",
      campaignId: ref.campaignId,
      snapshotDigest: snapshot,
      occurredAt: "2026-10-10T00:00:00Z",
      type: "verification-finished",
      findingId: ref.findingId,
      verificationId: "later-verification",
      labSetupDigest: labSetup,
      result: {
        status: "incomplete",
        reason: "evidence",
        nextStep: "Review evidence",
      },
    });
    expect(
      review.queue({ campaignId: ref.campaignId }).items[0]?.decision,
    ).toBeNull();
    const bundle = await exportReviewBundle({
      ledger,
      store,
      campaignId: ref.campaignId,
      findingId: ref.findingId,
    });
    expect(bundle.review.decision).toMatchObject({
      decision: "defer",
      reasonCode: "needs-review",
      duplicate: "no-match",
    });
    // Historical duplicate checks survive a new verification, independently of
    // whether the old human decision is still current in the queue.
    expect(await review.duplicateOf(ref)).toMatchObject({ status: "no-match" });
    expect(
      (await review.listing({ campaignId: ref.campaignId })).rows[0],
    ).toMatchObject({
      item: { decision: null },
      decisionReason: null,
      duplicate: { status: "no-match" },
    });
    const after = reviewOver(
      ledger,
      store,
      () => new Date("2026-10-11T00:00:00Z"),
    );
    await after.decide({
      ref: { ...ref, verificationId: "later-verification" },
      decision: "reject",
      reasonCode: "reviewed",
      openedEvidence: [],
      decidedBy: "owner",
    });
    const queue = after.queue({ campaignId: ref.campaignId });
    const item = queue.items[0];
    expect(item?.decision).toBe("reject");
    expect((await after.listing({ campaignId: ref.campaignId })).rows).toEqual([
      {
        item,
        decisionReason: "reviewed",
        // Carried forward from the decision before the new verification.
        duplicate: expect.objectContaining({ status: "no-match" }),
        manualObservationEvidence: null,
      },
    ]);
    const latest = await exportReviewBundle({
      ledger,
      store,
      campaignId: ref.campaignId,
      findingId: ref.findingId,
    });
    expect(latest.review.decision).toMatchObject({
      decision: "reject",
      duplicate: "no-match",
    });
    expect(latest.review.decisions.map(({ decision }) => decision)).toEqual([
      "defer",
      "reject",
    ]);
  });

  it("carries a possible-match reference from Review's decision record", async () => {
    const { ledger, store } = await fixture({
      verification: "confirmed",
      review: "none",
    });
    const review = reviewOver(ledger, store);
    const exportDecision = async () =>
      (
        await exportReviewBundle({
          ledger,
          store,
          campaignId: "campaign-1",
          findingId: "finding-1",
        })
      ).review.decision;
    await review.decide({
      ref,
      decision: "defer",
      reasonCode: "needs-dedupe",
      openedEvidence: [],
      duplicate: { status: "no-match" },
      decidedBy: "owner",
    });
    expect(await exportDecision()).toMatchObject({
      decision: "defer",
      reasonCode: "needs-dedupe",
      duplicate: "no-match",
    });
    await review.decide({
      ref,
      decision: "reject",
      reasonCode: "duplicate",
      openedEvidence: [],
      duplicate: { status: "possible-match", reference: "CVE-2026-0001" },
      decidedBy: "owner",
    });
    expect(await exportDecision()).toMatchObject({
      decision: "reject",
      reasonCode: "duplicate",
      duplicate: "possible-match:CVE-2026-0001",
    });
  });

  it("keeps the stage-4 result, what backs it and when, until the next one is recorded (#442)", async () => {
    const { ledger, store } = await fixture({
      verification: "confirmed",
      review: "none",
    });
    let now = "2026-10-09T00:00:00Z";
    const review = reviewOver(ledger, store, () => new Date(now));
    const decide = (extra: Partial<Parameters<Review["decide"]>[0]> = {}) =>
      review.decide({
        ref,
        decision: "accept",
        reasonCode: "accepted",
        openedEvidence: [],
        decidedBy: "owner",
        ...extra,
      });
    const exported = () =>
      exportReviewBundle({
        ledger,
        store,
        campaignId: "campaign-1",
        findingId: "finding-1",
      });

    // A decision before any check carries an `unavailable` nobody recorded.
    await decide();
    expect((await exported()).review.duplicate).toEqual({
      status: "unavailable",
      reference: null,
      reason: null,
      checkedAt: null,
      note: null,
    });

    const url = "https://records.invalid/synthetic/1.2/stored-xss";
    now = "2026-10-09T01:00:00Z";
    await decide({
      duplicate: { status: "possible-match", reference: url },
      duplicateNote: "Three databases searched; one record matches.\n",
    });
    // A later decision without a result (here, the reproduction) keeps it.
    now = "2026-10-09T02:00:00Z";
    await decide({ reasonCode: "reproduced-by-hand" });
    const kept = await exported();
    expect(kept.review.decision).toMatchObject({
      reasonCode: "reproduced-by-hand",
      duplicate: `possible-match:${url}`,
      decidedAt: "2026-10-09T02:00:00.000Z",
    });
    expect(kept.review.duplicate).toMatchObject({
      status: "possible-match",
      reference: url,
      reason: null,
      checkedAt: "2026-10-09T01:00:00.000Z",
    });
    const note = kept.review.duplicate!.note!;
    expect(await readFile(note.path, "utf8")).toBe(
      "Three databases searched; one record matches.\n",
    );
    expect(kept.privateEvidence.artifacts).toContainEqual(
      expect.objectContaining({ kind: "dedupe-note", digest: note.digest }),
    );

    // `unavailable` keeps its reason; only a recorded `no-match` reads `no-match`.
    now = "2026-10-09T03:00:00Z";
    await decide({
      duplicate: { status: "unavailable", reason: "mirror-stale" },
    });
    expect((await exported()).review).toMatchObject({
      decision: { duplicate: "unavailable" },
      duplicate: {
        status: "unavailable",
        reference: null,
        reason: "mirror-stale",
        checkedAt: "2026-10-09T03:00:00.000Z",
        note: null,
      },
    });
    now = "2026-10-09T04:00:00Z";
    await decide({ duplicate: { status: "no-match" } });
    expect((await exported()).review).toMatchObject({
      decision: { duplicate: "no-match" },
      duplicate: { status: "no-match", checkedAt: "2026-10-09T04:00:00.000Z" },
    });

    await expect(decide({ duplicateNote: "No result." })).rejects.toThrow(
      "A dedupe note needs the result it supports",
    );
  });
});
