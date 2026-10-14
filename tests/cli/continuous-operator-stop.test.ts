import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runCampaignPipeline,
  type CampaignPipeline,
} from "../../src/cli/pipeline.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import type { Snapshot } from "../../src/snapshot/index.js";

const snapshotDigest = `sha256:${"a".repeat(64)}`;
const target = {
  targetId: "target-one",
  version: "1.0",
  score: 1,
  selectedAt: "2026-10-14T00:00:00.000Z",
  policy: { id: "policy", digest: `sha256:${"b".repeat(64)}` },
};

describe("continuous operator stop", () => {
  it.each(["before selection", "during freeze"])(
    "stops %s without starting or skipping a target",
    async (timing) => {
      const directory = await mkdtemp(join(tmpdir(), "wbh-operator-stop-"));
      const store = new PrivateArtifactStore({
        rootDirectory: join(directory, "evidence"),
        maxEntries: 10,
        maxBytes: 1024 * 1024,
      });
      const ledger = new Ledger({
        databasePath: join(directory, "ledger.sqlite"),
        artifactStore: store,
      });
      const controller = new AbortController();
      let frozen = 0;
      let admitted = 0;
      if (timing === "before selection") controller.abort();
      try {
        const pipeline = {
          select: async () => [target],
          freeze: async () => {
            frozen++;
            controller.abort();
            return { digest: snapshotDigest } as Snapshot;
          },
        } as unknown as CampaignPipeline<
          typeof target,
          never,
          never,
          never,
          never
        >;
        const result = await runCampaignPipeline({
          campaignId: "child-one",
          ledger,
          store,
          pipeline,
          clock: () => new Date("2026-10-14T00:00:00.000Z"),
          newId: () => "unused",
          stopSignal: controller.signal,
          beforeLab: () => {
            admitted++;
          },
        });
        expect(result).toMatchObject({
          stopped: "operator",
          targets: [],
          skipped: [],
        });
        expect(frozen).toBe(timing === "before selection" ? 0 : 1);
        expect(admitted).toBe(0);
        expect(ledger.read({ campaignId: "child-one", limit: 10 })).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("drains a provisioned Lab without beginning a Trial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wbh-operator-lab-stop-"));
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "evidence"),
      maxEntries: 10,
      maxBytes: 1024 * 1024,
    });
    const ledger = new Ledger({
      databasePath: join(directory, "ledger.sqlite"),
      artifactStore: store,
    });
    const controller = new AbortController();
    let cleaned = 0;
    let discoveryPrepared = 0;
    try {
      const pipeline = {
        select: async () => [target],
        freeze: async () => ({
          digest: snapshotDigest,
          target: { sourceDigest: `sha256:${"c".repeat(64)}` },
          dependencies: [],
        }),
        setupFor: () => ({}),
        lab: {
          provision: async () => {
            controller.abort();
            return {
              status: "ready",
              handle: { id: "lab-one", snapshotDigest },
            };
          },
          seedCanaries: async () => ({ status: "seeded" }),
          teardown: async () => {
            cleaned++;
            return { status: "removed" };
          },
        },
        discovery: async () => {
          discoveryPrepared++;
          throw new Error("Discovery should not be prepared after stop");
        },
      } as unknown as CampaignPipeline<
        typeof target,
        never,
        never,
        never,
        never
      >;
      const result = await runCampaignPipeline({
        campaignId: "child-two",
        ledger,
        store,
        pipeline,
        clock: () => new Date("2026-10-14T00:00:00.000Z"),
        newId: () => "unused",
        stopSignal: controller.signal,
      });
      expect(result).toMatchObject({
        stopped: "operator",
        targets: [],
        skipped: [],
      });
      expect(cleaned).toBe(1);
      expect(discoveryPrepared).toBe(0);
      expect(
        ledger.read({
          campaignId: "child-two",
          type: "discovery-run-started",
          limit: 10,
        }),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
