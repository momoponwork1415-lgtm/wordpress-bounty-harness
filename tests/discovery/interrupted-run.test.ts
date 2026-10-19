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

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexNativeAgentRuntime,
  defineAgentRuntimeProfile,
  GvisorCodexSandbox,
  PROVIDER_UPSTREAM_ORIGIN,
  ProviderAttachmentStore,
  providerCredentialEgressReceiptSchema,
  type DiscoveryTransportRun,
  type ProviderCredentialEgressBroker,
  type SandboxOwner,
} from "../../src/discovery/index.js";
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
  /** A sandbox of the process `owner` on its boot; `alive` answers for other pids. */
  const sandbox = (owner: SandboxOwner, alive: (pid: number) => boolean) => {
    let containerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      containerStarted = resolve;
    });
    const instance = new GvisorCodexSandbox({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      bundledCatalogPath: "/opt/codex/model-catalog.json",
      scratchRootDirectory: scratch,
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
  /** Host A starts run-1 and keeps it running; the test then treats host A as dead. */
  const startOnHostA = async (runProfile = profile) => {
    await recordStart("run-1");
    const hostA = sandbox({ pid: 4242, bootId: "boot-a" }, () => true);
    const controller = new AbortController();
    const running = new CodexNativeAgentRuntime(
      hostA.instance,
      broker(),
      attachments,
      image,
      () => new Date(T0),
    ).execute(
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
  return {
    scratch,
    ledger,
    evidence,
    context,
    recordStart,
    startOnHostA,
    recover,
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
  it("names the running run in a marker, and the run's own end removes it", async () => {
    const t = await fixture();
    const stop = await t.startOnHostA();
    expect(await leftovers(t.scratch)).toEqual({
      markers: ["run-1.json"],
      directories: 3,
    });
    await stop();
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
