import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  ANTHROPIC_UPSTREAM_ORIGIN,
  ClaudeOneShotRuntime,
  ClaudeSandboxNotAdmittedError,
  defineAgentRuntimeProfile,
  defineClaudeRuntimeProfile,
  ProviderAttachmentStore,
  providerCredentialEgressReceiptSchema,
  scriptRanIn,
  type ClaudeSandbox,
  type ClaudeSandboxCommand,
  type ClaudeSandboxResult,
  type OneShotRun,
  type ProviderCredentialEgressBroker,
  type ProviderCredentialEgressGrantRequest,
} from "../../src/discovery/index.js";
import { wordPressLabCommandRule } from "../../src/profiles/wordpress/discovery/lab-commands.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `claude@${digest}`;
const start = "2026-10-28T00:00:00.000Z";
const end = "2026-10-28T00:15:00.000Z";
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
const run = (output: "files" | "report"): OneShotRun => ({
  runId: `run-${output}`,
  targetSnapshotDigest: digest,
  profile,
  prompt: "Role body.",
  inputFiles: [{ name: "partition.json", content: "{}" }],
  toolFiles: [{ name: "tool.sh", content: Buffer.from("#!/bin/sh\n") }],
  output,
  wallMs: 20 * 60_000,
  expiresAt: "2026-10-28T01:00:00.000Z",
  sourceDirectory: "/private/source",
  sourceTree: { digest, entries: 1, bytes: 1 },
});

const lines = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const assistant = (name: string, input: unknown) => ({
  type: "assistant",
  session_id: "s1",
  message: {
    id: "m1",
    model: "claude-opus-5-5",
    usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
    content: [{ type: "tool_use", name, input }],
  },
});
const report = {
  findings: [JSON.stringify({ claim: "one" })],
  leads: [],
  examined: "partition",
  unexamined: "none",
};
const stdout = (toolUse: unknown, structured?: unknown) =>
  lines(
    {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-opus-5-5",
    },
    toolUse,
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      ...(structured === undefined ? {} : { structured_output: structured }),
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        output_tokens: 5,
      },
    },
    { type: "harness.turn", at: end, turn: 1, sessionId: "s1" },
  );

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
          forwardedRequests: 12,
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
  out: string,
  overrides: Partial<ClaudeSandboxResult> = {},
  options: {
    readonly noOutputFiles?: boolean;
    readonly noResearch?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "claude-one-shot-"));
  directories.push(root);
  const commands: ClaudeSandboxCommand[] = [];
  const requests: ProviderCredentialEgressGrantRequest[] = [];
  const sandbox: ClaudeSandbox = {
    async execute(command) {
      commands.push(command);
      return {
        status: "exited",
        exitCode: 0,
        stdout: out,
        startedAt: start,
        completedAt: end,
        image,
        cliVersion: "2.1.296",
        transcripts: [{ path: "-workspace-main/s1.jsonl", content: out }],
        ...(options.noResearch
          ? {}
          : { research: { archive: Buffer.from("{}"), truncated: false } }),
        ...(options.noOutputFiles ? {} : { outputFiles: [] }),
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
        ...overrides,
      };
    },
  };
  const attachments = new ProviderAttachmentStore(root);
  return {
    runtime: new ClaudeOneShotRuntime(
      sandbox,
      broker(requests),
      attachments,
      image,
      wordPressLabCommandRule,
      () => new Date(start),
    ),
    commands,
    requests,
  };
}

describe("Claude one-shot runtime (ADR 0042)", () => {
  it("rejects an unsupported Lab before requesting a grant", async () => {
    const { runtime: oneShot, requests } = await runtime("");
    const result = await oneShot.execute({
      ...run("files"),
      lab: {
        endpoint: "http://wordpress",
        networkName: "lab-internal",
        internalIp: "172.20.0.2",
        labJson: "{}",
        administratorExpiresAt: end,
        outputFileNames: [],
        async closeSetup() {
          return "{}";
        },
      },
    });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
    });
    expect(requests).toHaveLength(0);
  });
  it("runs one turn without children, mounts the files and reads the output files of an enumerator", async () => {
    const {
      runtime: oneShot,
      commands,
      requests,
    } = await runtime(
      stdout(
        assistant("Bash", {
          command: "bash /workspace/tools/tool.sh /workspace/main",
        }),
      ),
      {
        outputFiles: [{ name: "inventory.json", content: '{"rows":[]}' }],
      },
    );
    const result = await oneShot.execute(run("files"));
    expect(result.receipt).toMatchObject({
      runId: "run-files",
      terminal: "completed",
      reason: "unavailable",
      childThreadsObserved: 0,
      childThreadsAdmitted: 0,
      agentRole: "root",
      usage: { inputTokens: 10, cachedInputTokens: 100, outputTokens: 5 },
    });
    expect(result.scriptRan).toBe(true);
    expect(result.outputFiles).toEqual([
      { name: "inventory.json", content: '{"rows":[]}' },
    ]);
    expect(result.attachment).toBeUndefined();
    expect(result.researchArchive?.toString()).toBe("{}");
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.input).toEqual({
      prompt: "Role body.",
      minimumActiveMs: 0,
      maxChildren: 0,
      model: "claude-opus-5-5",
      effort: "high",
      oneShot: true,
    });
    expect(command.oneShot).toMatchObject({
      wallMs: 20 * 60_000,
      inputFiles: [{ name: "partition.json" }],
      toolFiles: [{ name: "tool.sh" }],
    });
    expect(command.resume).toBeUndefined();
    expect(requests[0]).toMatchObject({
      model: "claude-opus-5-5",
      protocol: "anthropic-messages",
      expiresAt: "2026-10-28T01:00:00.000Z",
    });
    expect(requests[0]).not.toHaveProperty("agentNetworkName");
  });

  it("seals a tracer's final message as the report and observes that no tool script ran", async () => {
    const { runtime: oneShot, commands } = await runtime(
      stdout(
        assistant("Read", { file_path: "/workspace/tools/tool.sh" }),
        report,
      ),
    );
    const result = await oneShot.execute(run("report"));
    expect(result.scriptRan).toBe(false);
    expect(result.attachment?.kind).toBe("findings");
    expect(result.receipt).toMatchObject({
      terminal: "completed",
      reportArtifactDigest: result.attachment?.digest,
      observed: { toolCalls: 1, filesRead: 0 },
    });
    expect(result.outputFiles).toBeUndefined();
    expect(commands[0]!.input.outputSchema).toBeDefined();
  });

  it("ends a tracer without a readable report as incomplete(schema) and a lost output capture as incomplete(evidence)", async () => {
    const noReport = await runtime(
      stdout(assistant("Read", { file_path: "x" })),
    );
    expect(
      (await noReport.runtime.execute(run("report"))).receipt,
    ).toMatchObject({
      terminal: "incomplete",
      reason: "schema",
      reasonDetail: "report-unreadable",
    });
    const lost = await runtime(
      stdout(assistant("Read", { file_path: "x" })),
      { outputFailure: "capture-failed" },
      { noOutputFiles: true },
    );
    expect((await lost.runtime.execute(run("files"))).receipt).toMatchObject({
      terminal: "incomplete",
      reason: "evidence",
      reasonDetail: "output-capture-failed",
    });
    const lostResearch = await runtime(
      stdout(assistant("Read", { file_path: "x" })),
      { researchFailure: "capture-failed" },
      { noResearch: true },
    );
    const lostResearchResult = await lostResearch.runtime.execute(run("files"));
    expect(lostResearchResult.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "evidence",
      reasonDetail: "research-capture-failed",
    });
    expect(lostResearchResult.researchArchive).toBeUndefined();
    expect(lostResearchResult.outputFiles).toEqual([]);
    const timedOut = await runtime(
      stdout(assistant("Read", { file_path: "x" })),
      {
        status: "failed",
        exitCode: -1,
        failureKind: "timed-out",
      },
    );
    expect(
      (await timedOut.runtime.execute(run("files"))).receipt,
    ).toMatchObject({ terminal: "incomplete", reason: "wall" });
  });

  it("refuses a Codex profile before any grant", async () => {
    const { runtime: oneShot, requests } = await runtime("");
    const codex = defineAgentRuntimeProfile({
      id: "codex",
      transportKind: "codex-native/v1",
      sandboxImageDigest: digest,
      requestedModelId: "gpt-6-sol",
      requestedEffort: "high",
      codexCliVersion: "0.161.0",
      bundledCatalogDigest: digest,
      authenticationMethod: "unavailable",
      cyberAccessProgram: "unavailable",
      serviceTier: "unavailable",
      subagent: { modelId: "unavailable", effort: "unavailable" },
    });
    const result = await oneShot.execute({ ...run("files"), profile: codex });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
      reasonDetail: "claude-run-not-admitted",
    });
    expect(requests).toEqual([]);
  });

  it("ends a command the sandbox refuses as policy, not as a broker failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-one-shot-refused-"));
    directories.push(root);
    const requests: ProviderCredentialEgressGrantRequest[] = [];
    const refusing: ClaudeSandbox = {
      execute: () => Promise.reject(new ClaudeSandboxNotAdmittedError()),
    };
    const oneShot = new ClaudeOneShotRuntime(
      refusing,
      broker(requests),
      new ProviderAttachmentStore(root),
      image,
      wordPressLabCommandRule,
      () => new Date(start),
    );
    const result = await oneShot.execute(run("files"));
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
      reasonDetail: "claude-run-not-admitted",
    });
    expect(requests).toHaveLength(1);
    // The same refusal reported through a broker that caught the throw.
    const caught: ProviderCredentialEgressBroker = {
      async withGrant(request, operation) {
        const inner = await broker(requests).withGrant(request, async (grant) =>
          operation(grant).then(
            (value) => ({ status: "completed" as const, value }),
            (error: unknown) => ({ status: "failed" as const, error }),
          ),
        );
        if (inner.operation.status !== "completed")
          throw new Error("unreachable");
        return { operation: inner.operation.value, receipt: inner.receipt };
      },
    };
    const viaBroker = new ClaudeOneShotRuntime(
      refusing,
      caught,
      new ProviderAttachmentStore(root),
      image,
      wordPressLabCommandRule,
      () => new Date(start),
    );
    expect((await viaBroker.execute(run("files"))).receipt).toMatchObject({
      reason: "policy",
      reasonDetail: "claude-run-not-admitted",
    });
  });

  it("detects a script run from Bash tool calls only", () => {
    expect(
      scriptRanIn([
        assistant("Bash", { command: "ls /workspace/main" }),
        assistant("Read", { file_path: "/workspace/tools/tool.sh" }),
      ]),
    ).toBe(false);
    expect(
      scriptRanIn([
        assistant("Bash", { command: "sh /workspace/tools/tool.sh ." }),
      ]),
    ).toBe(true);
  });
});
