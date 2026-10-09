import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  createHistoryCatalog,
  defineAgentRuntimeProfile,
} from "../../src/discovery/index.js";
import {
  CodexNativeAgentRuntime,
  type CodexSandbox,
  type CodexSandboxCommand,
} from "../../src/discovery/index.js";
import {
  providerCredentialEgressReceiptSchema,
  type ProviderCredentialEgressBroker,
} from "../../src/discovery/index.js";
import {
  BROKER_TLS_HOSTNAME,
  PROVIDER_UPSTREAM_ORIGIN,
} from "../../src/discovery/index.js";
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
  lab: {
    endpoint: "http://wordpress",
    networkName: "lab-internal",
    internalIp: "172.20.0.2",
  },
  campaignInput: {
    schemaVersion: 1 as const,
    snapshotDigest: digest,
    trustBoundary: { version: "v1", text: "Untrusted request" },
    programmeBoundary: { version: "v1", text: "Low privilege" },
    modelProfileDigest: profile.digest,
    promptDigest: digest,
    stopRules: { maxRuns: 40, noFindingRuns: 4 },
    lab: { setupDigest: digest },
    history: { mode: "none" as const },
  },
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

type Grant = Parameters<
  Parameters<ProviderCredentialEgressBroker["withGrant"]>[1]
>[0];

function broker(
  grantOverrides: Partial<Grant> = {},
): ProviderCredentialEgressBroker {
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
        dockerNetworkName: request.agentNetworkName ?? "internal-run",
        model: request.model,
        protocol: request.protocol,
        expiresAt: request.expiresAt,
        ...grantOverrides,
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
  it("uses the same isolated transport for a sealed Verifier attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-verifier-transport-"));
    try {
      const report = {
        "http.json": '{"exchanges":[]}',
        "steps.md": "Synthetic steps",
        "route.json": null,
        "session.json": null,
        "refutation.md": null,
        precondition: null,
      };
      const verifierTranscript = [
        { type: "thread.started", thread_id: crypto.randomUUID() },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: JSON.stringify(report) },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
      const commands: CodexSandboxCommand[] = [];
      const attachments = new ProviderAttachmentStore(root);
      const runtime = new CodexNativeAgentRuntime(
        sandbox(verifierTranscript, commands),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      const result = await runtime.execute({
        ...run,
        outputKind: "verification",
      });
      expect(result.receipt.terminal).toBe("completed");
      expect(result.attachment?.kind).toBe("verification");
      expect(commands[0]?.sourceMount.mode).toBe("ro");
      expect(commands[0]?.args).toContain("--ephemeral");
      expect(commands[0]?.args).not.toContain("resume");
      expect(commands[0]?.supportFiles[0]?.content).toContain("http.json");
      const stored =
        result.attachment && (await attachments.read(result.attachment));
      expect(stored?.status).toBe("resolved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("sends only validated pre-cutoff catalog history to the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const commands: CodexSandboxCommand[] = [];
      const runtime = new CodexNativeAgentRuntime(
        sandbox(transcript, commands),
        broker(),
        new ProviderAttachmentStore(root),
        image,
        () => new Date(now),
      );
      const history = createHistoryCatalog("2026-02-01T00:00:00Z", [
        {
          id: "public-1",
          kind: "sql-injection",
          affectedVersions: ["1.0"],
          fixedVersions: ["1.1"],
          publishedAt: "2026-01-01T00:00:00Z",
          title: "Synthetic title",
          changedFiles: [],
        },
      ]);
      expect(
        (
          await runtime.execute({
            ...run,
            campaignInput: { ...run.campaignInput, history },
          })
        ).receipt.terminal,
      ).toBe("completed");
      expect(commands[0]?.stdin).toContain("Synthetic title");
      expect(commands[0]?.stdin).toContain("2026-02-01T00:00:00Z");
      const unsafe = {
        ...run,
        campaignInput: {
          ...run.campaignInput,
          history: {
            ...history,
            records: [{ ...history.records[0]!, payload: "secret" }],
          },
        },
      };
      expect((await runtime.execute(unsafe)).receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
      expect(commands).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects an Answer Key field before invoking the agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const commands: CodexSandboxCommand[] = [];
      const runtime = new CodexNativeAgentRuntime(
        sandbox(transcript, commands),
        broker(),
        new ProviderAttachmentStore(root),
        image,
        () => new Date(now),
      );
      const candidate = { ...run, answerKey: "private-evaluation-data" };
      expect((await runtime.execute(candidate)).receipt).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
      expect(commands).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(commands[0]?.labHost).toEqual({
        name: "wordpress",
        ipv4: "172.20.0.2",
      });
      expect(commands[0]?.grant.dockerNetworkName).toBe("lab-internal");
      expect(commands[0]?.args).toContain("gpt-6.1-sol");
      expect(commands[0]?.args).toContain("danger-full-access");
      expect(commands[0]?.args).not.toContain("read-only");
      // `codex exec` 0.161 has no `-a`; approvals are set through config.
      expect(commands[0]?.args).not.toContain("-a");
      expect(commands[0]?.args).toContain('approval_policy="never"');
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

  it("passes a frozen core dependency mount and rejects a relative dependency path", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-core-transport-"));
    try {
      const commands: CodexSandboxCommand[] = [];
      const runtime = new CodexNativeAgentRuntime(
        sandbox(transcript, commands),
        broker(),
        new ProviderAttachmentStore(root),
        image,
        () => new Date(now),
      );
      const dependencySource = {
        directory: "/synthetic/wordpress-core",
        tree: { digest, entries: 1, bytes: 20 },
      };
      expect(
        (await runtime.execute({ ...run, dependencySource })).receipt.terminal,
      ).toBe("completed");
      expect(commands[0]?.dependencyMount).toEqual({
        directory: dependencySource.directory,
        expectedTree: dependencySource.tree,
        path: "/workspace/wordpress",
        mode: "ro",
      });
      expect(
        (
          await runtime.execute({
            ...run,
            dependencySource: {
              ...dependencySource,
              directory: "relative/core",
            },
          })
        ).receipt,
      ).toMatchObject({
        terminal: "incomplete",
        reason: "policy",
      });
      expect(commands).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a provider rate limit or quota as a provider limit and nothing else", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const attachments = new ProviderAttachmentStore(root);
      const failed = (message: string) =>
        new CodexNativeAgentRuntime(
          sandbox(
            [
              { type: "thread.started", thread_id: "synthetic" },
              { type: "turn.started" },
              { type: "error", message },
              { type: "turn.failed", error: { message } },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n"),
            [],
            { exitCode: 1 },
          ),
          broker(),
          attachments,
          image,
          () => new Date(now),
        ).execute(run);
      const cases: [string, string | undefined][] = [
        ["You've hit your usage limit. Try again later.", "quota"],
        ["Quota exceeded. Check your plan and billing details.", "quota"],
        [
          "exceeded retry limit, last status: 429 Too Many Requests",
          "rate-limit",
        ],
        // The broker's own per-grant cap is a Harness bound, not the subscription's.
        [
          "unexpected status 429 Too Many Requests: grant-request-limit-exceeded",
          undefined,
        ],
        ["stream disconnected before completion", undefined],
      ];
      for (const [message, providerLimit] of cases) {
        const { receipt } = await failed(message);
        expect(receipt).toMatchObject({
          terminal: "incomplete",
          reason: "provider",
        });
        expect(receipt.providerLimit).toBe(providerLimit);
      }
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
        reasonDetail: "invalid-event-json",
      });
      const exited = new CodexNativeAgentRuntime(
        sandbox(transcript, [], { exitCode: 2 }),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      expect((await exited.execute(run)).receipt).toMatchObject({
        reason: "provider",
        reasonDetail: "cli-exit:2",
      });
      const unadmitted = new CodexNativeAgentRuntime(
        sandbox(
          transcript.replace('"type":"agent_message"', '"type":"file_change"'),
          [],
        ),
        broker(),
        attachments,
        image,
        () => new Date(now),
      );
      expect((await unadmitted.execute(run)).receipt.reasonDetail).toBe(
        "unadmitted-item-type:file_change",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks the provider for a strict report and turns each Finding text back into an object", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const commands: CodexSandboxCommand[] = [];
      const attachments = new ProviderAttachmentStore(root);
      const finding = { claim: "synthetic", sourceTrace: [{ line: 1 }] };
      const withFindings = (findings: unknown[]) =>
        transcript.replace(
          JSON.stringify(
            JSON.stringify({
              findings: [],
              examined: "source",
              unexamined: "none",
            }),
          ),
          JSON.stringify(
            JSON.stringify({
              findings,
              examined: "source",
              unexamined: "none",
            }),
          ),
        );
      const runtime = (stdout: string) =>
        new CodexNativeAgentRuntime(
          sandbox(stdout, commands),
          broker(),
          attachments,
          image,
          () => new Date(now),
        );
      const result = await runtime(
        withFindings([JSON.stringify(finding)]),
      ).execute(run);
      expect(result.receipt.terminal).toBe("completed");
      const stored =
        result.attachment && (await attachments.read(result.attachment));
      expect(
        stored?.status === "resolved"
          ? (JSON.parse(stored.bytes.toString("utf8")) as unknown)
          : undefined,
      ).toMatchObject({ findings: [finding] });

      // Strict structured output: every object closes and requires all keys.
      const schema = JSON.parse(
        commands[0]?.supportFiles[0]?.content ?? "{}",
      ) as unknown;
      const objects: Record<string, unknown>[] = [];
      const walk = (node: unknown): void => {
        if (typeof node !== "object" || node === null) return;
        const record = node as Record<string, unknown>;
        if (record.type === "object") objects.push(record);
        Object.values(record).forEach(walk);
      };
      walk(schema);
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) {
        expect(object.additionalProperties).toBe(false);
        expect([...((object.required as string[]) ?? [])].sort()).toEqual(
          Object.keys((object.properties as object) ?? {}).sort(),
        );
      }

      for (const malformed of ["not json", JSON.stringify([1])])
        expect(
          (await runtime(withFindings([malformed])).execute(run)).receipt
            .reason,
        ).toBe("schema");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads only the final agent message as the report and treats earlier ones as progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const events = transcript.split("\n");
      const progress = (text: string) =>
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text },
        });
      const runtime = (stdout: string) =>
        new CodexNativeAgentRuntime(
          sandbox(stdout, []),
          broker(),
          new ProviderAttachmentStore(root),
          image,
          () => new Date(now),
        );
      const withProgress = [
        ...events.slice(0, 2),
        progress("I'll map the pinned source first."),
        ...events.slice(2),
      ].join("\n");
      expect((await runtime(withProgress).execute(run)).receipt.terminal).toBe(
        "completed",
      );
      // The run must still end on its report.
      const endsInProse = [
        ...events.slice(0, 3),
        progress("Done."),
        ...events.slice(3),
      ].join("\n");
      expect((await runtime(endsInProse).execute(run)).receipt).toMatchObject({
        reason: "schema",
        reasonDetail: "final-message-not-report",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("points a ChatGPT login run at the TLS broker's subscription backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-transport-"));
    try {
      const {
        kind: _kind,
        schemaVersion: _version,
        digest: _digest,
        ...base
      } = profile;
      const chatgptProfile = defineAgentRuntimeProfile({
        ...base,
        requestedModelId: "gpt-6-luna",
        authenticationMethod: "chatgpt-oauth-host",
        cyberAccessProgram: "daybreak_blue",
      });
      const chatgptRun = {
        ...run,
        profile: chatgptProfile,
        campaignInput: {
          ...run.campaignInput,
          modelProfileDigest: chatgptProfile.digest,
        },
      };
      const tlsGrant = {
        baseUrl: `https://${BROKER_TLS_HOSTNAME}:8080`,
        tls: {
          hostname: BROKER_TLS_HOSTNAME,
          address: "172.20.0.9",
          caPem:
            "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
        },
      };
      const commands: CodexSandboxCommand[] = [];
      const runtime = (grant: Partial<Grant>) =>
        new CodexNativeAgentRuntime(
          sandbox(transcript, commands),
          broker(grant),
          new ProviderAttachmentStore(root),
          image,
          () => new Date(now),
        );
      const result = await runtime(tlsGrant).execute(chatgptRun);
      expect(result.receipt.terminal).toBe("completed");
      expect(result.receipt.authenticationMethod).toBe("chatgpt-oauth-host");
      const args = commands[0]?.args ?? [];
      expect(args).toContain(
        `chatgpt_base_url="https://${BROKER_TLS_HOSTNAME}:8080/backend-api/"`,
      );
      expect(args.join(" ")).not.toContain("openai_base_url");
      // A compressed request body would hide the model from the broker.
      expect(args.join(" ")).toContain("--disable enable_request_compression");
      expect(args.join(" ")).toContain("--cyber-access-program daybreak_blue");
      expect(commands[0]?.grant.tls?.address).toBe("172.20.0.9");

      // A login run never falls back to a plain API-key grant, and back.
      commands.length = 0;
      expect((await runtime({}).execute(chatgptRun)).receipt.terminal).toBe(
        "incomplete",
      );
      expect((await runtime(tlsGrant).execute(run)).receipt.terminal).toBe(
        "incomplete",
      );
      expect(commands).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
