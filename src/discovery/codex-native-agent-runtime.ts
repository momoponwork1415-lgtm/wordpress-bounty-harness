import { z } from "zod";
import { isAbsolute } from "node:path";

import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import { campaignInputV1Schema, type CampaignInputV1 } from "./campaign.js";
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

/** One Finding, sent as JSON text so the provider's strict schema stays closed. */
const findingTextSchema = z.string().transform((text, context) => {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  context.addIssue({ code: "custom", message: "Finding is not a JSON object" });
  return z.NEVER;
});
const reportSchema = z.strictObject({
  findings: z.array(findingTextSchema),
  examined: z.string().max(16_384),
  unexamined: z.string().max(16_384),
});
/**
 * Structured outputs require every object to be closed with all keys
 * required, but a Finding's shape belongs to the target profile, so each
 * Finding travels as a JSON object encoded in a string.
 */
const reportJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "string",
        description: "One Finding as a JSON object, encoded as a string",
      },
    },
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
  readonly labHost: { readonly name: string; readonly ipv4: string };
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
  /** Verification uses the same isolated transport with a different sealed report. */
  readonly outputKind?: "verification";
  readonly lab: {
    readonly endpoint: string;
    readonly networkName: string;
    readonly internalIp: string;
  };
  readonly campaignInput: CampaignInputV1;
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
  outputKind: z.literal("verification").optional(),
  lab: z.strictObject({
    endpoint: z.url(),
    networkName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    internalIp: z.ipv4(),
  }),
  campaignInput: campaignInputV1Schema,
  sourceDirectory: z.string().min(1),
  sourceTree: z.strictObject({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  expiresAt: z.iso.datetime({ offset: true }),
});

const event = z.looseObject({ type: z.string() });
const verificationReportSchema = z.strictObject({
  "http.json": z.string().nullable(),
  "steps.md": z.string().nullable(),
  "route.json": z.string().nullable(),
  "refutation.md": z.string().nullable(),
  precondition: z.string().nullable(),
});
const verificationReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    "http.json": { type: ["string", "null"] },
    "steps.md": { type: ["string", "null"] },
    "route.json": { type: ["string", "null"] },
    "refutation.md": { type: ["string", "null"] },
    precondition: { type: ["string", "null"] },
  },
  required: [
    "http.json",
    "steps.md",
    "route.json",
    "refutation.md",
    "precondition",
  ],
} as const;
const usageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative().optional(),
});
function decodeTranscript(
  stdout: string,
  outputKind?: "verification",
):
  | {
      report:
        z.infer<typeof reportSchema> | z.infer<typeof verificationReportSchema>;
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
  let report:
    | z.infer<typeof reportSchema>
    | z.infer<typeof verificationReportSchema>
    | undefined;
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
        const found = (
          outputKind === "verification"
            ? verificationReportSchema
            : reportSchema
        ).safeParse(reportValue);
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

const failureEventSchema = z.union([
  z.looseObject({ type: z.literal("error"), message: z.string() }),
  z.looseObject({
    type: z.literal("turn.failed"),
    error: z.looseObject({ message: z.string() }),
  }),
]);

/** Classifies the CLI's failure events; the broker's own grant cap is not a provider limit. */
function providerLimitOf(stdout: string): "rate-limit" | "quota" | undefined {
  let limit: "rate-limit" | "quota" | undefined;
  for (const line of stdout.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const parsed = failureEventSchema.safeParse(value);
    if (!parsed.success) continue;
    const message =
      parsed.data.type === "error"
        ? parsed.data.message
        : parsed.data.error.message;
    if (message.includes("grant-request-limit-exceeded")) continue;
    if (/usage limit|quota/i.test(message)) return "quota";
    if (/\b429\b|too many requests|rate[ _-]?limit/i.test(message))
      limit = "rate-limit";
  }
  return limit;
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
      providerLimit?: "rate-limit" | "quota",
    ): DiscoveryTransportResult => ({
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "incomplete",
        reason,
        ...(providerLimit === undefined ? {} : { providerLimit }),
        startedAt,
        completedAt,
        ...(grantReceiptDigest === undefined ? {} : { grantReceiptDigest }),
      }),
    });
    if (
      !discoveryTransportRunSchema.safeParse(run).success ||
      run.campaignInput.snapshotDigest !== run.targetSnapshotDigest ||
      run.campaignInput.modelProfileDigest !== run.profile.digest ||
      admitAgentRuntimeProfile(run.profile, this.sandboxImage).status !==
        "admitted" ||
      run.prompt.length === 0 ||
      !isAbsolute(run.sourceDirectory) ||
      run.profile.authenticationMethod !== "host-private-bearer" ||
      run.profile.subagent.modelId !== "unavailable" ||
      run.profile.subagent.effort !== "unavailable"
    )
      return incomplete("policy");
    const labEndpoint = new URL(run.lab.endpoint);
    if (
      labEndpoint.protocol !== "http:" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(labEndpoint.hostname) ||
      labEndpoint.username !== "" ||
      labEndpoint.password !== ""
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
          agentNetworkName: run.lab.networkName,
        },
        async (grant) => {
          if (grant.dockerNetworkName !== run.lab.networkName)
            throw new Error("Provider grant is not on the Lab network");
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
              "danger-full-access",
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
            stdin:
              run.campaignInput.history.mode === "catalog"
                ? `${run.prompt}\n\nPublic history catalog (records strictly before the cutoff):\n${canonicalJson(run.campaignInput.history)}`
                : run.prompt,
            supportFiles: [
              {
                path: "/opt/codex-support/report-schema.json",
                content: JSON.stringify(
                  run.outputKind === "verification"
                    ? verificationReportJsonSchema
                    : reportJsonSchema,
                ),
              },
            ],
            grant,
            sourceMount: {
              directory: run.sourceDirectory,
              path: "/workspace/main",
              mode: "ro",
              expectedTree: run.sourceTree,
            },
            labHost: { name: labEndpoint.hostname, ipv4: run.lab.internalIp },
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
    const decoded =
      result.status === "exited" && result.exitCode === 0
        ? decodeTranscript(result.stdout, run.outputKind)
        : undefined;
    if (decoded === undefined) {
      const limit = providerLimitOf(result.stdout);
      if (limit !== undefined)
        return incomplete(
          "provider",
          result.completedAt,
          granted.receipt.digest,
          limit,
        );
    }
    if (result.status !== "exited" || result.exitCode !== 0)
      return incomplete("provider", result.completedAt, granted.receipt.digest);
    if (decoded === undefined)
      return incomplete("schema", result.completedAt, granted.receipt.digest);
    let attachment: ProviderAttachmentRef;
    try {
      attachment = await this.attachments.put(
        run.outputKind === "verification" ? "verification" : "findings",
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
