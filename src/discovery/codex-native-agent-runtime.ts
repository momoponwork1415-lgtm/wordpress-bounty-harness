import { z } from "zod";
import { isAbsolute, posix } from "node:path";

import type { ExpectedSourceTree } from "../infrastructure/canonical-source-tree.js";
import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import { campaignInputV1Schema, type CampaignInputV1 } from "./campaign.js";
import {
  admitAgentRuntimeProfile,
  admitCooperativeRuntimeProfile,
  agentRuntimeProfileSchema,
  type AgentRuntimeProfile,
} from "./agent-runtime-profile.js";
import {
  codexThreadIdSchema,
  createNativeRunReceipt,
  isClaudeTranscriptPath,
  isCodexSessionPath,
  nativeRunReceiptSchema,
  type NativeRunAgentFields,
  type NativeRunReceipt,
  type NativeRunSession,
} from "./native-run-receipts.js";
import type {
  ProviderCredentialEgressBroker,
  ProviderCredentialEgressGrant,
  ProviderCredentialEgressResult,
} from "./provider-credential-egress-broker.js";
import {
  ProviderAttachmentStore,
  type ProviderAttachmentRef,
} from "./provider-research-report.js";
import { commandsFromRollout, type ObservedCommand } from "./read-paths.js";
import {
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountPathSchema,
  dependencyMountPathsAreDisjoint,
  dependencyMountPathsOf,
  mountedSourcePath,
  mountedSourcePathPattern,
} from "./sandbox-layout.js";

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
  /** Old v5/v6 Root reports carried an entry-index coverage record; still readable, never required (ADR 0034). */
  coverage: z.unknown().optional(),
});
/** Children are not constrained by Root's --output-schema; preserve structured coverage as text. */
const childCoverageSchema = z
  .union([
    z.string(),
    z.array(z.union([z.string(), z.record(z.string(), z.json())])),
  ])
  .transform((value) =>
    Array.isArray(value)
      ? value
          .map((entry) =>
            typeof entry === "string" ? entry : canonicalJson(entry),
          )
          .join("\n")
      : value,
  )
  .pipe(z.string().max(16_384));
const childReportSchema = z.strictObject({
  findings: z.array(z.unknown()),
  leads: z.array(z.unknown()),
  examined: childCoverageSchema,
  unexamined: childCoverageSchema,
});
const candidateReportSchema = z.object({
  findings: z.array(z.unknown()).default([]),
  leads: z.array(z.unknown()).default([]),
  examined: childCoverageSchema.default(""),
  unexamined: childCoverageSchema.default(""),
  coverage: z.unknown().optional(),
});
export function extractCandidateReport(message: string) {
  const value = JSON.parse(message) as unknown;
  const record = object(value);
  if (
    record === undefined ||
    (!Array.isArray(record.findings) && !Array.isArray(record.leads))
  )
    throw new Error("Final message has no candidate arrays");
  return candidateReportSchema.parse(value);
}
/** Every turn's report, merged: Root continuation turns and child follow-up turns alike. */
export function mergeTurnReports(messages: readonly string[]) {
  const reports: z.infer<typeof candidateReportSchema>[] = [];
  for (const message of messages) {
    try {
      reports.push(extractCandidateReport(message));
    } catch {
      // Progress prose and malformed interim reports are not candidates.
    }
  }
  const latest = reports.at(-1);
  if (latest === undefined) return undefined;
  const distinct = (key: "findings" | "leads") => {
    const seen = new Set<string>();
    return reports
      .flatMap((report) => report[key])
      .filter((claim) => {
        const identity = canonicalJson(claim);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
  };
  return {
    ...latest,
    findings: distinct("findings"),
    leads: distinct("leads"),
  };
}
/**
 * When the Root first handed in a readable report, and how many distinct
 * candidates its later turns added (A2). Turns without a time leave both out.
 */
export function finalReportTimeline(
  turns: readonly { readonly at?: unknown; readonly message: string }[],
): Pick<
  NativeRunAgentFields,
  "firstFinalReportAt" | "candidatesAfterFirstFinalReport"
> {
  let first: string | undefined;
  let after = 0;
  const seen = new Set<string>();
  for (const turn of turns) {
    let report;
    try {
      report = extractCandidateReport(turn.message);
    } catch {
      continue;
    }
    const later = first !== undefined;
    if (!later) {
      if (typeof turn.at !== "string" || !Number.isFinite(Date.parse(turn.at)))
        return {};
      first = new Date(turn.at).toISOString();
    }
    for (const claim of [
      ...report.findings.map((value) => `finding:${canonicalJson(value)}`),
      ...report.leads.map((value) => `lead:${canonicalJson(value)}`),
    ]) {
      if (seen.has(claim)) continue;
      seen.add(claim);
      if (later) after++;
    }
  }
  return first === undefined
    ? {}
    : { firstFinalReportAt: first, candidatesAfterFirstFinalReport: after };
}

/** Candidate extraction is independent of transcript event admission. */
function extractRootCandidateReport(stdout: string) {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const item = object(event?.item);
      if (
        event?.type === "item.completed" &&
        item?.type === "agent_message" &&
        typeof item.text === "string"
      )
        messages.push(item.text);
    } catch {
      // A malformed event does not erase a later final message.
    }
  }
  return mergeTurnReports(messages);
}

/** Each Root turn's final message in a rollout, with the time its `task_complete` was written. */
export function rootTurnsFromRollout(
  raw: string,
): { readonly at?: unknown; readonly message: string }[] {
  const turns: { at?: unknown; message: string }[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (
        event?.type === "event_msg" &&
        payload?.type === "task_complete" &&
        typeof payload.last_agent_message === "string"
      )
        turns.push({
          at: event.timestamp,
          message: payload.last_agent_message,
        });
    } catch {
      // An interrupted rollout can end with a partial line.
    }
  }
  return turns;
}

function extractRootCandidateReportFromRollout(raw: string) {
  return mergeTurnReports(
    rootTurnsFromRollout(raw).map((turn) => turn.message),
  );
}
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
export const reportJsonSchema = {
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

/** Files one earlier segment left behind, restored before a resumed Root starts (ADR 0036). */
export type CodexSandboxResumeSeed = {
  readonly threadId: string;
  /** Session files at their `sessions/`-relative paths; the Root's is among them. */
  readonly sessions: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  /** The Trial notes archive's complete files, relative to `/workspace/research`. */
  readonly research: readonly {
    readonly path: string;
    readonly content: Buffer;
  }[];
};
export interface CodexSandboxCommand {
  readonly executable: "codex";
  readonly args: readonly string[];
  readonly stdin: string;
  /** A cooperative discovery run resumes the same Root session until this wall floor. */
  readonly minimumActiveMs?: number;
  readonly resumeArgs?: readonly string[];
  readonly resumePrompt?: string;
  /** Operator-triggered resume: start with `exec resume <threadId>` on the restored session. */
  readonly resume?: CodexSandboxResumeSeed;
  /**
   * Names the run in a marker outside every mount, so a later process can find
   * this sandbox's directories when the host dies mid-run (ADR 0036, 2026-10-19
   * second addendum).
   */
  readonly runMarker?: {
    readonly runId: string;
    readonly runtimeProfileDigest: string;
  };
  readonly supportFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly grant: ProviderCredentialEgressGrant;
  readonly sourceMount: {
    readonly directory: string;
    readonly path: typeof SANDBOX_SOURCE_MOUNT_PATH;
    readonly mode: "ro";
    readonly expectedTree: ExpectedSourceTree;
  };
  /** The profile's primary dependency tree, at the mount path the run declares. */
  readonly dependencyMount?: {
    readonly directory: string;
    readonly path: string;
    readonly mode: "ro";
    readonly expectedTree: ExpectedSourceTree;
  };
  /** Additional profile supplied source trees, each sealed in the snapshot. */
  readonly additionalDependencyMounts?: readonly {
    readonly directory: string;
    readonly path: string;
    readonly mode: "ro";
    readonly expectedTree: ExpectedSourceTree;
  }[];
  readonly researchMount?: {
    readonly path: typeof SANDBOX_RESEARCH_MOUNT_PATH;
    readonly mode: "rw";
  };
  readonly labHost?: { readonly name: string; readonly ipv4: string };
  readonly databaseHost?: { readonly name: string; readonly ipv4: string };
  /** The exploration Lab's control endpoint (ADR 0003, 2026-10-25 addendum). */
  readonly controlHost?: { readonly name: string; readonly ipv4: string };
}
export interface CodexSandboxResult {
  readonly status: "exited" | "failed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
  readonly failureKind?: "timed-out" | "output-limit-exceeded" | "cancelled";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly image: string;
  readonly cliVersion: string;
  readonly bundledCatalogDigest: string;
  /** Private CLI session records, including child threads omitted from --json stdout. */
  readonly rollouts?: readonly string[];
  /** `rolloutPaths[i]` is the `sessions/`-relative path of `rollouts[i]`, when the sandbox reports it. */
  readonly rolloutPaths?: readonly string[];
  readonly rolloutFailure?: "capture-failed";
  /** Canonical JSON archive of the Trial-local writable notes directory. */
  readonly research?: { readonly archive: Buffer; readonly truncated: boolean };
  readonly researchFailure?: "capture-failed";
  readonly isolation: {
    readonly backend: "gvisor";
    readonly runtime: "runsc";
    readonly fallbackUsed: false;
  };
}
/**
 * What the sandbox of a run left on disk. `alive`: the process that started it
 * still runs on this boot. `found`: it is gone and the files are read back as
 * a failed result; `discard` removes them once they are sealed.
 */
export type CodexSandboxLeftover =
  | { readonly status: "absent" }
  | { readonly status: "alive" }
  | {
      readonly status: "found";
      readonly runtimeProfileDigest: string;
      readonly result: CodexSandboxResult;
      discard(): Promise<void>;
    };
/** The Lab module supplies this executor. This adapter has no host execution fallback. */
export interface CodexSandbox {
  execute(
    command: CodexSandboxCommand,
    signal?: AbortSignal,
  ): Promise<CodexSandboxResult>;
  /** Reads back the directories of a run whose marker names `runId`. */
  leftover?(runId: string): Promise<CodexSandboxLeftover>;
}
/** `recoverInterrupted`: the leftover sealed as an `interrupted` result, or why not. */
export type InterruptedRunRecovery =
  | { readonly status: "absent" }
  | { readonly status: "alive" }
  | { readonly status: "runtime-profile-differs"; readonly detail: string }
  | {
      readonly status: "recovered";
      readonly result: DiscoveryTransportResult;
      discard(): Promise<void>;
    };
/** ADR 0029: live children of one Root unless the campaign sets another ceiling. */
export const DEFAULT_MAX_CHILDREN = 4;
/** The highest ceiling a campaign may set (redesign 2026-10-25 §7). */
export const MAX_CHILDREN_LIMIT = 8;

export interface DiscoveryTransportRun {
  readonly runId: string;
  readonly targetSnapshotDigest: string;
  readonly profile: AgentRuntimeProfile;
  readonly prompt: string;
  /** Live children the Root may hold at once; absent, DEFAULT_MAX_CHILDREN. */
  readonly maxChildren?: number;
  /** A completed discovery report is not admitted before this active wall floor. */
  readonly minimumActiveMs?: number;
  /** A versioned excerpt already present in prompt, used only for early Root resumes. */
  readonly resumePrompt?: string;
  /**
   * Operator-triggered continuation of an earlier segment's Root thread in a
   * new sandbox (ADR 0036): the restored session files and notes, and which
   * segment this run is. Children listed here were recorded by earlier segments.
   */
  readonly resume?: DiscoveryResumeInput;
  /** Discovery requires the cooperative profile; absent, a run is cooperative whenever the profile permits children. */
  readonly coordination?: "cooperative";
  /** Verification uses the same isolated transport with a different sealed report. */
  readonly outputKind?: "verification";
  readonly lab?: {
    readonly endpoint: string;
    readonly networkName: string;
    /** The address the endpoint's host name resolves to inside the sandbox. */
    readonly internalIp: string;
    readonly database?: { readonly host: string; readonly ipv4: string };
    /** An exploration Lab's control endpoint (ADR 0003, 2026-10-25 addendum). */
    readonly control?: { readonly host: string; readonly ipv4: string };
  };
  readonly campaignInput: CampaignInputV1;
  readonly sourceDirectory: string;
  readonly sourceTree: ExpectedSourceTree;
  /** Mount paths come from the profile's sandbox layout declaration. */
  readonly dependencySource?: {
    readonly path: string;
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  };
  readonly dependencySources?: readonly {
    readonly path: string;
    readonly directory: string;
    readonly tree: ExpectedSourceTree;
  }[];
  readonly expiresAt: string;
}
export interface DiscoveryTransportResult {
  readonly receipt: NativeRunReceipt;
  readonly attachment?: ProviderAttachmentRef;
  readonly researchArtifact?: {
    readonly attachment: ProviderAttachmentRef;
    readonly truncated: boolean;
  };
  /** Each child is independent of the Root's final report and receipt. */
  readonly agentRuns?: readonly {
    readonly agentPath: string;
    readonly receipt: NativeRunReceipt;
    readonly attachment?: ProviderAttachmentRef;
  }[];
}

const discoveryResumeInputSchema = z.strictObject({
  threadId: codexThreadIdSchema,
  segment: z.number().int().positive().max(64),
  sessions: z
    .array(
      z.strictObject({
        /** A Codex rollout path or a Claude Code transcript path; each sandbox admits only its own. */
        path: z
          .string()
          .refine(
            (path) => isCodexSessionPath(path) || isClaudeTranscriptPath(path),
          ),
        threadId: codexThreadIdSchema,
        kind: z.enum(["root", "child"]),
        /** Sealed in Private Evidence by the earlier segment; carried forward unchanged. */
        diagnosticArtifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .max(256),
  research: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        contentBase64: z.string(),
      }),
    )
    .max(256),
});
export type DiscoveryResumeInput = z.infer<typeof discoveryResumeInputSchema>;

const discoveryTransportRunSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  targetSnapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  profile: agentRuntimeProfileSchema,
  prompt: z.string().min(1),
  maxChildren: z.number().int().min(1).max(MAX_CHILDREN_LIMIT).optional(),
  /** 0 is the `wide` mode: no active floor, the first turn only (ADR 0039). */
  minimumActiveMs: z
    .number()
    .int()
    .nonnegative()
    .max(120 * 60_000)
    .optional(),
  resumePrompt: z.string().min(1).max(2_048).optional(),
  resume: discoveryResumeInputSchema.optional(),
  coordination: z.literal("cooperative").optional(),
  outputKind: z.literal("verification").optional(),
  lab: z
    .strictObject({
      endpoint: z.url(),
      networkName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
      internalIp: z.ipv4(),
      database: z
        .strictObject({
          host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          ipv4: z.ipv4(),
        })
        .optional(),
      control: z
        .strictObject({
          host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          ipv4: z.ipv4(),
        })
        .optional(),
    })
    .optional(),
  campaignInput: campaignInputV1Schema,
  sourceDirectory: z.string().min(1),
  sourceTree: z.strictObject({
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  dependencySource: z
    .strictObject({
      path: dependencyMountPathSchema,
      directory: z.string().min(1),
      tree: z.strictObject({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        entries: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  dependencySources: z
    .array(
      z.strictObject({
        path: dependencyMountPathSchema,
        directory: z.string().min(1),
        tree: z.strictObject({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          entries: z.number().int().nonnegative(),
          bytes: z.number().int().nonnegative(),
        }),
      }),
    )
    .max(32)
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

/** Root turns the segment started; the runner prints one `thread.started` per turn. */
function rootTurnsStarted(stdout: string): number {
  let turns = 0;
  for (const line of stdout.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      if (event?.type === "thread.started") turns++;
    } catch {
      // Not a transcript event.
    }
  }
  return turns;
}

function rootThreadIdFromResult(
  result: CodexSandboxResult,
): string | undefined {
  const fromTranscript = rootThreadId(result.stdout);
  if (fromTranscript !== undefined) return fromTranscript;
  const ids = new Set<string>();
  for (const raw of result.rollouts ?? []) {
    try {
      ids.add(rootThreadIdFromRollout(raw));
    } catch {
      // Child rollouts have no Root exec identity.
    }
  }
  return ids.size === 1 ? [...ids][0] : undefined;
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

/** Keep provider refusal details typed without copying private error text to the ledger. */
function providerPolicyDetail(result: CodexSandboxResult): string | undefined {
  if (result.status === "exited" && result.exitCode === 0) return undefined;
  const threadId = rootThreadId(result.stdout);
  const rollout = result.rollouts?.find(
    (raw) => threadId !== undefined && isRootRollout(raw, threadId),
  );
  if (rollout === undefined) return undefined;
  let lastTaskCode: string | undefined;
  for (const line of rollout.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (event?.type !== "event_msg" || payload?.type !== "task_complete")
        continue;
      const error = object(payload.error);
      lastTaskCode =
        error?.codex_error_info === "cyber_policy"
          ? "provider-cyber-policy"
          : undefined;
    } catch {
      // An unrelated malformed rollout line cannot create a policy verdict.
    }
  }
  return lastTaskCode;
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
  /** `agent_role` of the spawn; the CLI writes null for the default role. */
  readonly agentRole: string | undefined;
  readonly modelId: string | undefined;
  readonly effort: string | undefined;
  readonly cyberAccessProgram: string | undefined;
  readonly usage: z.infer<typeof usageSchema> | undefined;
  readonly commands: readonly ObservedCommand[];
  readonly finalMessage: string | undefined;
  /** Each completed turn's final message, in order; a Root follow-up starts a new turn. */
  readonly turnMessages: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly captureTruncated: boolean;
};

function decodeChildRollout(
  raw: string,
  parentThreadId: string,
): ChildRollout | undefined {
  let threadId: string | undefined;
  let agentPath: string | undefined;
  let agentRole: string | undefined;
  let modelId: string | undefined;
  let effort: string | undefined;
  let cyberAccessProgram: string | undefined;
  let usage: z.infer<typeof usageSchema> | undefined;
  let finalMessage: string | undefined;
  const turnMessages: string[] = [];
  let startedAt: string | undefined;
  let completedAt: string | undefined;
  let captureTruncated = false;
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
        const role = spawn.agent_role ?? payload?.agent_role;
        if (typeof role === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(role))
          agentRole = role;
        if (typeof event.timestamp === "string") startedAt = event.timestamp;
      }
    } else if (event.type === "session_capture") {
      if (payload?.truncated === true) captureTruncated = true;
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
        if (typeof payload.last_agent_message === "string") {
          finalMessage = payload.last_agent_message;
          turnMessages.push(payload.last_agent_message);
        }
        if (typeof event.timestamp === "string") completedAt = event.timestamp;
      }
    }
  }
  if (threadId === undefined || agentPath === undefined) return undefined;
  return {
    threadId,
    agentPath,
    agentRole,
    modelId,
    effort,
    cyberAccessProgram,
    usage,
    commands,
    finalMessage,
    turnMessages,
    startedAt: startedAt ?? new Date(0).toISOString(),
    completedAt: completedAt ?? startedAt ?? new Date(0).toISOString(),
    captureTruncated,
  };
}

function parseChildFinalMessage(
  message: string,
): z.infer<typeof candidateReportSchema> {
  return extractCandidateReport(message);
}

/**
 * A child answers each Root follow-up with a new turn and a new report, so a
 * later prose reply or a failed last turn must not erase the earlier reports.
 * One report is kept as written; several are merged as Root turns are.
 */
function childTurnsReport(
  messages: readonly string[],
): z.infer<typeof candidateReportSchema> | undefined {
  const reports = messages.filter((message) => {
    try {
      extractCandidateReport(message);
      return true;
    } catch {
      return false;
    }
  });
  if (reports.length === 1) return parseChildFinalMessage(reports[0]!);
  return mergeTurnReports(reports);
}

/** Recover a final report from the receipt-bound private Root rollout. */
export function recoverRootReportFromRollout(raw: string) {
  let message: string | undefined;
  for (const line of raw.split("\n")) {
    try {
      const event = object(JSON.parse(line) as unknown);
      const payload = object(event?.payload);
      if (
        event?.type === "event_msg" &&
        payload?.type === "task_complete" &&
        typeof payload.last_agent_message === "string"
      )
        message = payload.last_agent_message;
    } catch {
      // The sealed diagnostic can include a process tail after the rollout.
    }
  }
  if (message === undefined)
    throw new Error("Archived Root final message is missing");
  return extractCandidateReport(message);
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
  const child = archivedChild(raw, expected);
  const report = parseChildFinalMessage(child.finalMessage);
  return {
    ...report,
    findings: report.findings.map(childClaim),
    leads: report.leads.map(childClaim),
  };
}

type ArchivedChildExpectation = Parameters<
  typeof recoverChildReportFromRollout
>[1];

function archivedChild(raw: string, expected: ArchivedChildExpectation) {
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
  return { ...child, finalMessage: child.finalMessage };
}

/**
 * An archived completed child, read as the capture now reads it: `recorded` is
 * the last-message report the capture stored before every turn was read, and
 * `merged` is every turn's report merged. Both stay as the child wrote them.
 */
export function recoverChildTurnReportsFromRollout(
  raw: string,
  expected: ArchivedChildExpectation,
): {
  readonly recorded: z.infer<typeof candidateReportSchema>;
  readonly merged: z.infer<typeof candidateReportSchema>;
} {
  const child = archivedChild(raw, expected);
  const merged = childTurnsReport(child.turnMessages);
  if (merged === undefined)
    throw new Error("Archived child has no turn report");
  return { recorded: parseChildFinalMessage(child.finalMessage), merged };
}
type Observed = NonNullable<NativeRunReceipt["observed"]>;
function sourcePath(
  path: string,
  cwd: string | undefined,
  dependencyMounts: readonly string[],
): string | undefined {
  let directory = cwd;
  if (cwd?.startsWith("file://")) {
    try {
      directory = new URL(cwd).pathname;
    } catch {
      return undefined;
    }
  }
  return mountedSourcePath(
    dependencyMounts,
    posix.resolve(directory ?? "/", path),
  );
}
/** Counts reads of the target source and the run's dependency mounts. */
export function observedFromCommands(
  commands: readonly (string | ObservedCommand)[],
  dependencyMounts: readonly string[],
): Observed {
  const mountedPath = mountedSourcePathPattern(dependencyMounts);
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
          const path = sourcePath(parsed.path, entry.cwd, dependencyMounts);
          if (path !== undefined) {
            filesRead++;
            if (parsed.type === "read") paths.add(path);
          }
        }
      }
    if (filesRead === before)
      for (const match of command.matchAll(mountedPath)) {
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

function observedFromRollout(
  raw: string,
  dependencyMounts: readonly string[],
): Observed {
  return observedFromCommands(commandsFromRollout(raw), dependencyMounts);
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
      if (parsed.success)
        usage =
          usage === undefined
            ? parsed.data
            : {
                input_tokens: usage.input_tokens + parsed.data.input_tokens,
                output_tokens: usage.output_tokens + parsed.data.output_tokens,
                ...(usage.cached_input_tokens === undefined ||
                parsed.data.cached_input_tokens === undefined
                  ? {}
                  : {
                      cached_input_tokens:
                        usage.cached_input_tokens +
                        parsed.data.cached_input_tokens,
                    }),
                ...(usage.reasoning_output_tokens === undefined ||
                parsed.data.reasoning_output_tokens === undefined
                  ? {}
                  : {
                      reasoning_output_tokens:
                        usage.reasoning_output_tokens +
                        parsed.data.reasoning_output_tokens,
                    }),
              };
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
  outputKind: "verification" | undefined,
  dependencyMounts: readonly string[],
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
  let threadId: string | undefined;
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
      const id = (parsed.data as Record<string, unknown>).thread_id;
      if (typeof id !== "string")
        return { reasonDetail: "invalid-thread-start" };
      if (threadId !== undefined && id !== threadId)
        return { reasonDetail: "changed-root-thread-id" };
      threadId = id;
      continue;
    }
    // The CLI reports a recovered stream error (a retry after a 429, "at
    // capacity" or a disconnect) as a top-level error event and goes on. The
    // turn's completion and final report below still decide the result; a
    // turn that does not recover ends with turn.failed, which stays fatal.
    if (parsed.data.type === "error") continue;
    if (parsed.data.type === "turn.started") {
      completed = false;
      finalMessage = undefined;
      continue;
    }
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
          // Notes created inside the disposable agent container do not alter
          // the pinned read-only source or the independently provisioned Lab.
          "file_change",
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
      // The receipt admits no dots, so `turn.failed` is recorded as `turn-failed`.
      reasonDetail: `unadmitted-event-type:${/^[a-z][a-z._-]{0,31}$/.test(parsed.data.type) ? parsed.data.type.replaceAll(".", "-") : "other"}`,
    };
  }
  if (threadId === undefined) return { reasonDetail: "missing-thread-start" };
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
    observed: observedFromCommands(commands, dependencyMounts),
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
    // "Selected model is at capacity" (server_overloaded) passes like a 429.
    if (
      /\b429\b|too many requests|rate[ _-]?limit|at capacity|overloaded/i.test(
        message,
      )
    )
      limit = "rate-limit";
  }
  return limit;
}

/** A broker body-size rejection is a Harness bound, not a provider failure. */
function brokerRequestBytesExceeded(stdout: string): boolean {
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
    if (/\b413\b/.test(message) && message.includes("request-limit-exceeded"))
      return true;
  }
  return false;
}

type AgentRun = NonNullable<DiscoveryTransportResult["agentRuns"]>[number];
type IncompleteReason =
  | "provider"
  | "schema"
  | "sandbox"
  | "policy"
  | "evidence"
  | "wall"
  | "operator"
  | "interrupted";
type GrantedSandboxRun = ProviderCredentialEgressResult<CodexSandboxResult>;
type ExecutionState = {
  readonly run: DiscoveryTransportRun;
  readonly startedAt: string;
  readonly cooperative: boolean;
  agentRuns: readonly AgentRun[];
  childThreadsObserved: number | undefined;
  childThreadsAdmitted: number | undefined;
  rootDiagnosticArtifactDigest: string | undefined;
  rootUsage: NativeRunReceipt["usage"] | undefined;
  rootObserved: Observed | undefined;
  brokerMetrics: NativeRunReceipt["brokerMetrics"] | undefined;
  sandboxExitCode: number | undefined;
  /** Root thread, segment and session files; set once the Root rollout is captured. */
  session: NativeRunSession | undefined;
  /** Role and first-report timeline of a cooperative Root; set with the Root rollout. */
  rootAgent: NativeRunAgentFields;
  childSessionFiles: NativeRunSession["files"];
  researchArtifact:
    | {
        readonly attachment: ProviderAttachmentRef;
        readonly truncated: boolean;
      }
    | undefined;
};

function executionState(
  run: DiscoveryTransportRun,
  startedAt: string,
): ExecutionState {
  return {
    run,
    startedAt,
    cooperative: cooperativeRun(run),
    agentRuns: [],
    childThreadsObserved: undefined,
    childThreadsAdmitted: undefined,
    rootDiagnosticArtifactDigest: undefined,
    rootUsage: undefined,
    rootObserved: undefined,
    brokerMetrics: undefined,
    sandboxExitCode: undefined,
    session: undefined,
    rootAgent: {},
    childSessionFiles: [],
    researchArtifact: undefined,
  };
}

function incompleteExecution(
  state: ExecutionState,
  reason: IncompleteReason,
  completedAt: string,
  grantReceiptDigest?: string,
  providerLimit?: "rate-limit" | "quota",
  reasonDetail?: string,
  attachment?: ProviderAttachmentRef,
): DiscoveryTransportResult {
  return {
    receipt: createNativeRunReceipt({
      ...state.run,
      terminal: "incomplete",
      reason,
      ...(reasonDetail === undefined ? {} : { reasonDetail }),
      ...(providerLimit === undefined ? {} : { providerLimit }),
      startedAt: state.startedAt,
      completedAt,
      ...state.rootAgent,
      ...(grantReceiptDigest === undefined ? {} : { grantReceiptDigest }),
      ...(state.sandboxExitCode === undefined
        ? {}
        : { sandboxExitCode: state.sandboxExitCode }),
      ...(state.rootDiagnosticArtifactDigest === undefined
        ? {}
        : { diagnosticArtifactDigest: state.rootDiagnosticArtifactDigest }),
      ...(state.session === undefined ? {} : { session: state.session }),
      ...(state.rootUsage === undefined ? {} : { usage: state.rootUsage }),
      ...(state.rootObserved === undefined
        ? {}
        : { observed: state.rootObserved }),
      ...(state.childThreadsObserved === undefined
        ? {}
        : { childThreadsObserved: state.childThreadsObserved }),
      ...(state.childThreadsAdmitted === undefined
        ? {}
        : { childThreadsAdmitted: state.childThreadsAdmitted }),
      ...(state.brokerMetrics === undefined
        ? {}
        : { brokerMetrics: state.brokerMetrics }),
      ...(attachment === undefined
        ? {}
        : { reportArtifactDigest: attachment.digest }),
    }),
    ...(attachment === undefined ? {} : { attachment }),
    ...(state.researchArtifact === undefined
      ? {}
      : { researchArtifact: state.researchArtifact }),
    ...(state.cooperative ? { agentRuns: state.agentRuns } : {}),
  };
}

function cooperativeRun(run: DiscoveryTransportRun): boolean {
  return (
    run.outputKind !== "verification" &&
    (run.profile.subagent.modelId !== "unavailable" ||
      run.profile.subagent.effort !== "unavailable")
  );
}

function admittedRun(
  run: DiscoveryTransportRun,
  sandboxImage: string,
  cooperative: boolean,
): boolean {
  return (
    discoveryTransportRunSchema.safeParse(run).success &&
    run.campaignInput.snapshotDigest === run.targetSnapshotDigest &&
    run.campaignInput.modelProfileDigest === run.profile.digest &&
    (run.lab === undefined) ===
      ("mode" in run.campaignInput.lab &&
        run.campaignInput.lab.mode === "none") &&
    admitAgentRuntimeProfile(run.profile, sandboxImage).status === "admitted" &&
    run.prompt.length > 0 &&
    (run.minimumActiveMs === undefined ||
      (cooperative && run.outputKind !== "verification")) &&
    (run.resumePrompt === undefined ||
      (run.minimumActiveMs !== undefined &&
        run.prompt.includes(run.resumePrompt))) &&
    (run.resume === undefined ||
      (cooperative &&
        run.minimumActiveMs !== undefined &&
        run.resumePrompt !== undefined &&
        run.resume.sessions.every((file) => isCodexSessionPath(file.path)) &&
        run.resume.sessions.some(
          (file) =>
            file.kind === "root" && file.threadId === run.resume?.threadId,
        ))) &&
    isAbsolute(run.sourceDirectory) &&
    (run.dependencySource === undefined ||
      isAbsolute(run.dependencySource.directory)) &&
    (run.dependencySources === undefined ||
      run.dependencySources.every((source) => isAbsolute(source.directory))) &&
    dependencyMountPathsAreDisjoint(dependencyMountPathsOf(run)) &&
    CODEX_AUTHENTICATION_METHODS.includes(run.profile.authenticationMethod) &&
    (!cooperative ||
      admitCooperativeRuntimeProfile(run.profile, sandboxImage).status ===
        "admitted")
  );
}

function admittedLabEndpoint(run: DiscoveryTransportRun): URL | undefined {
  if (run.lab === undefined) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(run.lab.endpoint);
  } catch {
    return undefined;
  }
  return endpoint.protocol === "http:" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint.hostname) &&
    endpoint.username === "" &&
    endpoint.password === ""
    ? endpoint
    : undefined;
}

function sandboxAdmissionFailure(
  result: CodexSandboxResult,
  run: DiscoveryTransportRun,
  sandboxImage: string,
): "sandbox" | "policy" | undefined {
  if (
    result.isolation.backend !== "gvisor" ||
    result.isolation.runtime !== "runsc" ||
    result.isolation.fallbackUsed !== false
  )
    return "sandbox";
  if (
    result.image !== sandboxImage ||
    result.cliVersion !== run.profile.codexCliVersion ||
    result.bundledCatalogDigest !== run.profile.bundledCatalogDigest
  )
    return "policy";
  return undefined;
}

function assertBrokerAddress(
  grant: ProviderCredentialEgressGrant,
  run: DiscoveryTransportRun,
): boolean {
  if (run.lab !== undefined && grant.dockerNetworkName !== run.lab.networkName)
    throw new Error("Provider grant is not on the Lab network");
  const login = run.profile.authenticationMethod === "chatgpt-oauth-host";
  if (
    login
      ? grant.tls === undefined ||
        grant.baseUrl !== `https://${grant.tls.hostname}:8080`
      : grant.tls !== undefined ||
        !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(grant.baseUrl)
  )
    throw new Error("Provider broker address is invalid");
  return login;
}

function codexArgs(
  run: DiscoveryTransportRun,
  grant: ProviderCredentialEgressGrant,
  cooperative: boolean,
  login: boolean,
): string[] {
  return [
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
          `agents.max_threads=${run.maxChildren ?? DEFAULT_MAX_CHILDREN}`,
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
  ];
}

function codexResumeArgs(
  run: DiscoveryTransportRun,
  grant: ProviderCredentialEgressGrant,
  login: boolean,
): string[] {
  return [
    "exec",
    "resume",
    "--model",
    run.profile.requestedModelId,
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    ...(run.profile.cyberAccessProgram === "unavailable"
      ? []
      : ["--cyber-access-program", run.profile.cyberAccessProgram]),
    "--disable",
    "apps",
    "--disable",
    "remote_plugin",
    "--disable",
    "unified_exec",
    "-c",
    'web_search="disabled"',
    "--enable",
    "multi_agent",
    "-c",
    `agents.max_threads=${run.maxChildren ?? DEFAULT_MAX_CHILDREN}`,
    "-c",
    "agents.max_depth=1",
    "-c",
    `model_reasoning_effort="${run.profile.requestedEffort}"`,
    ...(login
      ? [
          "-c",
          `chatgpt_base_url="${grant.baseUrl}/backend-api/"`,
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
  ];
}

function sandboxCommand(
  run: DiscoveryTransportRun,
  grant: ProviderCredentialEgressGrant,
  cooperative: boolean,
  labEndpoint: URL | undefined,
  login: boolean,
): CodexSandboxCommand {
  return {
    executable: "codex",
    args: codexArgs(run, grant, cooperative, login),
    ...(run.minimumActiveMs === undefined
      ? {}
      : {
          minimumActiveMs: run.minimumActiveMs,
          resumeArgs: codexResumeArgs(run, grant, login),
          resumePrompt: run.resumePrompt ?? run.prompt,
          runMarker: {
            runId: run.runId,
            runtimeProfileDigest: run.profile.digest,
          },
        }),
    ...(run.resume === undefined
      ? {}
      : {
          resume: {
            threadId: run.resume.threadId,
            sessions: run.resume.sessions.map(({ path, content }) => ({
              path,
              content,
            })),
            research: run.resume.research.map(({ path, contentBase64 }) => ({
              path,
              content: Buffer.from(contentBase64, "base64"),
            })),
          },
        }),
    stdin: run.prompt,
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
      path: SANDBOX_SOURCE_MOUNT_PATH,
      mode: "ro",
      expectedTree: run.sourceTree,
    },
    ...(run.dependencySource === undefined
      ? {}
      : {
          dependencyMount: {
            directory: run.dependencySource.directory,
            path: run.dependencySource.path,
            mode: "ro" as const,
            expectedTree: run.dependencySource.tree,
          },
        }),
    ...(run.dependencySources === undefined
      ? {}
      : {
          additionalDependencyMounts: run.dependencySources.map((source) => ({
            directory: source.directory,
            path: source.path,
            mode: "ro" as const,
            expectedTree: source.tree,
          })),
        }),
    ...(cooperative
      ? {
          researchMount: {
            path: SANDBOX_RESEARCH_MOUNT_PATH,
            mode: "rw" as const,
          },
        }
      : {}),
    ...(labEndpoint === undefined || run.lab === undefined
      ? {}
      : { labHost: { name: labEndpoint.hostname, ipv4: run.lab.internalIp } }),
    ...(run.lab?.database === undefined
      ? {}
      : {
          databaseHost: {
            name: run.lab.database.host,
            ipv4: run.lab.database.ipv4,
          },
        }),
    ...(run.lab?.control === undefined
      ? {}
      : {
          controlHost: {
            name: run.lab.control.host,
            ipv4: run.lab.control.ipv4,
          },
        }),
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

  async execute(
    run: DiscoveryTransportRun,
    signal?: AbortSignal,
  ): Promise<DiscoveryTransportResult> {
    const state = executionState(run, this.clock().toISOString());
    if (run.coordination === "cooperative" && !state.cooperative)
      return incompleteExecution(
        state,
        "policy",
        this.clock().toISOString(),
        undefined,
        undefined,
        "cooperative-profile-unavailable",
      );
    if (!admittedRun(run, this.sandboxImage, state.cooperative))
      return incompleteExecution(state, "policy", this.clock().toISOString());
    const labEndpoint = admittedLabEndpoint(run);
    if (run.lab !== undefined && labEndpoint === undefined)
      return incompleteExecution(state, "policy", this.clock().toISOString());
    const granted = await this.#runWithBroker(
      run,
      state.cooperative,
      labEndpoint,
      signal,
    );
    if (granted === undefined)
      return incompleteExecution(
        state,
        signal?.aborted
          ? signal.reason === "operator"
            ? "operator"
            : "wall"
          : "provider",
        this.clock().toISOString(),
      );
    state.brokerMetrics = granted.receipt.metrics;
    if (
      granted.receipt.setup.status !== "ready" ||
      granted.operation.status !== "completed"
    )
      return incompleteExecution(
        state,
        "provider",
        this.clock().toISOString(),
        granted.receipt.digest,
      );
    const result = granted.operation.value;
    state.sandboxExitCode = result.exitCode;
    state.rootUsage = usageFromTranscript(result.stdout);
    const admissionFailure = sandboxAdmissionFailure(
      result,
      run,
      this.sandboxImage,
    );
    if (admissionFailure !== undefined)
      return incompleteExecution(
        state,
        admissionFailure,
        result.completedAt,
        granted.receipt.digest,
      );
    if (state.cooperative) {
      const failure = await this.#collectCooperativeEvidence(
        state,
        result,
        granted.receipt.digest,
      );
      if (
        result.failureKind === "timed-out" ||
        result.failureKind === "cancelled"
      ) {
        const attachment = await this.#retainRootCandidate(result);
        return incompleteExecution(
          state,
          result.failureKind === "timed-out" ? "wall" : "operator",
          result.completedAt,
          granted.receipt.digest,
          undefined,
          undefined,
          attachment,
        );
      }
      if (failure !== undefined)
        return this.#retainRootOnIncomplete(
          result,
          incompleteExecution(
            state,
            failure.reason,
            result.completedAt,
            granted.receipt.digest,
            undefined,
            failure.reasonDetail,
          ),
        );
    }
    if (
      result.failureKind === "timed-out" ||
      result.failureKind === "cancelled"
    )
      return incompleteExecution(
        state,
        result.failureKind === "timed-out" ? "wall" : "operator",
        result.completedAt,
        granted.receipt.digest,
      );
    if (granted.receipt.cleanup.status !== "completed")
      return this.#retainRootOnIncomplete(
        result,
        incompleteExecution(
          state,
          "provider",
          result.completedAt,
          granted.receipt.digest,
        ),
      );
    return this.#resolveReport(state, result, granted.receipt.digest);
  }

  /**
   * A cooperative run whose host process died before it finished (ADR 0036,
   * 2026-10-19 second addendum): its sandbox's leftover rollouts and notes are
   * sealed exactly as a failed sandbox result is, under the reason
   * `interrupted`. Nothing runs. `startedAt` is the run's ledger start.
   */
  async recoverInterrupted(
    run: DiscoveryTransportRun,
    startedAt: string,
  ): Promise<InterruptedRunRecovery> {
    const leftover = (await this.sandbox.leftover?.(run.runId)) ?? {
      status: "absent" as const,
    };
    if (leftover.status !== "found") return leftover;
    if (leftover.runtimeProfileDigest !== run.profile.digest)
      return {
        status: "runtime-profile-differs",
        detail: leftover.runtimeProfileDigest,
      };
    const state = executionState(run, startedAt);
    if (!state.cooperative) return { status: "absent" };
    const failure = await this.#collectCooperativeEvidence(
      state,
      leftover.result,
      "unavailable",
    );
    // Without the Root's session nothing could be resumed; record nothing.
    if (state.session === undefined) return { status: "absent" };
    return {
      status: "recovered",
      result: await this.#retainRootOnIncomplete(
        leftover.result,
        incompleteExecution(
          state,
          "interrupted",
          leftover.result.completedAt,
          undefined,
          undefined,
          failure?.reasonDetail,
        ),
      ),
      discard: () => leftover.discard(),
    };
  }

  async #runWithBroker(
    run: DiscoveryTransportRun,
    cooperative: boolean,
    labEndpoint: URL | undefined,
    signal?: AbortSignal,
  ): Promise<GrantedSandboxRun | undefined> {
    return this.broker
      .withGrant(
        {
          schemaVersion: 1,
          runtimeProfileDigest: run.profile.digest,
          model: run.profile.requestedModelId,
          protocol: "responses",
          maxRequests: cooperative ? 2000 : 100,
          maxRequestBytes: cooperative ? 8 * 1024 * 1024 : 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          expiresAt: run.expiresAt,
          ...(run.lab === undefined
            ? {}
            : { agentNetworkName: run.lab.networkName }),
        },
        async (grant) => {
          const login = assertBrokerAddress(grant, run);
          return this.sandbox.execute(
            sandboxCommand(run, grant, cooperative, labEndpoint, login),
            signal,
          );
        },
        signal,
      )
      .catch(() => undefined);
  }

  async #collectCooperativeEvidence(
    state: ExecutionState,
    result: CodexSandboxResult,
    grantReceiptDigest: string,
  ): Promise<{ reason: IncompleteReason; reasonDetail: string } | undefined> {
    const parentThreadId = rootThreadIdFromResult(result);
    if (parentThreadId !== undefined) {
      const children = await this.#captureChildren(
        state.run,
        result,
        parentThreadId,
        grantReceiptDigest,
      );
      state.agentRuns = children.agentRuns;
      state.childThreadsObserved = children.observed;
      state.childThreadsAdmitted = children.admitted;
      state.childSessionFiles = children.sessionFiles;
      if (children.observed > 255)
        return {
          reason: "evidence",
          reasonDetail: "child-session-limit-exceeded",
        };
    }
    if (result.researchFailure !== undefined || result.research === undefined)
      return { reason: "evidence", reasonDetail: "research-capture-failed" };
    try {
      state.researchArtifact = {
        attachment: await this.attachments.put(
          "research",
          result.research.archive,
        ),
        truncated: result.research.truncated,
      };
    } catch {
      return { reason: "evidence", reasonDetail: "research-capture-failed" };
    }
    if (result.rolloutFailure !== undefined)
      return { reason: "evidence", reasonDetail: "rollout-capture-failed" };
    if (parentThreadId === undefined)
      return { reason: "schema", reasonDetail: "missing-root-thread-id" };
    const rootIndex = (result.rollouts ?? []).findIndex((raw) =>
      isRootRollout(raw, parentThreadId),
    );
    const rootRollout = result.rollouts?.[rootIndex];
    if (rootRollout === undefined)
      return { reason: "evidence", reasonDetail: "root-rollout-missing" };
    try {
      await this.#captureRootRollout(state, result, rootRollout);
    } catch {
      return { reason: "evidence", reasonDetail: "root-rollout-unavailable" };
    }
    this.#recordSession(state, result, parentThreadId, rootIndex);
    return undefined;
  }

  /**
   * The receipt names the Root thread and every session file Private Evidence
   * holds for it, so an operator can restore the thread later (ADR 0036).
   * Children of earlier segments keep the digests those segments sealed.
   */
  #recordSession(
    state: ExecutionState,
    result: CodexSandboxResult,
    rootThreadId: string,
    rootIndex: number,
  ): void {
    const rootPath = result.rolloutPaths?.[rootIndex];
    const rootDigest = state.rootDiagnosticArtifactDigest;
    if (
      rootPath === undefined ||
      !isCodexSessionPath(rootPath) ||
      rootDigest === undefined
    )
      return;
    const priorChildren = (state.run.resume?.sessions ?? [])
      .filter((file) => file.kind === "child")
      .map(({ path, threadId, diagnosticArtifactDigest }) => ({
        path,
        threadId,
        kind: "child" as const,
        diagnosticArtifactDigest,
      }));
    state.session = {
      rootThreadId,
      rootTurns: rootTurnsStarted(result.stdout),
      segment: state.run.resume?.segment ?? 0,
      files: [
        {
          path: rootPath,
          threadId: rootThreadId,
          kind: "root" as const,
          diagnosticArtifactDigest: rootDigest,
        },
        ...priorChildren,
        ...state.childSessionFiles,
      ].slice(0, 256),
    };
  }

  async #retainRootCandidate(
    result: CodexSandboxResult,
  ): Promise<ProviderAttachmentRef | undefined> {
    let report = extractRootCandidateReport(result.stdout);
    if (report === undefined) {
      const threadId = rootThreadIdFromResult(result);
      const rollout = result.rollouts?.find(
        (raw) => threadId !== undefined && isRootRollout(raw, threadId),
      );
      if (rollout !== undefined)
        report = extractRootCandidateReportFromRollout(rollout);
    }
    if (report === undefined) return undefined;
    try {
      return await this.attachments.put(
        "findings",
        Buffer.from(canonicalJson(report)),
      );
    } catch {
      return undefined;
    }
  }

  /** A later failure must not erase a report from an earlier Root turn. */
  async #retainRootOnIncomplete(
    result: CodexSandboxResult,
    failure: DiscoveryTransportResult,
  ): Promise<DiscoveryTransportResult> {
    if (
      failure.receipt.terminal !== "incomplete" ||
      failure.attachment !== undefined
    )
      return failure;
    const attachment = await this.#retainRootCandidate(result);
    if (attachment === undefined) return failure;
    const { digest: _priorDigest, ...body } = failure.receipt;
    const bound = { ...body, reportArtifactDigest: attachment.digest };
    return {
      ...failure,
      attachment,
      receipt: nativeRunReceiptSchema.parse({
        ...bound,
        digest: canonicalDigest(bound),
      }),
    };
  }

  async #captureRootRollout(
    state: ExecutionState,
    result: CodexSandboxResult,
    rootRollout: string,
  ): Promise<void> {
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
    state.rootDiagnosticArtifactDigest = (
      await this.attachments.put("diagnostic", Buffer.from(processDiagnostic))
    ).digest;
    state.rootObserved = observedFromRollout(
      rootRollout,
      dependencyMountPathsOf(state.run),
    );
    state.rootUsage ??= usageFromRollout(rootRollout);
    if (state.cooperative)
      state.rootAgent = {
        agentRole: "root",
        ...finalReportTimeline(rootTurnsFromRollout(rootRollout)),
      };
  }

  async #captureChildren(
    run: DiscoveryTransportRun,
    result: CodexSandboxResult,
    parentThreadId: string,
    grantReceiptDigest: string,
  ): Promise<{
    agentRuns: AgentRun[];
    observed: number;
    admitted: number;
    sessionFiles: NativeRunSession["files"];
  }> {
    // Children restored from an earlier segment were recorded by that segment.
    const seen = new Set<string>(
      (run.resume?.sessions ?? [])
        .filter((file) => file.kind === "child")
        .map((file) => file.threadId),
    );
    const children: { child: ChildRollout; raw: string; order: number }[] = [];
    for (const [order, raw] of (result.rollouts ?? []).entries()) {
      const child = decodeChildRollout(raw, parentThreadId);
      if (child === undefined || seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      children.push({ child, raw, order });
    }
    children.sort((left, right) => {
      const byStart = left.child.startedAt.localeCompare(right.child.startedAt);
      return byStart || left.order - right.order;
    });
    // max_threads bounds live children, not the number of waves in a Trial.
    const admitted = children.slice(0, 255);
    const agentRuns: AgentRun[] = [];
    const sessionFiles: NativeRunSession["files"][number][] = [];
    for (const { child, raw, order } of admitted) {
      const agentRun = await this.#captureChild(
        run,
        child,
        raw,
        grantReceiptDigest,
      );
      agentRuns.push(agentRun);
      const path = result.rolloutPaths?.[order];
      const digest = agentRun.receipt.diagnosticArtifactDigest;
      if (
        !child.captureTruncated &&
        path !== undefined &&
        isCodexSessionPath(path) &&
        digest !== undefined
      )
        sessionFiles.push({
          path,
          threadId: child.threadId,
          kind: "child",
          diagnosticArtifactDigest: digest,
        });
    }
    return {
      agentRuns,
      observed: children.length,
      admitted: admitted.filter(({ child }) => !child.captureTruncated).length,
      sessionFiles,
    };
  }

  async #captureChild(
    run: DiscoveryTransportRun,
    child: ChildRollout,
    raw: string,
    grantReceiptDigest: string,
  ): Promise<AgentRun> {
    let reason: "policy" | "schema" | "evidence" | undefined;
    let reasonDetail: string | undefined;
    if (child.captureTruncated) {
      reason = "evidence";
      reasonDetail = "child-rollout-truncated";
    } else if (
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
        const report = childTurnsReport(child.turnMessages);
        if (report === undefined)
          throw new Error("No child turn ended with a report");
        attachment = await this.attachments.put(
          "findings",
          Buffer.from(canonicalJson(report)),
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
      agentRole: "child",
      agentType: child.agentRole ?? "unavailable",
      // spawn_agent / followup_task messages are encrypted in the rollout.
      delegationDigest: "unavailable",
      usage: {
        inputTokens: child.usage?.input_tokens ?? "unavailable",
        cachedInputTokens: child.usage?.cached_input_tokens ?? "unavailable",
        outputTokens: child.usage?.output_tokens ?? "unavailable",
        reasoningOutputTokens:
          child.usage?.reasoning_output_tokens ?? "unavailable",
      },
      observed: observedFromCommands(
        child.commands,
        dependencyMountPathsOf(run),
      ),
      grantReceiptDigest,
      ...(diagnosticArtifactDigest === undefined
        ? {}
        : { diagnosticArtifactDigest }),
      ...(attachment === undefined
        ? {}
        : { reportArtifactDigest: attachment.digest }),
    });
    return {
      agentPath: child.agentPath,
      receipt,
      ...(attachment === undefined ? {} : { attachment }),
    };
  }

  async #resolveReport(
    state: ExecutionState,
    result: CodexSandboxResult,
    grantReceiptDigest: string,
  ): Promise<DiscoveryTransportResult> {
    const decoded =
      result.status === "exited" && result.exitCode === 0
        ? decodeTranscript(
            result.stdout,
            state.run.outputKind,
            dependencyMountPathsOf(state.run),
          )
        : undefined;
    const failure = this.#executionFailure(
      state,
      result,
      grantReceiptDigest,
      decoded,
    );
    if (failure !== undefined)
      return this.#retainRootOnIncomplete(result, failure);
    if (decoded === undefined || "reasonDetail" in decoded)
      return this.#salvageRootReport(
        state,
        result,
        grantReceiptDigest,
        decoded?.reasonDetail ?? "missing-transcript",
      );
    return this.#completeReport(state, result, grantReceiptDigest, decoded);
  }

  #executionFailure(
    state: ExecutionState,
    result: CodexSandboxResult,
    grantReceiptDigest: string,
    decoded: ReturnType<typeof decodeTranscript> | undefined,
  ): DiscoveryTransportResult | undefined {
    if ((state.brokerMetrics?.requestLimitExceeded ?? 0) > 0)
      return incompleteExecution(
        state,
        "policy",
        result.completedAt,
        grantReceiptDigest,
        undefined,
        "broker-request-cap",
      );
    if (brokerRequestBytesExceeded(result.stdout))
      return incompleteExecution(
        state,
        "policy",
        result.completedAt,
        grantReceiptDigest,
        undefined,
        "broker-request-bytes-cap",
      );
    const policyDetail = providerPolicyDetail(result);
    if (policyDetail !== undefined)
      return incompleteExecution(
        state,
        "provider",
        result.completedAt,
        grantReceiptDigest,
        undefined,
        policyDetail,
      );
    if (decoded === undefined || "reasonDetail" in decoded) {
      const limit = providerLimitOf(result.stdout);
      if (limit !== undefined)
        return incompleteExecution(
          state,
          "provider",
          result.completedAt,
          grantReceiptDigest,
          limit,
          decoded === undefined
            ? `cli-exit:${result.exitCode}`
            : decoded.reasonDetail,
        );
    }
    if (result.status !== "exited" || result.exitCode !== 0)
      return incompleteExecution(
        state,
        result.status === "failed" || result.exitCode === 137
          ? "sandbox"
          : "provider",
        result.completedAt,
        grantReceiptDigest,
        undefined,
        result.failureKind ?? `cli-exit:${result.exitCode}`,
      );
    return undefined;
  }

  async #salvageRootReport(
    state: ExecutionState,
    result: CodexSandboxResult,
    grantReceiptDigest: string,
    reasonDetail: string,
  ): Promise<DiscoveryTransportResult> {
    if (state.run.outputKind === "verification")
      return incompleteExecution(
        state,
        "schema",
        result.completedAt,
        grantReceiptDigest,
        undefined,
        reasonDetail,
      );
    let attachment: ProviderAttachmentRef | undefined;
    try {
      const report = extractRootCandidateReport(result.stdout);
      if (report !== undefined)
        attachment = await this.attachments.put(
          "findings",
          Buffer.from(canonicalJson(report)),
        );
    } catch {
      // Keep the original transcript failure when no candidate report can be extracted.
    }
    return incompleteExecution(
      state,
      "schema",
      result.completedAt,
      grantReceiptDigest,
      undefined,
      reasonDetail,
      attachment,
    );
  }

  async #completeReport(
    state: ExecutionState,
    result: CodexSandboxResult,
    grantReceiptDigest: string,
    decoded: Exclude<
      ReturnType<typeof decodeTranscript>,
      { reasonDetail: string }
    >,
  ): Promise<DiscoveryTransportResult> {
    const activeMs =
      Date.parse(result.completedAt) - Date.parse(result.startedAt);
    if (
      state.run.minimumActiveMs !== undefined &&
      (!Number.isFinite(activeMs) || activeMs < state.run.minimumActiveMs)
    )
      return this.#retainRootOnIncomplete(
        result,
        incompleteExecution(
          state,
          "policy",
          result.completedAt,
          grantReceiptDigest,
          undefined,
          "early-final-before-minimum",
        ),
      );
    let attachment: ProviderAttachmentRef;
    try {
      attachment = await this.attachments.put(
        state.run.outputKind === "verification" ? "verification" : "findings",
        Buffer.from(
          canonicalJson(
            state.run.outputKind === "verification"
              ? decoded.report
              : (extractRootCandidateReport(result.stdout) ?? decoded.report),
          ),
        ),
      );
    } catch {
      return incompleteExecution(
        state,
        "evidence",
        result.completedAt,
        grantReceiptDigest,
      );
    }
    return {
      attachment,
      ...(state.researchArtifact === undefined
        ? {}
        : { researchArtifact: state.researchArtifact }),
      ...(state.cooperative ? { agentRuns: state.agentRuns } : {}),
      receipt: createNativeRunReceipt({
        ...state.run,
        terminal: "completed",
        reason: "unavailable",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        ...state.rootAgent,
        usage: state.rootUsage ?? decoded.usage,
        observed: state.rootObserved ?? decoded.observed,
        ...(state.childThreadsObserved === undefined
          ? {}
          : { childThreadsObserved: state.childThreadsObserved }),
        ...(state.childThreadsAdmitted === undefined
          ? {}
          : { childThreadsAdmitted: state.childThreadsAdmitted }),
        ...(state.brokerMetrics === undefined
          ? {}
          : { brokerMetrics: state.brokerMetrics }),
        sandboxExitCode: result.exitCode,
        ...(state.rootDiagnosticArtifactDigest === undefined
          ? {}
          : { diagnosticArtifactDigest: state.rootDiagnosticArtifactDigest }),
        ...(state.session === undefined ? {} : { session: state.session }),
        grantReceiptDigest,
        reportArtifactDigest: attachment.digest,
      }),
    };
  }
}
