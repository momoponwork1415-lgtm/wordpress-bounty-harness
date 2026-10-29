import { isAbsolute } from "node:path";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import { bytesDigest } from "../infrastructure/content-digest.js";
import { admitAgentRuntimeProfile } from "./agent-runtime-profile.js";
import type {
  ClaudeSandbox,
  ClaudeSandboxResult,
} from "./claude-gvisor-sandbox.js";
import {
  extractCandidateReport,
  finalReportTimeline,
  mergeTurnReports,
  observedFromCommands,
  reportJsonSchema,
  DEFAULT_MAX_CHILDREN,
  type DiscoveryTransportResult,
  type DiscoveryTransportRun,
} from "./codex-native-agent-runtime.js";
import { isGvisorIsolation } from "./gvisor-container.js";
import {
  CHILD_ID,
  CHILD_TRANSCRIPT,
  claudeRunSession,
  jsonLines,
  lastSessionId,
  object,
  type Event,
} from "./claude-session.js";
import {
  createNativeRunReceipt,
  isClaudeTranscriptPath,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type {
  ProviderCredentialEgressBroker,
  ProviderCredentialEgressResult,
} from "./provider-credential-egress-broker.js";
import type {
  ProviderAttachmentRef,
  ProviderAttachmentStore,
} from "./provider-research-report.js";
import {
  commandFromClaudeToolUse,
  type LabCommandRule,
  type ObservedCommand,
} from "./read-paths.js";
import {
  dependencyMountPathsAreDisjoint,
  dependencyMountPathsOf,
} from "./sandbox-layout.js";

type AgentRun = NonNullable<DiscoveryTransportResult["agentRuns"]>[number];
type Reason = Exclude<NativeRunReceipt["reason"], "unavailable">;
type ProviderLimit = "rate-limit" | "quota";
type Failure = {
  readonly reason: Reason;
  readonly detail?: string;
  readonly providerLimit?: ProviderLimit;
};

/** Where the sandbox mounts the Claude config directory; transcript paths start here. */
const TRANSCRIPT_ROOT = "/tmp/claude/projects/";
/** Claude Code labels the assistant messages it writes for an API error with this model. */
const SYNTHETIC_MODEL = "<synthetic>";

const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

const contentOf = (event: Event): Event[] => {
  const content = object(event.message)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const value = object(block);
        return value === undefined ? [] : [value];
      })
    : [];
};

/** Tool calls as the command records `observedFromCommands` counts. */
export function commandsOf(events: readonly Event[]): ObservedCommand[] {
  return events
    .filter((event) => event.type === "assistant")
    .flatMap(contentOf)
    .filter((block) => block.type === "tool_use")
    .map(commandFromClaudeToolUse);
}

/** Models the assistant messages report; Claude Code's own error turns are left out. */
export function reportedModels(events: readonly Event[]): Set<string> {
  return new Set(
    events.flatMap((event) => {
      const model = object(event.message)?.model;
      return event.type === "assistant" &&
        typeof model === "string" &&
        model !== SYNTHETIC_MODEL
        ? [model]
        : [];
    }),
  );
}

/** Token counts of distinct assistant messages; Claude Code repeats a message's usage per content block. */
function transcriptUsage(events: readonly Event[]): NativeRunReceipt["usage"] {
  const byMessage = new Map<string, Event>();
  for (const event of events) {
    const message = object(event.message);
    const usage = object(message?.usage);
    if (event.type === "assistant" && usage !== undefined)
      byMessage.set(String(message?.id ?? byMessage.size), usage);
  }
  const sum = (key: string) =>
    [...byMessage.values()].reduce(
      (total, usage) => total + count(usage[key]),
      0,
    );
  return {
    inputTokens: sum("input_tokens"),
    cachedInputTokens: sum("cache_read_input_tokens"),
    outputTokens: sum("output_tokens"),
    reasoningOutputTokens: "unavailable",
  };
}

/** Claude Code's notices that the model ended a turn with `stop_reason: "refusal"`. */
const REFUSAL_NOTICES: ReadonlySet<unknown> = new Set([
  "model_refusal_fallback",
  "model_refusal_no_fallback",
]);
/** The broker's 403 for a request naming a model other than the bound one. */
const MODEL_NOT_ADMITTED = /model-not-admitted/;

const failedTurn = (event: Event): boolean =>
  object(event.message)?.model === SYNTHETIC_MODEL || event.error !== undefined;

/**
 * Whether the session's last answer from the model was a refusal. A refusal
 * that a later answer from the bound model followed (Claude Code retries once
 * on the same model) was recovered and does not count.
 */
function endsInRefusal(events: readonly Event[]): boolean {
  let refusal = false;
  for (const event of events) {
    if (event.type === "system" && REFUSAL_NOTICES.has(event.subtype))
      refusal = true;
    else if (event.type === "assistant") {
      const message = object(event.message);
      if (message?.stop_reason === "refusal") refusal = true;
      else if (!failedTurn(event)) refusal = false;
    }
  }
  return refusal;
}

/**
 * Provider refusals, usage limits and authentication failures, read from the
 * Messages API's own `stop_reason` and from the error turns Claude Code writes
 * for a failed request. The agent's prose is never matched: only synthetic
 * error messages, the SDK's error field and failed results are.
 *
 * `transcript` is the Root's session file, which keeps the refused turn that
 * the runner's compact stdout does not. Without the sandbox's no-fallback
 * switches, Claude Code answers a refusal by retrying on another model, which
 * the broker refuses as `model-not-admitted` and Claude Code reports as
 * "Failed to authenticate"; after a refusal that is the refusal, not an
 * authentication failure.
 */
export function claudeProviderFailure(
  events: readonly Event[],
  transcript: readonly Event[] = [],
): Failure | undefined {
  let limit: ProviderLimit | undefined;
  let authentication = false;
  let notAdmitted = false;
  let failed = false;
  const inspect = (text: string) => {
    if (/usage limit|limit reached|hit your limit|extra usage/i.test(text))
      limit = "quota";
    else if (/\b(?:429|529)\b|rate[ _-]?limit|overloaded/i.test(text))
      limit ??= "rate-limit";
    else if (/\b401\b|authenticat|oauth token|\/login/i.test(text))
      authentication = true;
  };
  // A refusal Claude Code wrote as an error turn ("usage policy") counts even
  // when the model answered later; only a recovered `stop_reason` does not.
  let usagePolicy = false;
  const read = (text: string) => {
    if (/usage policy/i.test(text)) usagePolicy = true;
    else if (MODEL_NOT_ADMITTED.test(text)) notAdmitted = true;
    else inspect(text);
  };
  for (const event of events) {
    if (event.type === "assistant") {
      if (event.error === "rate_limit") limit ??= "rate-limit";
      if (event.error === "billing_error") limit = "quota";
      if (failedTurn(event)) {
        failed = true;
        const texts = contentOf(event).flatMap((block) =>
          typeof block.text === "string" ? [block.text] : [],
        );
        if (
          event.error === "authentication_failed" &&
          !texts.some((text) => MODEL_NOT_ADMITTED.test(text))
        )
          authentication = true;
        texts.forEach(read);
      }
    } else if (
      event.type === "result" &&
      (event.is_error === true || event.subtype !== "success")
    ) {
      failed = true;
      const status = event.api_error_status;
      if (status === 429 || status === 529) limit ??= "rate-limit";
      if (status === 401) authentication = true;
      if (typeof event.result === "string") read(event.result);
    }
  }
  const refusal =
    usagePolicy ||
    endsInRefusal(events) ||
    (failed &&
      limit === undefined &&
      !authentication &&
      endsInRefusal(transcript));
  if (refusal) return { reason: "provider", detail: "provider-refusal" };
  if (limit !== undefined)
    return {
      reason: "provider",
      detail:
        limit === "quota" ? "provider-usage-limit" : "provider-rate-limit",
      providerLimit: limit,
    };
  // Not after a refusal: Claude Code asked for another model on its own.
  if (notAdmitted) return { reason: "policy", detail: "model-not-admitted" };
  if (authentication)
    return { reason: "provider", detail: "provider-authentication" };
  return undefined;
}

/**
 * The Root's own session file: the transcript of the session stdout last
 * named. On a resumed segment only what this segment appended counts; the
 * restored part ended in the earlier segment's stop.
 */
export function rootTranscript(
  events: readonly Event[],
  transcripts: ClaudeSandboxResult["transcripts"],
  restored: ReadonlyMap<string, string> = new Map(),
): Event[] {
  const session = lastSessionId(events);
  if (session === undefined) return [];
  const file = transcripts?.find(
    (entry) =>
      entry.path === `${session}.jsonl` ||
      entry.path.endsWith(`/${session}.jsonl`),
  );
  if (file === undefined) return [];
  const before = restored.get(file.path);
  return jsonLines(
    before !== undefined && file.content.startsWith(before)
      ? file.content.slice(before.length)
      : file.content,
  );
}

/** Each Root turn's report text, timed by the runner's `harness.turn` record after it. */
export function rootTurns(events: readonly Event[]) {
  const turns: { at?: unknown; message: string }[] = [];
  for (const event of events)
    if (event.type === "result") {
      const message =
        object(event.structured_output) !== undefined
          ? JSON.stringify(event.structured_output)
          : event.result;
      if (typeof message === "string") turns.push({ message });
    } else if (event.type === "harness.turn")
      for (const turn of turns) turn.at ??= event.at;
  return turns;
}

/** Every Root turn's structured report, merged as the Codex path merges turns. */
export function rootReport(events: readonly Event[]) {
  return mergeTurnReports(rootTurns(events).map((turn) => turn.message));
}

/**
 * The text the Root delegated to each child, by agent id: the Root
 * transcript's `Agent` tool_use joined to its result's `toolUseResult.agentId`.
 * A child still running at the end has no result yet.
 */
function delegationsOf(root: readonly Event[]): Map<string, string> {
  const prompts = new Map<unknown, string>();
  const delegated = new Map<string, string>();
  for (const event of root)
    for (const block of contentOf(event)) {
      const prompt = object(block.input)?.prompt;
      const agentId = object(event.toolUseResult)?.agentId;
      const text = prompts.get(block.tool_use_id);
      if (
        block.type === "tool_use" &&
        block.name === "Agent" &&
        typeof prompt === "string"
      )
        prompts.set(block.id, prompt);
      else if (
        block.type === "tool_result" &&
        typeof agentId === "string" &&
        text !== undefined
      )
        delegated.set(agentId, text);
    }
  return delegated;
}

function delegationFields(text: string | undefined) {
  return text === undefined
    ? { delegationDigest: "unavailable" as const }
    : {
        delegationDigest: bytesDigest(text),
        delegationLength: text.length,
      };
}

export function rootUsage(events: readonly Event[]): NativeRunReceipt["usage"] {
  const results = events.flatMap((event) => {
    const usage = event.type === "result" ? object(event.usage) : undefined;
    return usage === undefined ? [] : [usage];
  });
  const sum = (key: string) =>
    results.reduce((total, usage) => total + count(usage[key]), 0);
  return results.length === 0
    ? {
        inputTokens: "unavailable",
        cachedInputTokens: "unavailable",
        outputTokens: "unavailable",
        reasoningOutputTokens: "unavailable",
      }
    : {
        inputTokens: sum("input_tokens"),
        cachedInputTokens: sum("cache_read_input_tokens"),
        outputTokens: sum("output_tokens"),
        reasoningOutputTokens: "unavailable",
      };
}

/** The child's last report: its final message, else its latest readable assistant text. */
function childReport(finalMessage: unknown, transcript: readonly Event[]) {
  const texts = transcript
    .filter((event) => event.type === "assistant")
    .flatMap(contentOf)
    .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
    .reverse();
  for (const text of [
    ...(typeof finalMessage === "string" ? [finalMessage] : []),
    ...texts,
  ])
    for (const candidate of reportCandidates(text))
      try {
        return extractCandidateReport(candidate);
      } catch {
        // A later candidate, or an earlier report of the same child, may still be readable.
      }
  return undefined;
}

/**
 * Where a child's text can hold the contract's JSON object (ADR 0018 decision
 * 1): the whole text, else the last ```json fence, else the last line that
 * opens with `{` through the final `}`. Malformed JSON is not repaired.
 */
function reportCandidates(text: string): string[] {
  const whole = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const fence = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)].at(
    -1,
  )?.[1];
  const line = text.lastIndexOf("\n{");
  const opening = line >= 0 ? line + 1 : text.startsWith("{") ? 0 : -1;
  const tail = opening < 0 ? undefined : text.slice(opening);
  return [
    whole,
    ...(fence === undefined ? [] : [fence]),
    ...(tail === undefined ? [] : [tail.slice(0, tail.lastIndexOf("}") + 1)]),
  ];
}

/** A child transcript opens with the delegation as its first user message. */
function firstUserText(transcript: readonly Event[]): string | undefined {
  const content = object(
    transcript.find((event) => event.type === "user")?.message,
  )?.content;
  return typeof content === "string" ? content : undefined;
}

function admitted(run: DiscoveryTransportRun, sandboxImage: string): boolean {
  const profile = run.profile;
  return (
    profile.transportKind === "claude-code/v1" &&
    admitAgentRuntimeProfile(profile, sandboxImage).status === "admitted" &&
    profile.subagent.effort === profile.requestedEffort &&
    run.outputKind === undefined &&
    // A resume carries the restored Claude transcripts, the Root session's among them.
    (run.resume === undefined ||
      (run.resume.sessions.every((file) => isClaudeTranscriptPath(file.path)) &&
        run.resume.sessions.some(
          (file) =>
            file.kind === "root" &&
            file.threadId === run.resume?.threadId &&
            file.path.split("/").length === 2 &&
            file.path.endsWith(`/${file.threadId}.jsonl`),
        ))) &&
    run.minimumActiveMs !== undefined &&
    run.resumePrompt !== undefined &&
    run.prompt.includes(run.resumePrompt) &&
    (run.resumeNotice === undefined ||
      (run.resume !== undefined && run.prompt.includes(run.resumeNotice))) &&
    run.campaignInput.snapshotDigest === run.targetSnapshotDigest &&
    run.campaignInput.modelProfileDigest === profile.digest &&
    (run.lab === undefined) ===
      ("mode" in run.campaignInput.lab &&
        run.campaignInput.lab.mode === "none") &&
    isAbsolute(run.sourceDirectory) &&
    [run.dependencySource, ...(run.dependencySources ?? [])].every(
      (source) => source === undefined || isAbsolute(source.directory),
    ) &&
    dependencyMountPathsAreDisjoint(dependencyMountPathsOf(run))
  );
}

function labHost(run: DiscoveryTransportRun) {
  if (run.lab === undefined) return {};
  const endpoint = URL.parse(run.lab.endpoint);
  if (
    endpoint === null ||
    endpoint.protocol !== "http:" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  )
    return undefined;
  return {
    labHost: { name: endpoint.hostname, ipv4: run.lab.internalIp },
    ...(run.lab.database === undefined
      ? {}
      : {
          databaseHost: {
            name: run.lab.database.host,
            ipv4: run.lab.database.ipv4,
          },
        }),
    ...(run.lab.control === undefined
      ? {}
      : {
          controlHost: {
            name: run.lab.control.host,
            ipv4: run.lab.control.ipv4,
          },
        }),
  };
}

/**
 * Runs one cooperative v8 Trial through Claude Code with the owner's
 * subscription, behind the same broker, gVisor, wall and evidence rules as
 * the Codex runtime, and returns the same transport result.
 */
export class ClaudeNativeAgentRuntime {
  constructor(
    readonly sandbox: ClaudeSandbox,
    readonly broker: ProviderCredentialEgressBroker,
    readonly attachments: ProviderAttachmentStore,
    readonly sandboxImage: string,
    /** The profile's rule for `observed.labRequests` / `dbQueries` (ADR 0011). */
    readonly labCommands: LabCommandRule,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    run: DiscoveryTransportRun,
    signal?: AbortSignal,
  ): Promise<DiscoveryTransportResult> {
    const startedAt = this.clock().toISOString();
    const receipt = (
      fields: Omit<
        Parameters<typeof createNativeRunReceipt>[0],
        "runId" | "targetSnapshotDigest" | "profile"
      >,
    ) => createNativeRunReceipt({ ...run, ...fields });
    const refused = (reason: Reason, detail?: string) => ({
      receipt: receipt({
        terminal: "incomplete",
        reason,
        ...(detail === undefined ? {} : { reasonDetail: detail }),
        startedAt,
        completedAt: this.clock().toISOString(),
      }),
    });
    const hosts = labHost(run);
    const profile = run.profile;
    if (
      !admitted(run, this.sandboxImage) ||
      hosts === undefined ||
      profile.transportKind !== "claude-code/v1"
    )
      return refused("policy", "claude-run-not-admitted");
    const granted: ProviderCredentialEgressResult<ClaudeSandboxResult> | void =
      await this.broker
        .withGrant(
          {
            schemaVersion: 1,
            runtimeProfileDigest: profile.digest,
            model: profile.requestedModelId,
            // The broker admits the children's model besides the Root's.
            subagentModel: profile.subagent.modelId,
            protocol: "anthropic-messages",
            // Claude Code sends one Messages request per model turn, for the
            // Root and its live children (four by default), and its side requests
            // are pinned to the same model. Five streams over the 120-minute wall at
            // one turn per 3.6 s is 10,000, the broker's ceiling; a Trial that
            // needs more is runaway traffic and stops as broker-request-cap.
            maxRequests: 10_000,
            maxRequestBytes: 8 * 1024 * 1024,
            maxResponseBytes: 8 * 1024 * 1024,
            expiresAt: run.expiresAt,
            ...(run.lab === undefined
              ? {}
              : { agentNetworkName: run.lab.networkName }),
          },
          (grant) =>
            this.sandbox.execute(
              {
                grant,
                input: {
                  prompt: run.prompt,
                  resumePrompt: run.resumePrompt!,
                  minimumActiveMs: run.minimumActiveMs!,
                  maxChildren: run.maxChildren ?? DEFAULT_MAX_CHILDREN,
                  model: profile.requestedModelId,
                  effort: profile.requestedEffort,
                  outputSchema: reportJsonSchema,
                  ...(run.resume === undefined
                    ? {}
                    : { resumeSessionId: run.resume.threadId }),
                  ...(run.resume === undefined || run.resumeNotice === undefined
                    ? {}
                    : { resumeNotice: run.resumeNotice }),
                  ...(run.skills === undefined
                    ? {}
                    : { skills: run.skills.map((skill) => skill.name) }),
                },
                subagentModel: profile.subagent.modelId,
                ...(run.skills === undefined ? {} : { skills: run.skills }),
                ...(run.resume === undefined
                  ? {}
                  : {
                      resume: {
                        sessionId: run.resume.threadId,
                        transcripts: run.resume.sessions.map(
                          ({ path, content }) => ({ path, content }),
                        ),
                        research: run.resume.research.map(
                          ({ path, contentBase64 }) => ({
                            path,
                            content: Buffer.from(contentBase64, "base64"),
                          }),
                        ),
                      },
                    }),
                sourceMount: {
                  directory: run.sourceDirectory,
                  expectedTree: run.sourceTree,
                },
                dependencyMounts: [
                  ...(run.dependencySource === undefined
                    ? []
                    : [run.dependencySource]),
                  ...(run.dependencySources ?? []),
                ].map((source) => ({
                  path: source.path,
                  directory: source.directory,
                  expectedTree: source.tree,
                })),
                ...hosts,
              },
              signal,
            ),
          signal,
        )
        .catch(() => undefined);
    if (granted === undefined)
      return refused(
        signal?.aborted
          ? signal.reason === "operator"
            ? "operator"
            : "wall"
          : "provider",
        "broker-operation-failed",
      );
    if (
      granted.receipt.setup.status !== "ready" ||
      granted.operation.status !== "completed"
    )
      return {
        receipt: receipt({
          terminal: "incomplete",
          reason: "provider",
          reasonDetail:
            granted.receipt.setup.status === "ready"
              ? "sandbox-operation-failed"
              : granted.receipt.setup.reason,
          startedAt,
          completedAt: this.clock().toISOString(),
          grantReceiptDigest: granted.receipt.digest,
          ...(granted.receipt.metrics === undefined
            ? {}
            : { brokerMetrics: granted.receipt.metrics }),
        }),
      };
    return this.#settle(
      run,
      granted.receipt,
      granted.operation.value,
      startedAt,
    );
  }

  async #settle(
    run: DiscoveryTransportRun,
    grant: ProviderCredentialEgressResult<ClaudeSandboxResult>["receipt"],
    result: ClaudeSandboxResult,
    startedAt: string,
  ): Promise<DiscoveryTransportResult> {
    const grantReceiptDigest = grant.digest;
    const brokerMetrics = grant.metrics;
    const events = jsonLines(result.stdout);
    const mounts = dependencyMountPathsOf(run);
    const put = (
      kind: Parameters<ProviderAttachmentStore["put"]>[0],
      value: string | Buffer,
    ) =>
      this.attachments
        .put(kind, typeof value === "string" ? Buffer.from(value) : value)
        .catch(() => undefined);
    // Every session transcript, Root and children, is kept whatever ended the run.
    const sealed = new Map<string, string | undefined>();
    for (const file of result.transcripts ?? [])
      sealed.set(file.path, (await put("diagnostic", file.content))?.digest);
    const transcriptsSealed = [...sealed.values()].every(
      (digest) => digest !== undefined,
    );
    const diagnostic = await put(
      "diagnostic",
      `${result.stdout}\n${JSON.stringify({
        type: "sandbox_process_diagnostic",
        payload: {
          status: result.status,
          exitCode: result.exitCode,
          failureKind: result.failureKind ?? null,
          stderrTail: result.stderr?.slice(-64 * 1024) ?? "",
        },
      })}\n${JSON.stringify({
        type: "harness.transcripts",
        files: [...sealed].map(([path, digest]) => ({
          path,
          digest: digest ?? null,
        })),
      })}`,
    );
    const research =
      result.research === undefined
        ? undefined
        : await put("research", result.research.archive);
    const restoredRoot = new Map(
      (run.resume?.sessions ?? []).flatMap((file) =>
        file.kind === "root" ? [[file.path, file.content] as const] : [],
      ),
    );
    const rootEvents = rootTranscript(events, result.transcripts, restoredRoot);
    const agentRuns = await this.#children(
      run,
      result,
      grantReceiptDigest,
      sealed,
      delegationsOf(rootEvents),
    );
    const childIds = new Set([
      ...events.flatMap((event) =>
        event.type === "harness.child-start" &&
        typeof event.agentId === "string"
          ? [event.agentId]
          : [],
      ),
      ...agentRuns.map((child) => child.agentPath.slice("/root/".length)),
    ]);
    const report = rootReport(events);
    const attachment: ProviderAttachmentRef | undefined =
      report === undefined
        ? undefined
        : await put("findings", canonicalJson(report));
    const activeMs =
      Date.parse(result.completedAt) - Date.parse(result.startedAt);
    const session = claudeRunSession(
      events,
      [...sealed].map(([path, digest]) => ({
        path,
        ...(digest === undefined ? {} : { digest }),
      })),
      run.resume?.segment ?? 0,
    );
    // The Root answered on another model than the profile binds, as a child would.
    const rootModelMismatch: Failure | undefined = [
      ...reportedModels(events),
    ].some((model) => model !== run.profile.requestedModelId)
      ? { reason: "policy", detail: "root-profile-mismatch" }
      : undefined;
    const failure: Failure | undefined = !isGvisorIsolation(result.isolation)
      ? { reason: "sandbox", detail: "isolation-mismatch" }
      : result.image !== this.sandboxImage ||
          run.profile.transportKind !== "claude-code/v1" ||
          result.cliVersion !== run.profile.claudeCliVersion
        ? { reason: "policy", detail: "claude-image-mismatch" }
        : (brokerMetrics?.requestLimitExceeded ?? 0) > 0
          ? { reason: "policy", detail: "broker-request-cap" }
          : (rootModelMismatch ??
            claudeProviderFailure(events, rootEvents) ??
            (result.failureKind === "timed-out"
              ? { reason: "wall" }
              : result.failureKind === "cancelled"
                ? { reason: "operator" }
                : result.status !== "exited" || result.exitCode !== 0
                  ? {
                      reason:
                        result.status === "failed" || result.exitCode === 137
                          ? "sandbox"
                          : "provider",
                      detail:
                        result.failureKind ?? `claude-exit:${result.exitCode}`,
                    }
                  : diagnostic === undefined ||
                      result.researchFailure !== undefined ||
                      research === undefined
                    ? {
                        reason: "evidence",
                        detail: "research-capture-failed",
                      }
                    : result.transcriptFailure !== undefined ||
                        !transcriptsSealed
                      ? {
                          reason: "evidence",
                          detail: "transcript-capture-failed",
                        }
                      : grant.cleanup.status !== "completed"
                        ? {
                            reason: "provider",
                            detail: "broker-cleanup-failed",
                          }
                        : attachment === undefined
                          ? {
                              reason: "schema",
                              detail: "root-report-unreadable",
                            }
                          : !(activeMs >= run.minimumActiveMs!)
                            ? {
                                reason: "policy",
                                detail: "early-final-before-minimum",
                              }
                            : undefined));
    return {
      ...(attachment === undefined ? {} : { attachment }),
      ...(research === undefined || result.research === undefined
        ? {}
        : {
            researchArtifact: {
              attachment: research,
              truncated: result.research.truncated,
            },
          }),
      agentRuns,
      receipt: createNativeRunReceipt({
        ...run,
        terminal: failure === undefined ? "completed" : "incomplete",
        reason: failure?.reason ?? "unavailable",
        ...(failure?.detail === undefined
          ? {}
          : { reasonDetail: failure.detail }),
        ...(failure?.providerLimit === undefined
          ? {}
          : { providerLimit: failure.providerLimit }),
        startedAt: failure === undefined ? result.startedAt : startedAt,
        completedAt: result.completedAt,
        agentRole: "root",
        ...finalReportTimeline(rootTurns(events)),
        usage: rootUsage(events),
        observed: observedFromCommands(
          commandsOf(events),
          mounts,
          this.labCommands,
        ),
        childThreadsObserved: childIds.size,
        childThreadsAdmitted: agentRuns.length,
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        sandboxExitCode: result.exitCode,
        ...(diagnostic === undefined
          ? {}
          : { diagnosticArtifactDigest: diagnostic.digest }),
        ...(session === undefined ? {} : { session }),
        grantReceiptDigest,
        ...(attachment === undefined
          ? {}
          : { reportArtifactDigest: attachment.digest }),
      }),
    };
  }

  /**
   * Each child is sealed from its own transcript, independent of the Root's
   * report. A child that never reached SubagentStop (wall, crash) is still
   * found by its transcript file, like a Codex child by its rollout.
   */
  async #children(
    run: DiscoveryTransportRun,
    result: ClaudeSandboxResult,
    grantReceiptDigest: string,
    sealed: ReadonlyMap<string, string | undefined>,
    delegations: ReadonlyMap<string, string>,
  ): Promise<AgentRun[]> {
    const paths = new Map<string, string | undefined>();
    const stops = new Map<string, Event>();
    const agentTypes = new Map<string, string>();
    // Children restored from an earlier segment were recorded by that segment.
    const restored = new Set(
      (run.resume?.sessions ?? []).flatMap((file) =>
        file.kind === "child" ? [file.threadId] : [],
      ),
    );
    for (const event of jsonLines(result.stdout))
      if (
        event.type === "harness.child-start" &&
        typeof event.agentId === "string" &&
        typeof event.agentType === "string" &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(event.agentType)
      )
        agentTypes.set(event.agentId, event.agentType);
      else if (
        event.type === "harness.child-stop" &&
        typeof event.agentId === "string" &&
        CHILD_ID.test(event.agentId)
      ) {
        stops.set(event.agentId, event);
        paths.set(
          event.agentId,
          typeof event.transcriptPath === "string" &&
            event.transcriptPath.startsWith(TRANSCRIPT_ROOT)
            ? event.transcriptPath.slice(TRANSCRIPT_ROOT.length)
            : undefined,
        );
      }
    for (const file of [...(result.transcripts ?? [])].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const agentId = CHILD_TRANSCRIPT.exec(file.path)?.[1];
      if (agentId !== undefined && !paths.has(agentId))
        paths.set(agentId, file.path);
    }
    const agentRuns: AgentRun[] = [];
    for (const [agentId, path] of [...paths]
      .filter(([agentId]) => !restored.has(agentId))
      .slice(0, 255)) {
      const stop = stops.get(agentId);
      const raw = result.transcripts?.find((file) => file.path === path);
      const transcript = jsonLines(raw?.content ?? "");
      const models = reportedModels(transcript);
      const times = transcript.flatMap((event) =>
        typeof event.timestamp === "string" &&
        Number.isFinite(Date.parse(event.timestamp))
          ? [new Date(event.timestamp).toISOString()]
          : [],
      );
      const diagnostic = raw === undefined ? undefined : sealed.get(raw.path);
      const report = childReport(stop?.finalMessage, transcript);
      const attachment =
        report === undefined
          ? undefined
          : await this.attachments
              .put("findings", Buffer.from(canonicalJson(report)))
              .catch(() => undefined);
      const failure: Failure | undefined =
        diagnostic === undefined
          ? { reason: "evidence", detail: "child-transcript-unavailable" }
          : [...models].some((model) => model !== run.profile.subagent.modelId)
            ? { reason: "policy", detail: "child-profile-mismatch" }
            : (claudeProviderFailure(transcript) ??
              (attachment === undefined
                ? { reason: "schema", detail: "child-final-message-not-report" }
                : undefined));
      agentRuns.push({
        agentPath: `/root/${agentId}`,
        receipt: createNativeRunReceipt({
          ...run,
          runId: `${run.runId.slice(0, 60)}-${agentId}`,
          terminal: failure === undefined ? "completed" : "incomplete",
          reason: failure?.reason ?? "unavailable",
          ...(failure?.detail === undefined
            ? {}
            : { reasonDetail: failure.detail }),
          startedAt: times[0] ?? result.startedAt,
          completedAt: times.at(-1) ?? result.completedAt,
          agentRole: "child",
          agentType: agentTypes.get(agentId) ?? "unavailable",
          // A child without a joined result opens its transcript with the delegation.
          ...delegationFields(
            delegations.get(agentId) ?? firstUserText(transcript),
          ),
          usage: transcriptUsage(transcript),
          observed: observedFromCommands(
            commandsOf(transcript),
            dependencyMountPathsOf(run),
            this.labCommands,
          ),
          grantReceiptDigest,
          ...(diagnostic === undefined
            ? {}
            : { diagnosticArtifactDigest: diagnostic }),
          ...(attachment === undefined
            ? {}
            : { reportArtifactDigest: attachment.digest }),
        }),
        ...(attachment === undefined ? {} : { attachment }),
      });
    }
    return agentRuns;
  }
}
