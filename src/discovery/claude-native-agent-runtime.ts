import { isAbsolute } from "node:path";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import { admitAgentRuntimeProfile } from "./agent-runtime-profile.js";
import type {
  ClaudeSandbox,
  ClaudeSandboxResult,
} from "./claude-gvisor-sandbox.js";
import {
  extractCandidateReport,
  mergeRootTurnReports,
  observedFromCommands,
  reportJsonSchema,
  type DiscoveryTransportResult,
  type DiscoveryTransportRun,
} from "./codex-native-agent-runtime.js";
import {
  createNativeRunReceipt,
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
import type { ObservedCommand } from "./read-paths.js";
import {
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountPathsAreDisjoint,
  dependencyMountPathsOf,
} from "./sandbox-layout.js";

type Event = Record<string, unknown>;
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
const CHILD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Claude Code writes each child's session to `<project>/<session>/subagents/agent-<id>.jsonl`. */
const CHILD_TRANSCRIPT =
  /(?:^|\/)subagents\/agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
/** Claude Code labels the assistant messages it writes for an API error with this model. */
const SYNTHETIC_MODEL = "<synthetic>";

const object = (value: unknown): Event | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Event)
    : undefined;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

function jsonLines(text: string): Event[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value = object(JSON.parse(line) as unknown);
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });
}

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
function commandsOf(events: readonly Event[]): ObservedCommand[] {
  return events
    .filter((event) => event.type === "assistant")
    .flatMap(contentOf)
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const input = object(block.input) ?? {};
      const path =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.path === "string"
            ? input.path
            : undefined;
      if (block.name === "Bash" && typeof input.command === "string")
        return { text: input.command, cwd: SANDBOX_SOURCE_MOUNT_PATH };
      if (path === undefined) return { text: String(block.name) };
      const type = block.name === "Read" ? "read" : "search";
      return {
        text: `${type} ${path}`,
        cwd: SANDBOX_SOURCE_MOUNT_PATH,
        parsed: [{ type, path }],
      };
    });
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

/** The Root's own session file: the transcript of the session stdout last named. */
function rootTranscript(
  events: readonly Event[],
  transcripts: ClaudeSandboxResult["transcripts"],
): Event[] {
  const session = events
    .flatMap((event) =>
      typeof event.session_id === "string"
        ? [event.session_id]
        : event.type === "harness.turn" && typeof event.sessionId === "string"
          ? [event.sessionId]
          : [],
    )
    .at(-1);
  if (session === undefined || !CHILD_ID.test(session)) return [];
  const file = transcripts?.find(
    (entry) =>
      entry.path === `${session}.jsonl` ||
      entry.path.endsWith(`/${session}.jsonl`),
  );
  return jsonLines(file?.content ?? "");
}

/** Every Root turn's structured report, merged as the Codex path merges turns. */
function rootReport(events: readonly Event[]) {
  return mergeRootTurnReports(
    events
      .filter((event) => event.type === "result")
      .flatMap((event) =>
        object(event.structured_output) !== undefined
          ? [JSON.stringify(event.structured_output)]
          : typeof event.result === "string"
            ? [event.result]
            : [],
      ),
  );
}

function rootUsage(events: readonly Event[]): NativeRunReceipt["usage"] {
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
  ]) {
    const trimmed = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      return extractCandidateReport(trimmed);
    } catch {
      // An earlier report of the same child may still be readable.
    }
  }
  return undefined;
}

function admitted(run: DiscoveryTransportRun, sandboxImage: string): boolean {
  const profile = run.profile;
  return (
    profile.transportKind === "claude-code/v1" &&
    admitAgentRuntimeProfile(profile, sandboxImage).status === "admitted" &&
    profile.subagent.effort === profile.requestedEffort &&
    run.outputKind === undefined &&
    run.resume === undefined &&
    run.minimumActiveMs !== undefined &&
    run.resumePrompt !== undefined &&
    run.prompt.includes(run.resumePrompt) &&
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
            protocol: "anthropic-messages",
            // Claude Code sends one Messages request per model turn, for the
            // Root and up to four children at once, and its side requests are
            // pinned to the same model. Five streams over the 120-minute wall at
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
                  model: profile.requestedModelId,
                  effort: profile.requestedEffort,
                  outputSchema: reportJsonSchema,
                },
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
    const agentRuns = await this.#children(
      run,
      result,
      grantReceiptDigest,
      sealed,
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
    const failure: Failure | undefined =
      result.isolation.backend !== "gvisor" ||
      result.isolation.runtime !== "runsc" ||
      result.isolation.fallbackUsed !== false
        ? { reason: "sandbox", detail: "isolation-mismatch" }
        : result.image !== this.sandboxImage ||
            run.profile.transportKind !== "claude-code/v1" ||
            result.cliVersion !== run.profile.claudeCliVersion
          ? { reason: "policy", detail: "claude-image-mismatch" }
          : (brokerMetrics?.requestLimitExceeded ?? 0) > 0
            ? { reason: "policy", detail: "broker-request-cap" }
            : (claudeProviderFailure(
                events,
                rootTranscript(events, result.transcripts),
              ) ??
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
                          result.failureKind ??
                          `claude-exit:${result.exitCode}`,
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
        usage: rootUsage(events),
        observed: observedFromCommands(commandsOf(events), mounts),
        childThreadsObserved: childIds.size,
        childThreadsAdmitted: agentRuns.length,
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        sandboxExitCode: result.exitCode,
        ...(diagnostic === undefined
          ? {}
          : { diagnosticArtifactDigest: diagnostic.digest }),
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
  ): Promise<AgentRun[]> {
    const paths = new Map<string, string | undefined>();
    const stops = new Map<string, Event>();
    for (const event of jsonLines(result.stdout))
      if (
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
    for (const [agentId, path] of [...paths].slice(0, 255)) {
      const stop = stops.get(agentId);
      const raw = result.transcripts?.find((file) => file.path === path);
      const transcript = jsonLines(raw?.content ?? "");
      const models = new Set(
        transcript.flatMap((event) => {
          const model = object(event.message)?.model;
          return event.type === "assistant" &&
            typeof model === "string" &&
            model !== SYNTHETIC_MODEL
            ? [model]
            : [];
        }),
      );
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
          usage: transcriptUsage(transcript),
          observed: observedFromCommands(
            commandsOf(transcript),
            dependencyMountPathsOf(run),
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
