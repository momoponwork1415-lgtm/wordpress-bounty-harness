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
import {
  wordpressCampaignConfigSchema,
  wordPressRuntimeCaps,
} from "../../src/cli/wordpress-session.js";
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
 * A no-Lab campaign over the named targets, in selection order. With a
 * boolean, a name starting with `c` runs on Claude and any other on Codex.
 * The named targets' Trial ends provider-limited, every other one completes;
 * with `manual`, each Trial ends only when the test calls `end`.
 */
async function campaign(
  names: readonly string[],
  limited: ReadonlySet<string>,
  caps: boolean | RuntimeTargetCaps<Target> | undefined,
  options: {
    readonly maxConcurrentTargets?: number;
    manual?: boolean;
    readonly beforeTarget?: (signal: AbortSignal) => Promise<void>;
    readonly evidenceBytes?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-runtime-limit-"));
  roots.push(root);
  const store = new PrivateArtifactStore({
    rootDirectory: join(root, "evidence"),
    maxEntries: 64,
    maxBytes: options.evidenceBytes ?? 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: store,
  });
  const attachments = new ProviderAttachmentStore(join(root, "reports"));
  const nameOf = (target: Target) => target.targetId.slice("wporg:".length);
  const runtimeCaps: RuntimeTargetCaps<Target> | undefined =
    typeof caps !== "boolean"
      ? caps
      : {
          runtimeOf: (target) =>
            nameOf(target).startsWith("c") ? "claude" : "codex",
          ceilings: {},
          providerLimitPerRuntime: caps,
        };
  const gates = new Map<string, () => void>();
  let ids = 0;
  const done = runCampaignPipeline({
    campaignId: "prod-20261020-1",
    ledger,
    store,
    clock: () => new Date("2026-10-20T00:00:00Z"),
    newId: () => `id-${++ids}`,
    discoveryLab: "none",
    maxConcurrentTargets: options.maxConcurrentTargets ?? 1,
    ...(options.beforeTarget === undefined
      ? {}
      : { beforeTarget: options.beforeTarget }),
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
            if (options.manual === true)
              await new Promise<void>((end) => gates.set(nameOf(target), end));
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
  const started = () =>
    ledger
      .readAll({ campaignId: "prod-20261020-1", type: "discovery-run-started" })
      .map(({ event }) => ("runId" in event ? event.runId!.slice(4) : ""));
  const stops = () =>
    ledger
      .readAll({ campaignId: "prod-20261020-1", type: "campaign-stopped" })
      .map(({ event }) => event);
  const end = (name: string) => gates.get(name)!();
  return { done, started, stops, ledger, end, gated: () => [...gates.keys()] };
}

describe("a provider limit in a campaign split between runtimes", () => {
  it("stops only the limited runtime's targets; the other runtime's targets still start and finish", async () => {
    const c = await campaign(["c1", "x1", "c2", "x2"], new Set(["c1"]), true);
    const [summary, started, stops] = [await c.done, c.started(), c.stops()];
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
    expect(c.ledger.stops({ campaignId: "prod-20261020-1" })).toContainEqual({
      type: "campaign-stopped",
      fields: { reason: "provider-limit", runtime: "claude" },
      count: 1,
    });
  });

  it("stops the whole campaign when both runtimes hit their limits", async () => {
    const c = await campaign(
      ["c1", "x1", "c2", "x2"],
      new Set(["c1", "x1"]),
      true,
    );
    const [summary, started, stops] = [await c.done, c.started(), c.stops()];
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
      const c = await campaign(
        ["c1", "x1", "c2", "x2"],
        new Set(["c1"]),
        perRuntime,
      );
      const [summary, started, stops] = [await c.done, c.started(), c.stops()];
      expect(started).toEqual(["c1"]);
      expect(summary.stopped).toBe("provider-limit");
      expect(summary).not.toHaveProperty("limitedRuntimes");
      expect(stops).toHaveLength(1);
      expect(stops[0]).not.toHaveProperty("runtime");
    },
  );
});

describe("runtime-scoped stops", () => {
  const until = async (condition: () => boolean) => {
    // Generous: the whole suite shares the machine.
    for (let i = 0; i < 1000 && !condition(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  };

  it.each(["provider", "runtime-drained", "fatal"])(
    "returns %s while the next target waits for login",
    async (reason) => {
      let calls = 0;
      let releaseLogin = () => {};
      let waiting = false;
      const c = await campaign(
        ["x1", "x2"],
        new Set(["x1"]),
        reason === "runtime-drained" ? true : undefined,
        {
          maxConcurrentTargets: 2,
          manual: reason !== "fatal",
          ...(reason === "fatal" ? { evidenceBytes: 1 } : {}),
          beforeTarget: async (signal) => {
            if (++calls === 1) return;
            waiting = true;
            await new Promise<void>((resolve) => {
              releaseLogin = resolve;
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          },
        },
      );
      let returned = false;
      const done = c.done
        .catch((error: unknown) => error)
        .then((summary) => {
          returned = true;
          return summary;
        });
      try {
        await until(
          () => waiting && (reason === "fatal" || c.gated().includes("x1")),
        );
        if (reason !== "fatal") c.end("x1");
        await expect.poll(() => returned, { timeout: 500 }).toBe(true);
        if (reason === "fatal")
          expect(await done).toMatchObject({ code: "bounds-exceeded" });
        else expect(await done).toMatchObject({ stopped: "provider-limit" });
        expect(c.started()).toEqual(reason === "fatal" ? [] : ["x1"]);
      } finally {
        releaseLogin();
        await done;
      }
    },
  );

  it("with two targets in flight, starts no pending target of the limited runtime", async () => {
    const c = await campaign(
      ["c1", "x1", "c2", "x2", "c3"],
      new Set(["c1"]),
      true,
      { maxConcurrentTargets: 2, manual: true },
    );
    await until(() => c.gated().length === 2);
    expect(c.started().sort()).toEqual(["c1", "x1"]);
    // c1 hits the limit while x1 runs: the freed slot goes to x2, not c2.
    c.end("c1");
    await until(() => c.gated().includes("x2"));
    c.end("x1");
    c.end("x2");
    const summary = await c.done;
    expect(c.started().sort()).toEqual(["c1", "x1", "x2"]);
    expect(summary.limitedRuntimes).toEqual(["claude"]);
  });

  const config = (share: { codex: number; claude: number } | undefined) =>
    wordpressCampaignConfigSchema.parse({
      schemaVersion: 1,
      programmeBoundary: { version: "v", text: "t" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "s", initialPosts: [], customerRole: false },
      discovery: {
        lab: "none",
        ...(share === undefined ? {} : { runtimeShare: share }),
      },
    });

  it.each([
    ["both runtimes weighted, no Lab", { codex: 1, claude: 1 }, true],
    ["Claude weighted 0", { codex: 1, claude: 0 }, false],
    ["Codex weighted 0", { codex: 0, claude: 1 }, false],
  ] as const)(
    "derives the runtime-scoped stop from the config: %s",
    (_, share, perRuntime) => {
      expect(wordPressRuntimeCaps(config(share))?.providerLimitPerRuntime).toBe(
        perRuntime,
      );
    },
  );

  it.each(["codex", "claude"] as const)(
    "accounts partitioned %s roles independently of the wide runtime share",
    (runtime) => {
      const base = config({ codex: 1, claude: 1 });
      const parsed = wordpressCampaignConfigSchema.parse({
        ...base,
        promptId: "objective-partition-v1",
        discovery: {
          ...base.discovery,
          mode: "partitioned",
          enumerator: { runtime },
          tracer: { runtime },
        },
        resources: {
          ...base.resources,
          maxConcurrentTargets: 1,
          maxConcurrentTargetsByRuntime: {
            codex: runtime === "codex" ? 1 : 0,
            claude: runtime === "claude" ? 1 : 0,
          },
        },
      });
      const caps = wordPressRuntimeCaps(parsed)!;
      expect(caps.runtimeOf({ targetId: "wporg:fixed" } as never)).toBe(
        runtime,
      );
      expect(caps.providerLimitPerRuntime).toBe(false);
      expect(caps.ceilings[runtime]).toBe(1);
    },
  );

  it("keeps the whole-campaign stop for a {codex: 1, claude: 0} campaign", async () => {
    expect(wordPressRuntimeCaps(config(undefined))).toBeUndefined();
    const c = await campaign(
      ["a1", "a2", "a3"],
      new Set(["a1"]),
      wordPressRuntimeCaps(config({ codex: 1, claude: 0 })) as never,
    );
    const summary = await c.done;
    expect(c.started()).toEqual(["a1"]);
    expect(summary).not.toHaveProperty("limitedRuntimes");
    expect(c.stops()).toHaveLength(1);
    expect(c.stops()[0]).not.toHaveProperty("runtime");
  });
});
