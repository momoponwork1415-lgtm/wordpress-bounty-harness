import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  runCampaignPipeline,
  verifyNextFinding,
} from "../../src/cli/pipeline.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

it("lets attached post-processing and the background consumer verify a Finding once", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbh-pipeline-consumer-"));
  try {
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "evidence"),
      maxEntries: 8,
      maxBytes: 4096,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    });
    const digest = `sha256:${"a".repeat(64)}`;
    const target = {
      targetId: "synthetic",
      version: "1.0",
      score: 1,
      selectedAt: "2026-10-18T00:00:00Z",
      policy: { id: "test", digest },
    };
    const snapshot = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      digest,
      target: { identity: "synthetic", version: "1.0", sourceDigest: digest },
      dependencies: [],
    };
    const base = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-18T00:00:00Z",
    };
    await ledger.append({
      ...base,
      identity: "selected",
      type: "target-selected",
      selectionId: "synthetic@1.0",
    });
    await ledger.append({
      ...base,
      identity: "concluded",
      type: "discovery-concluded",
      stoppedBy: "no-new-finding",
    });
    await ledger.append({
      ...base,
      identity: "finding",
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "run-1",
      category: "stored-xss",
    });
    let began!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verifyCalls = 0;
    let ids = 0;
    const verification = {
      promptVersion: "v7",
      async verify(input: {
        campaignId: string;
        findingId: string;
        verificationId: string;
        campaignLabSetupDigest: string;
      }) {
        if (++verifyCalls === 1) {
          began();
          await gate;
        }
        const result = {
          status: "incomplete" as const,
          reason: "no-judge" as const,
          nextStep: "Review",
        };
        await ledger.append({
          ...base,
          identity: `finished-${input.verificationId}`,
          type: "verification-finished",
          verificationId: input.verificationId,
          findingId: input.findingId,
          labSetupDigest: input.campaignLabSetupDigest,
          promptVersion: "v7",
          result,
        });
        return result;
      },
    };
    const setupFor = () => ({});
    const pipeline = {
      select: async () => [target],
      freeze: async () => snapshot,
      lab: {
        provision: async () => ({
          status: "ready" as const,
          handle: {
            id: "lab-1",
            snapshotDigest: digest,
            setupDigest: digest,
            endpoint: "http://lab",
          },
        }),
        seedCanaries: async () => ({ status: "seeded" as const, digest }),
        teardown: async () => ({ status: "removed" as const }),
      },
      setupFor,
      reconstructionFor: () => ({}),
      verification,
      discovery: async () => ({
        input: {
          schemaVersion: 1 as const,
          snapshotDigest: digest,
          trustBoundary: { version: "v1", text: "Synthetic trust" },
          programmeBoundary: { version: "v1", text: "Synthetic scope" },
          modelProfileDigest: digest,
          promptDigest: digest,
          stopRules: { maxRuns: 1, noFindingRuns: 1 },
          lab: { setupDigest: digest },
          history: { mode: "none" as const },
        },
        plannedTrials: [],
        historyFraction: 0,
        executor: {
          execute: async () => {
            throw new Error("Concluded discovery must not execute");
          },
        },
        attachments: {} as never,
        admitFinding: () => {
          throw new Error("Concluded discovery must not admit");
        },
      }),
    };
    const running = runCampaignPipeline({
      campaignId: "campaign-1",
      ledger,
      store,
      pipeline: pipeline as never,
      clock: () => new Date("2026-10-18T00:00:00Z"),
      newId: () => `id-${++ids}`,
    });
    await started;
    const background = await verifyNextFinding({
      campaignId: "campaign-1",
      ledger,
      newId: () => `id-${++ids}`,
      loadSnapshot: async () => snapshot,
      setupFor,
      reconstructionFor: () => ({}),
      verification: verification as never,
    });
    expect(background).toBeNull();
    release();
    await running;
    expect(verifyCalls).toBe(1);
    expect(ledger.read({ type: "verification-finished" })).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
