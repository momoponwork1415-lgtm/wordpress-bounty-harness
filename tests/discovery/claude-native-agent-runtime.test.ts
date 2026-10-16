import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClaudeNativeAgentRuntime,
  defineClaudeRuntimeProfile,
  ProviderAttachmentStore,
  type ProviderCredentialEgressBroker,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `claude@${digest}`;
const now = "2026-10-14T00:00:00.000Z";
const profile = defineClaudeRuntimeProfile(
  {
    id: "claude-opus-55",
    requestedModelId: "claude-opus-5-5",
    requestedEffort: "high",
    claudeCliVersion: "2.1.296",
    authenticationMethod: "anthropic-api-key-host",
    cyberAccessProgram: "unavailable",
    serviceTier: "default",
    subagent: { modelId: "claude-opus-5-5", effort: "high" },
  },
  digest,
);
const run = {
  runId: "trial-1",
  targetSnapshotDigest: digest,
  profile,
  coordination: "cooperative" as const,
  prompt: "Inspect the fixed source and report candidates.",
  sourceDirectory: "/frozen/source",
  sourceTree: { digest, entries: 1, bytes: 1 },
  lab: {
    endpoint: "http://wordpress",
    networkName: "lab-internal",
    internalIp: "172.20.0.2",
  },
  campaignInput: {
    snapshotDigest: digest,
    modelProfileDigest: profile.digest,
    history: { mode: "none" },
  },
  expiresAt: "2026-10-14T00:30:00.000Z",
} as DiscoveryTransportRun;
const grant = {
  baseUrl: "http://172.20.0.5:8080",
  authorization: `Bearer ${"t".repeat(43)}`,
  dockerNetworkName: "lab-internal",
  model: "claude-opus-5-5",
  protocol: "anthropic-messages" as const,
  anthropicAuthentication: "api-key" as const,
  expiresAt: run.expiresAt,
};
const report = {
  findings: [],
  leads: [],
  examined: "source",
  unexamined: "none",
};
const transcript = (
  root: unknown,
  childFinal = JSON.stringify(report),
  childTranscript = "{}",
) =>
  [
    { type: "harness.child-start", ordinal: 1 },
    { type: "harness.child-id", agentId: "child-1" },
    {
      type: "harness.child-transcript",
      agentId: "child-1",
      transcript: "first wave",
      finalMessage: "unfinished",
    },
    {
      type: "harness.child-transcript",
      agentId: "child-1",
      transcript: childTranscript,
      finalMessage: childFinal,
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: root,
      modelUsage: {
        "claude-opus-5-5": {
          inputTokens: 50,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          thinkingTokens: 3,
        },
      },
    },
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function setup(
  rootOutput: unknown,
  childFinal?: string,
  childTranscript?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-claude-test-"));
  roots.push(root);
  const attachments = new ProviderAttachmentStore(root);
  let calls = 0;
  let capturedPrompt = "";
  const sandbox = {
    async probe() {
      return {
        cliVersion: "2.1.296",
        bundledCatalogDigest: "unavailable" as const,
      };
    },
    async execute(command: { prompt: string }) {
      calls += 1;
      capturedPrompt = command.prompt;
      return {
        kind: "exited" as const,
        exitCode: 0,
        stdout: transcript(rootOutput, childFinal, childTranscript),
        stderr: "",
        cliVersion: "2.1.296",
        image,
        startedAt: now,
        completedAt: now,
        research: { archive: Buffer.from("{}"), truncated: false },
        isolation: {
          backend: "gvisor" as const,
          runtime: "runsc" as const,
          fallbackUsed: false as const,
        },
      };
    },
  };
  const broker = {
    async withGrant(
      _request: unknown,
      operation: (value: typeof grant) => Promise<unknown>,
    ) {
      return {
        operation: {
          status: "completed" as const,
          value: await operation(grant),
        },
        receipt: {
          digest,
          setup: { status: "ready" },
          cleanup: { status: "completed" },
          metrics: {
            forwardedRequests: 2,
            requestLimitExceeded: 0,
            unauthorizedRequests: 0,
          },
        },
      };
    },
  } as ProviderCredentialEgressBroker;
  const runtime = new ClaudeNativeAgentRuntime(
    sandbox,
    broker,
    attachments,
    image,
    () => new Date(now),
  );
  return {
    runtime,
    attachments,
    calls: () => calls,
    prompt: () => capturedPrompt,
  };
}

describe("Claude single cooperative Trial", () => {
  it("uses one sandbox query and seals Root and child reports separately", async () => {
    const fixture = await setup({
      ...report,
      findings: [JSON.stringify({ claim: "candidate" })],
    });
    const result = await fixture.runtime.execute(run);
    expect(fixture.calls()).toBe(1);
    expect(result.receipt.terminal).toBe("completed");
    expect(result.receipt.childThreadsObserved).toBe(1);
    expect(result.receipt.usage.inputTokens).toBe(50);
    expect(result.agentRuns).toHaveLength(1);
    expect(result.agentRuns?.[0]?.receipt.terminal).toBe("completed");
    expect(result.attachment?.digest).not.toBe(
      result.agentRuns?.[0]?.attachment?.digest,
    );
    expect((await fixture.attachments.read(result.attachment!)).status).toBe(
      "resolved",
    );
  });

  it("retains the child when the Root report is malformed", async () => {
    const fixture = await setup({
      findings: "invalid",
      leads: [],
      examined: "",
      unexamined: "",
    });
    const result = await fixture.runtime.execute(run);
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "schema",
    });
    expect(result.agentRuns?.[0]?.receipt.terminal).toBe("completed");
    expect(result.agentRuns?.[0]?.attachment).toBeDefined();
  });

  it("recovers a valid child report from its transcript after a prose final reply", async () => {
    const earlier = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: JSON.stringify(report) }] },
    });
    const fixture = await setup(report, "Done", earlier);
    const result = await fixture.runtime.execute(run);
    expect(result.receipt.terminal).toBe("completed");
    expect(result.agentRuns?.[0]?.receipt.terminal).toBe("completed");
    expect(result.agentRuns?.[0]?.attachment).toBeDefined();
  });

  it("rejects a mismatched snapshot before granting provider access", async () => {
    const fixture = await setup(report);
    const result = await fixture.runtime.execute({
      ...run,
      targetSnapshotDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(result.receipt).toMatchObject({
      terminal: "incomplete",
      reason: "policy",
    });
    expect(fixture.calls()).toBe(0);
  });
});
