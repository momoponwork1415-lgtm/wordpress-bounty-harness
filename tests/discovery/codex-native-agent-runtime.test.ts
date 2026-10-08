import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { defineAgentRuntimeProfile } from "../../src/discovery/index.js";
import {
  CodexNativeAgentRuntime,
  type CodexSandbox,
  type CodexSandboxCommand,
} from "../../src/discovery/index.js";
import {
  providerCredentialEgressReceiptSchema,
  type ProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";
import { PROVIDER_UPSTREAM_ORIGIN } from "../../src/discovery/index.js";
import { ProviderAttachmentStore } from "../../src/discovery/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `node@${digest}`;
const now = "2026-10-08T07:00:00.000Z";
const profile = defineAgentRuntimeProfile({
  id: "production",
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
const run = {
  runId: "run-1",
  targetSnapshotDigest: digest,
  profile,
  sourceDirectory: "/private/frozen-source",
  sourceTree: { digest, entries: 1, bytes: 1 },
  prompt: "Inspect the fixed source and report findings.",
  expiresAt: "2026-10-08T07:30:00.000Z",
};
const transcript = [
  { type: "thread.started", thread_id: crypto.randomUUID() },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({
        findings: [],
        examined: "source",
        unexamined: "none",
      }),
    },
  },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
]
  .map((event) => JSON.stringify(event))
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
  stdout: string,
  commands: CodexSandboxCommand[],
  overrides: Partial<Awaited<ReturnType<CodexSandbox["execute"]>>> = {},
): CodexSandbox {
  return {
    async execute(command) {
      commands.push(command);
      return {
        status: "exited",
        exitCode: 0,
        stdout,
        startedAt: now,
        completedAt: now,
        image,
        cliVersion: "0.161.0",
        bundledCatalogDigest: digest,
        isolation: { backend: "gvisor", runtime: "runsc", fallbackUsed: false },
        ...overrides,
      };
    },
  };
}

describe("Codex native agent runtime", () => {
  it("uses the sealed model and source mount and stores only a private report reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const commands: CodexSandboxCommand[] = [];
      const attachments = new ProviderAttachmentStore(root);
      const runtime = new CodexNativeAgentRuntime(
        sandbox(transcript, commands),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      const result = await runtime.execute(run);
      expect(result.receipt.terminal).toBe("completed");
      expect(result.receipt.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: "unavailable",
        outputTokens: 4,
        reasoningOutputTokens: "unavailable",
      });
      expect(result.receipt.grantReceiptDigest).toMatch(/^sha256:/);
      expect(commands).toHaveLength(1);
      expect(commands[0]?.sourceMount).toEqual({
        directory: run.sourceDirectory,
        path: "/workspace/main",
        mode: "ro",
        expectedTree: run.sourceTree,
      });
      expect(commands[0]?.args).toContain("gpt-6.1-sol");
      expect(commands[0]?.args).toContain('model_reasoning_effort="high"');
      expect(commands[0]?.args).toContain(
        'openai_base_url="http://127.0.0.1:8080/v1"',
      );
      expect(commands[0]?.args).toContain('service_tier="priority"');
      expect(result.receipt.serviceTier).toBe("priority");
      expect(commands[0]?.args).toContain("--cyber-access-program");
      expect(result.receipt.cyberAccessProgram).toBe("standard");
      expect(commands[0]?.args).not.toContain("resume");
      expect(
        result.attachment && (await attachments.read(result.attachment)),
      ).toMatchObject({ status: "resolved" });
      expect(JSON.stringify(result.receipt)).not.toContain("findings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns typed incomplete receipts for unbound CLI and malformed output", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const attachments = new ProviderAttachmentStore(root);
      const wrongVersion = new CodexNativeAgentRuntime(
        sandbox(transcript, [], { cliVersion: "0.160.0" }),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      expect((await wrongVersion.execute(run)).receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
      const invalidOutput = new CodexNativeAgentRuntime(
        sandbox("invalid", []),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      expect((await invalidOutput.execute(run)).receipt).toMatchObject({
        terminal: "incomplete",
        reason: "schema",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
