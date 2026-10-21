import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runCampaignPipeline,
  type RuntimeTargetCaps,
} from "../../src/cli/pipeline.js";
import {
  wordpressCampaignConfigSchema,
  wordPressRuntimeCeilings,
} from "../../src/cli/wordpress-session.js";
import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 500 && !condition(); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(condition()).toBe(true);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

type Target = { readonly targetId: string };

/**
 * A campaign over the named targets whose freeze blocks until the test ends
 * it, so each blocked freeze is one target in flight. A name starting with
 * `c` runs on Claude, any other on Codex.
 */
async function campaign(
  names: readonly string[],
  options: {
    readonly maxConcurrentTargets?: number;
    readonly ceilings?: Readonly<Record<string, number>>;
    readonly live?: () => number | null;
    readonly liveRuntime?: (runtime: string) => number | null;
    readonly held?: () => ReadonlySet<string>;
    readonly pollMs?: number;
    readonly stop?: () => boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-runtime-caps-"));
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
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const reports: string[] = [];
  let reads = 0;
  let ids = 0;
  const runtimeOf = (target: Target) =>
    target.targetId.startsWith("wporg:c") ? "claude" : "codex";
  const runtimeCaps: RuntimeTargetCaps<Target> | undefined =
    options.ceilings === undefined
      ? undefined
      : { runtimeOf, ceilings: options.ceilings };
  const done = runCampaignPipeline({
    campaignId: "prod-20261019-1",
    ledger,
    store,
    clock: () => new Date("2026-10-19T00:00:00Z"),
    newId: () => `id-${++ids}`,
    discoveryLab: "none",
    maxConcurrentTargets: options.maxConcurrentTargets ?? 4,
    ...(options.live === undefined &&
    options.liveRuntime === undefined &&
    options.held === undefined
      ? {}
      : {
          targetLimit: {
            read: async () => {
              reads++;
              return options.live?.() ?? null;
            },
            report: (limit: number) => reports.push(`total=${limit}`),
            readRuntime: async (runtime: string) =>
              options.liveRuntime?.(runtime) ?? null,
            reportRuntime: (runtime: string, limit: number) =>
              reports.push(`${runtime}=${limit}`),
            ...(options.held === undefined
              ? {}
              : { heldRuntimes: options.held }),
            pollMs: options.pollMs ?? 5,
          },
        }),
    ...(runtimeCaps === undefined ? {} : { runtimeCaps: runtimeCaps as never }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    pipeline: {
      select: async () =>
        names.map((name) => ({
          targetId: `wporg:${name}`,
          version: "1.0.0",
          score: 1,
          selectedAt: "2026-10-19T00:00:00Z",
          policy: { id: "policy", digest: `sha256:${"b".repeat(64)}` },
        })),
      freeze: (target: Target) =>
        new Promise((_, reject) => {
          started.push(target.targetId.slice("wporg:".length));
          finish.set(target.targetId.slice("wporg:".length), () =>
            reject(new Error("synthetic end")),
          );
        }),
    } as never,
  });
  const end = (name: string) => {
    finish.get(name)!();
    finish.delete(name);
  };
  const running = (runtime?: "claude" | "codex") =>
    [...finish.keys()].filter(
      (name) =>
        runtime === undefined ||
        name.startsWith("c") === (runtime === "claude"),
    ).length;
  return { done, started, reports, end, running, reads: () => reads };
}

describe("per-runtime target caps", () => {
  it("keeps each runtime under its cap and starts the other runtime's later target instead", async () => {
    const c = await campaign(["c1", "c2", "c3", "c4", "x1", "x2", "x3"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 2, codex: 2 },
    });
    await until(() => c.started.length === 4);
    await settle();
    // c3 and c4 wait for a Claude slot; the Codex targets behind them start.
    expect(c.started).toEqual(["c1", "c2", "x1", "x2"]);
    expect(c.running("claude")).toBe(2);
    expect(c.running("codex")).toBe(2);

    // A Codex end frees a Codex slot only: x3 starts, not c3.
    c.end("x1");
    await until(() => c.started.length === 5);
    await settle();
    expect(c.started.at(-1)).toBe("x3");
    expect(c.running("claude")).toBe(2);

    c.end("c1");
    await until(() => c.started.length === 6);
    expect(c.started.at(-1)).toBe("c3");
    for (const name of ["c2", "c3", "x2", "x3"]) c.end(name);
    await until(() => c.started.length === 7);
    c.end("c4");
    const summary = await c.done;
    expect(summary.skipped.map(({ targetId }) => targetId)).toHaveLength(7);
  });

  it("waits without spinning while every pending target's runtime is full", async () => {
    const c = await campaign(["c1", "c2", "c3", "x1"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 1, codex: 1 },
      live: () => null,
      pollMs: 10_000,
    });
    await until(() => c.started.length === 2);
    await settle();
    expect(c.started).toEqual(["c1", "x1"]);
    // Four workers, each read once to start or to wait: no busy loop.
    expect(c.reads()).toBeLessThanOrEqual(4);

    // A release wakes the waiters at once, long before the poll.
    c.end("x1");
    await settle();
    expect(c.started).toEqual(["c1", "x1"]);
    c.end("c1");
    await until(() => c.started.length === 3);
    expect(c.started.at(-1)).toBe("c2");
    c.end("c2");
    await until(() => c.started.length === 4);
    c.end("c3");
    await c.done;
  });

  it("applies a live per-runtime limit before the next start, from 0 up to the cap", async () => {
    let claude: number | null = 0;
    const c = await campaign(["c1", "c2", "c3", "c4", "x1"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 3, codex: 3 },
      liveRuntime: (runtime) => (runtime === "claude" ? claude : null),
    });
    await until(() => c.started.length === 1);
    await settle();
    // Claude held at 0: only the Codex target starts.
    expect(c.started).toEqual(["x1"]);

    // A raise takes effect at the next poll, without a target finishing.
    claude = 2;
    await until(() => c.started.length === 3);
    await settle();
    expect(c.started).toEqual(["x1", "c1", "c2"]);

    // Lowering ends nothing; above the cap the configured cap applies.
    claude = 1;
    c.end("x1");
    await settle();
    expect(c.running("claude")).toBe(2);
    expect(c.started).toHaveLength(3);
    claude = 9;
    await until(() => c.started.length === 4);
    await settle();
    expect(c.started).toHaveLength(4);
    expect(c.running("claude")).toBe(3);

    for (const name of ["c1", "c2", "c3"]) c.end(name);
    await until(() => c.started.length === 5);
    c.end("c4");
    await c.done;
    expect(c.reports).toEqual([
      "total=4",
      "claude=0",
      "codex=3",
      "claude=2",
      "claude=1",
      "claude=3",
    ]);
  });

  it("starts no target of a runtime in provider backoff until it leaves it", async () => {
    let held: ReadonlySet<string> = new Set(["claude"]);
    const c = await campaign(["c1", "x1", "c2", "x2"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 2, codex: 2 },
      held: () => held,
    });
    await until(() => c.started.length === 2);
    await settle();
    expect(c.started).toEqual(["x1", "x2"]);

    // The backoff ends: the next poll starts the held targets.
    held = new Set();
    await until(() => c.started.length === 4);
    expect(c.started).toEqual(["x1", "x2", "c1", "c2"]);
    for (const name of [...c.started]) c.end(name);
    await c.done;
  });

  it("still holds the total under the live total limit", async () => {
    const c = await campaign(["c1", "x1", "c2", "x2"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 2, codex: 2 },
      live: () => 3,
    });
    await until(() => c.started.length === 3);
    await settle();
    expect(c.started).toEqual(["c1", "x1", "c2"]);
    for (const name of [...c.started]) c.end(name);
    await until(() => c.started.length === 4);
    c.end("x2");
    await c.done;
  });

  it("stops as operator while waiting for a held runtime, after the running targets end", async () => {
    let stop = false;
    const c = await campaign(["x1", "c1", "c2"], {
      maxConcurrentTargets: 4,
      ceilings: { claude: 1, codex: 1 },
      liveRuntime: (runtime) => (runtime === "claude" ? 0 : null),
      stop: () => stop,
    });
    await until(() => c.started.length === 1);
    stop = true;
    await settle();
    c.end("x1");
    const summary = await c.done;
    expect(summary.stopped).toBe("operator");
    expect(c.started).toEqual(["x1"]);
  });

  it("without caps starts targets in selection order exactly as before", async () => {
    const c = await campaign(["c1", "c2", "c3", "x1", "x2"], {
      maxConcurrentTargets: 3,
    });
    await until(() => c.started.length === 3);
    await settle();
    expect(c.started).toEqual(["c1", "c2", "c3"]);
    c.end("c2");
    await until(() => c.started.length === 4);
    expect(c.started.at(-1)).toBe("x1");
    for (const name of ["c1", "c3", "x1"]) c.end(name);
    await until(() => c.started.length === 5);
    c.end("x2");
    const summary = await c.done;
    expect(summary.skipped).toHaveLength(5);
  });
});

describe("maxConcurrentTargetsByRuntime in the campaign config", () => {
  const base = JSON.parse(
    '{"schemaVersion":1,"programmeBoundary":{"version":"v","text":"t"},"wordpressVersion":"6.8","lab":{"siteTitle":"s","initialPosts":[],"customerRole":false}}',
  ) as Record<string, unknown>;
  const parse = (
    resources: Record<string, unknown>,
    share?: { codex: number; claude: number },
  ) =>
    wordpressCampaignConfigSchema.safeParse({
      ...base,
      discovery: {
        lab: "none",
        ...(share === undefined ? {} : { runtimeShare: share }),
      },
      resources: {
        maxConcurrentRuns: 1,
        maxConcurrentTargets: 6,
        memoryBudgetMiB: 10752,
        ...resources,
      },
    });

  it("accepts 3 + 3 under 6 with an even share and reads back only the set caps", () => {
    const parsed = parse(
      { maxConcurrentTargetsByRuntime: { codex: 3, claude: 3 } },
      { codex: 1, claude: 1 },
    );
    expect(parsed.success).toBe(true);
    expect(wordPressRuntimeCeilings(parsed.data!)).toEqual({
      codex: 3,
      claude: 3,
    });
    const codexOnly = parse({ maxConcurrentTargetsByRuntime: { codex: 2 } });
    expect(codexOnly.success).toBe(true);
    expect(wordPressRuntimeCeilings(codexOnly.data!)).toEqual({ codex: 2 });
    expect(wordPressRuntimeCeilings(parse({}).data!)).toEqual({});
  });

  it("rejects a cap above maxConcurrentTargets and a missing or zero cap for a runtime with a share", () => {
    expect(
      parse(
        { maxConcurrentTargetsByRuntime: { codex: 7, claude: 3 } },
        { codex: 1, claude: 1 },
      ).success,
    ).toBe(false);
    expect(
      parse(
        { maxConcurrentTargetsByRuntime: { codex: 3 } },
        { codex: 1, claude: 1 },
      ).success,
    ).toBe(false);
    expect(
      parse(
        { maxConcurrentTargetsByRuntime: { codex: 3, claude: 0 } },
        { codex: 1, claude: 1 },
      ).success,
    ).toBe(false);
    // Without a share every target is Codex, so Codex needs the cap.
    expect(
      parse({ maxConcurrentTargetsByRuntime: { claude: 3 } }).success,
    ).toBe(false);
    // A runtime with weight 0 needs no cap.
    expect(
      parse(
        { maxConcurrentTargetsByRuntime: { claude: 2 } },
        { codex: 0, claude: 1 },
      ).success,
    ).toBe(true);
  });
});
