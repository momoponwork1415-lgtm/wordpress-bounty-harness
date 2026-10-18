import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runCli, type CliProfile } from "../../src/cli/index.js";
import {
  runCampaignPipeline,
  verifyNextFinding,
} from "../../src/cli/pipeline.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

it("routes refute run and backfill without selecting a Lab", async () => {
  const root = await mkdtemp(join(tmpdir(), "refute-cli-"));
  try {
    const calls: { campaignId: string; findingId?: string }[] = [];
    const profile = {
      refute: async (
        _state: unknown,
        input: { campaignId: string; findingId?: string },
      ) => {
        calls.push(input);
        return [
          {
            findingId: input.findingId ?? "finding-1",
            verdict: "undecided" as const,
          },
        ];
      },
    } as unknown as CliProfile;
    const environment = { stateDirectory: root, profile };
    const io = {
      stdout: () => undefined,
      stderr: () => undefined,
    };
    expect(
      await runCli(
        ["refute", "run", "--campaign", "campaign-1", "--finding", "finding-1"],
        environment,
        io,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["refute", "backfill", "--campaign", "campaign-1"],
        environment,
        io,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      { campaignId: "campaign-1", findingId: "finding-1" },
      { campaignId: "campaign-1" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refutes a recorded Finding before the verification consumer and skips it on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "refute-pipeline-"));
  try {
    const digest = `sha256:${"a".repeat(64)}`;
    const store = new PrivateArtifactStore({
      rootDirectory: join(root, "private"),
      maxEntries: 10,
      maxBytes: 100_000,
    });
    const ledger = new Ledger({
      databasePath: join(root, "ledger.sqlite"),
      artifactStore: store,
    });
    const common = {
      schemaVersion: 1 as const,
      campaignId: "campaign-1",
      snapshotDigest: digest,
      occurredAt: "2026-10-18T00:00:00Z",
    };
    await ledger.append({
      ...common,
      identity: "finding-1",
      type: "finding-recorded",
      findingId: "finding-1",
      runId: "discover-1",
      category: "sqli",
    });
    await ledger.append({
      ...common,
      identity: "concluded-1",
      type: "discovery-concluded",
      stoppedBy: "max-runs",
    });
    const target = {
      targetId: "target-1",
      version: "1.0",
      score: 1,
      selectedAt: common.occurredAt,
      policy: { id: "policy-1", digest },
    };
    const snapshot = {
      kind: "source-snapshot" as const,
      schemaVersion: 1 as const,
      digest,
      target: {
        identity: target.targetId,
        version: target.version,
        sourceDigest: digest,
      },
      dependencies: [],
    };
    const handle = {
      id: "lab-1",
      snapshotDigest: digest,
      setupDigest: digest,
      endpoint: "local",
    };
    let provisions = 0;
    let refutations = 0;
    let verifications = 0;
    let sequence = 0;
    const options = {
      campaignId: common.campaignId,
      ledger,
      store,
      clock: () => new Date(common.occurredAt),
      newId: () => `id-${++sequence}`,
      pipeline: {
        select: async () => [target],
        freeze: async () => snapshot,
        setupFor: () => ({}),
        lab: {
          provision: async () => {
            provisions++;
            return { status: "ready" as const, handle };
          },
          seedCanaries: async () => ({ status: "seeded" as const, digest }),
          teardown: async () => ({ status: "removed" as const }),
        },
        discovery: async () => ({
          input: {
            schemaVersion: 1 as const,
            snapshotDigest: digest,
            trustBoundary: { version: "test", text: "test" },
            programmeBoundary: { version: "test", text: "test" },
            modelProfileDigest: digest,
            promptDigest: digest,
            stopRules: { maxRuns: 1, noFindingRuns: 1 },
            lab: { setupDigest: digest },
            history: { mode: "none" as const },
          },
          plannedTrials: [],
          historyFraction: 0,
          executor: undefined as never,
          attachments: undefined as never,
          admitFinding: undefined as never,
        }),
        refuteFinding: async () => {
          refutations++;
          await ledger.append({
            ...common,
            identity: "park-1",
            type: "finding-parked",
            findingId: "finding-1",
            runId: "discover-1",
            category: "sqli",
            reason: "refuted",
          });
          return true;
        },
        verification: {
          verify: async () => {
            verifications++;
            throw new Error("verification must not run");
          },
        },
        reconstructionFor: () => null,
      },
    };
    await runCampaignPipeline(options as never);
    await runCampaignPipeline(options as never);
    expect([provisions, refutations, verifications]).toEqual([1, 1, 0]);
    await ledger.append({
      ...common,
      identity: "finding-2",
      type: "finding-recorded",
      findingId: "finding-2",
      runId: "discover-1",
      category: "sqli",
    });
    let pendingRefutations = 0;
    expect(
      await verifyNextFinding({
        campaignId: common.campaignId,
        ledger,
        newId: () => "unused",
        loadSnapshot: async () => {
          throw new Error("Lab opened before refutation");
        },
        setupFor: () => ({}),
        reconstructionFor: () => null,
        verification: options.pipeline.verification as never,
        refuteFinding: async () => {
          pendingRefutations++;
        },
      }),
    ).toBeNull();
    expect(pendingRefutations).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
