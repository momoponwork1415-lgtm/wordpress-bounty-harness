import { z } from "zod";
import { isAbsolute } from "node:path";

import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import {
  admitAgentRuntimeProfile,
  agentRuntimeProfileSchema,
  type AgentRuntimeProfile,
} from "./agent-runtime-profile.js";
import {
  createNativeRunReceipt,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type {
  ProviderCredentialEgressBroker,
  ProviderCredentialEgressGrant,
} from "./provider-credential-egress-broker.js";
import {
  ProviderAttachmentStore,
  type ProviderAttachmentRef,
} from "./provider-research-report.js";

const reportSchema = z.strictObject({
  findings: z.array(z.record(z.string(), z.unknown())),
  examined: z.string().max(16_384),
  unexamined: z.string().max(16_384),
});
const reportJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: { type: "array", items: { type: "object" } },
    examined: { type: "string" },
    unexamined: { type: "string" },
  },
  required: ["findings", "examined", "unexamined"],
} as const;

export interface CodexSandboxCommand {
  readonly executable: "codex";
  readonly args: readonly string[];
  readonly stdin: string;
  readonly supportFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly grant: ProviderCredentialEgressGrant;
  readonly sourceMount: {
    readonly directory: string;
    readonly path: "/workspace/main";
    readonly mode: "ro";
    readonly expectedTree: ExpectedSourceTree;
  };
}
export interface CodexSandboxResult {
  readonly status: "exited" | "failed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly image: string;
  readonly cliVersion: string;
  readonly bundledCatalogDigest: string;
  readonly isolation: {
    readonly backend: "gvisor";
    readonly runtime: "runsc";
    readonly fallbackUsed: false;
  };
}
/** The Lab module supplies this executor. This adapter has no host execution fallback. */
export interface CodexSandbox {
  execute(command: CodexSandboxCommand): Promise<CodexSandboxResult>;
}
export interface DiscoveryTransportRun {
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
  readonly prompt: string;
  readonly sourceDirectory: string;
  readonly sourceTree: ExpectedSourceTree;
  readonly expiresAt: string;
}
export interface DiscoveryTransportResult {
  readonly receipt: NativeRunReceipt;
  readonly attachment?: ProviderAttachmentRef;
}

const discoveryTransportRunSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  targetSnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  profile: agentRuntimeProfileSchema,
  prompt: z.string().min(1),
  sourceDirectory: z.string().min(1),
  sourceTree: z.strictObject({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  expiresAt: z.iso.datetime({ offset: true }),
});

const event = z.looseObject({ type: z.string() });
const usageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
});
function decodeTranscript(stdout: string):
  | {
      report: z.infer<typeof reportSchema>;
      usage: {
        inputTokens: number | "unavailable";
        cachedInputTokens: number | "unavailable";
        outputTokens: number | "unavailable";
        reasoningOutputTokens: number | "unavailable";
      };
    }
  | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  let started = false;
  let completed = false;
  let report: z.infer<typeof reportSchema> | undefined;
  let usage: ReturnType<typeof usageSchema.parse> | undefined;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    const parsed = event.safeParse(value);
    if (!parsed.success) return undefined;
    if (parsed.data.type === "thread.started") {
      if (started) return undefined;
      started = true;
      continue;
    }
    if (parsed.data.type === "turn.started") continue;
    if (parsed.data.type === "turn.completed") {
      if (completed) return undefined;
      const object = parsed.data as Record<string, unknown>;
      const found = usageSchema.safeParse(object.usage);
      if (found.success) usage = found.data;
      completed = true;
      continue;
    }
    if (
      parsed.data.type === "item.started" ||
      parsed.data.type === "item.updated" ||
      parsed.data.type === "item.completed"
    ) {
      const item = (parsed.data as Record<string, unknown>).item;
      if (typeof item !== "object" || item === null || !("type" in item))
        return undefined;
      if (
        item.type === "agent_message" &&
        parsed.data.type === "item.completed" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        let reportValue: unknown;
        try {
          reportValue = JSON.parse(item.text) as unknown;
        } catch {
          return undefined;
        }
        const found = reportSchema.safeParse(reportValue);
        if (!found.success) return undefined;
        report = found.data;
      } else if (
        !["reasoning", "error", "agent_message", "command_execution"].includes(
          String(item.type),
        )
      ) {
        // A tool not admitted by this transport makes the transcript unusable.
        return undefined;
      }
      continue;
    }
    return undefined;
  }
  if (!started || !completed || report === undefined) return undefined;
  return {
    report,
    usage: {
      inputTokens: usage?.input_tokens ?? "unavailable",
      cachedInputTokens: usage?.cached_input_tokens ?? "unavailable",
      outputTokens: usage?.output_tokens ?? "unavailable",
      reasoningOutputTokens: usage?.reasoning_output_tokens ?? "unavailable",
    },
  };
}

export class CodexNativeAgentRuntime {
  constructor(
    readonly sandbox: CodexSandbox,
    readonly broker: ProviderCredentialEgressBroker,
    readonly attachments: ProviderAttachmentStore,
    readonly sandboxImage: string,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult> {
    const startedAt = this.clock().toISOString();
    const incomplete = (
      reason: "provider" | "schema" | "sandbox" | "policy" | "evidence",
      completedAt = this.clock().toISOString(),
      grantReceiptDigest?: string,
    ): DiscoveryTransportResult => ({
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "incomplete",
        reason,
        startedAt,
        completedAt,
        ...(grantReceiptDigest === undefined ? {} : { grantReceiptDigest }),
      }),
    });
    if (
      !discoveryTransportRunSchema.safeParse(run).success ||
      admitAgentRuntimeProfile(run.profile, this.sandboxImage).status !==
        "admitted" ||
      run.prompt.length === 0 ||
      !isAbsolute(run.sourceDirectory) ||
      run.profile.authenticationMethod !== "host-private-bearer" ||
      run.profile.subagent.modelId !== "unavailable" ||
      run.profile.subagent.effort !== "unavailable"
    )
      return incomplete("policy");
    const granted = await this.broker
      .withGrant(
        {
          schemaVersion: 1,
          runtimeProfileDigest: run.profile.digest,
          model: run.profile.requestedModelId,
          protocol: "responses",
          maxRequests: 100,
          maxRequestBytes: 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          expiresAt: run.expiresAt,
        },
        async (grant) => {
          if (!/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(grant.baseUrl)) {
            throw new Error("Provider broker address is invalid");
          }
          return this.sandbox.execute({
            executable: "codex",
            args: [
              "exec",
              "--model",
              run.profile.requestedModelId,
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "--ephemeral",
              "-a",
              "never",
              ...(run.profile.cyberAccessProgram === "unavailable"
                ? []
                : ["--cyber-access-program", run.profile.cyberAccessProgram]),
              "--ignore-user-config",
              "--ignore-rules",
              "--disable",
              "unified_exec",
              "-c",
              'web_search="disabled"',
              "-c",
              "features.multi_agent=false",
              "-c",
              `model_reasoning_effort="${run.profile.requestedEffort}"`,
              "-c",
              `openai_base_url="${grant.baseUrl}/v1"`,
              ...(run.profile.serviceTier === "unavailable"
                ? []
                : ["-c", `service_tier="${run.profile.serviceTier}"`]),
              "-c",
              'history.persistence="none"',
              "--output-schema",
              "/opt/codex-support/report-schema.json",
              "--json",
              "-",
            ],
            stdin: run.prompt,
            supportFiles: [
              {
                path: "/opt/codex-support/report-schema.json",
                content: JSON.stringify(reportJsonSchema),
              },
            ],
            grant,
            sourceMount: {
              directory: run.sourceDirectory,
              path: "/workspace/main",
              mode: "ro",
              expectedTree: run.sourceTree,
            },
          });
        },
      )
      .catch(() => undefined);
    if (granted === undefined) return incomplete("provider");
    if (
      granted.receipt.setup.status !== "ready" ||
      granted.receipt.cleanup.status !== "completed" ||
      granted.operation.status !== "completed"
    )
      return incomplete(
        "provider",
        this.clock().toISOString(),
        granted.receipt.digest,
      );
    const result = granted.operation.value;
    if (
      result.isolation.backend !== "gvisor" ||
      result.isolation.runtime !== "runsc" ||
      result.isolation.fallbackUsed !== false
    )
      return incomplete("sandbox", result.completedAt, granted.receipt.digest);
    if (
      result.image !== this.sandboxImage ||
      result.cliVersion !== run.profile.codexCliVersion ||
      result.bundledCatalogDigest !== run.profile.bundledCatalogDigest
    )
      return incomplete("policy", result.completedAt, granted.receipt.digest);
    if (result.status !== "exited" || result.exitCode !== 0)
      return incomplete("provider", result.completedAt, granted.receipt.digest);
    const decoded = decodeTranscript(result.stdout);
    if (decoded === undefined)
      return incomplete("schema", result.completedAt, granted.receipt.digest);
    let attachment: ProviderAttachmentRef;
    try {
      attachment = await this.attachments.put(
        "findings",
        Buffer.from(canonicalJson(decoded.report)),
      );
    } catch {
      return incomplete("evidence", result.completedAt, granted.receipt.digest);
    }
    return {
      attachment,
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "completed",
        reason: "unavailable",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        usage: decoded.usage,
        grantReceiptDigest: granted.receipt.digest,
        reportArtifactDigest: attachment.digest,
      }),
    };
  }
}
