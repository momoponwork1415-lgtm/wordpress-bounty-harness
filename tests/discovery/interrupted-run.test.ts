import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exploreTrials } from "../../src/cli/continuous.js";
import {
  assessTrialResume,
  CodexNativeAgentRuntime,
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  executeTrialResume,
  GvisorCodexSandbox,
  PROVIDER_UPSTREAM_ORIGIN,
  ProviderAttachmentStore,
  providerCredentialEgressReceiptSchema,
  recordInterruptedRun,
  runDiscoveryCampaign,
  type DiscoveryTransportRun,
  type ProviderCredentialEgressBroker,
  type SandboxOwner,
} from "../../src/discovery/index.js";
import { executeTrial } from "../../src/discovery/execute-trial.js";
import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

const digest = `sha256:${"a".repeat(64)}`;
const catalog = `sha256:${"b".repeat(64)}`;
const promptDigest = `sha256:${"c".repeat(64)}`;
const image = `node@${digest}`;
const T0 = "2026-10-19T00:00:00.000Z";
const MINUTE = 60_000;
const ROOT_THREAD = "11111111-2222-4333-8444-555555555555";
const CHILD_THREAD = "66666666-7777-4888-9999-000000000000";
const ROOT_PATH = "2026/10/19/rollout-2026-10-19T00-00-00-root.jsonl";
const CHILD_PATH = "2026/10/19/rollout-2026-10-19T00-01-00-child.jsonl";
const resumePrompt = "Before giving up, keep exploring the fixed source.";
const prompt = `Find impact in the fixed source.\n\n${resumePrompt}`;
const profile = defineAgentRuntimeProfile({
  id: "cooperative",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: catalog,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "daybreak_blue",
  serviceTier: "priority",
  subagent: { modelId: "gpt-6-sol", effort: "high" },
});
const otherProfile = defineAgentRuntimeProfile({
  id: "other",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "medium",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: catalog,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "daybreak_blue",
  serviceTier: "priority",
  subagent: { modelId: "gpt-6-sol", effort: "medium" },
});

const line = (event: unknown) => JSON.stringify(event);
const report = line({
  findings: [],
  leads: [],
  examined: "routes",
  unexamined: "none",
});
const rootRollout = [
  {
    timestamp: T0,
    type: "session_meta",
    payload: { id: ROOT_THREAD, source: "exec" },
  },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        command: ["sed", "-n", "1,5p", "/workspace/main/main.php"],
      },
    },
  },
]
  .map(line)
  .join("\n");
const childRollout = [
  {
    timestamp: "2026-10-19T00:01:00Z",
    type: "session_meta",
    payload: {
      id: CHILD_THREAD,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT_THREAD,
            depth: 1,
            agent_path: "/root/child_1",
          },
        },
      },
    },
  },
  {
    type: "turn_context",
    payload: {
      model: "gpt-6-sol",
      effort: "high",
      cyber_access_program: "daybreak_blue",
    },
  },
  {
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: report },
  },
]
  .map(line)
  .join("\n");

const roots: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function broker(): ProviderCredentialEgressBroker {
  return {
    async withGrant(request, operation) {
      const body = {
        schemaVersion: 1 as const,
        grantId: "grant-1",
        runtimeProfileDigest: request.runtimeProfileDigest,
        brokerImage: image,
        upstreamOrigin: PROVIDER_UPSTREAM_ORIGIN,
        model: request.model,
        protocol: request.protocol,
        maxRequests: request.maxRequests,
        maxRequestBytes: request.maxRequestBytes,
        maxResponseBytes: request.maxResponseBytes,
        expiresAt: request.expiresAt,
        startedAt: T0,
        completedAt: T0,
        setup: { status: "ready" as const },
        cleanup: { status: "completed" as const },
        isolation: {
          backend: "gvisor" as const,
          runtime: "runsc" as const,
          fallbackUsed: false as const,
          agentNetworkInternal: true as const,
        },
      };
      const value = await operation({
        baseUrl: "http://127.0.0.1:8080",
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
        dockerNetworkName: "internal-run",
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
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-interrupted-"));
  roots.push(root);
  const scratch = join(root, "scratch");
  const source = join(root, "source");
  await mkdir(scratch);
  await mkdir(source);
  await writeFile(join(source, "main.php"), "<?php");
  const sourceTree = await measureCanonicalSourceTree(source, {
    maxEntries: 10,
    maxBytes: 1024,
  });
  const attachments = new ProviderAttachmentStore(join(root, "attachments"));
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 50,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  /**
   * A sandbox of the process `owner` on its boot; `alive` answers for other
   * pids. Its CLI keeps working until cancelled, or exits once it has written
   * when `exits` is set.
   */
  const sandbox = (
    owner: SandboxOwner,
    alive: (pid: number) => boolean,
    exits = false,
  ) => {
    let containerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      containerStarted = resolve;
    });
    const instance = new GvisorCodexSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      bundledCatalogPath: "/opt/codex/model-catalog.json",
      scratchRootDirectory: scratch,
      ownerDirectory: join(scratch, "discovery-owners"),
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 120 * MINUTE,
      clock: () => new Date(T0),
      owner: async () => owner,
      ownerAlive: alive,
      runDocker: async (args, _stdin, _timeoutMs, signal) => {
        if (!args.includes("--entrypoint=node"))
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: args.includes("--version")
              ? "codex-cli 0.161.0\n"
              : `${"b".repeat(64)}  /opt/codex/model-catalog.json\n`,
            stderr: "",
          };
        const mountOf = (dst: string) =>
          /^--mount=type=bind,src=(.+),dst=/.exec(
            args.find((arg) => arg.endsWith(`,dst=${dst}`)) ?? "",
          )?.[1] ?? "";
        const lastWrite = new Date(Date.parse(T0) + 30 * MINUTE);
        const files: [string, string][] = [
          [
            join(mountOf("/tmp/codex"), "sessions", ...ROOT_PATH.split("/")),
            rootRollout,
          ],
          [
            join(mountOf("/tmp/codex"), "sessions", ...CHILD_PATH.split("/")),
            childRollout,
          ],
          [join(mountOf("/workspace/research"), "notes", "plan.md"), "plan\n"],
        ];
        for (const [path, content] of files) {
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, content);
          await utimes(path, lastWrite, lastWrite);
        }
        containerStarted();
        if (exits)
          return {
            kind: "exited" as const,
            exitCode: 0,
            stdout: "",
            stderr: "",
          };
        // The CLI keeps working until the host dies; only a test cleanup ends it.
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({ kind: "cancelled", stdout: "", stderr: "" }),
          ),
        );
      },
    });
    return { instance, started };
  };
  const run: Omit<
    DiscoveryTransportRun,
    "runId" | "campaignInput" | "expiresAt"
  > = {
    targetSnapshotDigest: digest,
    profile,
    coordination: "cooperative",
    prompt,
    minimumActiveMs: 60 * MINUTE,
    resumePrompt,
    sourceDirectory: source,
    sourceTree,
  };
  const input = {
    schemaVersion: 1 as const,
    snapshotDigest: digest,
    trustBoundary: {
      version: "trust-boundary-v1",
      text: "Low privilege only.",
    },
    programmeBoundary: { version: "v1", text: "Boundary" },
    modelProfileDigest: profile.digest,
    promptDigest,
    stopRules: { maxRuns: 1, noFindingRuns: 1 },
    lab: { mode: "none" as const },
    history: { mode: "none" as const },
  };
  const context = {
    campaignId: "campaign-1",
    input,
    attachments,
    evidence,
    ledger,
    recordReport: recordWordPressReport,
    clock: () => new Date(T0),
  };
  /** The start `executeTrial` appends before the transport runs. */
  const recordStart = async (runId: string, occurredAt = T0) => {
    const appended = await ledger.append({
      schemaVersion: 1,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt,
      identity: `discovery-start-${runId}`,
      type: "discovery-run-started",
      runId,
      trialId: runId,
      trialOrdinal: 0,
      runKind: "explore",
      labAttached: false,
      history: { mode: "none" },
      configuration: {
        promptVariant: "wp2shell-bounty-v8",
        promptDigest,
        trustBoundaryVersion: "trust-boundary-v1",
        sourcePack: { dependency: "none" },
      },
    });
    expect(appended.status).toBe("appended");
  };
  const HOST_A = { pid: 4242, bootId: "boot-a" };
  let runtimeA: CodexNativeAgentRuntime | undefined;
  /** Host A starts run-1 and keeps it running; the test then treats host A as dead. */
  const startOnHostA = async (runProfile = profile) => {
    await recordStart("run-1");
    const hostA = sandbox(HOST_A, () => true);
    const controller = new AbortController();
    runtimeA = new CodexNativeAgentRuntime(
      hostA.instance,
      broker(),
      attachments,
      image,
      () => new Date(T0),
    );
    const running = runtimeA.execute(
      {
        ...run,
        profile: runProfile,
        runId: "run-1",
        campaignInput: { ...input, modelProfileDigest: runProfile.digest },
        expiresAt: "2026-10-19T02:00:00.000Z",
      },
      controller.signal,
    );
    const stop = async () => {
      controller.abort("operator");
      await running.catch(() => undefined);
    };
    cleanups.push(stop);
    await hostA.started;
    return stop;
  };
  /** The same scratch root seen by another process: `owner` on its boot. */
  const runtimeOn = (owner: SandboxOwner, alive: (pid: number) => boolean) =>
    new CodexNativeAgentRuntime(
      sandbox(owner, alive).instance,
      broker(),
      attachments,
      image,
      () => new Date(T0),
    );
  const recover = (owner: SandboxOwner, alive: (pid: number) => boolean) =>
    runtimeOn(owner, alive).recoverInterrupted(
      {
        ...run,
        runId: "run-1",
        campaignInput: input,
        expiresAt: "2026-10-19T02:00:00.000Z",
      },
      T0,
    );
  /** `campaign resume` in another process, with the discovery-side sealing wired in. */
  const resumeFrom = (owner: SandboxOwner, alive: (pid: number) => boolean) => {
    const runtime = runtimeOn(owner, alive);
    return assessTrialResume({
      ledger,
      evidence,
      attachments,
      campaignId: "campaign-1",
      runId: "run-1",
      snapshotDigest: digest,
      promptDigest,
      prompt,
      resumePrompt,
      profileDigest: profile.digest,
      wallTimeMs: 120 * MINUTE,
      minimumActiveMs: 60 * MINUTE,
      recoverInterrupted: (started) =>
        recordInterruptedRun(context, runtime, started, run),
    });
  };
  /** Host A runs run-1 as one planned Trial, through `executeTrial`, to its own end. */
  const executeOnHostA = () =>
    executeTrial(
      {
        ...context,
        executor: new CodexNativeAgentRuntime(
          sandbox(HOST_A, () => true, true).instance,
          broker(),
          attachments,
          image,
          () => new Date(T0),
        ),
        seen: new Set(),
      },
      {
        trialId: "run-1",
        trialOrdinal: 0,
        explore: {
          run: {
            ...run,
            runId: "run-1",
            expiresAt: "2026-10-19T02:00:00.000Z",
          },
          configuration: {
            promptVariant: "wp2shell-bounty-v8",
            promptDigest,
          },
        },
      },
    );
  return {
    scratch,
    ledger,
    evidence,
    context,
    run,
    recordStart,
    startOnHostA,
    executeOnHostA,
    releaseOnHostA: (runId: string) => runtimeA!.release(runId),
    recover,
    resumeFrom,
  };
}

const leftovers = async (scratch: string) => ({
  markers: await readdir(join(scratch, "run-markers")),
  directories: (await readdir(scratch)).filter((name) =>
    name.startsWith("codex-"),
  ).length,
});
const DEAD_HOST = { pid: 5151, bootId: "boot-b" };

describe("run marker and leftovers of a dead host (ADR 0036, 2026-10-19 second addendum)", () => {
  it("names the running run in a marker, kept past the run's own end until release (#512)", async () => {
    const t = await fixture();
    const stop = await t.startOnHostA();
    expect(await leftovers(t.scratch)).toEqual({
      markers: ["run-1.json"],
      directories: 3,
    });
    await stop();
    // The staging directory goes; the marker, sessions and notes wait for the finish.
    expect(await leftovers(t.scratch)).toEqual({
      markers: ["run-1.json"],
      directories: 2,
    });
    await t.releaseOnHostA("run-2");
    expect((await leftovers(t.scratch)).markers).toEqual(["run-1.json"]);
    await t.releaseOnHostA("run-1");
    expect(await leftovers(t.scratch)).toEqual({ markers: [], directories: 0 });
  });

  it("seals a dead host's leftovers as an interrupted receipt with the session, then discards them", async () => {
    const t = await fixture();
    await t.startOnHostA();
    const recovered = await t.recover(DEAD_HOST, () => false);
    if (recovered.status !== "recovered") throw new Error(recovered.status);
    const { receipt, researchArtifact, agentRuns } = recovered.result;
    expect(receipt).toMatchObject({
      runId: "run-1",
      terminal: "incomplete",
      reason: "interrupted",
      runtimeProfileDigest: profile.digest,
      codexCliVersion: "0.161.0",
      // The ledger start, and the last write under the sessions and notes.
      startedAt: T0,
      completedAt: "2026-10-19T00:30:00.000Z",
      childThreadsObserved: 1,
      session: { rootThreadId: ROOT_THREAD, segment: 0 },
    });
    expect(
      receipt.session?.files.map((file) => [file.kind, file.path]),
    ).toEqual([
      ["root", ROOT_PATH],
      ["child", CHILD_PATH],
    ]);
    expect(researchArtifact?.truncated).toBe(false);
    expect(agentRuns).toHaveLength(1);
    await recovered.discard();
    expect(await leftovers(t.scratch)).toEqual({ markers: [], directories: 0 });
  });

  it("is alive while its pid runs on the same boot, and dead once that pid is gone (kill -9)", async () => {
    const t = await fixture();
    await t.startOnHostA();
    const sameBoot = { pid: 5151, bootId: "boot-a" };
    expect(await t.recover(sameBoot, (pid) => pid === 4242)).toEqual({
      status: "alive",
    });
    expect((await t.recover(sameBoot, () => false)).status).toBe("recovered");
  });

  it("finds nothing without a marker or without the Codex home", async () => {
    const t = await fixture();
    expect(await t.recover(DEAD_HOST, () => false)).toEqual({
      status: "absent",
    });
    await t.startOnHostA();
    for (const name of await readdir(t.scratch))
      if (name.startsWith("codex-home-"))
        await rm(join(t.scratch, name), { recursive: true });
    expect(await t.recover(DEAD_HOST, () => false)).toEqual({
      status: "absent",
    });
  });

  it("refuses a run another runtime profile started", async () => {
    const t = await fixture();
    await t.startOnHostA(otherProfile);
    expect(await t.recover(DEAD_HOST, () => false)).toEqual({
      status: "runtime-profile-differs",
      detail: otherProfile.digest,
    });
  });
});

describe("campaign resume of an interrupted run (ADR 0036, 2026-10-19 second addendum)", () => {
  it("seals what a dead host left behind, settles the run and resumes the same thread", async () => {
    const t = await fixture();
    await t.startOnHostA();
    // Host A loses power: no finish. After the reboot another process resumes it.
    const assessment = await t.resumeFrom(DEAD_HOST, () => false);
    expect(assessment).toMatchObject({
      status: "resumable",
      plan: {
        originalRunId: "run-1",
        resumesRun: "run-1",
        segment: 1,
        consumedWallMs: 30 * MINUTE,
        remainingWallMs: 90 * MINUTE,
        minimumActiveMs: 30 * MINUTE,
        researchRestored: true,
        resume: { threadId: ROOT_THREAD },
      },
    });
    if (assessment.status !== "resumable") return;
    expect(assessment.plan.resume.sessions[0]?.content).toBe(rootRollout);
    expect(assessment.plan.resume.research).toEqual([
      {
        path: "notes/plan.md",
        contentBase64: Buffer.from("plan\n").toString("base64"),
      },
    ]);
    // The original run now has its finish, and its child was recorded as on any failed run.
    const events = t.ledger
      .readAll({ campaignId: "campaign-1" })
      .map(({ event }) => event);
    expect(
      events.find(
        (event) =>
          event.type === "discovery-run-finished" && event.runId === "run-1",
      ),
    ).toMatchObject({
      occurredAt: T0,
      outcome: "failed",
      reason: "interrupted",
      wallTimeMs: 30 * MINUTE,
      researchArtifact: { truncated: false },
    });
    expect(
      events.flatMap((event) =>
        event.type === "discovery-run-started" ? [event.runKind] : [],
      ),
    ).toEqual(["explore", "child"]);
    expect(await leftovers(t.scratch)).toEqual({ markers: [], directories: 0 });

    const outcome = await executeTrialResume(
      {
        ...t.context,
        executor: {
          async execute(run) {
            return {
              receipt: createNativeRunReceipt({
                runId: run.runId,
                targetSnapshotDigest: run.targetSnapshotDigest,
                profile: run.profile,
                terminal: "incomplete",
                reason: "wall",
                startedAt: T0,
                completedAt: "2026-10-19T01:30:00.000Z",
              }),
            };
          },
        },
      },
      assessment.plan,
      {
        runId: "run-1-segment-1",
        targetSnapshotDigest: digest,
        profile,
        coordination: "cooperative",
        prompt,
        resumePrompt,
        sourceDirectory: "/private/frozen-source",
        sourceTree: { digest, entries: 1, bytes: 1 },
      },
    );
    expect(outcome.runId).toBe("run-1-segment-1");
    // Nothing is left unsettled, and the Trial is counted once.
    const trials = exploreTrials(t.ledger, {});
    expect(trials).toMatchObject({ started: 1, superseded: 0 });
    // The Trial ends as its latest segment ended.
    expect(trials.finished).toEqual(["failed"]);
    expect(t.ledger.funnel("campaign-1").discoveryAttempts).toBe(1);
  });

  it("refuses a live run and a run without leftovers, writing nothing", async () => {
    const t = await fixture();
    await t.recordStart("run-1");
    expect(await t.resumeFrom(DEAD_HOST, () => false)).toEqual({
      status: "refused",
      reason: "session-evidence-missing",
    });
    const u = await fixture();
    await u.startOnHostA();
    const before = u.ledger.readAll({}).length;
    expect(
      await u.resumeFrom({ pid: 5151, bootId: "boot-a" }, () => true),
    ).toEqual({ status: "refused", reason: "run-alive" });
    expect(t.ledger.readAll({}).length).toBe(1);
    expect(u.ledger.readAll({}).length).toBe(before);
  });

  it("refuses a run that a restarted campaign already ran again, and does not count it as unsettled", async () => {
    const t = await fixture();
    await t.startOnHostA();
    // The runner restarted the campaign and ran the target from scratch.
    await t.recordStart("run-2", "2026-10-19T01:00:00.000Z");
    const before = t.ledger.readAll({}).length;
    expect(await t.resumeFrom(DEAD_HOST, () => false)).toEqual({
      status: "refused",
      reason: "superseded",
      detail: "run-2",
    });
    expect(t.ledger.readAll({}).length).toBe(before);
    expect(exploreTrials(t.ledger, {})).toMatchObject({
      started: 2,
      finished: [],
      superseded: 1,
    });
    expect((await leftovers(t.scratch)).markers).toEqual(["run-1.json"]);
  });
});

describe("runner restart after the host died (ADR 0036, 2026-10-19 addendum 3)", () => {
  /** The restarted campaign: one planned Trial, and the runner's resume of a dead run. */
  const restart = (
    t: Awaited<ReturnType<typeof fixture>>,
    options: { readonly segment: "completed" | "wall"; readonly refuse?: true },
  ) => {
    const executed: string[] = [];
    const offered: string[] = [];
    const executor = {
      async execute(run: DiscoveryTransportRun) {
        executed.push(run.runId);
        const identity = {
          runId: run.runId,
          targetSnapshotDigest: run.targetSnapshotDigest,
          profile: run.profile,
          startedAt: T0,
          completedAt: "2026-10-19T01:30:00.000Z",
        };
        if (options.segment === "wall")
          return {
            receipt: createNativeRunReceipt({
              ...identity,
              terminal: "incomplete",
              reason: "wall",
            }),
          };
        const attachment = await t.context.attachments.put(
          "findings",
          Buffer.from(report),
        );
        return {
          attachment,
          receipt: createNativeRunReceipt({
            ...identity,
            terminal: "completed",
            reason: "unavailable",
            reportArtifactDigest: attachment.digest,
            observed: {
              toolCalls: 3,
              filesRead: 2,
              uniqueFilesRead: 2,
              labRequests: 0,
              dbQueries: 0,
            },
          }),
        };
      },
    };
    const run = async () =>
      runDiscoveryCampaign({
        ...t.context,
        plannedTrials: [
          {
            trialId: "run-new",
            trialOrdinal: 0,
            explore: {
              run: { ...t.run, runId: "run-new", expiresAt: T0 },
              configuration: {
                promptVariant: "wp2shell-bounty-v8",
                promptDigest,
              },
            },
          },
        ],
        executor,
        resumeInterrupted: async (started) => {
          offered.push(started.runId);
          if (options.refuse) return undefined;
          const assessment = await t.resumeFrom(DEAD_HOST, () => false);
          if (assessment.status !== "resumable") return undefined;
          return executeTrialResume(
            { ...t.context, executor },
            assessment.plan,
            { ...t.run, runId: "run-1-segment-1" },
          );
        },
      });
    return { run, executed, offered };
  };

  it("resumes the dead run in its target's slot instead of starting a new Trial", async () => {
    const t = await fixture();
    await t.startOnHostA();
    const runner = restart(t, { segment: "completed" });
    expect(await runner.run()).toMatchObject({
      runCount: 1,
      stoppedBy: "no-new-finding",
    });
    expect(runner.offered).toEqual(["run-1"]);
    expect(runner.executed).toEqual(["run-1-segment-1"]);
    const trials = exploreTrials(t.ledger, {});
    expect(trials).toMatchObject({ started: 1, superseded: 0 });
    expect(trials.finished).toEqual(["completed"]);
    expect(t.ledger.funnel("campaign-1").discoveryAttempts).toBe(1);
  });

  it("does not resume a segment that ended incomplete again", async () => {
    const t = await fixture();
    await t.startOnHostA();
    const runner = restart(t, { segment: "wall" });
    expect((await runner.run()).stoppedBy).toBe("incomplete");
    // The runner restarts once more: the segment has its finish, so nothing runs.
    expect(await runner.run()).toMatchObject({
      runCount: 0,
      stoppedBy: "incomplete",
    });
    expect(runner.offered).toEqual(["run-1"]);
    expect(runner.executed).toEqual(["run-1-segment-1"]);
  });

  it("falls back to a new Trial when the resume is refused", async () => {
    const t = await fixture();
    await t.startOnHostA();
    const runner = restart(t, { segment: "completed", refuse: true });
    expect((await runner.run()).runCount).toBe(1);
    expect(runner.executed).toEqual(["run-new"]);
    expect(exploreTrials(t.ledger, {})).toMatchObject({
      started: 2,
      superseded: 1,
    });
  });

  it("falls back after a refused interrupted run that already started a child", async () => {
    const t = await fixture();
    await t.startOnHostA();
    await t.ledger.append({
      schemaVersion: 1,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: T0,
      identity: "child-before-host-stop",
      type: "discovery-run-started",
      runId: "run-1-child",
      trialId: "run-1",
      trialOrdinal: 0,
      runKind: "child",
      parentRunId: "run-1",
      labAttached: false,
      history: { mode: "none" },
      configuration: { promptVariant: "wp2shell-bounty-v8" },
    });
    const runner = restart(t, { segment: "completed", refuse: true });
    expect((await runner.run()).runCount).toBe(1);
    expect(runner.executed).toEqual(["run-new"]);
  });
});

describe("the marker outlives the run until its finish is in the ledger (#512)", () => {
  const finishOf = (event: { type: string; runId?: string | undefined }) =>
    event.type === "discovery-run-finished" && event.runId === "run-1";

  it("still has the marker when the finish is appended, and removes it after", async () => {
    const t = await fixture();
    const append = t.ledger.append.bind(t.ledger);
    const atFinish: Awaited<ReturnType<typeof leftovers>>[] = [];
    vi.spyOn(t.ledger, "append").mockImplementation(async (event) => {
      if (finishOf(event)) atFinish.push(await leftovers(t.scratch));
      return append(event);
    });
    await t.executeOnHostA();
    expect(atFinish).toEqual([{ markers: ["run-1.json"], directories: 2 }]);
    expect(await leftovers(t.scratch)).toEqual({ markers: [], directories: 0 });
  });

  it("leaves the marker when the finish cannot be appended, and the run is later sealed as interrupted", async () => {
    const t = await fixture();
    const append = t.ledger.append.bind(t.ledger);
    let failed = false;
    vi.spyOn(t.ledger, "append").mockImplementation(async (event) => {
      if (finishOf(event) && !failed) {
        failed = true;
        throw new Error("database is locked");
      }
      return append(event);
    });
    await expect(t.executeOnHostA()).rejects.toThrow("database is locked");
    expect(await leftovers(t.scratch)).toEqual({
      markers: ["run-1.json"],
      directories: 2,
    });
    // Host A's process is gone; `campaign resume` in another process seals the run.
    const assessment = await t.resumeFrom(DEAD_HOST, () => false);
    expect(assessment).toMatchObject({
      status: "resumable",
      plan: { originalRunId: "run-1", resume: { threadId: ROOT_THREAD } },
    });
    expect(
      t.ledger
        .readAll({ campaignId: "campaign-1" })
        .map(({ event }) => event)
        .filter(finishOf),
    ).toMatchObject([{ outcome: "failed", reason: "interrupted" }]);
    expect(await leftovers(t.scratch)).toEqual({ markers: [], directories: 0 });
  });
});
