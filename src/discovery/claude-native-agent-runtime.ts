import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../infrastructure/canonical-json.js";
import { admitClaudeCooperativeRuntimeProfile } from "./agent-runtime-profile.js";
import type {
  DiscoveryTransportRun,
  DiscoveryTransportResult,
} from "./codex-native-agent-runtime.js";
import type {
  ClaudeSandbox,
  ClaudeSandboxResult,
} from "./claude-gvisor-sandbox.js";
import {
  createNativeRunReceipt,
  type NativeRunReceipt,
} from "./native-run-receipts.js";
import type {
  ProviderCredentialEgressBroker,
  ProviderCredentialEgressResult,
} from "./provider-credential-egress-broker.js";
import {
  ProviderAttachmentStore,
  type ProviderAttachmentRef,
} from "./provider-research-report.js";

const claimText = z.string().transform((text, context) => {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {
    /* handled below */
  }
  context.addIssue({ code: "custom", message: "Claim is not a JSON object" });
  return z.NEVER;
});
const report = z.strictObject({
  findings: z.array(claimText),
  leads: z.array(claimText),
  examined: z.string().max(16_384),
  unexamined: z.string().max(16_384),
});
const childCoverage = z
  .union([
    z.string(),
    z.array(z.union([z.string(), z.record(z.string(), z.json())])),
  ])
  .transform((value) =>
    Array.isArray(value)
      ? value
          .map((item) =>
            typeof item === "string" ? item : canonicalJson(item),
          )
          .join("\n")
      : value,
  )
  .pipe(z.string().max(16_384));
const childReport = z.object({
  findings: z.array(z.unknown()).default([]),
  leads: z.array(z.unknown()).default([]),
  examined: childCoverage.default(""),
  unexamined: childCoverage.default(""),
});
const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "string",
        description: "One Finding encoded as a JSON object string",
      },
    },
    leads: {
      type: "array",
      items: {
        type: "string",
        description: "One Lead encoded as a JSON object string",
      },
    },
    examined: { type: "string" },
    unexamined: { type: "string" },
  },
  required: ["findings", "leads", "examined", "unexamined"],
} as const;

type Event = Record<string, unknown>;
const object = (value: unknown): Event | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Event)
    : undefined;
function events(stdout: string): Event[] {
  return stdout.split("\n").flatMap((line) => {
    try {
      const value = object(JSON.parse(line) as unknown);
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });
}
function childCandidate(message: string) {
  const trimmed = message
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  const parsed = childReport.parse(value);
  if (
    !Array.isArray(object(value)?.findings) &&
    !Array.isArray(object(value)?.leads)
  )
    throw new Error("Child report has no candidate arrays");
  const claim = (item: unknown): unknown => {
    if (typeof item !== "string") return item;
    try {
      return object(JSON.parse(item) as unknown) ?? item;
    } catch {
      return item;
    }
  };
  return {
    ...parsed,
    findings: parsed.findings.map(claim),
    leads: parsed.leads.map(claim),
  };
}
function rootCandidate(item: Event) {
  const value =
    item.structured_output ??
    (() => {
      try {
        return JSON.parse(String(item.result)) as unknown;
      } catch {
        return undefined;
      }
    })();
  return report.parse(value);
}
function usage(item: Event | undefined): NativeRunReceipt["usage"] | undefined {
  const models = object(item?.modelUsage);
  if (models === undefined) return undefined;
  const totals = Object.values(models)
    .map(object)
    .filter((value): value is Event => value !== undefined);
  const sum = (key: string) =>
    totals.reduce(
      (total, model) =>
        total +
        (typeof model[key] === "number" &&
        Number.isSafeInteger(model[key]) &&
        Number(model[key]) >= 0
          ? Number(model[key])
          : 0),
      0,
    );
  return {
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cacheReadInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningOutputTokens: totals.some(
      (model) => typeof model.thinkingTokens === "number",
    )
      ? sum("thinkingTokens")
      : "unavailable",
  };
}
export class ClaudeNativeAgentRuntime {
  constructor(
    readonly sandbox: ClaudeSandbox,
    readonly broker: ProviderCredentialEgressBroker,
    readonly attachments: ProviderAttachmentStore,
    readonly sandboxImage: string,
    readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(run: DiscoveryTransportRun): Promise<DiscoveryTransportResult> {
    const startedAt = this.clock().toISOString();
    const profile =
      run.profile.transportKind === "claude-code/v1" ? run.profile : undefined;
    const incomplete = (
      reason: Exclude<NativeRunReceipt["reason"], "unavailable">,
      detail?: string,
      completedAt = this.clock().toISOString(),
      grantReceiptDigest?: string,
      extras: {
        brokerMetrics?: NativeRunReceipt["brokerMetrics"];
        sandboxExitCode?: number;
        diagnosticArtifactDigest?: string;
        childThreadsObserved?: number;
        childThreadsAdmitted?: number;
        usage?: NativeRunReceipt["usage"];
        providerLimit?: "rate-limit" | "quota";
      } = {},
    ): DiscoveryTransportResult => ({
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "incomplete",
        reason,
        ...(detail === undefined ? {} : { reasonDetail: detail }),
        startedAt,
        completedAt,
        ...(grantReceiptDigest === undefined ? {} : { grantReceiptDigest }),
        ...extras,
      }),
    });
    if (
      profile === undefined ||
      run.coordination !== "cooperative" ||
      run.outputKind !== undefined ||
      run.prompt.length === 0 ||
      !isAbsolute(run.sourceDirectory) ||
      (run.dependencySource !== undefined &&
        !isAbsolute(run.dependencySource.directory)) ||
      run.targetSnapshotDigest !== run.campaignInput.snapshotDigest ||
      run.profile.digest !== run.campaignInput.modelProfileDigest ||
      admitClaudeCooperativeRuntimeProfile(run.profile, this.sandboxImage)
        .status !== "admitted"
    )
      return incomplete("policy", "claude-run-not-admitted");
    let endpoint: URL;
    try {
      endpoint = new URL(run.lab.endpoint);
    } catch {
      return incomplete("policy", "lab-endpoint-invalid");
    }
    if (
      endpoint.protocol !== "http:" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint.hostname) ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    )
      return incomplete("policy", "lab-endpoint-invalid");
    let granted: ProviderCredentialEgressResult<ClaudeSandboxResult>;
    try {
      granted = await this.broker.withGrant(
        {
          schemaVersion: 1,
          runtimeProfileDigest: profile.digest,
          model: profile.requestedModelId,
          protocol: "anthropic-messages",
          maxRequests: 1600,
          maxRequestBytes: 8 * 1024 * 1024,
          maxResponseBytes: 8 * 1024 * 1024,
          expiresAt: run.expiresAt,
          agentNetworkName: run.lab.networkName,
        },
        async (grant) => {
          if (
            grant.dockerNetworkName !== run.lab.networkName ||
            grant.model !== profile.requestedModelId ||
            grant.protocol !== "anthropic-messages"
          )
            throw new Error("Claude broker grant mismatch");
          return this.sandbox.execute({
            grant,
            model: profile.requestedModelId,
            effort: profile.requestedEffort,
            prompt:
              run.campaignInput.history.mode === "catalog"
                ? `${run.prompt}\n\nPublic history catalog (records strictly before the cutoff):\n${canonicalJson(run.campaignInput.history)}`
                : run.prompt,
            outputSchema,
            source: { directory: run.sourceDirectory, tree: run.sourceTree },
            ...(run.dependencySource === undefined
              ? {}
              : { dependency: run.dependencySource }),
            labHost: { name: endpoint.hostname, ipv4: run.lab.internalIp },
            ...(run.lab.database === undefined
              ? {}
              : {
                  databaseHost: {
                    name: run.lab.database.host,
                    ipv4: run.lab.database.ipv4,
                  },
                }),
            deadline: run.expiresAt,
          });
        },
      );
    } catch {
      return incomplete("provider", "broker-operation-failed");
    }
    const grantDigest = granted.receipt.digest;
    const brokerMetrics = granted.receipt.metrics;
    if (granted.receipt.setup.status !== "ready")
      return incomplete(
        "provider",
        granted.receipt.setup.reason,
        this.clock().toISOString(),
        grantDigest,
        { brokerMetrics },
      );
    if (granted.operation.status !== "completed")
      return incomplete(
        granted.operation.status === "failed" ? "sandbox" : "provider",
        granted.operation.status === "failed"
          ? "sandbox-operation-failed"
          : "broker-run-incomplete",
        this.clock().toISOString(),
        grantDigest,
        { brokerMetrics },
      );
    const result = granted.operation.value;
    const parsed = events(result.stdout);
    const final = parsed.filter((item) => item.type === "result").at(-1);
    const starts = parsed.filter((item) => item.type === "harness.child-start");
    const ids = [
      ...new Set(
        parsed
          .filter((item) => item.type === "harness.child-id")
          .map((item) => item.agentId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const childEvents = parsed.filter(
      (item) =>
        item.type === "harness.child-transcript" ||
        item.type === "harness.child-transcript-limit" ||
        item.type === "harness.child-transcript-failed",
    );
    const latestChild = new Map<string, Event>();
    for (const child of childEvents)
      if (typeof child.agentId === "string")
        latestChild.set(child.agentId, child);
    let diagnostic: ProviderAttachmentRef | undefined;
    try {
      diagnostic = await this.attachments.put(
        "diagnostic",
        Buffer.from(
          canonicalJson({
            stdout: result.stdout,
            stderr: result.stderr,
            image: result.image,
            cliVersion: result.cliVersion,
            grantReceiptDigest: grantDigest,
          }),
        ),
      );
    } catch {
      /* The receipt records an evidence failure below. */
    }
    let researchArtifact: DiscoveryTransportResult["researchArtifact"];
    try {
      if (result.research !== undefined)
        researchArtifact = {
          attachment: await this.attachments.put(
            "research",
            result.research.archive,
          ),
          truncated: result.research.truncated,
        };
    } catch {
      /* The receipt records an evidence failure below. */
    }
    const agentRuns = await Promise.all(
      ids.slice(0, 3).map(async (id, index) => {
        const child = latestChild.get(id);
        const childRunId = `${run.runId.slice(0, 75)}-claude-child-${index + 1}`;
        let attachment: ProviderAttachmentRef | undefined;
        try {
          attachment = await this.attachments.put(
            "findings",
            Buffer.from(
              canonicalJson(childCandidate(String(child?.finalMessage ?? ""))),
            ),
          );
        } catch {
          /* Child remains incomplete. */
        }
        return {
          agentPath: `/root/worker-${index + 1}`,
          receipt: createNativeRunReceipt({
            ...run,
            runId: childRunId,
            terminal: attachment === undefined ? "incomplete" : "completed",
            reason: attachment === undefined ? "schema" : "unavailable",
            ...(attachment === undefined
              ? { reasonDetail: "child-report-unreadable" }
              : { reportArtifactDigest: attachment.digest }),
            startedAt: result.startedAt,
            completedAt: result.completedAt,
            grantReceiptDigest: grantDigest,
            ...(diagnostic === undefined
              ? {}
              : { diagnosticArtifactDigest: diagnostic.digest }),
          }),
          ...(attachment === undefined ? {} : { attachment }),
        };
      }),
    );
    const extras = {
      brokerMetrics,
      sandboxExitCode: result.exitCode,
      ...(diagnostic === undefined
        ? {}
        : { diagnosticArtifactDigest: diagnostic.digest }),
      childThreadsObserved: ids.length,
      childThreadsAdmitted: agentRuns.length,
      ...(usage(final) === undefined ? {} : { usage: usage(final)! }),
    };
    const childResult = {
      agentRuns,
      ...(researchArtifact === undefined ? {} : { researchArtifact }),
    };
    const providerStatus = Number(final?.api_error_status);
    const limit = providerStatus === 429 ? ("rate-limit" as const) : undefined;
    const failure =
      (brokerMetrics?.requestLimitExceeded ?? 0) > 0 ||
      (brokerMetrics?.responseLimitExceeded ?? 0) > 0 ||
      (brokerMetrics?.unauthorizedRequests ?? 0) > 0
        ? "policy"
        : result.kind !== "exited"
          ? "sandbox"
          : limit !== undefined
            ? "provider"
            : result.exitCode !== 0
              ? "sandbox"
              : result.image !== this.sandboxImage ||
                  result.cliVersion !== profile.claudeCliVersion
                ? "policy"
                : result.researchFailure !== undefined ||
                    researchArtifact === undefined ||
                    diagnostic === undefined
                  ? "evidence"
                  : granted.receipt.cleanup.status !== "completed"
                    ? "provider"
                    : starts.length > 3 ||
                        ids.length > 3 ||
                        [...latestChild.keys()].some((id) => !ids.includes(id))
                      ? "policy"
                      : ids.length !== starts.length ||
                          ids.some((id) => !latestChild.has(id))
                        ? "evidence"
                        : final === undefined ||
                            final.subtype !== "success" ||
                            final.is_error === true
                          ? "provider"
                          : undefined;
    if (failure !== undefined)
      return {
        ...incomplete(
          failure,
          (brokerMetrics?.requestLimitExceeded ?? 0) > 0
            ? "broker-request-cap"
            : (brokerMetrics?.responseLimitExceeded ?? 0) > 0
              ? "broker-response-cap"
              : (brokerMetrics?.unauthorizedRequests ?? 0) > 0
                ? "broker-grant-unauthorized"
                : limit !== undefined
                  ? "provider-rate-limit"
                  : failure === "sandbox"
                    ? result.kind
                    : "claude-run-incomplete",
          result.completedAt,
          grantDigest,
          {
            ...extras,
            ...(failure === "provider" && limit !== undefined
              ? { providerLimit: limit }
              : {}),
          },
        ),
        ...childResult,
      };
    let attachment: ProviderAttachmentRef;
    try {
      attachment = await this.attachments.put(
        "findings",
        Buffer.from(canonicalJson(rootCandidate(final!))),
      );
    } catch {
      return {
        ...incomplete(
          "schema",
          "root-report-unreadable",
          result.completedAt,
          grantDigest,
          extras,
        ),
        ...childResult,
      };
    }
    return {
      ...childResult,
      attachment,
      receipt: createNativeRunReceipt({
        ...run,
        terminal: "completed",
        reason: "unavailable",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        grantReceiptDigest: grantDigest,
        reportArtifactDigest: attachment.digest,
        ...extras,
      }),
    };
  }
}
