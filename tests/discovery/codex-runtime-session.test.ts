import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  CodexNativeAgentRuntime,
  defineAgentRuntimeProfile,
  PROVIDER_UPSTREAM_ORIGIN,
  providerCredentialEgressReceiptSchema,
  ProviderAttachmentStore,
  type CodexSandbox,
  type CodexSandboxCommand,
  type DiscoveryTransportRun,
  type ProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `node@${digest}`;
const now = "2026-10-19T00:00:00.000Z";
const later = "2026-10-19T01:05:00.000Z";
const ROOT_THREAD = "11111111-2222-4333-8444-555555555555";
const OLD_CHILD = "66666666-7777-4888-9999-000000000000";
const NEW_CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ROOT_PATH = "2026/10/19/rollout-2026-10-19T00-00-00-root.jsonl";
const OLD_CHILD_PATH = "2026/10/19/rollout-2026-10-19T00-01-00-old.jsonl";
const NEW_CHILD_PATH = "2026/10/19/rollout-2026-10-19T00-30-00-new.jsonl";
const profile = defineAgentRuntimeProfile({
  id: "cooperative",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "daybreak_blue",
  serviceTier: "priority",
  subagent: { modelId: "gpt-6-sol", effort: "high" },
});

const line = (event: unknown) => JSON.stringify(event);
const report = JSON.stringify({
  findings: [],
  leads: [],
  examined: "routes",
  unexamined: "none",
});
const rootRollout = [
  {
    timestamp: now,
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
  {
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: report },
  },
]
  .map(line)
  .join("\n");
const childRollout = (threadId: string, startedAt: string, agentPath: string) =>
  [
    {
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id: threadId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: ROOT_THREAD,
              depth: 1,
              agent_path: agentPath,
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
const transcript = [
  { type: "thread.started", thread_id: ROOT_THREAD },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: report } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
  { type: "thread.started", thread_id: ROOT_THREAD },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: report } },
  { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } },
]
  .map(line)
  .join("\n");

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
        startedAt: now,
        completedAt: now,
        setup: { status: "ready" as const },
        cleanup: { status: "completed" as const },
        isolation: {
          backend: "gvisor" as const,
          runtime: "runsc" as const,
          fallbackUsed: false as const,
          agentNetworkInternal: true as const,
        },
      };
      const receipt = providerCredentialEgressReceiptSchema.parse({
        ...body,
        digest: canonicalDigest(body),
      });
      const value = await operation({
        baseUrl: "http://127.0.0.1:8080",
        authorization: `Bearer ${randomBytes(32).toString("hex")}`,
        dockerNetworkName: "internal-run",
        model: request.model,
        protocol: request.protocol,
        expiresAt: request.expiresAt,
      });
      return { operation: { status: "completed", value }, receipt };
    },
  };
}

function sandbox(
  commands: CodexSandboxCommand[],
  rollouts: readonly { path: string; raw: string }[],
): CodexSandbox {
  return {
    async execute(command) {
      commands.push(command);
      return {
        status: "exited",
        exitCode: 0,
        stdout: transcript,
        startedAt: now,
        completedAt: later,
        image,
        cliVersion: "0.161.0",
        bundledCatalogDigest: digest,
        rollouts: rollouts.map((entry) => entry.raw),
        rolloutPaths: rollouts.map((entry) => entry.path),
        research: {
          archive: Buffer.from(
            JSON.stringify({
              kind: "research-directory-archive",
              schemaVersion: 1,
              truncated: false,
              collectedBytes: 0,
              entries: [],
            }),
          ),
          truncated: false,
        },
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
      };
    },
  };
}

const prompt = "Objective.\n\nBefore giving up, keep exploring.";
const run: DiscoveryTransportRun = {
  runId: "run-1",
  targetSnapshotDigest: digest,
  profile,
  coordination: "cooperative",
  prompt,
  minimumActiveMs: 60 * 60_000,
  resumePrompt: "Before giving up, keep exploring.",
  sourceDirectory: "/private/frozen-source",
  sourceTree: { digest, entries: 1, bytes: 1 },
  campaignInput: {
    schemaVersion: 1,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "Untrusted request" },
    programmeBoundary: { version: "v1", text: "Low privilege" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: { maxRuns: 1, noFindingRuns: 1 },
    lab: { mode: "none" },
    history: { mode: "none" },
  },
  expiresAt: "2026-10-19T02:00:00.000Z",
};

describe("receipt session record (ADR 0036)", () => {
  it("names the Root thread, its turns and every session file with its sealed digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-session-"));
    try {
      const attachments = new ProviderAttachmentStore(root);
      const commands: CodexSandboxCommand[] = [];
      const result = await new CodexNativeAgentRuntime(
        sandbox(commands, [
          { path: ROOT_PATH, raw: rootRollout },
          {
            path: OLD_CHILD_PATH,
            raw: childRollout(
              OLD_CHILD,
              "2026-10-19T00:01:00Z",
              "/root/child_1",
            ),
          },
        ]),
        broker(),
        attachments,
        image,
        () => new Date(now),
      ).execute(run);
      expect(result.receipt.terminal).toBe("completed");
      expect(result.receipt.childThreadsObserved).toBe(1);
      expect(result.agentRuns).toHaveLength(1);
      const session = result.receipt.session;
      expect(session).toMatchObject({
        rootThreadId: ROOT_THREAD,
        rootTurns: 2,
        segment: 0,
      });
      expect(
        session?.files.map((file) => [file.kind, file.path, file.threadId]),
      ).toEqual([
        ["root", ROOT_PATH, ROOT_THREAD],
        ["child", OLD_CHILD_PATH, OLD_CHILD],
      ]);
      expect(session?.files[0]?.diagnosticArtifactDigest).toBe(
        result.receipt.diagnosticArtifactDigest,
      );
      expect(session?.files[1]?.diagnosticArtifactDigest).toBe(
        result.agentRuns?.[0]?.receipt.diagnosticArtifactDigest,
      );
      // Every listed file is readable back from Private Evidence.
      for (const file of session?.files ?? [])
        expect(
          (
            await attachments.readByDigest(
              "diagnostic",
              file.diagnosticArtifactDigest,
            )
          ).status,
        ).toBe("resolved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits the session when the sandbox reports no file paths, so old-style evidence is not resumable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-session-nopaths-"));
    try {
      const pathless: CodexSandbox = {
        async execute(command) {
          const inner = await sandbox(
            [],
            [{ path: ROOT_PATH, raw: rootRollout }],
          ).execute(command);
          const { rolloutPaths: _paths, ...rest } = inner;
          return rest;
        },
      };
      const result = await new CodexNativeAgentRuntime(
        pathless,
        broker(),
        new ProviderAttachmentStore(root),
        image,
        () => new Date(now),
      ).execute(run);
      expect(result.receipt.terminal).toBe("completed");
      expect(result.receipt.session).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("on a resumed segment seeds the sandbox, skips children earlier segments recorded and carries them forward", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-session-resume-"));
    try {
      const attachments = new ProviderAttachmentStore(root);
      const oldChildRaw = childRollout(
        OLD_CHILD,
        "2026-10-19T00:01:00Z",
        "/root/child_1",
      );
      const priorChildDigest = `sha256:${"d".repeat(64)}`;
      const commands: CodexSandboxCommand[] = [];
      const result = await new CodexNativeAgentRuntime(
        sandbox(commands, [
          {
            path: ROOT_PATH,
            raw: `${rootRollout}\n${line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: report } })}`,
          },
          { path: OLD_CHILD_PATH, raw: oldChildRaw },
          {
            path: NEW_CHILD_PATH,
            raw: childRollout(
              NEW_CHILD,
              "2026-10-19T00:30:00Z",
              "/root/child_2",
            ),
          },
        ]),
        broker(),
        attachments,
        image,
        () => new Date(now),
      ).execute({
        ...run,
        runId: "run-1-segment-1",
        minimumActiveMs: 35 * 60_000,
        resume: {
          threadId: ROOT_THREAD,
          segment: 1,
          sessions: [
            {
              path: ROOT_PATH,
              threadId: ROOT_THREAD,
              kind: "root",
              diagnosticArtifactDigest: `sha256:${"e".repeat(64)}`,
              content: rootRollout,
            },
            {
              path: OLD_CHILD_PATH,
              threadId: OLD_CHILD,
              kind: "child",
              diagnosticArtifactDigest: priorChildDigest,
              content: oldChildRaw,
            },
          ],
          research: [
            {
              path: "notes/plan.md",
              contentBase64: Buffer.from("plan\n").toString("base64"),
            },
          ],
        },
      });
      // The sandbox was asked to restore the files and start on the thread.
      expect(commands[0]?.resume).toMatchObject({
        threadId: ROOT_THREAD,
        sessions: [{ path: ROOT_PATH }, { path: OLD_CHILD_PATH }],
      });
      expect(commands[0]?.resume?.research[0]?.content.toString("utf8")).toBe(
        "plan\n",
      );
      expect(commands[0]?.minimumActiveMs).toBe(35 * 60_000);
      // Only the new child is a child of this segment.
      expect(result.receipt.terminal).toBe("completed");
      expect(result.receipt.childThreadsObserved).toBe(1);
      expect(
        result.agentRuns?.map((agentRun) => agentRun.receipt.runId),
      ).toEqual([NEW_CHILD]);
      expect(result.receipt.session).toMatchObject({
        rootThreadId: ROOT_THREAD,
        segment: 1,
      });
      expect(
        result.receipt.session?.files.map((file) => [file.kind, file.threadId]),
      ).toEqual([
        ["root", ROOT_THREAD],
        ["child", OLD_CHILD],
        ["child", NEW_CHILD],
      ]);
      // The earlier child's digest is the one its own segment sealed.
      expect(result.receipt.session?.files[1]?.diagnosticArtifactDigest).toBe(
        priorChildDigest,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not admit a resume without the minimum-active runner or without the thread's Root file", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-session-inadmissible-"));
    try {
      const runtime = new CodexNativeAgentRuntime(
        sandbox([], [{ path: ROOT_PATH, raw: rootRollout }]),
        broker(),
        new ProviderAttachmentStore(root),
        image,
        () => new Date(now),
      );
      const resume = {
        threadId: ROOT_THREAD,
        segment: 1,
        sessions: [
          {
            path: OLD_CHILD_PATH,
            threadId: OLD_CHILD,
            kind: "child" as const,
            diagnosticArtifactDigest: digest,
            content: "x",
          },
        ],
        research: [],
      };
      const withoutRoot = await runtime.execute({ ...run, resume });
      expect(withoutRoot.receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
      const { minimumActiveMs: _minimum, resumePrompt: _resume, ...bare } = run;
      const withoutRunner = await runtime.execute({
        ...bare,
        resume: {
          ...resume,
          sessions: [
            {
              path: ROOT_PATH,
              threadId: ROOT_THREAD,
              kind: "root",
              diagnosticArtifactDigest: digest,
              content: rootRollout,
            },
          ],
        },
      });
      expect(withoutRunner.receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
