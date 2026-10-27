import { isAbsolute } from "node:path";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import { admitAgentRuntimeProfile } from "./agent-runtime-profile.js";
import type {
  ClaudeSandbox,
  ClaudeSandboxResult,
} from "./claude-gvisor-sandbox.js";
import {
  claudeProviderFailure,
  commandsOf,
  reportedModels,
  rootReport,
  rootTranscript,
  rootTurns,
  rootUsage,
} from "./claude-native-agent-runtime.js";
import { claudeRunSession, jsonLines } from "./claude-session.js";
import {
  finalReportTimeline,
  observedFromCommands,
  reportJsonSchema,
} from "./codex-native-agent-runtime.js";
import { isGvisorIsolation } from "./gvisor-container.js";
import {
  createNativeRunReceipt,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import {
  admittedOneShotFiles,
  ONE_SHOT_MAX_INPUT_BYTES,
  ONE_SHOT_MAX_TOOL_BYTES,
  ONE_SHOT_MAX_WALL_MS,
  scriptRanIn,
  type OneShotExecutor,
  type OneShotResult,
  type OneShotRun,
} from "./one-shot-run.js";
import type {
  ProviderCredentialEgressBroker,
  ProviderCredentialEgressResult,
} from "./provider-credential-egress-broker.js";
import type {
  ProviderAttachmentRef,
  ProviderAttachmentStore,
} from "./provider-research-report.js";
import type { LabCommandRule } from "./read-paths.js";
import {
  dependencyMountPathsAreDisjoint,
  dependencyMountPathsOf,
} from "./sandbox-layout.js";

type Reason = Exclude<NativeRunReceipt["reason"], "unavailable">;
type Failure = {
  readonly reason: Reason;
  readonly detail?: string;
  readonly providerLimit?: "rate-limit" | "quota";
};

function admitted(run: OneShotRun, sandboxImage: string): boolean {
  const profile = run.profile;
  return (
    profile.transportKind === "claude-code/v1" &&
    admitAgentRuntimeProfile(profile, sandboxImage).status === "admitted" &&
    run.prompt.length > 0 &&
    Number.isSafeInteger(run.wallMs) &&
    run.wallMs > 0 &&
    run.wallMs <= ONE_SHOT_MAX_WALL_MS &&
    admittedOneShotFiles(run.inputFiles, ONE_SHOT_MAX_INPUT_BYTES) &&
    admittedOneShotFiles(run.toolFiles, ONE_SHOT_MAX_TOOL_BYTES) &&
    isAbsolute(run.sourceDirectory) &&
    [run.dependencySource, ...(run.dependencySources ?? [])].every(
      (source) => source === undefined || isAbsolute(source.directory),
    ) &&
    dependencyMountPathsAreDisjoint(dependencyMountPathsOf(run))
  );
}

/**
 * Runs one role of a partitioned Trial (ADR 0042) through Claude Code: one
 * agent, one turn, no children, behind the same broker, gVisor and evidence
 * rules as the cooperative runtime. The sources are mounted as for a Root;
 * the Harness's input files and the tool files are mounted read-only; the
 * output is what the run wrote under `/workspace/output`, or its final
 * message under the report schema. Whether the run's tool calls named a
 * mounted tool file is observed from the transcript, never from prose.
 */
export class ClaudeOneShotRuntime implements OneShotExecutor {
  constructor(
    readonly sandbox: ClaudeSandbox,
    readonly broker: ProviderCredentialEgressBroker,
    readonly attachments: ProviderAttachmentStore,
    readonly sandboxImage: string,
    readonly labCommands: LabCommandRule,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(run: OneShotRun, signal?: AbortSignal): Promise<OneShotResult> {
    const startedAt = this.clock().toISOString();
    const refused = (
      reason: Reason,
      detail: string,
      extra: Partial<Parameters<typeof createNativeRunReceipt>[0]> = {},
    ): OneShotResult => ({
      receipt: createNativeRunReceipt({
        runId: run.runId,
        targetSnapshotDigest: run.targetSnapshotDigest,
        profile: run.profile,
        terminal: "incomplete",
        reason,
        reasonDetail: detail,
        startedAt,
        completedAt: this.clock().toISOString(),
        ...extra,
      }),
      scriptRan: false,
    });
    const profile = run.profile;
    if (!admitted(run, this.sandboxImage))
      return refused("policy", "claude-run-not-admitted");
    const granted: ProviderCredentialEgressResult<ClaudeSandboxResult> | void =
      await this.broker
        .withGrant(
          {
            schemaVersion: 1,
            runtimeProfileDigest: profile.digest,
            model: profile.requestedModelId,
            protocol: "anthropic-messages",
            // One stream at one turn per 3.6 s over the 240-minute ceiling.
            maxRequests: 4_000,
            maxRequestBytes: 8 * 1024 * 1024,
            maxResponseBytes: 8 * 1024 * 1024,
            expiresAt: run.expiresAt,
          },
          (grant) =>
            this.sandbox.execute(
              {
                grant,
                input: {
                  prompt: run.prompt,
                  minimumActiveMs: 0,
                  maxChildren: 0,
                  model: profile.requestedModelId,
                  effort: profile.requestedEffort,
                  ...(run.output === "report"
                    ? { outputSchema: reportJsonSchema }
                    : {}),
                  oneShot: true,
                },
                oneShot: {
                  inputFiles: run.inputFiles,
                  toolFiles: run.toolFiles,
                  wallMs: run.wallMs,
                },
                // No child runs; the image still needs a bound model name.
                subagentModel: profile.requestedModelId,
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
      return refused(
        "provider",
        granted.receipt.setup.status === "ready"
          ? "sandbox-operation-failed"
          : granted.receipt.setup.reason,
        {
          grantReceiptDigest: granted.receipt.digest,
          ...(granted.receipt.metrics === undefined
            ? {}
            : { brokerMetrics: granted.receipt.metrics }),
        },
      );
    return this.#settle(
      run,
      granted.receipt,
      granted.operation.value,
      startedAt,
    );
  }

  async #settle(
    run: OneShotRun,
    grant: ProviderCredentialEgressResult<ClaudeSandboxResult>["receipt"],
    result: ClaudeSandboxResult,
    startedAt: string,
  ): Promise<OneShotResult> {
    const brokerMetrics = grant.metrics;
    const events = jsonLines(result.stdout);
    const put = (
      kind: Parameters<ProviderAttachmentStore["put"]>[0],
      value: string,
    ) => this.attachments.put(kind, Buffer.from(value)).catch(() => undefined);
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
    const transcript = rootTranscript(events, result.transcripts);
    const scriptRan = scriptRanIn(events) || scriptRanIn(transcript);
    const report = run.output === "report" ? rootReport(events) : undefined;
    const attachment: ProviderAttachmentRef | undefined =
      report === undefined
        ? undefined
        : await put("findings", canonicalJson(report));
    const session = claudeRunSession(
      events,
      [...sealed].map(([path, digest]) => ({
        path,
        ...(digest === undefined ? {} : { digest }),
      })),
      0,
    );
    const modelMismatch: Failure | undefined = [...reportedModels(events)].some(
      (model) => model !== run.profile.requestedModelId,
    )
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
          : (modelMismatch ??
            claudeProviderFailure(events, transcript) ??
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
                  : diagnostic === undefined
                    ? { reason: "evidence", detail: "diagnostic-seal-failed" }
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
                        : run.output === "report"
                          ? attachment === undefined
                            ? { reason: "schema", detail: "report-unreadable" }
                            : undefined
                          : result.outputFailure !== undefined ||
                              result.outputFiles === undefined
                            ? {
                                reason: "evidence",
                                detail: "output-capture-failed",
                              }
                            : undefined));
    return {
      ...(attachment === undefined ? {} : { attachment }),
      ...(run.output === "files" && result.outputFiles !== undefined
        ? { outputFiles: result.outputFiles }
        : {}),
      scriptRan,
      receipt: createNativeRunReceipt({
        runId: run.runId,
        targetSnapshotDigest: run.targetSnapshotDigest,
        profile: run.profile,
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
          dependencyMountPathsOf(run),
          this.labCommands,
        ),
        childThreadsObserved: 0,
        childThreadsAdmitted: 0,
        ...(brokerMetrics === undefined ? {} : { brokerMetrics }),
        sandboxExitCode: result.exitCode,
        ...(diagnostic === undefined
          ? {}
          : { diagnosticArtifactDigest: diagnostic.digest }),
        ...(session === undefined ? {} : { session }),
        grantReceiptDigest: grant.digest,
        ...(attachment === undefined
          ? {}
          : { reportArtifactDigest: attachment.digest }),
      }),
    };
  }
}
