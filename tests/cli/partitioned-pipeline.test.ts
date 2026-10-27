import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCampaignPipeline } from "../../src/cli/pipeline.js";
import {
  createNativeRunReceipt,
  defineClaudeRuntimeProfile,
  ENUMERATION_OUTPUT_FILES,
  ProviderAttachmentStore,
  type OneShotExecutor,
  type OneShotRun,
  type PartitionedTrialPlan,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

// ADR 0042: how a partitioned Trial's end reaches the campaign pipeline. An
// exhausted enumeration skips the target with a diagnostic that names the
// Trial's failure; a tracer's usage limit backs the campaign off even when
// the Trial concluded partially.

const digest = `sha256:${"a".repeat(64)}`;
const campaignId = "prod-20261028-1";
const profile = defineClaudeRuntimeProfile(
  {
    id: "opus",
    requestedModelId: "claude-opus-5-5",
    requestedEffort: "high",
    claudeCliVersion: "2.1.296",
    authenticationMethod: "anthropic-oauth-host",
    subagent: { modelId: "claude-opus-5-5", effort: "high" },
  },
  digest,
);
const row = (id: string) => ({
  id,
  origin: "agent",
  kind: "entry",
  file: "includes/example.php",
  line: 12,
  text: id,
});
const inventory = { rows: [row("a1"), row("a2")] };
const proposal = {
  partitions: [
    { id: "p1", label: "First", rowIds: ["a1"] },
    { id: "p2", label: "Second", rowIds: ["a2"] },
  ],
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

type Reply = "no-proposal" | "limited-first-tracer";

async function open(reply: Reply) {
  const root = await mkdtemp(join(tmpdir(), "wbh-partitioned-pipeline-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: 4 * 1024 * 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const executed: string[] = [];
  let ids = 0;
  const receipt = (
    run: OneShotRun,
    fields: Partial<Parameters<typeof createNativeRunReceipt>[0]> = {},
  ) =>
    createNativeRunReceipt({
      runId: run.runId,
      targetSnapshotDigest: run.targetSnapshotDigest,
      profile: run.profile,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-28T00:00:00Z",
      completedAt: "2026-10-28T00:10:00Z",
      observed: {
        toolCalls: 4,
        filesRead: 3,
        uniqueFilesRead: 3,
        labRequests: 0,
        dbQueries: 0,
      },
      childThreadsObserved: 0,
      childThreadsAdmitted: 0,
      ...fields,
    });
  const oneShot: OneShotExecutor = {
    async execute(run) {
      executed.push(run.runId);
      if (run.output === "files")
        return {
          receipt: receipt(run),
          outputFiles: [
            {
              name: ENUMERATION_OUTPUT_FILES.inventory,
              content: JSON.stringify(inventory),
            },
            ...(reply === "no-proposal"
              ? []
              : [
                  {
                    name: ENUMERATION_OUTPUT_FILES.partitions,
                    content: JSON.stringify(proposal),
                  },
                ]),
          ],
          scriptRan: true,
        };
      if (run.runId.endsWith("-p-p1"))
        return {
          receipt: receipt(run, {
            terminal: "incomplete",
            reason: "provider",
            reasonDetail: "cli-exit:1",
            providerLimit: "quota",
          }),
          scriptRan: false,
        };
      const attachment = await attachments.put(
        "findings",
        Buffer.from(
          JSON.stringify({
            findings: [],
            leads: [],
            examined: "partition",
            unexamined: "none",
          }),
        ),
      );
      return {
        receipt: receipt(run, { reportArtifactDigest: attachment.digest }),
        attachment,
        scriptRan: false,
      };
    },
  };
  const mounts = {
    sourceDirectory: "/synthetic/source",
    sourceTree: { digest, entries: 1, bytes: 1 },
  };
  const role = (kind: "enumerator" | "tracer") => ({
    configuration: {
      promptVariant:
        kind === "enumerator" ? "enumerator-v1" : "objective-partition-v1",
      promptDigest: digest,
      mode: "partitioned" as const,
      runtime: "claude-code/v1" as const,
      role: { kind, definitionDigest: digest, toolsDigest: digest },
    },
    run: {
      targetSnapshotDigest: digest,
      profile,
      prompt: `${kind} prompt`,
      toolFiles: [],
      output: kind === "enumerator" ? ("files" as const) : ("report" as const),
      wallMs: 20 * 60_000,
      ...mounts,
    },
  });
  const partitioned: PartitionedTrialPlan = {
    enumerate: role("enumerator"),
    trace: role("tracer"),
    limits: { maxEntriesPerPartition: 60, maxPartitions: 8, maxResubmits: 0 },
    maxParallel: 1,
    targetWallMs: 100 * 60_000,
    rowSource: "agent",
    definitionDigests: { enumerator: digest, tracer: digest },
    toolsDigest: digest,
  };
  const run = () =>
    runCampaignPipeline({
      campaignId,
      ledger,
      store,
      clock: () => new Date("2026-10-28T00:00:00Z"),
      newId: () => `id-${++ids}`,
      discoveryLab: "none",
      pipeline: {
        select: async () => [
          {
            targetId: "wporg:partitioned",
            version: "1.0.0",
            score: 1,
            selectedAt: "2026-10-28T00:00:00Z",
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
              trialId: "trial-1",
              trialOrdinal: 0,
              explore: {
                configuration: partitioned.enumerate.configuration,
                run: {
                  runId: "trial-1",
                  targetSnapshotDigest: digest,
                  profile,
                  prompt: "enumerator prompt",
                  ...mounts,
                  expiresAt: "2026-10-28T04:00:00Z",
                },
              },
              partitioned,
            },
          ],
          executor: {
            execute: () =>
              Promise.reject(new Error("cooperative executor unused")),
          },
          oneShotExecutor: oneShot,
          attachments,
          recordReport: recordWordPressReport,
        }),
      } as never,
    });
  return { ledger, store, executed, run };
}

describe("partitioned Trials through the campaign pipeline (ADR 0042)", () => {
  it("skips the target with a diagnostic naming the Trial's failure when the enumeration is rejected", async () => {
    const t = await open("no-proposal");
    const summary = await t.run();
    // One failed target does not stop the campaign; the target is skipped.
    expect(summary.stopped).toBeUndefined();
    expect(summary.targets[0]).toMatchObject({
      runCount: 1,
      stoppedBy: "incomplete",
    });
    expect(t.executed).toEqual(["trial-1"]);
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
      kind: "run-failed",
      runId: "trial-1",
      reason: "schema",
      reasonDetail: "enumeration-rejected",
    });
    expect(t.ledger.funnel(campaignId).attemptOutcomes).toMatchObject({
      incomplete: 1,
      incompleteByReason: { "schema/enumeration-rejected": 1 },
      completedWithoutCandidate: 0,
    });
  });

  it("backs the campaign off on a tracer's usage limit although the Trial concluded partially", async () => {
    const t = await open("limited-first-tracer");
    const summary = await t.run();
    expect(summary.stopped).toBe("provider-limit");
    expect(t.executed).toEqual(["trial-1", "trial-1-p-p1", "trial-1-p-p2"]);
    const events = t.ledger.readAll({ campaignId }).map(({ event }) => event);
    expect(
      events.filter((event) => event.type === "campaign-stopped"),
    ).toMatchObject([{ reason: "provider-limit" }]);
    expect(
      events.filter((event) => event.type === "discovery-concluded"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "target-skipped"),
    ).toHaveLength(0);
    // The target itself concluded on its own stop rule.
    expect(summary.targets[0]).toMatchObject({
      runCount: 1,
      stoppedBy: "no-new-finding",
    });
  });
});
