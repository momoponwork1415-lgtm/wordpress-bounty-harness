import { describe, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
} from "../../src/discovery/index.js";
import {
  finishedEventFrom,
  type TrialOutcome,
} from "../../src/discovery/execute-trial.js";

const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: digest,
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: digest,
  authenticationMethod: "unavailable",
  cyberAccessProgram: "unavailable",
  serviceTier: "unavailable",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});
const base = {
  schemaVersion: 1 as const,
  campaignId: "campaign-1",
  snapshotDigest: digest,
  occurredAt: "2026-10-08T07:00:00.000Z",
};

describe("finishedEventFrom", () => {
  it("writes a cancelled run that returned no receipt with only its sealed digest", () => {
    const outcome: TrialOutcome = {
      runId: "run-0",
      outcome: "failed",
      failure: { reason: "wall" },
      wallTimeMs: 60_000,
      receiptDigest: other,
      counted: false,
      foundNew: false,
      heldBoundary: false,
      findingsRecorded: 0,
    };
    expect(finishedEventFrom(base, outcome)).toEqual({
      ...base,
      identity: "discovery-finish-run-0",
      type: "discovery-run-finished",
      runId: "run-0",
      outcome: "failed",
      costUsd: "unavailable",
      wallTimeMs: 60_000,
      reason: "wall",
      artifacts: [{ kind: "native-run-receipt", digest: other }],
    });
  });

  it("copies the transport receipt, the failure and every artifact one to one", () => {
    const receipt = createNativeRunReceipt({
      runId: "run-1",
      targetSnapshotDigest: digest,
      profile,
      terminal: "incomplete",
      reason: "provider",
      reasonDetail: "cli-exit:2",
      providerLimit: "quota",
      startedAt: "2026-10-08T07:00:00Z",
      completedAt: "2026-10-08T07:00:03Z",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: "unavailable",
      },
      observed: {
        toolCalls: 2,
        filesRead: 1,
        uniqueFilesRead: 1,
        labRequests: 0,
        dbQueries: 0,
      },
      childThreadsObserved: 1,
      childThreadsAdmitted: 1,
      brokerMetrics: {
        forwardedRequests: 3,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
      sandboxExitCode: 2,
      diagnosticArtifactDigest: other,
    });
    const outcome: TrialOutcome = {
      runId: "run-1",
      outcome: "provider-limited",
      failure: {
        reason: "provider",
        reasonDetail: "cli-exit:2",
        providerLimit: "quota",
      },
      receipt,
      wallTimeMs: 3_000,
      researchArtifact: { digest: other, truncated: false },
      receiptDigest: digest,
      readPathsDigest: digest,
      counted: true,
      foundNew: false,
      heldBoundary: false,
      findingsRecorded: 0,
    };
    expect(finishedEventFrom(base, outcome)).toEqual({
      ...base,
      identity: "discovery-finish-run-1",
      type: "discovery-run-finished",
      runId: "run-1",
      outcome: "provider-limited",
      costUsd: "unavailable",
      wallTimeMs: 3_000,
      usage: receipt.usage,
      observed: receipt.observed,
      childThreadsObserved: 1,
      childThreadsAdmitted: 1,
      brokerMetrics: receipt.brokerMetrics,
      sandboxExitCode: 2,
      diagnosticArtifactDigest: other,
      researchArtifact: { digest: other, truncated: false },
      reason: "provider",
      reasonDetail: "cli-exit:2",
      providerLimit: "quota",
      artifacts: [
        { kind: "native-run-receipt", digest },
        { kind: "read-paths", digest },
      ],
    });
  });

  it("drops a stale failure from a completed run", () => {
    const receipt = createNativeRunReceipt({
      runId: "run-2",
      targetSnapshotDigest: digest,
      profile,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-08T07:00:00Z",
      completedAt: "2026-10-08T07:00:01Z",
    });
    const event = finishedEventFrom(base, {
      runId: "run-2",
      outcome: "completed",
      failure: { reason: "schema" },
      receipt,
      wallTimeMs: 1_000,
      receiptDigest: digest,
      counted: true,
      foundNew: true,
      heldBoundary: false,
      findingsRecorded: 1,
    });
    expect(event).not.toHaveProperty("reason");
    expect(event).toMatchObject({ outcome: "completed", usage: receipt.usage });
  });
});
