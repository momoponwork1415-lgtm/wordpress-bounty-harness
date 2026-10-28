import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exploreTrials,
  pendingProviderLimited,
} from "../../src/cli/continuous.js";
import { runCampaignPipeline } from "../../src/cli/pipeline.js";
import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  providerLimitedAutoResumeRefusal,
  type DiscoveryTransportResult,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";
import { inspectWordPressLedgerExclusions } from "../../src/profiles/wordpress/selection/ledger-exclusions.js";

const digest = `sha256:${"a".repeat(64)}`;
const campaignId = "prod-20261021-1";
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Resume = NonNullable<
  Awaited<
    ReturnType<
      Parameters<typeof runCampaignPipeline>[0]["pipeline"]["discovery"]
    >
  >["resumeProviderLimited"]
>;

/**
 * One target through `runCampaignPipeline` with discovery Lab off. The
 * executor returns `replies` in turn; `resume`, when given, is what the runner
 * passes after a provider backoff (the WordPress profile's resume of the run).
 */
async function open(runtime: "codex-native/v1" | "claude-code/v1") {
  const root = await mkdtemp(join(tmpdir(), "wbh-provider-resume-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: 1024 * 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const executed: string[] = [];
  let ids = 0;
  let campaigns = 0;
  const execute = async (
    run: DiscoveryTransportRun,
    reply: "limit" | "empty",
  ): Promise<DiscoveryTransportResult> => {
    executed.push(run.runId);
    const identity = {
      runId: run.runId,
      targetSnapshotDigest: run.targetSnapshotDigest,
      profile: run.profile,
      startedAt: "2026-10-21T00:00:00Z",
      completedAt: "2026-10-21T00:10:00Z",
    };
    if (reply === "limit")
      return {
        receipt: createNativeRunReceipt({
          ...identity,
          terminal: "incomplete",
          reason: "provider",
          reasonDetail: "cli-exit:1",
          providerLimit: "rate-limit",
        }),
      };
    const attachment = await attachments.put(
      "findings",
      Buffer.from(
        JSON.stringify({
          findings: [],
          examined: "source",
          unexamined: "none",
        }),
      ),
    );
    return {
      attachment,
      receipt: createNativeRunReceipt({
        ...identity,
        terminal: "completed",
        reason: "unavailable",
        reportArtifactDigest: attachment.digest,
      }),
    };
  };
  const run = (reply: "limit" | "empty", resume?: Resume) => {
    const prefix = `campaign-run-${++campaigns}`;
    return runCampaignPipeline({
      campaignId,
      ledger,
      store,
      clock: () => new Date("2026-10-21T00:00:00Z"),
      newId: () => `id-${++ids}`,
      discoveryLab: "none",
      pipeline: {
        select: async () => [
          {
            targetId: "wporg:limited",
            version: "1.0.0",
            score: 1,
            selectedAt: "2026-10-21T00:00:00Z",
            policy: { id: "policy", digest },
          },
        ],
        freeze: async () => ({
          digest,
          target: { sourceDigest: digest },
          dependencies: [],
        }),
        setupFor: () => ({}),
        discovery: async () => ({
          input: {
            schemaVersion: 1,
            snapshotDigest: digest,
            trustBoundary: { version: "v1", text: "Low privilege only" },
            programmeBoundary: { version: "v1", text: "Synthetic boundary" },
            modelProfileDigest: profile.digest,
            promptDigest: digest,
            stopRules: { maxRuns: 1, noFindingRuns: 1 },
            lab: { mode: "none" },
            history: { mode: "none" },
          },
          plannedTrials: [
            {
              trialId: `${prefix}-0`,
              trialOrdinal: 0,
              explore: {
                configuration: { promptVariant: "wp2shell-bounty-v8", runtime },
                run: {
                  runId: `${prefix}-0`,
                  targetSnapshotDigest: digest,
                  profile,
                  prompt: "Synthetic objective",
                  sourceDirectory: "/synthetic/source",
                  sourceTree: { digest, entries: 1, bytes: 1 },
                  expiresAt: "2026-10-21T02:00:00Z",
                },
              },
            },
          ],
          executor: {
            execute: (planned: DiscoveryTransportRun) =>
              execute(planned, reply),
          },
          attachments,
          recordReport: recordWordPressReport,
          ...(resume === undefined ? {} : { resumeProviderLimited: resume }),
        }),
      } as never,
    });
  };
  const reasons = () =>
    inspectWordPressLedgerExclusions({
      ledger,
      candidates: [{ slug: "limited", version: "1.0.0" }],
    })[0]?.reasons;
  return { ledger, store, executed, run, reasons };
}

describe("runner resume of a provider-limited Trial through the campaign pipeline (ADR 0036, addendum 4)", () => {
  it("resumes five segments, then closes the Trial with a diagnosed skip that selection and the runner both honour", async () => {
    const t = await open("codex-native/v1");
    expect((await t.run("limit")).stopped).toBe("provider-limit");
    // A provider-limited run alone is not a Trial: still pending, still selectable.
    expect(pendingProviderLimited(t.ledger, campaignId)).toBe(true);
    expect(t.reasons()).toEqual([]);

    const offered: string[] = [];
    // Stands in for the WordPress resume: the segment cap first, then a
    // resumed segment that the provider limits again.
    const resume: Resume = async (started) => {
      offered.push(started.runId);
      const refusal = providerLimitedAutoResumeRefusal(started);
      if (refusal !== undefined)
        return { status: "incomplete", runId: started.runId, reason: refusal };
      const segment = (started.resumeSegment ?? 0) + 1;
      const runId = `segment-${segment}`;
      const base = {
        schemaVersion: 1 as const,
        campaignId,
        snapshotDigest: digest,
        occurredAt: "2026-10-21T01:00:00Z",
      };
      await t.ledger.append({
        ...base,
        identity: `start-${runId}`,
        type: "discovery-run-started",
        runId,
        trialId: started.trialId,
        trialOrdinal: 0,
        resumesRun: started.runId,
        resumeSegment: segment,
        labAttached: false,
        history: { mode: "none" },
        configuration: started.configuration,
      });
      await t.ledger.append({
        ...base,
        identity: `finish-${runId}`,
        type: "discovery-run-finished",
        runId,
        outcome: "provider-limited",
        reason: "provider",
        providerLimit: "rate-limit",
        costUsd: "unavailable",
        wallTimeMs: 60_000,
      });
      return {
        status: "resumed",
        outcome: {
          runId,
          outcome: "provider-limited",
          wallTimeMs: 60_000,
          counted: false,
          foundNew: false,
          heldBoundary: false,
          findingsRecorded: 0,
        },
      };
    };
    for (let backoff = 1; backoff <= 5; backoff++) {
      expect((await t.run("empty", resume)).stopped).toBe("provider-limit");
      expect(pendingProviderLimited(t.ledger, campaignId)).toBe(true);
    }
    // The sixth offer meets the cap of five resume segments.
    expect((await t.run("empty", resume)).stopped).toBeUndefined();
    expect(offered).toEqual([
      "campaign-run-1-0",
      "segment-1",
      "segment-2",
      "segment-3",
      "segment-4",
      "segment-5",
    ]);
    // No new Trial ever started after the first run.
    expect(t.executed).toEqual(["campaign-run-1-0"]);

    const skips = t.ledger
      .readAll({ campaignId, type: "target-skipped" })
      .map(({ event }) => event);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      stage: "discovery",
      reason: "run-failed",
    });
    const artifact =
      skips[0]?.type === "target-skipped" ? skips[0].artifacts[0] : undefined;
    expect(artifact?.kind).toBe("target-skip-diagnostic");
    const diagnostic = await t.store.readFile(
      artifact!.digest,
      "target-skip-diagnostic.json",
      4096,
    );
    if (diagnostic.status !== "resolved") throw new Error(diagnostic.status);
    expect(JSON.parse(diagnostic.bytes.toString("utf8"))).toEqual({
      kind: "resume-refused",
      runId: "segment-5",
      reason: "resume-limit",
    });

    // The closed chain is one incomplete Trial: selection excludes the
    // version, the runner offers no further resume, and the funnel counts it.
    expect(t.reasons()).toEqual(["previously-selected"]);
    expect(pendingProviderLimited(t.ledger, campaignId)).toBe(false);
    expect(exploreTrials(t.ledger, { campaignId })).toMatchObject({
      started: 1,
      finished: ["provider-limited"],
      notTrials: 0,
    });
    const after = await t.run("empty", resume);
    expect(after.targets).toEqual([]);
    expect(t.executed).toEqual(["campaign-run-1-0"]);
  });

  it("leaves a Claude run to a new Trial after the backoff, with nothing pending", async () => {
    const t = await open("claude-code/v1");
    expect((await t.run("limit")).stopped).toBe("provider-limit");
    expect(pendingProviderLimited(t.ledger, campaignId)).toBe(false);
    expect(t.reasons()).toEqual([]);
    const summary = await t.run("empty", async () => {
      throw new Error("A Claude run must not be resumed automatically");
    });
    expect(summary.stopped).toBeUndefined();
    expect(t.executed).toEqual(["campaign-run-1-0", "campaign-run-2-0"]);
    expect(
      t.ledger.readAll({ campaignId, type: "target-skipped" }),
    ).toHaveLength(0);
    expect(exploreTrials(t.ledger, { campaignId })).toMatchObject({
      started: 2,
      finished: ["provider-limited", "completed"],
      notTrials: 1,
    });
  });
});
