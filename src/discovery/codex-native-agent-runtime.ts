import { z } from "zod";
import { isAbsolute, posix } from "node:path";

import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import { campaignInputV1Schema, type CampaignInputV1 } from "./campaign.js";
import {
  admitAgentRuntimeProfile,
  admitCooperativeRuntimeProfile,
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

/** A profile claim travels as JSON text so the provider's strict schema stays closed. */
const claimTextSchema = z.string().transform((text, context) => {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  context.addIssue({ code: "custom", message: "Claim is not a JSON object" });
  return z.NEVER;
});
const reportSchema = z.strictObject({
  findings: z.array(claimTextSchema),
  leads: z.array(claimTextSchema),
  examined: z.string().max(16_384),
  unexamined: z.string().max(16_384),
});
/** Children are not constrained by Root's --output-schema; admit both object and encoded claims. */
const childCoverageSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
  .pipe(z.string().max(16_384));
const childReportSchema = z.strictObject({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()),
  examined: childCoverageSchema,
  unexamined: childCoverageSchema,
});
function childClaim(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return object(JSON.parse(value) as unknown) ?? value;
  } catch {
    return value;
  }
}
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
    leads: {
      type: "array",
      items: {
        type: "string",
        description: "One Lead as a JSON object, encoded as a string",
      },
    },
    examined: { type: "string" },
    unexamined: { type: "string" },
  },
  required: ["findings", "leads", "examined", "unexamined"],
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
  readonly dependencyMount?: {
    readonly directory: string;
    readonly path: "/workspace/wordpress";
    readonly mode: "ro";
    readonly expectedTree: ExpectedSourceTree;
  };
  readonly labHost: { readonly name: string; readonly ipv4: string };
  readonly databaseHost?: { readonly name: string; readonly ipv4: string };
}
export interface CodexSandboxResult {
  readonly status: "exited" | "failed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly failureKind?: "timed-out" | "output-limit-exceeded";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly image: string;
  readonly cliVersion: string;
  readonly bundledCatalogDigest: string;
  /** Private CLI session records, including child threads omitted from --json stdout. */
  readonly rollouts?: readonly string[];
  readonly rolloutFailure?: "capture-failed";
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
    readonly database?: { readonly host: string; readonly ipv4: string };
  };
  readonly campaignInput: CampaignInputV1;
  readonly sourceDirectory: string;
  readonly sourceTree: ExpectedSourceTree;
  readonly dependencySource?: {
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  };
  readonly expiresAt: string;
}
export interface DiscoveryTransportResult {
  readonly receipt: NativeRunReceipt;
  readonly attachment?: ProviderAttachmentRef;
  /** Each child is independent of the Root's final report and receipt. */
  readonly agentRuns?: readonly {
    readonly agentPath: string;
    readonly receipt: NativeRunReceipt;
    readonly attachment?: ProviderAttachmentRef;
  }[];
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
    database: z
      .strictObject({
        host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        ipv4: z.ipv4(),
      })
      .optional(),
  }),
  campaignInput: campaignInputV1Schema,
  sourceDirectory: z.string().min(1),
  sourceTree: z.strictObject({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  dependencySource: z
    .strictObject({
      directory: z.string().min(1),
      tree: z.strictObject({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        entries: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  expiresAt: z.iso.datetime({ offset: true }),
});

const event = z.looseObject({ type: z.string() });
const verificationReportSchema = z.strictObject({
  "http.json": z.string().nullable(),
  "steps.md": z.string().nullable(),
  "route.json": z.string().nullable(),
  "session.json": z.string().nullable(),
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
    "session.json": { type: ["string", "null"] },
    "refutation.md": { type: ["string", "null"] },
    precondition: { type: ["string", "null"] },
  },
  required: [
    "http.json",
    "steps.md",
    "route.json",
    "session.json",
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
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function rootThreadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      if (
        event?.type === "thread.started" &&
        typeof event.thread_id === "string"
      )
        return event.thread_id;
    } catch {
      // A broken final report does not hide the earlier thread identity.
    }
  }
  return undefined;
}

function isRootRollout(raw: string, threadId: string): boolean {
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (
        event?.type === "session_meta" &&
        payload?.id === threadId &&
        payload.source === "exec"
      )
        return true;
    } catch {
      // A later malformed event does not hide the session header.
    }
  }
  return false;
}

/** The Root's immutable rollout identifies the parent of archived child reports. */
export function rootThreadIdFromRollout(raw: string): string {
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (
        event?.type === "session_meta" &&
        payload?.source === "exec" &&
        typeof payload.id === "string"
      )
        ids.add(payload.id);
    } catch {
      // A malformed non-header line cannot create a parent identity.
    }
  }
  if (ids.size !== 1) throw new Error("Root rollout identity is ambiguous");
  return [...ids][0]!;
}

type ChildRollout = {
  readonly threadId: string;
  readonly agentPath: string;
  readonly modelId: string | undefined;
  readonly effort: string | undefined;
  readonly cyberAccessProgram: string | undefined;
  readonly usage: z.infer<typeof usageSchema> | undefined;
  readonly observed: Observed;
  readonly finalMessage: string | undefined;
  readonly startedAt: string;
  readonly completedAt: string;
};

function decodeChildRollout(
  raw: string,
  parentThreadId: string,
): ChildRollout | undefined {
  let threadId: string | undefined;
  let agentPath: string | undefined;
  let modelId: string | undefined;
  let effort: string | undefined;
  let cyberAccessProgram: string | undefined;
  let usage: z.infer<typeof usageSchema> | undefined;
  let finalMessage: string | undefined;
  let startedAt: string | undefined;
  let completedAt: string | undefined;
  const commands: ObservedCommand[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(line) as unknown);
    } catch {
      continue;
    }
    if (event === undefined) continue;
    const payload = object(event.payload);
    if (event.type === "session_meta") {
      const spawn = object(
        object(object(payload?.source)?.subagent)?.thread_spawn,
      );
      if (
        spawn?.parent_thread_id === parentThreadId &&
        spawn.depth === 1 &&
        typeof payload?.id === "string" &&
        typeof spawn.agent_path === "string"
      ) {
        threadId = payload.id;
        agentPath = spawn.agent_path;
        if (typeof event.timestamp === "string") startedAt = event.timestamp;
      }
    } else if (event.type === "turn_context") {
      if (typeof payload?.model === "string") modelId = payload.model;
      if (typeof payload?.effort === "string") effort = payload.effort;
      if (typeof payload?.cyber_access_program === "string")
        cyberAccessProgram = payload.cyber_access_program;
    } else if (event.type === "event_msg") {
      if (payload?.type === "token_count") {
        const parsed = usageSchema.safeParse(
          object(payload.info)?.total_token_usage,
        );
        if (parsed.success) usage = parsed.data;
      } else if (payload?.type === "item_completed") {
        const item = object(payload.item);
        if (item?.type === "CommandExecution" && Array.isArray(item.command))
          commands.push({
            text:
              item.command
                .filter((part): part is string => typeof part === "string")
                .at(-1) ?? "",
            ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
            ...(Array.isArray(item.parsed_cmd)
              ? { parsed: item.parsed_cmd }
              : {}),
          });
      } else if (payload?.type === "task_complete") {
        if (typeof payload.last_agent_message === "string")
          finalMessage = payload.last_agent_message;
        if (typeof event.timestamp === "string") completedAt = event.timestamp;
      }
    }
  }
  if (threadId === undefined || agentPath === undefined) return undefined;
  return {
    threadId,
    agentPath,
    modelId,
    effort,
    cyberAccessProgram,
    usage,
    observed: observedFromCommands(commands),
    finalMessage,
    startedAt: startedAt ?? new Date(0).toISOString(),
    completedAt: completedAt ?? startedAt ?? new Date(0).toISOString(),
  };
}

function parseChildFinalMessage(
  message: string,
): z.infer<typeof childReportSchema> {
  return childReportSchema.parse(JSON.parse(message) as unknown);
}

/** Reinterpret an archived child report only when its lineage and runtime match the receipt. */
export function recoverChildReportFromRollout(
  raw: string,
  expected: {
    readonly parentThreadId: string;
    readonly childThreadId: string;
    readonly agentPath: string;
    readonly modelId: string;
    readonly effort: string;
    readonly cyberAccessProgram: string;
  },
): z.infer<typeof childReportSchema> {
  const child = decodeChildRollout(raw, expected.parentThreadId);
  if (
    child === undefined ||
    child.threadId !== expected.childThreadId ||
    child.agentPath !== expected.agentPath ||
    child.modelId !== expected.modelId ||
    child.effort !== expected.effort ||
    child.cyberAccessProgram !== expected.cyberAccessProgram ||
    child.finalMessage === undefined
  )
    throw new Error("Archived child report lineage or runtime does not match");
  const report = parseChildFinalMessage(child.finalMessage);
  return {
    ...report,
    findings: report.findings.map(childClaim),
    leads: report.leads.map(childClaim),
  };
}
type Observed = NonNullable<NativeRunReceipt["observed"]>;
type ObservedCommand = {
  readonly text: string;
  readonly cwd?: string;
  readonly parsed?: readonly unknown[];
};
function sourcePath(path: string, cwd?: string): string | undefined {
  let directory = cwd;
  if (cwd?.startsWith("file://")) {
    try {
      directory = new URL(cwd).pathname;
    } catch {
      return undefined;
    }
  }
  const resolved = posix.resolve(directory ?? "/", path);
  return resolved.startsWith("/workspace/main/") ||
    resolved.startsWith("/workspace/wordpress/")
    ? resolved
    : undefined;
}
function observedFromCommands(
  commands: readonly (string | ObservedCommand)[],
): Observed {
  const paths = new Set<string>();
  let filesRead = 0;
  let labRequests = 0;
  let dbQueries = 0;
  for (const entry of commands) {
    const command = typeof entry === "string" ? entry : entry.text;
    const before = filesRead;
    if (typeof entry !== "string")
      for (const raw of entry.parsed ?? []) {
        const parsed = object(raw);
        if (
          (parsed?.type === "read" || parsed?.type === "search") &&
          typeof parsed.path === "string"
        ) {
          const path = sourcePath(parsed.path, entry.cwd);
          if (path !== undefined) {
            filesRead++;
            if (parsed.type === "read") paths.add(path);
          }
        }
      }
    if (filesRead === before)
      for (const match of command.matchAll(
        /\/workspace\/(?:main|wordpress)\/[^\s'"`;&|)]+/g,
      )) {
        filesRead++;
        paths.add(match[0]);
      }
    if (
      /(?:^|[\s;&|])(?:curl|wget|python|php)(?=\s|$)/.test(command) &&
      /\bwordpress\b/.test(command)
    )
      labRequests++;
    if (
      /(?:^|[\s;&|])(?:mysql|mariadb)(?=\s|$)/.test(command) &&
      /\bdatabase\b/.test(command)
    )
      dbQueries++;
  }
  return {
    toolCalls: commands.length,
    filesRead,
    uniqueFilesRead: paths.size,
    labRequests,
    dbQueries,
  };
}

function observedFromRollout(raw: string): Observed {
  const commands: ObservedCommand[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      const item = object(payload?.item);
      if (
        event?.type === "event_msg" &&
        payload?.type === "item_completed" &&
        item?.type === "CommandExecution" &&
        Array.isArray(item.command)
      ) {
        commands.push({
          text:
            item.command
              .filter((part): part is string => typeof part === "string")
              .at(-1) ?? "",
          ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
          ...(Array.isArray(item.parsed_cmd)
            ? { parsed: item.parsed_cmd }
            : {}),
        });
      }
    } catch {
      // Keep observations from other well-formed events.
    }
  }
  return observedFromCommands(commands);
}

function usageFromTranscript(
  stdout: string,
): NativeRunReceipt["usage"] | undefined {
  let usage: z.infer<typeof usageSchema> | undefined;
  for (const line of stdout.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      if (event?.type !== "turn.completed") continue;
      const parsed = usageSchema.safeParse(event.usage);
      if (parsed.success) usage = parsed.data;
    } catch {
      // A malformed report does not erase earlier usage.
    }
  }
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens ?? "unavailable",
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens ?? "unavailable",
  };
}
function usageFromRollout(raw: string): NativeRunReceipt["usage"] | undefined {
  let usage: z.infer<typeof usageSchema> | undefined;
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (event?.type !== "event_msg" || payload?.type !== "token_count")
        continue;
      const parsed = usageSchema.safeParse(
        object(payload.info)?.total_token_usage,
      );
      if (parsed.success) usage = parsed.data;
    } catch {
      // Earlier counters remain useful if a later event is malformed.
    }
  }
  return usage === undefined
    ? undefined
    : {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.cached_input_tokens ?? "unavailable",
        outputTokens: usage.output_tokens,
        reasoningOutputTokens: usage.reasoning_output_tokens ?? "unavailable",
      };
}
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
      observed: Observed;
    }
  | { reasonDetail: string } {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  let started = false;
  let completed = false;
  let report:
    | z.infer<typeof reportSchema>
    | z.infer<typeof verificationReportSchema>
    | undefined;
  let usage: ReturnType<typeof usageSchema.parse> | undefined;
  let finalMessage: string | undefined;
  const commands: string[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return { reasonDetail: "invalid-event-json" };
    }
    const parsed = event.safeParse(value);
    if (!parsed.success) return { reasonDetail: "invalid-event-shape" };
    if (parsed.data.type === "thread.started") {
      if (started) return { reasonDetail: "duplicate-thread-start" };
      started = true;
      continue;
    }
    if (parsed.data.type === "turn.started") continue;
    if (parsed.data.type === "turn.completed") {
      if (completed) return { reasonDetail: "duplicate-turn-completion" };
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
        return { reasonDetail: "invalid-item-shape" };
      if (
        item.type === "command_execution" &&
        parsed.data.type === "item.completed" &&
        "command" in item &&
        typeof item.command === "string"
      ) {
        commands.push(item.command);
      }
      if (
        item.type === "agent_message" &&
        parsed.data.type === "item.completed" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        // Earlier messages are progress notes; only the last is the report.
        finalMessage = item.text;
      } else if (
        ![
          "reasoning",
          "error",
          "agent_message",
          "command_execution",
          "collab_tool_call",
        ].includes(String(item.type))
      ) {
        // A tool not admitted by this transport makes the transcript unusable.
        const itemType = String(item.type);
        return {
          reasonDetail: `unadmitted-item-type:${/^[a-z][a-z_]{0,31}$/.test(itemType) ? itemType : "other"}`,
        };
      }
      continue;
    }
    return {
      reasonDetail: `unadmitted-event-type:${/^[a-z][a-z._-]{0,31}$/.test(parsed.data.type) ? parsed.data.type : "other"}`,
    };
  }
  if (!started) return { reasonDetail: "missing-thread-start" };
  if (!completed) return { reasonDetail: "missing-turn-completion" };
  if (finalMessage === undefined)
    return { reasonDetail: "missing-final-message" };
  try {
    const found = (
      outputKind === "verification" ? verificationReportSchema : reportSchema
    ).safeParse(JSON.parse(finalMessage) as unknown);
    if (!found.success) return { reasonDetail: "final-message-not-report" };
    report = found.data;
  } catch {
    return { reasonDetail: "final-message-not-report" };
  }
  return {
    report,
    usage: {
      inputTokens: usage?.input_tokens ?? "unavailable",
      cachedInputTokens: usage?.cached_input_tokens ?? "unavailable",
      outputTokens: usage?.output_tokens ?? "unavailable",
      reasoningOutputTokens: usage?.reasoning_output_tokens ?? "unavailable",
    },
    observed: observedFromCommands(commands),
  };
}

const failureEventSchema = z.union([
  z.looseObject({ type: z.literal("error"), message: z.string() }),
  z.looseObject({
    type: z.literal("turn.failed"),
    error: z.looseObject({ message: z.string() }),
  }),
]);

/**
 * How the CLI reaches the provider: an API key held by the broker, or the
 * host's ChatGPT login relayed by a TLS broker. Neither reaches the agent.
 */
const CODEX_AUTHENTICATION_METHODS: readonly string[] = [
  "host-private-bearer",
  "chatgpt-oauth-host",
];

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
    let agentRuns: NonNullable<DiscoveryTransportResult["agentRuns"]> = [];
    let rootDiagnosticArtifactDigest: string | undefined;
    let rootUsage: NativeRunReceipt["usage"] | undefined;
    let rootObserved: Observed | undefined;
    let brokerMetrics: NativeRunReceipt["brokerMetrics"];
    const cooperative =
      run.outputKind !== "verification" &&
      (run.profile.subagent.modelId !== "unavailable" ||
        run.profile.subagent.effort !== "unavailable");
    let sandboxExitCode: number | undefined;
    const incomplete = (
      reason: "provider" | "schema" | "sandbox" | "policy" | "evidence",
      completedAt = this.clock().toISOString(),
      grantReceiptDigest?: string,
      providerLimit?: "rate-limit" | "quota",
      reasonDetail?: string,
    ): DiscoveryTransportResult => ({
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "incomplete",
        reason,
        ...(reasonDetail === undefined ? {} : { reasonDetail }),
        ...(providerLimit === undefined ? {} : { providerLimit }),
        startedAt,
        completedAt,
        ...(grantReceiptDigest === undefined ? {} : { grantReceiptDigest }),
        ...(sandboxExitCode === undefined ? {} : { sandboxExitCode }),
        ...(rootDiagnosticArtifactDigest === undefined
          ? {}
          : { diagnosticArtifactDigest: rootDiagnosticArtifactDigest }),
        ...(rootUsage === undefined ? {} : { usage: rootUsage }),
        ...(rootObserved === undefined ? {} : { observed: rootObserved }),
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
      }),
      ...(cooperative ? { agentRuns } : {}),
    });
    if (
      !discoveryTransportRunSchema.safeParse(run).success ||
      run.campaignInput.snapshotDigest !== run.targetSnapshotDigest ||
      run.campaignInput.modelProfileDigest !== run.profile.digest ||
      admitAgentRuntimeProfile(run.profile, this.sandboxImage).status !==
        "admitted" ||
      run.prompt.length === 0 ||
      !isAbsolute(run.sourceDirectory) ||
      (run.dependencySource !== undefined &&
        !isAbsolute(run.dependencySource.directory)) ||
      !CODEX_AUTHENTICATION_METHODS.includes(
        run.profile.authenticationMethod,
      ) ||
      (cooperative &&
        admitCooperativeRuntimeProfile(run.profile, this.sandboxImage)
          .status !== "admitted")
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
          maxRequests: cooperative ? 400 : 100,
          maxRequestBytes: 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          expiresAt: run.expiresAt,
          agentNetworkName: run.lab.networkName,
        },
        async (grant) => {
          if (grant.dockerNetworkName !== run.lab.networkName)
            throw new Error("Provider grant is not on the Lab network");
          const login =
            run.profile.authenticationMethod === "chatgpt-oauth-host";
          if (
            login
              ? grant.tls === undefined ||
                grant.baseUrl !== `https://${grant.tls.hostname}:8080`
              : grant.tls !== undefined ||
                !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(grant.baseUrl)
          ) {
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
              ...(cooperative ? [] : ["--ephemeral"]),
              "-c",
              'approval_policy="never"',
              ...(run.profile.cyberAccessProgram === "unavailable"
                ? []
                : ["--cyber-access-program", run.profile.cyberAccessProgram]),
              "--ignore-user-config",
              "--ignore-rules",
              "--disable",
              "apps",
              "--disable",
              "remote_plugin",
              "--disable",
              "unified_exec",
              "-c",
              'web_search="disabled"',
              ...(cooperative
                ? [
                    "--enable",
                    "multi_agent",
                    "-c",
                    "agents.max_threads=3",
                    "-c",
                    "agents.max_depth=1",
                  ]
                : ["-c", "features.multi_agent=false"]),
              "-c",
              `model_reasoning_effort="${run.profile.requestedEffort}"`,
              ...(login
                ? [
                    "-c",
                    `chatgpt_base_url="${grant.baseUrl}/backend-api/"`,
                    // The broker reads the model from the body before forwarding.
                    "--disable",
                    "enable_request_compression",
                  ]
                : ["-c", `openai_base_url="${grant.baseUrl}/v1"`]),
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
            ...(run.dependencySource === undefined
              ? {}
              : {
                  dependencyMount: {
                    directory: run.dependencySource.directory,
                    path: "/workspace/wordpress" as const,
                    mode: "ro" as const,
                    expectedTree: run.dependencySource.tree,
                  },
                }),
            labHost: { name: labEndpoint.hostname, ipv4: run.lab.internalIp },
            ...(run.lab.database === undefined
              ? {}
              : {
                  databaseHost: {
                    name: run.lab.database.host,
                    ipv4: run.lab.database.ipv4,
                  },
                }),
          });
        },
      )
      .catch(() => undefined);
    if (granted === undefined) return incomplete("provider");
    brokerMetrics = granted.receipt.metrics;
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
    sandboxExitCode = result.exitCode;
    rootUsage = usageFromTranscript(result.stdout);
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
    if (cooperative && run.outputKind !== "verification") {
      if (result.rolloutFailure !== undefined)
        return incomplete(
          "evidence",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          "rollout-capture-failed",
        );
      const parentThreadId = rootThreadId(result.stdout);
      if (parentThreadId === undefined)
        return incomplete(
          "schema",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          "missing-root-thread-id",
        );
      const rootRollout = (result.rollouts ?? []).find((raw) =>
        isRootRollout(raw, parentThreadId),
      );
      if (rootRollout === undefined)
        return incomplete(
          "evidence",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          "root-rollout-missing",
        );
      try {
        const processDiagnostic =
          result.status === "failed" || result.exitCode !== 0
            ? `${rootRollout}\n${JSON.stringify({
                type: "sandbox_process_diagnostic",
                payload: {
                  status: result.status,
                  exitCode: result.exitCode,
                  failureKind: result.failureKind ?? null,
                  stderrTail: result.stderr?.slice(-64 * 1024) ?? "",
                  stdoutTail: result.stdout.slice(-64 * 1024),
                },
              })}`
            : rootRollout;
        rootDiagnosticArtifactDigest = (
          await this.attachments.put(
            "diagnostic",
            Buffer.from(processDiagnostic),
          )
        ).digest;
        rootObserved = observedFromRollout(rootRollout);
        rootUsage ??= usageFromRollout(rootRollout);
      } catch {
        return incomplete(
          "evidence",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          "root-rollout-unavailable",
        );
      }
      const seen = new Set<string>();
      const children: NonNullable<
        DiscoveryTransportResult["agentRuns"]
      >[number][] = [];
      for (const raw of result.rollouts ?? []) {
        const child = decodeChildRollout(raw, parentThreadId);
        if (child === undefined || seen.has(child.threadId)) continue;
        seen.add(child.threadId);
        let reason: "policy" | "schema" | "evidence" | undefined;
        let reasonDetail: string | undefined;
        if (
          child.modelId !== run.profile.subagent.modelId ||
          child.effort !== run.profile.subagent.effort ||
          child.cyberAccessProgram !== run.profile.cyberAccessProgram ||
          !/^\/root\/[a-z0-9_-]+$/.test(child.agentPath)
        ) {
          reason = "policy";
          reasonDetail = "child-profile-mismatch";
        }
        let diagnosticArtifactDigest: string | undefined;
        try {
          diagnosticArtifactDigest = (
            await this.attachments.put("diagnostic", Buffer.from(raw))
          ).digest;
        } catch {
          reason = "evidence";
          reasonDetail = "child-rollout-unavailable";
        }
        let attachment: ProviderAttachmentRef | undefined;
        if (reason === undefined) {
          try {
            const report = parseChildFinalMessage(child.finalMessage ?? "");
            attachment = await this.attachments.put(
              "findings",
              Buffer.from(
                canonicalJson({
                  ...report,
                  findings: report.findings.map(childClaim),
                  leads: report.leads.map(childClaim),
                }),
              ),
            );
          } catch {
            reason = "schema";
            reasonDetail = "child-final-message-not-report";
          }
        }
        const receipt = createNativeRunReceipt({
          ...run,
          runId: child.threadId,
          terminal: reason === undefined ? "completed" : "incomplete",
          reason: reason ?? "unavailable",
          ...(reasonDetail === undefined ? {} : { reasonDetail }),
          startedAt: child.startedAt,
          completedAt: child.completedAt,
          usage: {
            inputTokens: child.usage?.input_tokens ?? "unavailable",
            cachedInputTokens:
              child.usage?.cached_input_tokens ?? "unavailable",
            outputTokens: child.usage?.output_tokens ?? "unavailable",
            reasoningOutputTokens:
              child.usage?.reasoning_output_tokens ?? "unavailable",
          },
          observed: child.observed,
          grantReceiptDigest: granted.receipt.digest,
          ...(diagnosticArtifactDigest === undefined
            ? {}
            : { diagnosticArtifactDigest }),
          ...(attachment === undefined
            ? {}
            : { reportArtifactDigest: attachment.digest }),
        });
        children.push({
          agentPath: child.agentPath,
          receipt,
          ...(attachment === undefined ? {} : { attachment }),
        });
      }
      agentRuns = children;
      if (children.length > 3)
        return incomplete(
          "policy",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          "child-count-exceeded",
        );
    }
    const decoded =
      result.status === "exited" && result.exitCode === 0
        ? decodeTranscript(result.stdout, run.outputKind)
        : undefined;
    if ((brokerMetrics?.requestLimitExceeded ?? 0) > 0)
      return incomplete(
        "policy",
        result.completedAt,
        granted.receipt.digest,
        undefined,
        "broker-request-cap",
      );
    if (decoded === undefined || "reasonDetail" in decoded) {
      const limit = providerLimitOf(result.stdout);
      if (limit !== undefined)
        return incomplete(
          "provider",
          result.completedAt,
          granted.receipt.digest,
          limit,
          decoded === undefined
            ? `cli-exit:${result.exitCode}`
            : decoded.reasonDetail,
        );
    }
    if (result.status !== "exited" || result.exitCode !== 0)
      return incomplete(
        result.status === "failed" || result.exitCode === 137
          ? "sandbox"
          : "provider",
        result.completedAt,
        granted.receipt.digest,
        undefined,
        result.failureKind ?? `cli-exit:${result.exitCode}`,
      );
    if (decoded === undefined || "reasonDetail" in decoded)
      return incomplete(
        "schema",
        result.completedAt,
        granted.receipt.digest,
        undefined,
        decoded?.reasonDetail ?? "missing-transcript",
      );
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
      ...(cooperative ? { agentRuns } : {}),
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "completed",
        reason: "unavailable",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        usage: rootUsage ?? decoded.usage,
        observed: rootObserved ?? decoded.observed,
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        sandboxExitCode: result.exitCode,
        ...(rootDiagnosticArtifactDigest === undefined
          ? {}
          : { diagnosticArtifactDigest: rootDiagnosticArtifactDigest }),
        grantReceiptDigest: granted.receipt.digest,
        reportArtifactDigest: attachment.digest,
      }),
    };
  }
}
