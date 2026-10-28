import { randomBytes } from "node:crypto";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { wordPressLabCommandRule } from "../../src/profiles/wordpress/discovery/lab-commands.js";
import { CodexOneShotRuntime } from "../../src/discovery/codex-one-shot-runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  providerCredentialEgressReceiptSchema,
  type AgentRuntimeProfile,
  type CodexSandboxCommand,
  type ProviderCredentialEgressBroker,
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
const defaultProfile = defineClaudeRuntimeProfile(
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
    reason: "provider" | "wall" | "schema" | "operator",
    providerLimit?: "rate-limit",
  ): OneShotResult;
};
type Scripted = (
  run: OneShotRun,
  attempt: number,
  helpers: Helpers,
) => Promise<OneShotResult> | OneShotResult;

async function fixture(options: {
  readonly script?: Scripted;
  readonly profile?: AgentRuntimeProfile;
  readonly runtime?: (store: ProviderAttachmentStore) => OneShotExecutor;
  readonly limits?: Partial<PartitionedTrialPlan["limits"]>;
  readonly maxParallel?: number;
  readonly targetWallMs?: number;
  /** Each executed run moves the clock this far; 0 keeps the clock still. */
  readonly runMs?: number;
  readonly signal?: AbortSignal;
  /** Replaces the WordPress admission; the default admits every claim. */
  readonly recordReport?: Parameters<
    typeof runDiscoveryCampaign
  >[0]["recordReport"];
  readonly evidenceMaxBytes?: number;
  /** Makes Private Evidence refuse any `putFiles` that names one of these files. */
  readonly brokenEvidenceFiles?: readonly string[];
}) {
  const profile = options.profile ?? defaultProfile;
  const root = await mkdtemp(join(tmpdir(), "wbh-partitioned-"));
  directories.push(root);
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: options.evidenceMaxBytes ?? 4 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const broken = options.brokenEvidenceFiles ?? [];
  const trialEvidence =
    broken.length === 0
      ? evidence
      : new Proxy(evidence, {
          get(target, property) {
            if (property === "putFiles")
              return async (files: Record<string, string>) => {
                if (Object.keys(files).some((name) => broken.includes(name)))
                  throw new Error("evidence store refused");
                return target.putFiles(files);
              };
            const value = Reflect.get(target, property) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
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
      reason: "provider" | "wall" | "schema" | "operator",
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
  const runtime = options.runtime?.(attachments);
  const calls: OneShotRun[] = [];
  const attempts = new Map<string, number>();
  const executor: OneShotExecutor = {
    async execute(run) {
      calls.push(run);
      now += options.runMs ?? 0;
      const attempt = attempts.get(run.runId) ?? 0;
      attempts.set(run.runId, attempt + 1);
      return runtime === undefined
        ? options.script!(run, attempt, helpers)
        : runtime.execute(run);
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
    evidence: trialEvidence,
    ledger,
    recordReport: options.recordReport ?? recordWordPressReport,
    clock,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const events = ledger
    .readAll({ campaignId: "campaign-1" })
    .map(({ event }) => event);
  return { result, events, calls, trialId, ledger, evidence };
}

/** Three partitions of one row each, for the pool tests. */
const threeProposal = {
  partitions: [
    { id: "p1", label: "A", rowIds: ["s1"] },
    { id: "p2", label: "B", rowIds: ["a1"] },
    { id: "p3", label: "C", rowIds: ["a2"] },
  ],
};

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
  it.each([undefined, "wall", "evidence", "schema", "provider"] as const)(
    "runs Codex through the existing ledger flow (failure: %s)",
    async (failure) => {
      const codex = defineAgentRuntimeProfile({
        id: "codex",
        transportKind: "codex-native/v1",
        sandboxImageDigest: digest,
        requestedModelId: "gpt-6-sol",
        requestedEffort: "high",
        codexCliVersion: "0.161.0",
        bundledCatalogDigest: digest,
        authenticationMethod: "host-private-bearer",
        cyberAccessProgram: "unavailable",
        serviceTier: "unavailable",
        subagent: { modelId: "gpt-6-sol", effort: "high" },
      });
      const commands: CodexSandboxCommand[] = [];
      const broker: ProviderCredentialEgressBroker = {
        async withGrant(request, operation) {
          expect(request).toMatchObject({
            protocol: "responses",
            maxRequests: 2000,
            maxRequestBytes: 8 * 1024 * 1024,
            maxResponseBytes: 8 * 1024 * 1024,
          });
          const body = {
            grantId: "grant-1",
            brokerImage: `broker@${digest}`,
            upstreamOrigin: "https://api.openai.com/v1",
            ...request,
            startedAt: start,
            completedAt: start,
            setup: { status: "ready" },
            cleanup: { status: "completed" },
            isolation: {
              backend: "gvisor",
              runtime: "runsc",
              fallbackUsed: false,
              agentNetworkInternal: true,
            },
          };
          const value = await operation({
            baseUrl: "http://172.30.0.2:8080",
            authorization: `Bearer ${randomBytes(32).toString("hex")}`,
            dockerNetworkName: "provider-egress-1",
            model: request.model,
            protocol: request.protocol,
            expiresAt: request.expiresAt,
          });
          return {
            operation: { status: "completed", value },
            receipt: providerCredentialEgressReceiptSchema.parse({
              ...body,
              digest: canonicalDigest(body),
            }),
          };
        },
      };
      const result = await fixture({
        profile: codex,
        maxParallel: 1,
        runtime: (attachments) =>
          new CodexOneShotRuntime(
            {
              async execute(command) {
                commands.push(command);
                const tracing = command.oneShot!.inputFiles.some(
                  (file) => file.name === "partition.json",
                );
                const report = {
                  findings: [JSON.stringify(claim("one per partition"))],
                  leads: [],
                  examined: "partition",
                  unexamined: "none",
                };
                return {
                  status: "exited",
                  exitCode: 0,
                  startedAt: start,
                  completedAt: start,
                  image: `codex@${digest}`,
                  cliVersion: "0.161.0",
                  bundledCatalogDigest: digest,
                  isolation: {
                    backend: "gvisor",
                    runtime: "runsc",
                    fallbackUsed: false,
                  },
                  stdout: [
                    { type: "thread.started", thread_id: "thread-1" },
                    { type: "turn.started" },
                    {
                      type: "item.completed",
                      item: {
                        type: "command_execution",
                        command: "sh /workspace/tools/tool.sh",
                      },
                    },
                    {
                      type: "item.completed",
                      item: {
                        type: "agent_message",
                        text: tracing ? JSON.stringify(report) : "done",
                      },
                    },
                    {
                      type: "turn.completed",
                      usage: { input_tokens: 10, output_tokens: 4 },
                    },
                  ]
                    .map((event) => JSON.stringify(event))
                    .join("\n"),
                  outputFiles: tracing
                    ? []
                    : [
                        {
                          name: "inventory.json",
                          content: JSON.stringify(inventory),
                        },
                        {
                          name: "partitions.json",
                          content: JSON.stringify(
                            commands.length === 1
                              ? { partitions: [proposal.partitions[0]] }
                              : proposal,
                          ),
                        },
                      ],
                  ...(failure === "wall"
                    ? {
                        status: "failed" as const,
                        exitCode: -1,
                        failureKind: "timed-out" as const,
                      }
                    : {}),
                  ...(failure === "evidence"
                    ? { outputFailure: "capture-failed" as const }
                    : {}),
                  ...(failure === "schema" ? { stdout: "malformed" } : {}),
                  ...(failure === "provider"
                    ? {
                        status: "failed" as const,
                        exitCode: -1,
                        stdout: JSON.stringify({
                          type: "turn.failed",
                          error: { message: "rate limit exceeded" },
                        }),
                      }
                    : {}),
                };
              },
            },
            broker,
            attachments,
            `codex@${digest}`,
            wordPressLabCommandRule,
          ),
      });
      if (failure !== undefined) {
        expect(result.result.findingsRecorded).toBe(0);
        expect(commands).toHaveLength(1);
        const finished = result.events.find(
          (event) => event.type === "discovery-run-finished",
        )!;
        const stored = await result.evidence.readFile(
          finished.artifacts.find((ref) => ref.kind === "native-run-receipt")!
            .digest,
          "receipt.json",
          64 * 1024,
        );
        if (stored.status !== "resolved") throw new Error(stored.status);
        expect(JSON.parse(stored.bytes.toString("utf8"))).toMatchObject({
          terminal: "incomplete",
          reason: failure,
          runtimeProfileDigest: codex.digest,
        });
        expect(
          result.events.some((event) => event.type === "partition-assigned"),
        ).toBe(false);
        return;
      }
      expect(result.result).toMatchObject({
        runCount: 1,
        stoppedBy: "max-runs",
        findingsRecorded: 2,
      });
      expect(summary(result.events)).toEqual([
        "start enumerate trial-1",
        "finish completed trial-1",
        "start enumerate trial-1-r1",
        "finish completed trial-1-r1",
        "enumeration accepted trial-1-r1",
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
      expect(commands).toHaveLength(4);
      for (const command of commands) {
        expect(command.args).toContain("features.multi_agent=false");
        expect(command.minimumActiveMs).toBeUndefined();
        expect(command.oneShot?.wallMs).toBe(20 * 60_000);
      }
      expect(commands[0]!.args).not.toContain("--output-schema");
      expect(commands[2]!.args).toContain("--output-schema");
      for (const event of result.events.filter(
        (event) => event.type === "discovery-run-finished",
      )) {
        const receipt = await result.evidence.readFile(
          event.artifacts.find((ref) => ref.kind === "native-run-receipt")!
            .digest,
          "receipt.json",
          64 * 1024,
        );
        if (receipt.status !== "resolved") throw new Error(receipt.status);
        expect(JSON.parse(receipt.bytes.toString("utf8"))).toMatchObject({
          runtimeProfileDigest: codex.digest,
          codexCliVersion: "0.161.0",
        });
      }
    },
  );

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
    const { result, events, calls, ledger } = await fixture({
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
      failure: {
        runId: "trial-1",
        reason: "schema",
        reasonDetail: "enumeration-rejected",
      },
    });
    // The funnel reads one attempt that ended incomplete, not a completed
    // attempt with zero candidates (ADR 0042); the send-back is no second attempt.
    const funnel = ledger.funnel("campaign-1");
    expect(funnel.discoveryAttempts).toBe(1);
    expect(funnel.attemptOutcomes).toEqual({
      completed: 0,
      completedWithoutCandidate: 0,
      incomplete: 1,
      incompleteByReason: { "schema/enumeration-rejected": 1 },
      providerLimited: 0,
      unfinished: 0,
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
        if (run.runId === "trial-1-p-p1.retry1")
          return helpers.report(run, `claim of ${run.runId}`);
        return run.runId.endsWith(".retry1")
          ? helpers.failed(run, "schema")
          : helpers.failed(run, "wall");
      },
    });
    const lines = summary(events);
    expect(lines.filter((line) => line.startsWith("finish"))).toEqual(
      expect.arrayContaining([
        "finish completed trial-1",
        "finish failed trial-1-p-p1",
        "finish completed trial-1-p-p1.retry1",
        "finish failed trial-1-p-p2",
        "finish failed trial-1-p-p2.retry1",
      ]),
    );
    expect(lines.filter((line) => line.startsWith("assigned"))).toEqual([
      "assigned p1 trial-1-p-p1",
      "assigned p2 trial-1-p-p2",
    ]);
    expect(lines.filter((line) => line.startsWith("finding"))).toEqual([
      "finding p1 trial-1-p-p1.retry1",
    ]);
    const retry = events.find(
      (event) =>
        event.type === "discovery-run-started" &&
        event.runId === "trial-1-p-p1.retry1",
    );
    expect(retry).toMatchObject({
      runKind: "trace",
      trialId: "trial-1",
      configuration: { role: { kind: "tracer", partitionId: "p1" } },
    });
    const last = events.find(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.runId === "trial-1-p-p2.retry1",
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
    expect(result.providerLimit).toBeUndefined();
  });

  it("names a retry with a separator outside the partition id alphabet, so it is never another partition's first run", async () => {
    const { events } = await fixture({
      maxParallel: 1,
      script: (run, _attempt, helpers) => {
        if (run.output === "files")
          return helpers.files(run, {
            [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
            [ENUMERATION_OUTPUT_FILES.partitions]: {
              partitions: [
                { id: "x", label: "X", rowIds: ["s1", "a1"] },
                { id: "x-r1", label: "X again", rowIds: ["a2"] },
              ],
            },
          });
        return run.runId === "trial-1-p-x"
          ? helpers.failed(run, "wall")
          : helpers.report(run, `claim of ${run.runId}`);
      },
    });
    expect(summary(events).filter((line) => line.startsWith("start"))).toEqual([
      "start enumerate trial-1",
      "start trace trial-1-p-x",
      "start trace trial-1-p-x.retry1",
      "start trace trial-1-p-x-r1",
    ]);
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish failed trial-1-p-x",
        "finish completed trial-1-p-x.retry1",
        "finish completed trial-1-p-x-r1",
      ],
    );
  });

  it("does not retry a provider-limited tracer and ends the Trial provider-limited when no tracer completed", async () => {
    const { result, events, calls } = await fixture({
      maxParallel: 1,
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : helpers.failed(run, "provider", "rate-limit"),
    });
    expect(calls.map((run) => run.runId)).toEqual([
      "trial-1",
      "trial-1-p-p1",
      "trial-1-p-p2",
    ]);
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish provider-limited trial-1-p-p1",
        "finish provider-limited trial-1-p-p2",
      ],
    );
    expect(result).toMatchObject({
      runCount: 1,
      stoppedBy: "provider-limit",
      providerLimit: "rate-limit",
      failure: {
        runId: "trial-1",
        reason: "provider",
        providerLimit: "rate-limit",
      },
    });
  });

  it("surfaces a tracer's usage limit to the campaign even when the Trial completes partially", async () => {
    const { result, events } = await fixture({
      maxParallel: 1,
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : run.runId === "trial-1-p-p1"
            ? helpers.failed(run, "provider", "rate-limit")
            : helpers.report(run, `claim of ${run.runId}`),
    });
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish provider-limited trial-1-p-p1",
        "finish completed trial-1-p-p2",
      ],
    );
    // Concluded, with the limit on the side for the runner's backoff.
    expect(result).toMatchObject({
      runCount: 1,
      findingsRecorded: 1,
      stoppedBy: "max-runs",
      providerLimit: "rate-limit",
    });
    expect(result.failure).toBeUndefined();
  });

  it("records a throw after the transport as missing evidence beside the real receipt, and does not retry it", async () => {
    let thrown = false;
    const { events, evidence } = await fixture({
      maxParallel: 1,
      recordReport: async (report, context) => {
        if (!thrown) {
          thrown = true;
          throw new Error("admission exploded");
        }
        return recordWordPressReport(report, context);
      },
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : helpers.report(run, `claim of ${run.runId}`),
    });
    // A Harness-side failure is not the sandbox's to repeat: no retry.
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish failed trial-1-p-p1",
        "finish completed trial-1-p-p2",
      ],
    );
    const failed = events.find(
      (event) =>
        event.type === "discovery-run-finished" &&
        event.runId === "trial-1-p-p1",
    );
    expect(failed).toMatchObject({
      outcome: "failed",
      reason: "evidence",
      reasonDetail: "post-run-threw",
      // The transport's own observation, with its own sealed receipt.
      observed: { filesRead: 3 },
    });
    const artifacts =
      failed?.type === "discovery-run-finished" ? failed.artifacts : [];
    expect(artifacts.map((ref) => ref.kind)).toEqual([
      "native-run-receipt",
      "role-run-error",
    ]);
    const receipt = await evidence.readFile(
      artifacts[0]!.digest,
      "receipt.json",
      64 * 1024,
    );
    if (receipt.status !== "resolved") throw new Error(receipt.status);
    expect(JSON.parse(receipt.bytes.toString("utf8"))).toMatchObject({
      runId: "trial-1-p-p1",
      terminal: "completed",
      reason: "unavailable",
    });
    const diagnostic = await evidence.readFile(
      artifacts[1]!.digest,
      "role-run-error.json",
      4096,
    );
    if (diagnostic.status !== "resolved") throw new Error(diagnostic.status);
    expect(JSON.parse(diagnostic.bytes.toString("utf8"))).toEqual({
      runId: "trial-1-p-p1",
      stage: "admission",
      message: "admission exploded",
    });
  });

  it("still appends the finish when Private Evidence itself refuses the error file or the receipt", async () => {
    // The error file alone cannot be written: the real receipt's artifact stays.
    const errorOnly = await fixture({
      maxParallel: 1,
      brokenEvidenceFiles: ["role-run-error.json"],
      recordReport: async () => {
        throw new Error("admission exploded");
      },
      script: (run, _attempt, helpers) =>
        run.output === "files"
          ? helpers.files(run, {
              [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
              [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
            })
          : helpers.report(run, `claim of ${run.runId}`),
    });
    expect(
      summary(errorOnly.events).filter((line) => line.startsWith("finish")),
    ).toEqual([
      "finish completed trial-1",
      "finish failed trial-1-p-p1",
      "finish failed trial-1-p-p2",
    ]);
    for (const runId of ["trial-1-p-p1", "trial-1-p-p2"]) {
      const finish = errorOnly.events.find(
        (event) =>
          event.type === "discovery-run-finished" && event.runId === runId,
      );
      expect(finish).toMatchObject({
        reason: "evidence",
        reasonDetail: "post-run-threw",
        artifacts: [{ kind: "native-run-receipt" }],
      });
    }
    expect(errorOnly.result).toMatchObject({ stoppedBy: "incomplete" });
    // Neither the receipt nor the error file can be written: the finish
    // carries the receipt's fields and no artifact; no start is left dangling.
    const nothing = await fixture({
      brokenEvidenceFiles: ["receipt.json", "role-run-error.json"],
      script: (run, _attempt, helpers) =>
        helpers.files(run, {
          [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
          [ENUMERATION_OUTPUT_FILES.partitions]: proposal,
        }),
    });
    expect(summary(nothing.events)).toEqual([
      "start enumerate trial-1",
      "finish failed trial-1",
    ]);
    expect(
      nothing.events.find((event) => event.type === "discovery-run-finished"),
    ).toMatchObject({
      reason: "evidence",
      reasonDetail: "post-run-threw",
      observed: { filesRead: 3 },
      artifacts: [],
    });
    expect(nothing.result).toMatchObject({
      stoppedBy: "incomplete",
      failure: {
        runId: "trial-1",
        reason: "evidence",
        reasonDetail: "post-run-threw",
      },
    });
  });

  it("keeps at most maxParallel tracers in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const { events } = await fixture({
      maxParallel: 2,
      script: async (run, _attempt, helpers) => {
        if (run.output === "files")
          return helpers.files(run, {
            [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
            [ENUMERATION_OUTPUT_FILES.partitions]: threeProposal,
          });
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return helpers.report(run, `claim of ${run.runId}`);
      },
    });
    expect(peak).toBe(2);
    expect(
      summary(events).filter((line) => line.startsWith("finish completed")),
    ).toHaveLength(4);
  });

  it("stops the pool on operator cancellation: the running tracer ends as operator, the rest are recorded without starting", async () => {
    const controller = new AbortController();
    const { result, events, calls } = await fixture({
      maxParallel: 1,
      signal: controller.signal,
      script: async (run, _attempt, helpers) => {
        if (run.output === "files")
          return helpers.files(run, {
            [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
            [ENUMERATION_OUTPUT_FILES.partitions]: threeProposal,
          });
        // The transport sees the operator's stop and returns a cancelled receipt.
        controller.abort("operator");
        return helpers.failed(run, "operator");
      },
    });
    expect(calls.map((run) => run.runId)).toEqual(["trial-1", "trial-1-p-p1"]);
    expect(summary(events).filter((line) => line.startsWith("finish"))).toEqual(
      [
        "finish completed trial-1",
        "finish failed trial-1-p-p1",
        "finish failed trial-1-p-p2",
        "finish failed trial-1-p-p3",
      ],
    );
    for (const runId of ["trial-1-p-p1", "trial-1-p-p2", "trial-1-p-p3"])
      expect(
        events.find(
          (event) =>
            event.type === "discovery-run-finished" && event.runId === runId,
        ),
      ).toMatchObject({ reason: "operator" });
    expect(result).toMatchObject({ runCount: 1, stoppedBy: "incomplete" });
  });

  it("ends the Trial instead of mounting a send-back that exceeds the input file cap", async () => {
    // Two raw files just under the output cap; their canonical form plus the
    // wrapper is over twice that cap, the input file limit.
    const filler = "x".repeat(8 * 1024 * 1024 - 20);
    const { result, events, calls } = await fixture({
      evidenceMaxBytes: 64 * 1024 * 1024,
      script: (run, _attempt, helpers) =>
        helpers.files(run, {
          [ENUMERATION_OUTPUT_FILES.inventory]: `{"rows":"${filler}"}`,
          [ENUMERATION_OUTPUT_FILES.partitions]: `{"partitions":"${filler}"}`,
        }),
    });
    expect(calls).toHaveLength(1);
    expect(summary(events)).toEqual([
      "start enumerate trial-1",
      "finish completed trial-1",
      "enumeration rejected trial-1",
    ]);
    expect(
      events.find((event) => event.type === "enumeration-recorded"),
    ).toMatchObject({
      accepted: false,
      resubmits: 0,
      rejectedReasons: [
        "inventory-invalid",
        "proposal-invalid",
        "send-back-oversize",
      ],
    });
    expect(result).toMatchObject({
      stoppedBy: "incomplete",
      failure: { reason: "schema", reasonDetail: "enumeration-rejected" },
    });
  });

  it("does not start a tracer, a retry or a send-back below the five-minute floor of the target wall", async () => {
    // Every run takes six minutes. Of a 16-minute target wall, 10 minutes
    // are left after the enumerator: the first tracer starts; its retry and
    // the second partition would start under the floor and are only recorded.
    const { events, calls } = await fixture({
      maxParallel: 1,
      targetWallMs: 16 * 60_000,
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
    // A send-back under the floor is not mounted either.
    const sentBack = await fixture({
      targetWallMs: 10 * 60_000,
      runMs: 6 * 60_000,
      script: (run, _attempt, helpers) =>
        helpers.files(run, {
          [ENUMERATION_OUTPUT_FILES.inventory]: inventory,
        }),
    });
    expect(sentBack.calls.map((run) => run.runId)).toEqual(["trial-1"]);
    expect(summary(sentBack.events)).toEqual([
      "start enumerate trial-1",
      "finish completed trial-1",
      "start enumerate trial-1-r1",
      "finish failed trial-1-r1",
    ]);
    expect(sentBack.result).toMatchObject({
      stoppedBy: "incomplete",
      failure: {
        runId: "trial-1",
        reason: "wall",
        reasonDetail: "target-ceiling",
      },
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
