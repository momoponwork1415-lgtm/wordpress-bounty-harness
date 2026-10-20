import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runCampaignPipeline,
  type RuntimeTargetCaps,
} from "../../src/cli/pipeline.js";
import {
  createNativeRunReceipt,
  defineAgentRuntimeProfile,
  ProviderAttachmentStore,
  type DiscoveryTransportRun,
} from "../../src/discovery/index.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";
import { recordWordPressReport } from "../../src/profiles/wordpress/discovery/candidate-admission.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const sha = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const profile = defineAgentRuntimeProfile({
  id: "synthetic",
  transportKind: "codex-native/v1",
  sandboxImageDigest: sha("image"),
  requestedModelId: "gpt-6.1-sol",
  requestedEffort: "high",
  codexCliVersion: "0.161.0",
  bundledCatalogDigest: sha("catalog"),
  authenticationMethod: "host-private-bearer",
  cyberAccessProgram: "standard",
  serviceTier: "priority",
  subagent: { modelId: "unavailable", effort: "unavailable" },
});

type Target = { readonly targetId: string; readonly version: string };
const noFindings = Buffer.from(
  JSON.stringify({ findings: [], examined: "source", unexamined: "none" }),
);

/**
 * A no-Lab campaign over the named targets, one at a time in selection
 * order. A name starting with `c` runs on Claude, any other on Codex; the
 * named targets' Trial ends provider-limited, every other one completes.
 */
async function campaign(
  names: readonly string[],
  limited: ReadonlySet<string>,
  perRuntime: boolean | undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-runtime-limit-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const nameOf = (target: Target) => target.targetId.slice("wporg:".length);
  const runtimeCaps: RuntimeTargetCaps<Target> | undefined =
    perRuntime === undefined
      ? undefined
      : {
          runtimeOf: (target) =>
            nameOf(target).startsWith("c") ? "claude" : "codex",
          ceilings: {},
          providerLimitPerRuntime: perRuntime,
        };
  let ids = 0;
  const summary = await runCampaignPipeline({
    campaignId: "prod-20261020-1",
    ledger,
    store,
    clock: () => new Date("2026-10-20T00:00:00Z"),
    newId: () => `id-${++ids}`,
    discoveryLab: "none",
    maxConcurrentTargets: 1,
    ...(runtimeCaps === undefined ? {} : { runtimeCaps: runtimeCaps as never }),
    pipeline: {
      select: async () =>
        names.map((name) => ({
          targetId: `wporg:${name}`,
          version: "1.0.0",
          score: 1,
          selectedAt: "2026-10-20T00:00:00Z",
          policy: { id: "policy", digest: sha("policy") },
        })),
      freeze: async (target: Target) => ({
        digest: sha(nameOf(target)),
        target: { sourceDigest: sha(`source ${nameOf(target)}`) },
        dependencies: [],
      }),
      setupFor: () => ({}),
      discovery: async ({
        target,
        snapshot,
      }: {
        target: Target;
        snapshot: { digest: string };
      }) => ({
        input: {
          schemaVersion: 1,
          snapshotDigest: snapshot.digest,
          trustBoundary: { version: "v1", text: "Low privilege only" },
          programmeBoundary: { version: "v1", text: "Synthetic boundary" },
          modelProfileDigest: profile.digest,
          promptDigest: sha("prompt"),
          stopRules: { maxRuns: 1, noFindingRuns: 1 },
          lab: { mode: "none" },
          history: { mode: "none" },
        },
        plannedTrials: [
          {
            trialId: `run-${nameOf(target)}`,
            trialOrdinal: 0,
            explore: {
              configuration: { promptVariant: "wp2shell-bounty-v8" },
              run: {
                runId: `run-${nameOf(target)}`,
                targetSnapshotDigest: snapshot.digest,
                profile,
                prompt: "Synthetic objective",
                sourceDirectory: "/synthetic/source",
                sourceTree: { digest: sha("tree"), entries: 1, bytes: 1 },
                expiresAt: "2026-10-20T02:00:00Z",
              },
            },
          },
        ],
        executor: {
          async execute(run: DiscoveryTransportRun) {
            const identity = {
              runId: run.runId,
              targetSnapshotDigest: run.targetSnapshotDigest,
              profile: run.profile,
              startedAt: "2026-10-20T00:00:00Z",
              completedAt: "2026-10-20T00:00:01Z",
            };
            if (limited.has(nameOf(target)))
              return {
                receipt: createNativeRunReceipt({
                  ...identity,
                  terminal: "incomplete",
                  reason: "provider",
                  providerLimit: "rate-limit",
                }),
              };
            const attachment = await attachments.put("findings", noFindings);
            return {
              attachment,
              receipt: createNativeRunReceipt({
                ...identity,
                terminal: "completed",
                reason: "unavailable",
                reportArtifactDigest: attachment.digest,
              }),
            };
          },
        },
        attachments,
        recordReport: recordWordPressReport,
      }),
    } as never,
  });
  const started = ledger
    .readAll({ campaignId: "prod-20261020-1", type: "discovery-run-started" })
    .map(({ event }) => ("runId" in event ? event.runId!.slice(4) : ""));
  const stops = ledger
    .readAll({ campaignId: "prod-20261020-1", type: "campaign-stopped" })
    .map(({ event }) => event);
  return { summary, started, stops, ledger };
}

describe("a provider limit in a campaign split between runtimes", () => {
  it("stops only the limited runtime's targets; the other runtime's targets still start and finish", async () => {
    const { summary, started, stops, ledger } = await campaign(
      ["c1", "x1", "c2", "x2"],
      new Set(["c1"]),
      true,
    );
    // c2 waits for the resume; the Codex targets behind it run.
    expect(started).toEqual(["c1", "x1", "x2"]);
    expect(summary.stopped).toBe("provider-limit");
    expect(summary.limitedRuntimes).toEqual(["claude"]);
    expect(summary.targets.map(({ targetId }) => targetId)).toEqual([
      "wporg:c1",
      "wporg:x1",
      "wporg:x2",
    ]);
    expect(stops).toEqual([
      expect.objectContaining({
        type: "campaign-stopped",
        reason: "provider-limit",
        runtime: "claude",
        snapshotDigest: sha("c1"),
      }),
    ]);
    expect(ledger.stops({ campaignId: "prod-20261020-1" })).toContainEqual({
      type: "campaign-stopped",
      fields: { reason: "provider-limit", runtime: "claude" },
      count: 1,
    });
  });

  it("stops the whole campaign when both runtimes hit their limits", async () => {
    const { summary, started, stops } = await campaign(
      ["c1", "x1", "c2", "x2"],
      new Set(["c1", "x1"]),
      true,
    );
    expect(started).toEqual(["c1", "x1"]);
    expect(summary.stopped).toBe("provider-limit");
    expect(summary.limitedRuntimes).toEqual(["claude", "codex"]);
    expect(stops.map((event) => "runtime" in event && event.runtime)).toEqual([
      "claude",
      "codex",
    ]);
  });

  it.each([
    ["without runtime caps", undefined],
    ["with runtime caps but no runtime share", false],
  ] as const)(
    "%s stops the whole campaign exactly as before",
    async (_, perRuntime) => {
      const { summary, started, stops } = await campaign(
        ["c1", "x1", "c2", "x2"],
        new Set(["c1"]),
        perRuntime,
      );
      expect(started).toEqual(["c1"]);
      expect(summary.stopped).toBe("provider-limit");
      expect(summary).not.toHaveProperty("limitedRuntimes");
      expect(stops).toHaveLength(1);
      expect(stops[0]).not.toHaveProperty("runtime");
    },
  );
});
