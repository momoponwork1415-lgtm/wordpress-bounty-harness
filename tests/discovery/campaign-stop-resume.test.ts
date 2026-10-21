import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exploreTrials } from "../../src/cli/continuous.js";
import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  defineClaudeRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  summarizeRecordedRuntimes,
  type AgentRuntimeProfile,
  type DiscoveryTransportResult,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";
import { inspectWordPressLedgerExclusions } from "../../src/profiles/wordpress/selection/ledger-exclusions.js";

const digest = `sha256:${"a".repeat(64)}`;
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

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const input = {
  schemaVersion: 1 as const,
  snapshotDigest: digest,
  trustBoundary: { version: "v1", text: "Low privilege only" },
  programmeBoundary: { version: "v1", text: "Synthetic boundary" },
  modelProfileDigest: profile.digest,
  promptDigest: digest,
  stopRules: { maxRuns: 6, noFindingRuns: 6 },
  lab: { setupDigest: digest },
  history: { mode: "none" as const },
};

type Reply = "empty" | "limit" | "finding" | "no-work";

async function open() {
  const root = await mkdtemp(join(tmpdir(), "wbh-stop-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 20,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const campaign = (options: {
    readonly prefix: string;
    readonly replies: (call: number) => Reply;
    readonly concurrency?: number;
    readonly profile?: AgentRuntimeProfile;
    readonly campaignId?: string;
    readonly maxRuns?: number;
    readonly resumeProviderLimited?: NonNullable<
      Parameters<typeof runDiscoveryCampaign>[0]["resumeProviderLimited"]
    >;
  }) =>
    runDiscoveryCampaign({
      campaignId: options.campaignId ?? "campaign-1",
      labId: "lab-1",
      input: {
        ...input,
        modelProfileDigest: (options.profile ?? profile).digest,
        ...(options.maxRuns === undefined
          ? {}
          : { stopRules: { maxRuns: options.maxRuns, noFindingRuns: 6 } }),
      },
      ...(options.resumeProviderLimited === undefined
        ? {}
        : { resumeProviderLimited: options.resumeProviderLimited }),
      ...(options.concurrency === undefined
        ? {}
        : { concurrency: options.concurrency }),
      clock: () => new Date("2026-10-08T09:00:00Z"),
      ledger,
      attachments,
      evidence,
      recordReport: recordWordPressReport,
      executor: {
        async execute(
          run: DiscoveryTransportRun,
        ): Promise<DiscoveryTransportResult> {
          const reply = options.replies(calls++);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Let every worker start before any run finishes.
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          const identity = {
            runId: run.runId,
            targetSnapshotDigest: run.targetSnapshotDigest,
            profile: run.profile,
            startedAt: "2026-10-08T07:00:00Z",
            completedAt: "2026-10-08T07:00:01Z",
          };
          if (reply === "limit")
            return {
              receipt: createNativeRunReceipt({
                ...identity,
                terminal: "incomplete",
                reason: "provider",
                reasonDetail: "cli-exit:2",
                providerLimit: "quota",
              }),
            };
          const attachment = await attachments.put(
            "findings",
            Buffer.from(
              JSON.stringify({
                findings:
                  reply === "finding"
                    ? [
                        {
                          claim: `Synthetic account state change ${run.runId}`,
                          attackerPosition: "subscriber",
                          impact: "account-takeover",
                          configurationPrecondition: "default",
                          brokenProperty: "Account ownership",
                          sourceTrace: [
                            {
                              file: "includes/example.php",
                              function: "fixture",
                              line: 12,
                            },
                          ],
                          existingControls: "None",
                          labObservations: "Canary user changed",
                        },
                      ]
                    : [],
                examined: reply === "no-work" ? "none" : "source",
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
              usage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 50,
                reasoningOutputTokens: "unavailable",
              },
              reportArtifactDigest: attachment.digest,
              ...(reply === "no-work"
                ? {
                    observed: {
                      toolCalls: 0,
                      filesRead: 0,
                      uniqueFilesRead: 0,
                      labRequests: 0,
                      dbQueries: 0,
                    },
                    childThreadsObserved: 0,
                    childThreadsAdmitted: 0,
                    brokerMetrics: {
                      forwardedRequests: 1,
                      requestLimitExceeded: 0,
                      unauthorizedRequests: 0,
                    },
                  }
                : {}),
            }),
          };
        },
      },
      plannedTrials: Array.from({ length: 6 }, (_, index) => ({
        trialId: `${options.prefix}-${index}`,
        trialOrdinal: index,
        explore: {
          configuration: {
            promptVariant: "short-objective",
            assignmentUnit: "plugin",
          },
          run: {
            runId: `${options.prefix}-${index}`,
            targetSnapshotDigest: digest,
            profile: options.profile ?? profile,
            prompt: "Synthetic objective",
            lab: {
              endpoint: "http://wordpress",
              networkName: "lab-network",
              internalIp: "172.20.0.2",
            },
            sourceDirectory: "/synthetic/source",
            sourceTree: { digest, entries: 1, bytes: 1 },
            expiresAt: "2026-10-08T08:00:00Z",
          },
        },
      })),
    });
  const finished = () =>
    ledger
      .read({ type: "discovery-run-finished" })
      .map(({ event }) =>
        event.type === "discovery-run-finished" ? event : null,
      );
  return {
    ledger,
    evidence,
    campaign,
    finished,
    maxInFlight: () => maxInFlight,
  };
}

describe("discovery campaign stop and resume", () => {
  it("continues a provider-limited run as one Trial after backoff", async () => {
    const { ledger, campaign } = await open();
    expect(
      (await campaign({ prefix: "first", maxRuns: 1, replies: () => "limit" }))
        .stoppedBy,
    ).toBe("provider-limit");
    const offered: string[] = [];
    const continued = await campaign({
      prefix: "replacement",
      maxRuns: 1,
      replies: () => {
        throw new Error("A new Trial must not start");
      },
      resumeProviderLimited: async (started) => {
        offered.push(started.runId);
        const base = {
          schemaVersion: 1 as const,
          campaignId: "campaign-1",
          snapshotDigest: digest,
          occurredAt: "2026-10-08T09:05:00Z",
        };
        await ledger.append({
          ...base,
          identity: "resume-start",
          type: "discovery-run-started",
          runId: "segment-1",
          trialId: started.trialId,
          trialOrdinal: 0,
          resumesRun: started.runId,
          resumeSegment: 1,
          labAttached: false,
          history: { mode: "none" },
          configuration: { promptVariant: "short-objective" },
        });
        await ledger.append({
          ...base,
          identity: "resume-finish",
          type: "discovery-run-finished",
          runId: "segment-1",
          outcome: "completed",
          costUsd: "unavailable",
          wallTimeMs: 10 * 60_000,
        });
        return {
          status: "resumed",
          outcome: {
            runId: "segment-1",
            outcome: "completed",
            wallTimeMs: 10 * 60_000,
            counted: true,
            foundNew: false,
            heldBoundary: false,
            findingsRecorded: 0,
          },
        };
      },
    });
    expect(offered).toEqual(["first-0"]);
    expect(continued).toMatchObject({ runCount: 1, stoppedBy: "max-runs" });
    expect(
      ledger
        .readAll({ campaignId: "campaign-1", type: "discovery-run-started" })
        .filter(({ event }) => event.type === "discovery-run-started"),
    ).toHaveLength(2);
    expect(exploreTrials(ledger, {})).toMatchObject({
      started: 1,
      finished: ["completed"],
      notTrials: 0,
    });
    expect(
      await campaign({
        prefix: "third",
        maxRuns: 1,
        replies: () => {
          throw new Error("A concluded Trial must not start");
        },
      }),
    ).toMatchObject({ runCount: 0, stoppedBy: "max-runs" });
  });

  it("leaves a refused provider-limited resume incomplete without starting fresh", async () => {
    const { ledger, campaign } = await open();
    await campaign({ prefix: "first", maxRuns: 1, replies: () => "limit" });
    const result = await campaign({
      prefix: "replacement",
      maxRuns: 1,
      replies: () => {
        throw new Error("A refused resume must not start a new Trial");
      },
      resumeProviderLimited: async (started) => ({
        status: "incomplete",
        runId: started.runId,
        reason: "runtime-profile-differs",
      }),
    });
    expect(result).toMatchObject({
      runCount: 0,
      stoppedBy: "incomplete",
      resumeRefusal: {
        runId: "first-0",
        reason: "runtime-profile-differs",
      },
    });
    expect(ledger.read({ type: "discovery-concluded" })).toHaveLength(0);
    expect(ledger.read({ type: "discovery-run-started" })).toHaveLength(1);
  });

  it("counts a resumed bootstrap failure as the same incomplete Trial", async () => {
    const { ledger, campaign } = await open();
    await campaign({ prefix: "first", maxRuns: 1, replies: () => "limit" });
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T09:05:00Z",
    };
    await ledger.append({
      ...base,
      identity: "failed-resume-start",
      type: "discovery-run-started",
      runId: "failed-segment",
      trialId: "first-0",
      trialOrdinal: 0,
      resumesRun: "first-0",
      resumeSegment: 1,
      labAttached: false,
      history: { mode: "none" },
      configuration: { promptVariant: "short-objective" },
    });
    await ledger.append({
      ...base,
      identity: "failed-resume-finish",
      type: "discovery-run-finished",
      runId: "failed-segment",
      outcome: "failed",
      reason: "schema",
      costUsd: "unavailable",
      wallTimeMs: 1,
      observed: {
        toolCalls: 0,
        filesRead: 0,
        uniqueFilesRead: 0,
        labRequests: 0,
        dbQueries: 0,
      },
      childThreadsObserved: 0,
      brokerMetrics: {
        forwardedRequests: 0,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
    });
    expect(
      await campaign({
        prefix: "replacement",
        maxRuns: 1,
        replies: () => {
          throw new Error("The incomplete Trial must not start fresh");
        },
      }),
    ).toMatchObject({ runCount: 0, stoppedBy: "incomplete" });
    expect(exploreTrials(ledger, {})).toMatchObject({
      started: 1,
      finished: ["failed"],
      notTrials: 0,
    });
    expect(ledger.read({ type: "discovery-run-started" })).toHaveLength(2);
  });

  it("reuses ordinal 0 after a start-only crash and returns its slug to selection", async () => {
    const { ledger, campaign } = await open();
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T07:00:00Z",
    };
    await ledger.append({
      ...base,
      identity: "retry-selection",
      type: "target-selected",
      selectionId: "wporg:retry@1.0.0",
    });
    await ledger.append({
      ...base,
      identity: "abandoned-start",
      type: "discovery-run-started",
      runId: "abandoned-0",
      trialId: "abandoned-0",
      trialOrdinal: 0,
      runKind: "explore",
      labId: "lab-1",
      history: { mode: "none" },
      configuration: {
        promptVariant: "short-objective",
        assignmentUnit: "plugin",
      },
    });
    const candidates = [{ slug: "retry", version: "1.0.0" }];
    const inspect = () =>
      inspectWordPressLedgerExclusions({
        ledger,
        candidates,
        currentPromptVariant: "short-objective",
        revisitPolicy: { kind: "never" },
      })[0]?.reasons;
    expect(inspect()).toEqual([]);

    const noWork = await campaign({
      prefix: "resume",
      replies: () => "no-work",
    });
    expect(noWork).toMatchObject({ runCount: 1, stoppedBy: "incomplete" });
    expect(inspect()).toEqual([]);
    expect(ledger.read({ type: "discovery-concluded" })).toEqual([]);
    expect(
      ledger.read({ type: "discovery-run-finished" })[0]?.event,
    ).toMatchObject({
      outcome: "failed",
      reason: "evidence",
      reasonDetail: "no-work",
    });
    const result = await campaign({ prefix: "retry", replies: () => "empty" });
    expect(result).toMatchObject({ runCount: 6, stoppedBy: "no-new-finding" });
    const starts = ledger.read({ type: "discovery-run-started" });
    expect(starts[1]?.event).toMatchObject({
      runId: "resume-0",
      trialOrdinal: 0,
      campaignId: "campaign-1",
    });
    expect(starts[2]?.event).toMatchObject({
      runId: "retry-0",
      trialOrdinal: 0,
    });
    expect(inspect()).toEqual(["previously-selected"]);
    expect(ledger.read({ type: "discovery-concluded" })).toHaveLength(1);
  });

  it("counts a historical stage-tagged exploration while excluding its child", async () => {
    const { ledger, campaign } = await open();
    const historical = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T07:00:00Z",
      labId: "lab-1",
      history: { mode: "none" as const },
      configuration: {
        promptVariant: "screening-v1",
        assignmentUnit: "plugin",
      },
    };
    await ledger.append({
      ...historical,
      identity: "historical-explore",
      type: "discovery-run-started",
      runId: "old-root",
      stage: "screening",
    });
    await ledger.append({
      ...historical,
      identity: "historical-child",
      type: "discovery-run-started",
      runId: "old-child",
      runKind: "child",
      parentRunId: "old-root",
      stage: "screening",
    });
    const result = await campaign({
      prefix: "new",
      replies: () => "finding",
    });
    // The legacy explore event has no finish. Resume must retain that typed
    // incomplete state even after all remaining Trial ordinals finish.
    expect(result).toMatchObject({ runCount: 5, stoppedBy: "incomplete" });
    expect(ledger.read({ type: "discovery-concluded" })).toEqual([]);
    expect(
      ledger
        .read({ type: "discovery-run-started" })
        .filter(({ event }) => event.type === "discovery-run-started"),
    ).toHaveLength(7);
  });

  it("concludes a campaign with a maximum-length id", async () => {
    const { campaign, ledger } = await open();
    const campaignId = "c".repeat(128);
    const result = await campaign({
      campaignId,
      prefix: "long-id",
      replies: () => "empty",
    });
    expect(result).toMatchObject({ runCount: 6, stoppedBy: "no-new-finding" });
    const concluded = ledger.read({ campaignId, type: "discovery-concluded" });
    expect(concluded).toHaveLength(1);
    expect(concluded[0]?.event.identity.length).toBeLessThanOrEqual(128);
  });

  it("stops on a provider limit, records the limited run and runs that Trial again on resume", async () => {
    const { ledger, campaign, finished } = await open();
    const stopped = await campaign({
      prefix: "first",
      replies: (call) => (call === 2 ? "limit" : "empty"),
    });
    expect(stopped.stoppedBy).toBe("provider-limit");
    expect(finished().map((event) => event?.outcome)).toEqual([
      "completed",
      "completed",
      "provider-limited",
    ]);
    expect(finished().map((event) => event?.reason)).toEqual([
      undefined,
      undefined,
      "provider",
    ]);
    expect(finished().at(-1)?.providerLimit).toBe("quota");
    expect(finished().at(-1)?.reasonDetail).toBe("cli-exit:2");
    expect(ledger.read({ type: "discovery-concluded" })).toEqual([]);

    const resumed = await campaign({
      prefix: "second",
      replies: () => "empty",
    });
    // The limited run is not a Trial (owner decision 2026-10-19): its ordinal
    // runs again, and the campaign concludes after the remaining Trials.
    expect(resumed).toMatchObject({ runCount: 4, stoppedBy: "max-runs" });
    expect(finished().map((event) => event?.outcome)).toEqual([
      "completed",
      "completed",
      "provider-limited",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(ledger.read({ type: "discovery-concluded" })).toHaveLength(1);
  });

  it("records the provider-reported usage of each finished run", async () => {
    const { campaign, finished } = await open();
    await campaign({
      prefix: "usage",
      replies: (call) => (call === 1 ? "limit" : "empty"),
    });
    expect(finished().map((event) => event?.usage)).toEqual([
      {
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: "unavailable",
      },
      {
        inputTokens: "unavailable",
        cachedInputTokens: "unavailable",
        outputTokens: "unavailable",
        reasoningOutputTokens: "unavailable",
      },
    ]);
  });

  it("runs up to the concurrency bound and lets in-flight runs finish after a limit", async () => {
    const { campaign, finished, maxInFlight } = await open();
    const result = await campaign({
      prefix: "parallel",
      concurrency: 3,
      replies: (call) => (call === 0 ? "limit" : "finding"),
    });
    expect(maxInFlight()).toBe(3);
    expect(result.stoppedBy).toBe("provider-limit");
    // The two runs already in flight are recorded; no new run starts.
    expect(finished().map((event) => event?.outcome)).toEqual([
      "provider-limited",
      "completed",
      "completed",
    ]);
    expect(result.findingsRecorded).toBe(2);
  });

  it("still reads a historical daily-cap stop event", async () => {
    const { ledger } = await open();
    await ledger.append({
      schemaVersion: 1,
      identity: "historical-cap-stop",
      campaignId: "campaign-0",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T02:00:00Z",
      type: "campaign-stopped",
      reason: "daily-run-cap",
    });
    expect(ledger.read({ type: "campaign-stopped" })[0]?.event).toMatchObject({
      reason: "daily-run-cap",
    });
  });

  it("keeps each run's receipt so a CLI or catalog update shows up in the recorded runtimes", async () => {
    const { ledger, evidence, campaign } = await open();
    await campaign({
      prefix: "before",
      replies: (call) => (call === 1 ? "limit" : "empty"),
    });
    const updated = defineAgentRuntimeProfile({
      id: "synthetic",
      transportKind: "codex-native/v1",
      sandboxImageDigest: digest,
      requestedModelId: "gpt-6.1-sol",
      requestedEffort: "high",
      codexCliVersion: "0.162.0",
      bundledCatalogDigest: `sha256:${"b".repeat(64)}`,
      authenticationMethod: "host-private-bearer",
      cyberAccessProgram: "standard",
      serviceTier: "priority",
      subagent: { modelId: "unavailable", effort: "unavailable" },
    });
    await campaign({
      prefix: "after",
      campaignId: "campaign-2",
      profile: updated,
      replies: () => "empty",
    });
    const runtimes = await summarizeRecordedRuntimes({
      ledger,
      store: evidence,
    });
    expect(runtimes).toEqual([
      {
        runtime: {
          requestedModelId: "gpt-6.1-sol",
          requestedEffort: "high",
          codexCliVersion: "0.161.0",
          bundledCatalogDigest: digest,
          serviceTier: "priority",
          cyberAccessProgram: "standard",
          authenticationMethod: "host-private-bearer",
          subagent: { modelId: "unavailable", effort: "unavailable" },
        },
        runs: 2,
        firstDay: "2026-10-08",
        lastDay: "2026-10-08",
      },
      {
        runtime: {
          requestedModelId: "gpt-6.1-sol",
          requestedEffort: "high",
          codexCliVersion: "0.162.0",
          bundledCatalogDigest: `sha256:${"b".repeat(64)}`,
          serviceTier: "priority",
          cyberAccessProgram: "standard",
          authenticationMethod: "host-private-bearer",
          subagent: { modelId: "unavailable", effort: "unavailable" },
        },
        runs: 6,
        firstDay: "2026-10-08",
        lastDay: "2026-10-08",
      },
    ]);
    expect(
      (
        await summarizeRecordedRuntimes({
          ledger,
          store: evidence,
          campaignId: "campaign-2",
        })
      ).map((group) => group.runtime.codexCliVersion),
    ).toEqual(["0.162.0"]);
  });

  it("keeps Claude profiles that differ only in the children's model apart in the recorded runtimes", async () => {
    const { ledger, evidence, campaign } = await open();
    const claude = (subagentModel: "claude-opus-5-5" | "claude-sonnet-5-5") =>
      defineClaudeRuntimeProfile(
        {
          id: "opus",
          requestedModelId: "claude-opus-5-5",
          requestedEffort: "high",
          claudeCliVersion: "2.1.296",
          authenticationMethod: "anthropic-oauth-host",
          subagent: { modelId: subagentModel, effort: "high" },
        },
        digest,
      );
    for (const [prefix, model] of [
      ["opus-children", "claude-opus-5-5"],
      ["sonnet-children", "claude-sonnet-5-5"],
    ] as const)
      await campaign({
        prefix,
        campaignId: prefix,
        profile: claude(model),
        replies: () => "empty",
      });
    expect(
      (await summarizeRecordedRuntimes({ ledger, store: evidence })).map(
        ({ runtime, runs }) => [
          runtime.requestedModelId,
          runtime.subagent.modelId,
          runs,
        ],
      ),
    ).toEqual([
      ["claude-opus-5-5", "claude-opus-5-5", 6],
      ["claude-opus-5-5", "claude-sonnet-5-5", 6],
    ]);
  });
});
