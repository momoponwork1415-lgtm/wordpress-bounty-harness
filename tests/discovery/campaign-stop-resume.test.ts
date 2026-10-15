import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { shouldAutomaticallyRetryVerification } from "../../src/cli/pipeline.js";
import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  summarizeRecordedRuntimes,
  type AgentRuntimeProfile,
  type DiscoveryTransportResult,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { admitWordPressFinding } from "../../src/profiles/wordpress/discovery/finding.js";
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

describe("verification retry policy on campaign resume", () => {
  const base = { attemptsForReason: 1, sameLabSetup: true };
  type RetryInput = Parameters<typeof shouldAutomaticallyRetryVerification>[0];
  const check = (
    reason: RetryInput["reason"],
    expected: boolean,
    overrides: Partial<RetryInput> = {},
  ) =>
    expect(
      shouldAutomaticallyRetryVerification({ ...base, reason, ...overrides }),
    ).toBe(expected);

  it.each(["recipe", "observation"] as const)("retry policy: %s", (reason) => {
    for (const attemptsForReason of [0, 1, 2])
      check(reason, true, { attemptsForReason });
    check(reason, false, { attemptsForReason: 3 });
    check(reason, false, { sameLabSetup: false });
  });

  it("retries precondition only after the scenario id changes", () => {
    const previous = { previousScenarioId: "a" };
    check("precondition", true, { ...previous, currentScenarioId: "b" });
    check("precondition", false, { ...previous, currentScenarioId: "a" });
    check("precondition", true, {
      previousScenarioId: null,
      currentScenarioId: "b",
    });
    check("precondition", false, {
      previousScenarioId: null,
      currentScenarioId: null,
    });
    check("precondition", false, { currentScenarioId: "b" });
  });

  it.each(["provision", "provider"] as const)("retries %s once", (reason) => {
    check(reason, true);
    check(reason, true, { attemptsForReason: 0 });
    check(reason, false, { attemptsForReason: 2 });
    check(reason, false, { sameLabSetup: false });
  });

  it.each([
    "evidence",
    "cleanup",
    "digest-mismatch",
    "no-judge",
    "sandbox",
  ] as const)("does not automatically retry %s", (reason) =>
    check(reason, false),
  );
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

type Reply = "empty" | "limit" | "finding";

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
  }) =>
    runDiscoveryCampaign({
      campaignId: options.campaignId ?? "campaign-1",
      labId: "lab-1",
      input: {
        ...input,
        modelProfileDigest: (options.profile ?? profile).digest,
      },
      historyFraction: 0,
      ...(options.concurrency === undefined
        ? {}
        : { concurrency: options.concurrency }),
      clock: () => new Date("2026-10-08T09:00:00Z"),
      ledger,
      attachments,
      evidence,
      admitFinding: admitWordPressFinding,
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
              usage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                outputTokens: 50,
                reasoningOutputTokens: "unavailable",
              },
              reportArtifactDigest: attachment.digest,
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
      trialOrdinal: 1,
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
    await ledger.append({
      ...historical,
      identity: "unspent-start",
      type: "discovery-run-started",
      runId: "unfinished-root",
      trialOrdinal: 0,
      runKind: "explore",
    });
    const result = await campaign({
      prefix: "new",
      replies: () => "finding",
    });
    // The child start proves a partial legacy Trial even without a root finish.
    expect(result).toMatchObject({ runCount: 5, stoppedBy: "incomplete" });
    expect(ledger.read({ type: "discovery-concluded" })).toEqual([]);
    expect(
      ledger
        .read({ type: "discovery-run-started" })
        .filter(({ event }) => event.type === "discovery-run-started"),
    ).toHaveLength(8);
    expect(
      ledger.read({ type: "discovery-run-started" })[3]?.event,
    ).toMatchObject({ runId: "new-0", trialOrdinal: 0 });
    expect(
      ledger
        .read({ type: "discovery-run-started" })
        .some(
          ({ event }) =>
            event.type === "discovery-run-started" && event.runId === "new-1",
        ),
    ).toBe(false);
  });

  it("reuses ordinal zero after a start-only attempt and returns its slug to selection (#270)", async () => {
    const { ledger, campaign } = await open();
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-08T07:00:00Z",
    };
    await ledger.append({
      ...base,
      identity: "selection-retry",
      type: "target-selected",
      selectionId: "wporg:retry@1.0.0",
    });
    await ledger.append({
      ...base,
      identity: "start-without-receipt",
      type: "discovery-run-started",
      runId: "attempt-0",
      trialId: "attempt-0",
      trialOrdinal: 0,
      runKind: "explore",
      labId: "lab-1",
      history: { mode: "none" },
      configuration: {
        promptVariant: "short-objective",
        assignmentUnit: "plugin",
      },
    });
    expect(ledger.read({ type: "discovery-run-finished" })).toHaveLength(0);
    expect(
      inspectWordPressLedgerExclusions({
        ledger,
        candidates: [{ slug: "retry", version: "1.0.0" }],
        currentPromptVariant: "short-objective",
        revisitPolicy: { kind: "never" },
      })[0]?.reasons,
    ).toEqual([]);

    const resumed = await campaign({ prefix: "retry", replies: () => "empty" });
    expect(resumed).toMatchObject({ runCount: 6, stoppedBy: "no-new-finding" });
    const starts = ledger.read({ type: "discovery-run-started" });
    expect(starts[1]?.event).toMatchObject({
      campaignId: "campaign-1",
      runId: "retry-0",
      trialOrdinal: 0,
    });
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

  it("stops on a provider limit, records the refused run and resumes after the completed runs", async () => {
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
    // All three started Trials spent their ordinals, including the refused one.
    expect(resumed).toMatchObject({ runCount: 3, stoppedBy: "provider-limit" });
    expect(ledger.read({ type: "discovery-concluded" })).toEqual([]);

    const again = await campaign({ prefix: "third", replies: () => "empty" });
    expect(again).toEqual({
      runCount: 0,
      findingsRecorded: 0,
      stoppedBy: "provider-limit",
    });
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
});
