import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  nativeRunReceiptSchema,
  readNativeRunReceipt,
  runFinishedFieldsFrom,
  sealNativeRunReceipt,
} from "../../src/discovery/index.js";
import { canonicalJson } from "../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";

const digest = `sha256:${"a".repeat(64)}`;
const profile = defineAgentRuntimeProfile({
  id: "production",
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
const identity = { runId: "run-1", targetSnapshotDigest: digest, profile };

const receipt = createNativeRunReceipt({
  ...identity,
  terminal: "incomplete",
  reason: "provider",
  startedAt: "2026-10-08T00:00:00Z",
  completedAt: "2026-10-08T00:00:01Z",
});

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function evidenceStore() {
  const root = await mkdtemp(join(tmpdir(), "run-receipts-"));
  directories.push(root);
  return new PrivateArtifactStore({
    rootDirectory: root,
    maxEntries: 4,
    maxBytes: 1024 * 1024,
  });
}

describe("native run receipts", () => {
  it("seals a receipt as one private file and reads the same receipt back", async () => {
    const evidence = await evidenceStore();
    const sealed = await sealNativeRunReceipt(evidence, receipt);
    expect(sealed).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await readNativeRunReceipt(evidence, sealed)).toEqual(receipt);
    const file = await evidence.readFile(sealed, "receipt.json", 64 * 1024);
    if (file.status !== "resolved") throw new Error("receipt not stored");
    expect(file.bytes.toString("utf8")).toBe(canonicalJson(receipt));
    expect(receipt.usage.inputTokens).toBe("unavailable");
    expect(receipt.childThreadsObserved).toBeUndefined();
    expect(receipt.childThreadsAdmitted).toBeUndefined();
  });

  it("refuses to seal a tampered receipt and reports missing or foreign evidence", async () => {
    const evidence = await evidenceStore();
    await expect(
      sealNativeRunReceipt(evidence, { ...receipt, runId: "other" }),
    ).rejects.toThrow();
    expect(
      await readNativeRunReceipt(evidence, `sha256:${"b".repeat(64)}`),
    ).toBeUndefined();
    const foreign = await evidence.putFiles({
      "receipt.json": canonicalJson({ kind: "not-a-receipt" }),
    });
    await expect(readNativeRunReceipt(evidence, foreign)).rejects.toThrow();
    const otherFile = await evidence.putFiles({
      "coverage.json": canonicalJson({}),
    });
    expect(await readNativeRunReceipt(evidence, otherFile)).toBeUndefined();
  });

  it("copies only present receipt fields into the finished event", () => {
    expect(runFinishedFieldsFrom(receipt)).toEqual({
      usage: {
        inputTokens: "unavailable",
        cachedInputTokens: "unavailable",
        outputTokens: "unavailable",
        reasoningOutputTokens: "unavailable",
      },
    });
    const observed = createNativeRunReceipt({
      ...identity,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-08T00:00:00Z",
      completedAt: "2026-10-08T00:00:01Z",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      observed: {
        toolCalls: 5,
        filesRead: 4,
        uniqueFilesRead: 3,
        labRequests: 0,
        dbQueries: 0,
      },
      childThreadsObserved: 2,
      childThreadsAdmitted: 1,
      brokerMetrics: {
        forwardedRequests: 7,
        requestLimitExceeded: 0,
        unauthorizedRequests: 0,
      },
      sandboxExitCode: 0,
      diagnosticArtifactDigest: digest,
    });
    expect(runFinishedFieldsFrom(observed)).toEqual({
      usage: observed.usage,
      observed: observed.observed,
      childThreadsObserved: 2,
      childThreadsAdmitted: 1,
      brokerMetrics: observed.brokerMetrics,
      sandboxExitCode: 0,
      diagnosticArtifactDigest: digest,
    });
  });

  it("binds observed and admitted child counts without changing legacy receipts", () => {
    const counted = createNativeRunReceipt({
      ...identity,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-08T00:00:00Z",
      completedAt: "2026-10-08T00:00:01Z",
      childThreadsObserved: 4,
      childThreadsAdmitted: 3,
    });
    expect(nativeRunReceiptSchema.parse(counted)).toMatchObject({
      childThreadsObserved: 4,
      childThreadsAdmitted: 3,
    });
    expect(nativeRunReceiptSchema.parse(receipt)).toEqual(receipt);
    const fourChildren = createNativeRunReceipt({
      ...identity,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-08T00:00:00Z",
      completedAt: "2026-10-08T00:00:01Z",
      childThreadsObserved: 4,
      childThreadsAdmitted: 4,
    });
    expect(nativeRunReceiptSchema.parse(fourChildren)).toMatchObject({
      childThreadsObserved: 4,
      childThreadsAdmitted: 4,
    });
    const laterWave = createNativeRunReceipt({
      ...identity,
      terminal: "completed",
      reason: "unavailable",
      startedAt: "2026-10-08T00:00:00Z",
      completedAt: "2026-10-08T00:00:01Z",
      childThreadsObserved: 5,
      childThreadsAdmitted: 5,
    });
    expect(nativeRunReceiptSchema.parse(laterWave)).toMatchObject({
      childThreadsAdmitted: 5,
    });
    expect(() =>
      createNativeRunReceipt({
        ...identity,
        terminal: "completed",
        reason: "unavailable",
        startedAt: "2026-10-08T00:00:00Z",
        completedAt: "2026-10-08T00:00:01Z",
        childThreadsObserved: 256,
        childThreadsAdmitted: 256,
      }),
    ).toThrow();
    expect(() =>
      createNativeRunReceipt({
        ...identity,
        terminal: "completed",
        reason: "unavailable",
        startedAt: "2026-10-08T00:00:00Z",
        completedAt: "2026-10-08T00:00:01Z",
        childThreadsAdmitted: 4,
      }),
    ).toThrow();
  });
});
