import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defineAgentRuntimeProfile } from "../../src/discovery/agent-runtime-profile.js";
import {
  createNativeRunReceipt,
  NativeRunReceiptStore,
} from "../../src/discovery/native-run-receipts.js";

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

describe("native run receipts", () => {
  it("preserves unavailable fields and recovers only the matching run", async () => {
    const root = await mkdtemp(join(tmpdir(), "run-receipts-"));
    try {
      const store = new NativeRunReceiptStore(root);
      await store.finalize(identity, receipt);
      expect(await store.recover(identity)).toEqual({
        status: "recovered",
        receipt,
      });
      expect(await store.recover({ ...identity, runId: "other" })).toEqual({
        status: "missing",
      });
      expect(receipt.usage.inputTokens).toBe("unavailable");
      await expect(
        store.finalize(
          identity,
          createNativeRunReceipt({
            ...identity,
            terminal: "completed",
            reason: "unavailable",
            startedAt: "2026-10-08T00:00:00Z",
            completedAt: "2026-10-08T00:00:01Z",
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
