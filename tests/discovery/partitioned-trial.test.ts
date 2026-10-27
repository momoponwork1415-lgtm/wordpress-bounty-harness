import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineClaudeRuntimeProfile,
  ENUMERATION_OUTPUT_FILES,
  PARTITION_INPUT_FILES,
  ProviderAttachmentStore,
  runDiscoveryCampaign,
  type OneShotExecutor,
  type OneShotResult,
  type OneShotRun,
  type PartitionedTrialPlan,
  type PlannedTrial,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventV1 } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
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
const start = "2026-10-28T00:00:00.000Z";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const row = (id: string, origin: "script" | "agent", text = id) => ({
  id,
  origin,
  kind: "entry",
  file: "includes/example.php",
  line: 12,
  text,
});
/** Three distinct rows and one that repeats `a1`'s content under another id. */
const inventory = {
  rows: [
    row("s1", "script"),
    row("a1", "agent"),
    row("a2", "agent"),
    row("a3", "agent", "a1"),
  ],
};
const proposal = {
  partitions: [
    { id: "p1", label: "First", rowIds: ["s1", "a1"] },
    // `a3` repeats `a1`, which p1 holds, so it is not named here (it is read as `a1`).
    { id: "p2", label: "Second", rowIds: ["a2"] },
  ],
};
const claim = (text: string) => ({
  claim: text,
  attackerPosition: "subscriber",
  impact: "account-takeover",
  configurationPrecondition: "default",
  brokenProperty: "Account ownership",
  sourceTrace: [
    { file: "includes/example.php", function: "fixture", line: 12 },
  ],
  existingControls: "Capability check elsewhere",
  labObservations: "Canary user changed",
});

type Helpers = {
  files(
    run: OneShotRun,
    files: Readonly<Record<string, unknown>>,
    scriptRan?: boolean,
  ): OneShotResult;
  report(run: OneShotRun, text: string): Promise<OneShotResult>;
  failed(
    run: OneShotRun,
    reason: "provider" | "wall" | "schema",
    providerLimit?: "rate-limit",
  ): OneShotResult;
};
type Scripted = (
  run: OneShotRun,
  attempt: number,
  helpers: Helpers,
) => Promise<OneShotResult> | OneShotResult;

async function fixture(options: {
  readonly script: Scripted;
  readonly limits?: Partial<PartitionedTrialPlan["limits"]>;
  readonly maxParallel?: number;
  readonly targetWallMs?: number;
  /** Each executed run moves the clock this far; 0 keeps the clock still. */
  readonly runMs?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-partitioned-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: 4 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  let now = Date.parse(start);
  const clock = () => new Date(now);
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
      startedAt: start,
      completedAt: "2026-10-28T00:10:00.000Z",
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
  const helpers: Helpers = {
    files(
      run: OneShotRun,
      files: Readonly<Record<string, unknown>>,
      scriptRan = true,
    ): OneShotResult {
      return {
        receipt: receipt(run),
        outputFiles: Object.entries(files).map(([name, value]) => ({
          name,
          content: typeof value === "string" ? value : JSON.stringify(value),
        })),
        scriptRan,
      };
    },
    async report(run: OneShotRun, text: string): Promise<OneShotResult> {
      const attachment = await attachments.put(
        "findings",
        Buffer.from(
          JSON.stringify({
            findings: [claim(text)],
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
    failed(
      run: OneShotRun,
      reason: "provider" | "wall" | "schema",
      providerLimit?: "rate-limit",
    ): OneShotResult {
      return {
        receipt: receipt(run, {
          terminal: "incomplete",
          reason,
          reasonDetail: `${reason}-synthetic`,
          ...(providerLimit === undefined ? {} : { providerLimit }),
        }),
        scriptRan: false,
      };
    },
  };
  const calls: OneShotRun[] = [];
  const attempts = new Map<string, number>();
  const executor: OneShotExecutor = {
    async execute(run) {
      calls.push(run);
      now += options.runMs ?? 0;
      const attempt = attempts.get(run.runId) ?? 0;
      attempts.set(run.runId, attempt + 1);
      return options.script(run, attempt, helpers);
    },
  };
  const mounts = {
    sourceDirectory: "/private/source",
    sourceTree: { digest, entries: 1, bytes: 1 },
    dependencySource: {
      path: "/workspace/core",
      directory: "/private/core",
      tree: { digest: other, entries: 1, bytes: 1 },
    },
  };
  const role = (kind: "enumerator" | "tracer", output: "files" | "report") => ({
    configuration: {
      promptVariant: "objective-partition-v1",
      promptDigest: digest,
      mode: "partitioned" as const,
      wallMinutes: 20,
      role: { kind, definitionDigest: digest, toolsDigest: other },
    },
    run: {
      targetSnapshotDigest: digest,
      profile,
      prompt: `${kind} prompt`,
      toolFiles: [{ name: "tool.sh", content: Buffer.from("#!/bin/sh\n") }],
      output,
      wallMs: 20 * 60_000,
      ...mounts,
    },
  });
  const plan: PartitionedTrialPlan = {
    enumerate: role("enumerator", "files"),
    trace: role("tracer", "report"),
    limits: {
      maxEntriesPerPartition: 60,
      maxPartitions: 8,
      maxResubmits: 2,
      ...options.limits,
    },
    maxParallel: options.maxParallel ?? 2,
    targetWallMs: options.targetWallMs ?? 200 * 60_000,
    rowSource: "agent",
    definitionDigests: { enumerator: digest, tracer: other },
    toolsDigest: other,
  };
  const trialId = "trial-1";
  const trial: PlannedTrial = {
    trialId,
    trialOrdinal: 0,
    explore: {
      configuration: plan.enumerate.configuration,
      run: {
        runId: trialId,
        targetSnapshotDigest: digest,
        profile,
        prompt: "enumerator prompt",
        ...mounts,
        expiresAt: "2026-10-28T04:00:00.000Z",
      },
    },
    partitioned: plan,
  };
  const result = await runDiscoveryCampaign({
    campaignId: "campaign-1",
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
    plannedTrials: [trial],
    executor: {
      execute: () => Promise.reject(new Error("cooperative executor unused")),
    },
    oneShotExecutor: executor,
    attachments,
    evidence,
    ledger,
    recordReport: recordWordPressReport,
    clock,
  });
  const events = ledger
    .readAll({ campaignId: "campaign-1" })
    .map(({ event }) => event);
  return { result, events, calls, trialId };
}

const summary = (events: readonly LedgerEventV1[]) =>
  events.map((event) =>
    event.type === "discovery-run-started"
      ? `start ${event.runKind} ${event.runId}`
      : event.type === "discovery-run-finished"
        ? `finish ${event.outcome} ${event.runId}`
        : event.type === "partition-assigned"
          ? `assigned ${event.partitionId} ${event.runId}`
          : event.type === "finding-recorded"
            ? `finding ${event.partition ?? "-"} ${event.runId}`
            : event.type === "enumeration-recorded"
              ? `enumeration ${event.accepted ? "accepted" : "rejected"} ${event.runId}`
              : event.type,
  );

describe("partitioned Trial executor (ADR 0042)", () => {
  it("runs the enumerator, assigns each accepted partition to a tracer and admits their claims with the partition", async () => {
    const { result, events, calls, trialId } = await fixture({
      maxParallel: 1,
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : helpers.report(run, `claim of ${run.runId}`),
    });
    expect(result).toMatchObject({
      runCount: 1,
      findingsRecorded: 2,
      stoppedBy: "max-runs",
    });
    expect(summary(events)).toEqual([
      "start enumerate trial-1",
      "finish completed trial-1",
      "enumeration accepted trial-1",
      "assigned p1 trial-1-p-p1",
      "start trace trial-1-p-p1",
      "candidate-normalized",
      "finding p1 trial-1-p-p1",
      "finish completed trial-1-p-p1",
      "assigned p2 trial-1-p-p2",
      "start trace trial-1-p-p2",
      "candidate-normalized",
      "finding p2 trial-1-p-p2",
      "finish completed trial-1-p-p2",
      "discovery-concluded",
    ]);
    const enumeration = events.find(
      (event) => event.type === "enumeration-recorded",
    );
    expect(enumeration).toMatchObject({
      trialId,
      accepted: true,
      resubmits: 0,
      scriptRan: true,
      scriptRowCount: 1,
      agentRowCount: 2,
      duplicateRowCount: 1,
      partitionCount: 2,
      definitionDigest: digest,
      toolsDigest: other,
      rowSource: "agent",
      artifacts: [{ kind: "enumeration-output", digest: expect.any(String) }],
    });
    const assigned = events.filter(
      (event) => event.type === "partition-assigned",
    );
    expect(assigned).toMatchObject([
      { partitionId: "p1", ordinal: 0, of: 2, rowCount: 2, scriptRowCount: 1 },
      { partitionId: "p2", ordinal: 1, of: 2, rowCount: 1, agentRowCount: 1 },
    ]);
    const starts = events.filter(
      (event) => event.type === "discovery-run-started",
    );
    expect(starts.map((event) => event.configuration)).toMatchObject([
      {
        mode: "partitioned",
        role: { kind: "enumerator", resubmit: 0, toolsDigest: other },
        trustBoundaryVersion: "v1",
        sourcePack: { dependency: "mounted" },
      },
      { role: { kind: "tracer", partitionId: "p1" } },
      { role: { kind: "tracer", partitionId: "p2" } },
    ]);
    expect(starts.every((event) => event.trialId === trialId)).toBe(true);
    // The enumerator starts without input files; each tracer gets its partition and the tools.
    expect(calls[0]).toMatchObject({
      runId: trialId,
      inputFiles: [],
      toolFiles: [{ name: "tool.sh" }],
    });
    const partition = JSON.parse(
      calls[1]!.inputFiles.find(
        (file) => file.name === PARTITION_INPUT_FILES.partition,
      )!.content,
    ) as { id: string; rows: unknown[] };
    expect(partition.id).toBe("p1");
    expect(partition.rows).toHaveLength(2);
    expect(calls[2]!.toolFiles).toHaveLength(1);
    // The duplicate `a3` collapsed onto `a1`; the tracers see three rows in all.
    const second = JSON.parse(calls[2]!.inputFiles[0]!.content) as {
      rows: { id: string }[];
    };
    expect(second.rows.map((entry) => entry.id)).toEqual(["a2"]);
  });

  it("sends an over-limit proposal back once with the reasons and accepts the corrected one", async () => {
    const { events, calls } = await fixture({
      limits: { maxEntriesPerPartition: 1 },
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]:
                run.inputFiles.length === 0
                  ? proposal
                  : {
                      partitions: [
                        { id: "p1", label: "A", rowIds: ["s1"] },
                        { id: "p2", label: "B", rowIds: ["a1"] },
                        { id: "p3", label: "C", rowIds: ["a2"] },
                      ],
                    },
            })
          : helpers.report(run, `claim of ${run.runId}`),
    });
    expect(summary(events).slice(0, 5)).toEqual([
      "start enumerate trial-1",
      "finish completed trial-1",
      "start enumerate trial-1-r1",
      "finish completed trial-1-r1",
      "enumeration accepted trial-1-r1",
    ]);
    expect(
      events.find((event) => event.type === "enumeration-recorded"),
    ).toMatchObject({ accepted: true, resubmits: 1, partitionCount: 3 });
    const resent = calls[1]!;
    expect(resent.inputFiles.map((file) => file.name)).toEqual([
      PARTITION_INPUT_FILES.previous,
      PARTITION_INPUT_FILES.sentBack,
    ]);
    expect(JSON.parse(resent.inputFiles[0]!.content)).toEqual({
      inventory,
      partitions: proposal,
    });
    expect(JSON.parse(resent.inputFiles[1]!.content)).toEqual({
      resubmit: 1,
      rejections: [
        { reason: "partition-too-large", partitionId: "p1", count: 2 },
      ],
    });
    const starts = events.filter(
      (event) => event.type === "discovery-run-started",
    );
    expect(starts.slice(0, 2).map((event) => event.configuration.role)).toEqual(
      [
        {
          kind: "enumerator",
          definitionDigest: digest,
          toolsDigest: other,
          resubmit: 0,
        },
        {
          kind: "enumerator",
          definitionDigest: digest,
          toolsDigest: other,
          resubmit: 1,
        },
      ],
    );
  });

  it("ends the Trial incomplete once the send-backs are exhausted, with the last rejection's reasons", async () => {
    const { result, events, calls } = await fixture({
      limits: { maxResubmits: 1 },
      script: (run, _attempt, helpers) =>
        helpers.files(
          run,
          { [ENUMERATION_OUTPUT_FILES.inventory]: inventory },
          false,
        ),
    });
    expect(calls).toHaveLength(2);
    expect(summary(events)).toEqual([
      "start enumerate trial-1",
      "finish completed trial-1",
      "start enumerate trial-1-r1",
      "finish completed trial-1-r1",
      "enumeration rejected trial-1-r1",
    ]);
    expect(
      events.find((event) => event.type === "enumeration-recorded"),
    ).toMatchObject({
      accepted: false,
      resubmits: 1,
      rejectedReasons: ["proposal-missing"],
      scriptRan: false,
      partitionCount: 0,
      scriptRowCount: 1,
      agentRowCount: 2,
    });
    expect(result).toMatchObject({
      runCount: 1,
      findingsRecorded: 0,
      stoppedBy: "incomplete",
    });
  });

  it("retries a failed tracer once in a fresh sandbox and ends partial when the retry fails too", async () => {
    const { result, events } = await fixture({
      maxParallel: 2,
      script: (run, _attempt, helpers) => {
        if (run.output === "files")
          return helpers.files(run, {
            [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
            [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
          });
        if (run.runId === "trial-1-p-p1-r1")
          return helpers.report(run, `claim of ${run.runId}`);
        if (run.runId === "trial-1-p-p1")
          return helpers.failed(run, "provider", "rate-limit");
        return run.runId.endsWith("-r1")
          ? helpers.failed(run, "schema")
          : helpers.failed(run, "wall");
      },
    });
    const lines = summary(events);
    expect(lines.filter((line) => line.startsWith("finish"))).toEqual(
      expect.arrayContaining([
        "finish completed trial-1",
        "finish provider-limited trial-1-p-p1",
        "finish completed trial-1-p-p1-r1",
        "finish failed trial-1-p-p2",
        "finish failed trial-1-p-p2-r1",
      ]),
    );
    expect(lines.filter((line) => line.startsWith("assigned"))).toEqual([
      "assigned p1 trial-1-p-p1",
      "assigned p2 trial-1-p-p2",
    ]);
    expect(lines.filter((line) => line.startsWith("finding"))).toEqual([
      "finding p1 trial-1-p-p1-r1",
    ]);
    const retry = events.find(
      (event) =>
        event.type === "discovery-run-started" &&
        event.runId === "trial-1-p-p1-r1",
    );
    expect(retry).toMatchObject({
      runKind: "trace",
      trialId: "trial-1",
      configuration: { role: { kind: "tracer", partitionId: "p1" } },
    });
    const last = events.find(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.runId === "trial-1-p-p2-r1",
    );
    expect(last).toMatchObject({
      reason: "schema",
      reasonDetail: "schema-synthetic",
    });
    // Partial: the completed partition's claim is admitted and the Trial concluded.
    expect(result).toMatchObject({
      runCount: 1,
      findingsRecorded: 1,
      stoppedBy: "max-runs",
    });
  });

  it("does not retry and does not start a tracer once the target ceiling is spent", async () => {
    // Every run takes six minutes; a 10-minute target wall is gone after the
    // enumerator and the first tracer attempt.
    const { events, calls } = await fixture({
      maxParallel: 1,
      targetWallMs: 10 * 60_000,
      runMs: 6 * 60_000,
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : helpers.failed(run, "wall"),
    });
    expect(calls.map((run) => run.runId)).toEqual(["trial-1", "trial-1-p-p1"]);
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish failed trial-1-p-p1",
        "finish failed trial-1-p-p2",
      ],
    );
    const unstarted = events.find(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.runId === "trial-1-p-p2",
    );
    expect(unstarted).toMatchObject({
      reason: "wall",
      reasonDetail: "target-ceiling",
    });
  });

  it("stops as provider-limited without an enumeration record when the enumerator hits the usage limit", async () => {
    const { result, events } = await fixture({
      script: (run, _attempt, helpers) =>
        helpers.failed(run, "provider", "rate-limit"),
    });
    expect(summary(events)).toEqual([
      "start enumerate trial-1",
      "finish provider-limited trial-1",
    ]);
    expect(result).toMatchObject({ runCount: 1, stoppedBy: "provider-limit" });
  });
});
