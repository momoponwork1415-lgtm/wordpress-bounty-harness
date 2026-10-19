import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  ANTHROPIC_UPSTREAM_ORIGIN,
  ClaudeNativeAgentRuntime,
  claudeProviderFailure,
  defineAgentRuntimeProfile,
  defineClaudeRuntimeProfile,
  ProviderAttachmentStore,
  providerCredentialEgressReceiptSchema,
  type ClaudeSandbox,
  type ClaudeSandboxCommand,
  type ClaudeSandboxResult,
  type DiscoveryTransportRun,
  type ProviderCredentialEgressBroker,
  type ProviderCredentialEgressGrantRequest,
} from "../../src/discovery/index.js";
import { reportJsonSchema } from "../../src/discovery/codex-native-agent-runtime.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `claude@${digest}`;
const start = "2026-10-19T00:00:00.000Z";
const end = "2026-10-19T01:05:00.000Z";
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
const resumePrompt = "Before giving up, keep exploring.";
const run: DiscoveryTransportRun = {
  runId: "run-claude",
  targetSnapshotDigest: digest,
  profile,
  coordination: "cooperative",
  prompt: `Objective.\n\n${resumePrompt}`,
  minimumActiveMs: 60 * 60_000,
  resumePrompt,
  sourceDirectory: "/private/source",
  sourceTree: { digest, entries: 1, bytes: 1 },
  campaignInput: {
    schemaVersion: 1,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "t" },
    programmeBoundary: { version: "v1", text: "p" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: { maxRuns: 1, noFindingRuns: 1 },
    lab: { mode: "none" },
    history: { mode: "none" },
  },
  expiresAt: "2026-10-19T02:00:00.000Z",
};

const report = (findings: unknown[]) => ({
  findings: findings.map((finding) => JSON.stringify(finding)),
  leads: [],
  examined: "source",
  unexamined: "none",
});
const lines = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const turn = (findings: unknown[]) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: report(findings),
  usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
});
const readTool = {
  type: "assistant",
  message: {
    id: "m1",
    model: "claude-opus-5-5",
    content: [
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/workspace/main/a.php" },
      },
    ],
  },
};
const childTranscript = (model = "claude-opus-5-5") =>
  lines(
    { type: "user", timestamp: start, message: { content: "Look at a.php" } },
    {
      type: "assistant",
      timestamp: end,
      message: {
        id: "c1",
        model,
        usage: { input_tokens: 3, output_tokens: 2 },
        content: [
          { type: "text", text: JSON.stringify(report([{ claim: "child" }])) },
        ],
      },
    },
  );
const jsonLast = (text: string) =>
  JSON.parse(text.trimEnd().split("\n").at(-1)!) as unknown;
const childEvents = [
  {
    type: "harness.child-start",
    agentId: "agent1",
    agentType: "general-purpose",
  },
  {
    type: "harness.child-stop",
    agentId: "agent1",
    transcriptPath:
      "/tmp/claude/projects/-workspace-main/s1/subagents/agent-agent1.jsonl",
  },
];

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function broker(
  requests: ProviderCredentialEgressGrantRequest[],
): ProviderCredentialEgressBroker {
  return {
    async withGrant(request, operation) {
      requests.push(request);
      const body = {
        schemaVersion: 1 as const,
        grantId: "grant-1",
        runtimeProfileDigest: request.runtimeProfileDigest,
        brokerImage: `broker@${digest}`,
        upstreamOrigin: ANTHROPIC_UPSTREAM_ORIGIN,
        model: request.model,
        protocol: request.protocol,
        maxRequests: request.maxRequests,
        maxRequestBytes: request.maxRequestBytes,
        maxResponseBytes: request.maxResponseBytes,
        expiresAt: request.expiresAt,
        startedAt: start,
        completedAt: end,
        setup: { status: "ready" as const },
        cleanup: { status: "completed" as const },
        metrics: {
          forwardedRequests: 40,
          requestLimitExceeded: 0,
          unauthorizedRequests: 0,
        },
        isolation: {
          backend: "gvisor" as const,
          runtime: "runsc" as const,
          fallbackUsed: false as const,
          agentNetworkInternal: true as const,
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
}

async function runtime(
  stdout: string,
  overrides: Partial<ClaudeSandboxResult> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "claude-runtime-"));
  directories.push(root);
  const commands: ClaudeSandboxCommand[] = [];
  const requests: ProviderCredentialEgressGrantRequest[] = [];
  const sandbox: ClaudeSandbox = {
    async execute(command) {
      commands.push(command);
      return {
        status: "exited",
        exitCode: 0,
        stdout,
        startedAt: start,
        completedAt: end,
        image,
        cliVersion: "2.1.296",
        transcripts: [
          {
            path: "-workspace-main/s1/subagents/agent-agent1.jsonl",
            content: childTranscript(),
          },
        ],
        research: { archive: Buffer.from("{}"), truncated: false },
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
        ...overrides,
      };
    },
  };
  const attachments = new ProviderAttachmentStore(root);
  return {
    runtime: new ClaudeNativeAgentRuntime(
      sandbox,
      broker(requests),
      attachments,
      image,
      () => new Date(start),
    ),
    commands,
    requests,
    attachments,
  };
}

describe("Claude native agent runtime", () => {
  it("completes a Trial with merged Root turns and an independent child report", async () => {
    const {
      runtime: claude,
      commands,
      requests,
      attachments,
    } = await runtime(
      lines(
        readTool,
        turn([{ claim: "first" }]),
        ...childEvents,
        turn([{ claim: "second" }]),
      ),
    );
    const result = await claude.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "completed",
      claudeCliVersion: "2.1.296",
      usage: { inputTokens: 20, cachedInputTokens: 200, outputTokens: 10 },
      observed: { filesRead: 1, uniqueFilesRead: 1 },
      childThreadsObserved: 1,
      childThreadsAdmitted: 1,
    });
    const stored = await attachments.readByDigest(
      "findings",
      result.attachment!.digest,
    );
    if (stored.status !== "resolved")
      throw new Error("Root report was not stored");
    const root = JSON.parse(stored.bytes.toString()) as { findings: unknown[] };
    expect(root.findings.map((finding) => JSON.parse(String(finding)))).toEqual(
      [{ claim: "first" }, { claim: "second" }],
    );
    expect(result.agentRuns?.[0]?.receipt).toMatchObject({
      terminal: "completed",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    // Agent-facing text is the Codex path's: same prompt, directive and schema.
    expect(commands[0]?.input).toEqual({
      prompt: run.prompt,
      resumePrompt,
      minimumActiveMs: run.minimumActiveMs,
      model: "claude-opus-5-5",
      effort: "high",
      outputSchema: reportJsonSchema,
    });
    expect(requests[0]).toMatchObject({
      protocol: "anthropic-messages",
      model: "claude-opus-5-5",
    });
  });

  it("records a provider refusal as a provider stop without a usage limit and keeps earlier turns", async () => {
    const { runtime: claude } = await runtime(
      lines(
        turn([{ claim: "kept" }]),
        {
          type: "assistant",
          message: {
            id: "m2",
            model: "claude-opus-5-5",
            stop_reason: "refusal",
            content: [],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "refused",
        },
      ),
      { exitCode: 3 },
    );
    const result = await claude.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-refusal",
    });
    expect(result.receipt.providerLimit).toBeUndefined();
    expect(result.receipt.reportArtifactDigest).toBe(result.attachment?.digest);
  });

  it("records the broker's 403 after a refused turn as the refusal, for the Root and a child", async () => {
    // Shaped on the 2026-10-19 Opus Trial: the refused turn is only in the
    // session files, and Claude Code's retry on another model comes back as
    // "Failed to authenticate" with the broker's model-not-admitted.
    const notAdmitted =
      'Failed to authenticate. API Error: 403 {"error":{"reason":"model-not-admitted"}}';
    const synthetic = {
      type: "assistant",
      error: "authentication_failed",
      isApiErrorMessage: true,
      message: {
        model: "<synthetic>",
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: notAdmitted }],
      },
    };
    const refused = {
      type: "assistant",
      message: {
        id: "r1",
        model: "claude-opus-5-5",
        stop_reason: "refusal",
        content: [{ type: "thinking" }],
      },
    };
    const rootSession = lines(
      { type: "user", message: { content: "Objective." } },
      refused,
      { type: "user", message: { content: "Continue." } },
      {
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        originalModel: "claude-opus-5-5",
        fallbackModel: "another-model",
      },
      synthetic,
    );
    const { runtime: claude } = await runtime(
      lines(
        { type: "system", subtype: "init", session_id: "s1" },
        readTool,
        ...childEvents,
        { ...readTool, message: { ...readTool.message, id: "m3" } },
        synthetic,
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 403,
          terminal_reason: "api_error",
          result: notAdmitted,
        },
        { type: "harness.runner-error", message: notAdmitted },
      ),
      {
        exitCode: 1,
        transcripts: [
          { path: "-workspace-main/s1.jsonl", content: rootSession },
          {
            path: "-workspace-main/s1/subagents/agent-agent1.jsonl",
            content: lines(
              { type: "user", message: { content: "Look at a.php" } },
              refused,
              synthetic,
            ),
          },
        ],
      },
    );
    const result = await claude.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-refusal",
    });
    expect(result.receipt.providerLimit).toBeUndefined();
    expect(result.agentRuns?.[0]?.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-refusal",
    });

    // Without a refused turn, the same 403 is the broker's model binding.
    expect(claudeProviderFailure([synthetic])).toEqual({
      reason: "policy",
      detail: "model-not-admitted",
    });
    // A refusal Claude Code retried on the same model and recovered from is not a stop.
    expect(
      claudeProviderFailure([
        refused,
        {
          ...readTool,
          message: { ...readTool.message, stop_reason: "tool_use" },
        },
      ]),
    ).toBeUndefined();
  });

  it("keeps a genuine authentication failure as provider-authentication", async () => {
    const failure =
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}';
    const { runtime: claude } = await runtime(
      lines(
        { type: "system", subtype: "init", session_id: "s1" },
        readTool,
        {
          type: "assistant",
          error: "authentication_failed",
          message: {
            model: "<synthetic>",
            content: [{ type: "text", text: failure }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: failure,
        },
      ),
      {
        exitCode: 1,
        transcripts: [
          {
            path: "-workspace-main/s1.jsonl",
            content: lines(readTool),
          },
        ],
      },
    );
    expect((await claude.execute(run)).receipt).toMatchObject({
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "provider-authentication",
    });
  });

  it("maps rate limits and subscription usage limits onto the provider limits the runner backs off on", async () => {
    const synthetic = (text: string) => ({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text }] },
    });
    for (const [text, limit] of [
      ["API Error: 429 rate_limit_error", "rate-limit"],
      ["API Error: Repeated 529 Overloaded errors", "rate-limit"],
      ["Claude AI usage limit reached|1760000000", "quota"],
    ] as const) {
      const { runtime: claude } = await runtime(lines(synthetic(text)), {
        exitCode: 3,
      });
      expect((await claude.execute(run)).receipt).toMatchObject({
        reason: "provider",
        providerLimit: limit,
      });
    }
    // The agent's own prose about a plugin's rate limit is not a provider failure.
    expect(
      claudeProviderFailure([
        {
          type: "assistant",
          message: {
            model: "claude-opus-5-5",
            content: [
              { type: "text", text: "The rate limit check returns 429" },
            ],
          },
        },
      ]),
    ).toBeUndefined();
  });

  it("refuses a Codex profile and a child that ran on another model", async () => {
    const codex = defineAgentRuntimeProfile({
      id: "codex",
      transportKind: "codex-native/v1",
      sandboxImageDigest: digest,
      requestedModelId: "gpt-6-sol",
      requestedEffort: "high",
      codexCliVersion: "0.161.0",
      bundledCatalogDigest: digest,
      authenticationMethod: "chatgpt-oauth-host",
      cyberAccessProgram: "daybreak_blue",
      serviceTier: "unavailable",
      subagent: { modelId: "gpt-6-sol", effort: "high" },
    });
    const { runtime: claude, commands } = await runtime(lines(turn([])));
    expect(
      (
        await claude.execute({
          ...run,
          profile: codex,
          campaignInput: {
            ...run.campaignInput,
            modelProfileDigest: codex.digest,
          },
        })
      ).receipt,
    ).toMatchObject({
      reason: "policy",
      reasonDetail: "claude-run-not-admitted",
    });
    expect(commands).toHaveLength(0);

    const mixed = await runtime(lines(...childEvents, turn([])), {
      transcripts: [
        {
          path: "-workspace-main/s1/subagents/agent-agent1.jsonl",
          content: childTranscript("claude-haiku-4-5"),
        },
      ],
    });
    expect(
      (await mixed.runtime.execute(run)).agentRuns?.[0]?.receipt,
    ).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
      reasonDetail: "child-profile-mismatch",
    });
  });

  it("keeps a child's report and every transcript when the wall stops the Trial before SubagentStop", async () => {
    const rootTranscript = lines({
      type: "user",
      timestamp: start,
      message: { content: "Objective." },
    });
    const { runtime: claude, attachments } = await runtime(
      // The child started, but the wall came before its stop event.
      lines(turn([{ claim: "root" }]), childEvents[0]),
      {
        status: "failed",
        exitCode: -1,
        failureKind: "timed-out",
        transcripts: [
          { path: "-workspace-main/s1.jsonl", content: rootTranscript },
          {
            path: "-workspace-main/s1/subagents/agent-agent1.jsonl",
            content: childTranscript(),
          },
        ],
      },
    );
    const result = await claude.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "wall",
      childThreadsObserved: 1,
      childThreadsAdmitted: 1,
    });
    expect(result.attachment).toBeDefined();
    const child = result.agentRuns?.[0];
    expect(child?.agentPath).toBe("/root/agent1");
    expect(child?.receipt).toMatchObject({ terminal: "completed" });
    const stored = await attachments.readByDigest(
      "findings",
      child!.attachment!.digest,
    );
    if (stored.status !== "resolved") throw new Error("child report missing");
    expect(
      (
        JSON.parse(stored.bytes.toString()) as { findings: string[] }
      ).findings.map((finding) => JSON.parse(finding) as unknown),
    ).toEqual([{ claim: "child" }]);
    // The Root diagnostic names every sealed transcript, Root included.
    const diagnostic = await attachments.readByDigest(
      "diagnostic",
      result.receipt.diagnosticArtifactDigest,
    );
    if (diagnostic.status !== "resolved") throw new Error("diagnostic missing");
    const listed = jsonLast(diagnostic.bytes.toString()) as {
      files: { path: string; digest: string }[];
    };
    expect(listed.files.map(({ path }) => path)).toEqual([
      "-workspace-main/s1.jsonl",
      "-workspace-main/s1/subagents/agent-agent1.jsonl",
    ]);
    const root = await attachments.readByDigest(
      "diagnostic",
      listed.files[0]!.digest,
    );
    expect(root.status === "resolved" && root.bytes.toString()).toBe(
      rootTranscript,
    );
  });

  it("does not accept a final report before the active wall floor", async () => {
    const { runtime: claude } = await runtime(lines(turn([])), {
      completedAt: "2026-10-19T00:10:00.000Z",
    });
    expect((await claude.execute(run)).receipt).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
      reasonDetail: "early-final-before-minimum",
    });
  });
});
