import { isAbsolute } from "node:path";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import { admittedOneShotLab } from "./one-shot-lab.js";
import { admitAgentRuntimeProfile } from "./agent-runtime-profile.js";
import { jsonLines } from "./claude-session.js";
import {
  assertBrokerAddress,
  brokerRequestBytesExceeded,
  CODEX_DISCOVERY_BROKER_LIMITS,
  codexArgs,
  decodeTranscript,
  extractRootCandidateReport,
  providerLimitOf,
  providerPolicyDetail,
  reportJsonSchema,
  sandboxAdmissionFailure,
  usageFromTranscript,
  type CodexSandbox,
  type CodexSandboxResult,
} from "./codex-native-agent-runtime.js";
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
  SANDBOX_SOURCE_MOUNT_PATH,
} from "./sandbox-layout.js";

/** A single Codex turn with the existing protocol, receipt and report contracts. */
export class CodexOneShotRuntime implements OneShotExecutor {
  constructor(
    readonly sandbox: CodexSandbox,
    readonly broker: ProviderCredentialEgressBroker,
    readonly attachments: ProviderAttachmentStore,
    readonly sandboxImage: string,
    readonly labCommands: LabCommandRule,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(run: OneShotRun, signal?: AbortSignal): Promise<OneShotResult> {
    const startedAt = this.clock().toISOString();
    let result: CodexSandboxResult | undefined;
    let granted: ProviderCredentialEgressResult<CodexSandboxResult> | undefined;
    let diagnostic: ProviderAttachmentRef | undefined;
    let attachment: ProviderAttachmentRef | undefined;
    let decoded: ReturnType<typeof decodeTranscript> | undefined;
    const finish = (
      reason?: NativeRunReceipt["reason"],
      detail?: string,
    ): OneShotResult => {
      const usage =
        result === undefined ? undefined : usageFromTranscript(result.stdout);
      const limit =
        result === undefined ? undefined : providerLimitOf(result.stdout);
      return {
        ...(attachment === undefined ? {} : { attachment }),
        ...(run.output === "files" && result?.outputFiles !== undefined
          ? { outputFiles: result.outputFiles }
          : {}),
        scriptRan: scriptRanIn(jsonLines(result?.stdout ?? "")),
        receipt: createNativeRunReceipt({
          runId: run.runId,
          targetSnapshotDigest: run.targetSnapshotDigest,
          profile: run.profile,
          terminal: reason === undefined ? "completed" : "incomplete",
          reason: reason ?? "unavailable",
          ...(detail === undefined ? {} : { reasonDetail: detail }),
          startedAt: result?.startedAt ?? startedAt,
          completedAt: result?.completedAt ?? this.clock().toISOString(),
          agentRole: "root",
          childThreadsObserved: 0,
          childThreadsAdmitted: 0,
          ...(result === undefined ? {} : { sandboxExitCode: result.exitCode }),
          ...(usage === undefined ? {} : { usage }),
          ...(decoded === undefined || "reasonDetail" in decoded
            ? {}
            : { observed: decoded.observed }),
          ...(reason !== "provider" || limit === undefined
            ? {}
            : { providerLimit: limit }),
          ...(granted === undefined
            ? {}
            : { grantReceiptDigest: granted.receipt.digest }),
          ...(granted?.receipt.metrics === undefined
            ? {}
            : { brokerMetrics: granted.receipt.metrics }),
          ...(diagnostic === undefined
            ? {}
            : { diagnosticArtifactDigest: diagnostic.digest }),
          ...(attachment === undefined
            ? {}
            : { reportArtifactDigest: attachment.digest }),
        }),
      };
    };
    if (
      run.profile.transportKind !== "codex-native/v1" ||
      admitAgentRuntimeProfile(run.profile, this.sandboxImage).status !==
        "admitted" ||
      !["host-private-bearer", "chatgpt-oauth-host"].includes(
        run.profile.authenticationMethod,
      ) ||
      !run.prompt ||
      !Number.isSafeInteger(run.wallMs) ||
      run.wallMs <= 0 ||
      run.wallMs > ONE_SHOT_MAX_WALL_MS ||
      !admittedOneShotFiles(run.inputFiles, ONE_SHOT_MAX_INPUT_BYTES) ||
      !admittedOneShotFiles(run.toolFiles, ONE_SHOT_MAX_TOOL_BYTES) ||
      !admittedOneShotLab(run, this.clock().getTime()) ||
      (run.lab !== undefined && run.output !== "files") ||
      !isAbsolute(run.sourceDirectory) ||
      [run.dependencySource, ...(run.dependencySources ?? [])].some(
        (source) => source !== undefined && !isAbsolute(source.directory),
      ) ||
      !dependencyMountPathsAreDisjoint(dependencyMountPathsOf(run))
    )
      return finish("policy", "codex-run-not-admitted");
    granted = await this.broker
      .withGrant(
        {
          schemaVersion: 1,
          runtimeProfileDigest: run.profile.digest,
          model: run.profile.requestedModelId,
          protocol: "responses",
          ...CODEX_DISCOVERY_BROKER_LIMITS,
          expiresAt: run.expiresAt,
          ...(run.lab === undefined
            ? {}
            : { agentNetworkName: run.lab.networkName }),
        },
        (grant) =>
          this.sandbox.execute(
            {
              executable: "codex",
              args: codexArgs(
                run,
                grant,
                false,
                assertBrokerAddress(grant, run),
                run.output === "report",
              ),
              stdin: run.prompt,
              grant,
              ...(run.lab === undefined
                ? {}
                : {
                    labHost: {
                      name: new URL(run.lab.endpoint).hostname,
                      ipv4: run.lab.internalIp,
                    },
                  }),
              oneShot: {
                inputFiles: run.inputFiles,
                toolFiles: run.toolFiles,
                wallMs: run.wallMs,
                ...(run.lab === undefined ? {} : { lab: run.lab }),
              },
              supportFiles: [
                {
                  path: "/opt/codex-support/report-schema.json",
                  content: JSON.stringify(reportJsonSchema),
                },
              ],
              sourceMount: {
                directory: run.sourceDirectory,
                expectedTree: run.sourceTree,
                path: SANDBOX_SOURCE_MOUNT_PATH,
                mode: "ro",
              },
              additionalDependencyMounts: [
                run.dependencySource,
                ...(run.dependencySources ?? []),
              ]
                .filter((source) => source !== undefined)
                .map((source) => ({
                  path: source.path,
                  directory: source.directory,
                  expectedTree: source.tree,
                  mode: "ro" as const,
                })),
            },
            signal,
          ),
        signal,
      )
      .catch(() => undefined);
    if (granted === undefined)
      return finish(
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
      return finish("provider", "sandbox-operation-failed");
    result = granted.operation.value;
    diagnostic = await this.attachments
      .put(
        "diagnostic",
        Buffer.from(
          canonicalJson({
            stdout: result.stdout,
            stderr: result.stderr ?? "",
            rollouts: result.rollouts ?? [],
            status: result.status,
            exitCode: result.exitCode,
            failureKind: result.failureKind ?? null,
            ...(run.lab === undefined
              ? {}
              : {
                  outputFiles: result.outputFiles ?? [],
                  labHandoff: result.labHandoff ?? null,
                }),
          }),
        ),
      )
      .catch(() => undefined);
    decoded = decodeTranscript(
      result.stdout,
      run.output === "files" ? "files" : undefined,
      dependencyMountPathsOf(run),
      this.labCommands,
    );
    if (run.output === "report") {
      const report = extractRootCandidateReport(result.stdout);
      if (report !== undefined)
        attachment = await this.attachments
          .put("findings", Buffer.from(canonicalJson(report)))
          .catch(() => undefined);
    }
    const admission = sandboxAdmissionFailure(result, run, this.sandboxImage);
    if (admission !== undefined)
      return finish(admission, "codex-image-or-isolation-mismatch");
    if ((granted.receipt.metrics?.requestLimitExceeded ?? 0) > 0)
      return finish("policy", "broker-request-cap");
    if (brokerRequestBytesExceeded(result.stdout))
      return finish("policy", "broker-request-bytes-cap");
    if (
      run.lab !== undefined &&
      (result.labHandoff?.failure === "administrator-expired" ||
        result.labHandoff?.failure === "setup-boundary")
    )
      return finish(
        result.labHandoff?.failure === "administrator-expired"
          ? "wall"
          : "evidence",
        result.labHandoff?.failure ?? "lab-handoff-missing",
      );
    if (result.failureKind === "timed-out") return finish("wall");
    if (result.failureKind === "cancelled") return finish("operator");
    const policy = providerPolicyDetail(result);
    if (policy !== undefined) return finish("provider", policy);
    if (
      "reasonDetail" in decoded &&
      providerLimitOf(result.stdout) !== undefined
    )
      return finish("provider", decoded.reasonDetail);
    if (result.status !== "exited" || result.exitCode !== 0)
      return finish(
        result.status === "failed" || result.exitCode === 137
          ? "sandbox"
          : "provider",
        result.failureKind ?? `cli-exit:${result.exitCode}`,
      );
    if (
      run.lab !== undefined &&
      (result.labHandoff === undefined ||
        result.labHandoff.failure !== undefined)
    )
      return finish(
        "evidence",
        result.labHandoff?.failure ?? "lab-handoff-missing",
      );
    if (diagnostic === undefined || result.rolloutFailure !== undefined)
      return finish("evidence", "diagnostic-seal-failed");
    if (granted.receipt.cleanup.status !== "completed")
      return finish("provider", "broker-cleanup-failed");
    if ("reasonDetail" in decoded)
      return finish(
        providerLimitOf(result.stdout) === undefined ? "schema" : "provider",
        decoded.reasonDetail,
      );
    if (run.output === "report" && attachment === undefined)
      return finish("evidence", "report-seal-failed");
    if (
      run.output === "files" &&
      (result.outputFailure !== undefined ||
        result.outputFiles === undefined ||
        run.lab?.outputFileNames.some(
          (name) => !result!.outputFiles?.some((file) => file.name === name),
        ))
    )
      return finish("evidence", "output-capture-failed");
    return finish();
  }
}
