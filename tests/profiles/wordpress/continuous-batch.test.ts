import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteContinuousRunJournal } from "../../../src/infrastructure/continuous-run-journal.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../../src/ledger/index.js";
import {
  collectWordPressCandidateInventory,
  createWordPressSelection,
  loadWordPressSelectionPolicy,
  prepareWordPressContinuousBatch,
} from "../../../src/profiles/wordpress/selection/index.js";

const now = "2026-10-14T00:00:00.000Z";
const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup(
  options: {
    readonly slugCount?: number;
    readonly pageSize?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wbh-continuous-batch-"));
  directories.push(directory);
  const store = new PrivateArtifactStore({
    rootDirectory: join(directory, "private-evidence"),
    maxEntries: 20,
    maxBytes: 4 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: store,
  });
  const policy = {
    ...(await loadWordPressSelectionPolicy()),
    maximumTargets: 3,
    candidateSource: {
      kind: "wordpress-org" as const,
      popularPages: 1,
      tags: [],
      pagesPerTag: 1,
      perPage: options.slugCount ?? 7,
      maxCandidates: options.pageSize ?? 7,
      maxAgeDays: 1,
    },
  };
  const slugs = Array.from(
    { length: options.slugCount ?? 7 },
    (_, i) => `plugin-${i + 1}`,
  );
  const targetSource = {
    observe: vi.fn(async ({ slug }: { slug: string }) => ({
      status: "observed" as const,
      observation: {
        pluginIdentity: `wporg:${slug}`,
        stableVersion: "1.0.0",
        activeInstallations: 100_000,
        lastUpdated: "2026-10-13 12:00am GMT",
        observedAt: now,
        author: "Independent Author",
        tags: [],
        minimumWordPressVersion: "6.0",
      },
      observationRef: {
        kind: "wordpress-org-target-observation-ref" as const,
        schemaVersion: 1 as const,
        id: `observation-${slug}`,
        digest: digest("a"),
      },
    })),
  };
  const programmeRef = {
    kind: "programme-eligibility-snapshot-ref" as const,
    schemaVersion: 1 as const,
    id: "programme-wordfence",
    digest: digest("b"),
  };
  const programme = {
    inspect: vi.fn(async () => ({
      status: "current" as const,
      snapshotRef: programmeRef,
      snapshot: {
        programmeIdentity: "programme:wordfence",
        policy: {
          programmeOpportunityBand: "high-impact-only",
          eligibility: {
            assets: [
              { kind: "wordpress-plugin", scope: "publicly-distributed" },
            ],
          },
        },
      },
    })),
  };
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          info: { page: 1 },
          plugins: slugs.map((slug) => ({ slug })),
        }),
        { status: 200, headers: { Date: new Date(now).toUTCString() } },
      ),
  );
  const selection = createWordPressSelection({
    targetSource: targetSource as never,
    programme: programme as never,
    programmeRef,
    fetch: fetcher,
    clock: () => new Date(now),
  });
  if (selection.inspectBatch === undefined)
    throw new Error("Automatic selection inspector is unavailable");
  const collected = await collectWordPressCandidateInventory({
    policy,
    inspectBatch: selection.inspectBatch,
    store,
    clock: () => new Date(now),
  });
  const journal = new SqliteContinuousRunJournal(
    join(directory, "continuous.sqlite"),
  );
  let run = journal.create({
    parentRunId: "parent-one",
    stateDirectory: directory,
    configDigest: digest("c"),
    policyDigest: collected.inventory.policy.digest,
    inventoryDigest: collected.digest,
  });
  const freeze = vi.fn(async (target: { slug: string }) => ({
    digest: digest(String(slugs.indexOf(target.slug) + 1)),
  }));
  const preFreezeEligibility = vi.fn(
    async (_slug: string) =>
      "eligible" as "eligible" | "already-started" | "hold",
  );
  let ownerReady = true;
  const owner = {
    assertReady() {
      if (!ownerReady) throw new Error("Parent recovery required");
    },
  };
  const input = () => ({
    parent: run,
    owner,
    ownerHandle: { parentRunId: run.parentRunId, token: "a".repeat(64) },
    policy,
    store,
    ledger,
    selection,
    freeze,
    preFreezeEligibility,
    clock: () => new Date(now),
  });
  return {
    journal,
    ledger,
    store,
    policy,
    slugs,
    fetcher,
    targetSource,
    selection,
    freeze,
    preFreezeEligibility,
    collected,
    input,
    setOwnerReady(value: boolean) {
      ownerReady = value;
    },
    reserve() {
      run = journal.reserveChild(run.parentRunId, run.revision);
    },
    advanceInventory(inventoryDigest: string) {
      run = journal.advanceUnboundChildInventory(
        run.parentRunId,
        run.revision,
        run.children.length - 1,
        inventoryDigest,
      );
    },
    bindAndSettle(batch: {
      readonly selectionBatchId: string;
      readonly snapshotDigests: readonly string[];
    }) {
      const ordinal = run.children.length - 1;
      run = journal.bindChild(run.parentRunId, run.revision, ordinal, {
        selectionBatchId: batch.selectionBatchId,
        snapshotDigests: batch.snapshotDigests,
      });
      run = journal.settleChild(
        run.parentRunId,
        run.revision,
        ordinal,
        ledger.read().at(-1)?.sequence ?? 0,
      );
    },
  };
}

describe("nominated automatic continuous selection", () => {
  it.each([1, 2])(
    "resumes an exact %i-event selection prefix after an append failure",
    async (prefixLength) => {
      const state = await setup();
      try {
        state.reserve();
        let appended = 0;
        const interruptedLedger = {
          read: state.ledger.read.bind(state.ledger),
          append: async (event: Parameters<typeof state.ledger.append>[0]) => {
            if (appended === prefixLength)
              throw new Error("simulated append interruption");
            appended++;
            return state.ledger.append(event);
          },
        };
        await expect(
          prepareWordPressContinuousBatch({
            ...state.input(),
            ledger: interruptedLedger,
          }),
        ).rejects.toThrow("simulated append interruption");
        const prefix = state.ledger.read({ type: "target-selected" });
        expect(prefix).toHaveLength(prefixLength);
        const reportDigest = prefix[0]?.event.artifacts.find(
          (artifact) => artifact.kind === "selection-report",
        )?.digest;
        expect(reportDigest).toBeDefined();
        const reportFile = await state.store.readFile(
          reportDigest!,
          "selection-report.json",
          2 * 1024 * 1024,
        );
        expect(reportFile.status).toBe("resolved");
        if (reportFile.status !== "resolved") return;
        const plan = JSON.parse(reportFile.bytes.toString("utf8")) as {
          selectionPlan: { selectionId: string; snapshotDigest: string }[];
        };
        expect(plan.selectionPlan).toHaveLength(3);
        const resumed = await prepareWordPressContinuousBatch(state.input());
        expect(resumed).toMatchObject({
          status: "ready",
          reportDigest,
          snapshotDigests: [digest("1"), digest("2"), digest("3")],
        });
        expect(
          state.ledger
            .read({ type: "target-selected" })
            .map(({ event }) =>
              event.type === "target-selected" ? event.selectionId : null,
            ),
        ).toEqual(plan.selectionPlan.map((item) => item.selectionId));
        if (resumed.status === "ready") state.bindAndSettle(resumed);
      } finally {
        state.journal.close();
      }
    },
  );

  it("holds an event that is not the report's exact prefix", async () => {
    const state = await setup();
    try {
      state.reserve();
      let appended = false;
      const interruptedLedger = {
        read: state.ledger.read.bind(state.ledger),
        append: async (event: Parameters<typeof state.ledger.append>[0]) => {
          if (appended) throw new Error("simulated append interruption");
          appended = true;
          return state.ledger.append(event);
        },
      };
      await expect(
        prepareWordPressContinuousBatch({
          ...state.input(),
          ledger: interruptedLedger,
        }),
      ).rejects.toThrow("simulated append interruption");
      const first = state.ledger.read({ type: "target-selected" })[0]?.event;
      expect(first?.type).toBe("target-selected");
      if (first?.type !== "target-selected") return;
      expect(
        await state.ledger.append({
          ...first,
          identity: "selected-tampered",
          selectionId: "wporg:plugin-2@9.9.9",
        }),
      ).toEqual({ status: "appended" });
      await expect(
        prepareWordPressContinuousBatch(state.input()),
      ).rejects.toThrow("not an exact plan prefix");
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(2);
    } finally {
      state.journal.close();
    }
  });

  it("propagates freeze failures instead of reporting candidate exhaustion", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.freeze.mockImplementationOnce(async () => {
        throw new Error("Snapshot source unavailable");
      });
      await expect(
        prepareWordPressContinuousBatch(state.input()),
      ).rejects.toThrow("Snapshot source unavailable");
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });

  it("fixes distinct batches from the same inventory page and never reuses the first three slugs", async () => {
    const state = await setup();
    try {
      state.reserve();
      const first = await prepareWordPressContinuousBatch(state.input());
      expect(first.status).toBe("ready");
      if (first.status !== "ready") return;
      expect(first.snapshotDigests).toEqual([
        digest("1"),
        digest("2"),
        digest("3"),
      ]);
      expect(
        state.ledger
          .read({ campaignId: first.selectionBatchId })
          .map(({ event }) =>
            event.type === "target-selected" ? event.selectionId : null,
          ),
      ).toEqual([
        "wporg:plugin-1@1.0.0",
        "wporg:plugin-2@1.0.0",
        "wporg:plugin-3@1.0.0",
      ]);
      const freezeCount = state.freeze.mock.calls.length;
      state.preFreezeEligibility.mockImplementationOnce(async () => "hold");
      await expect(
        prepareWordPressContinuousBatch(state.input()),
      ).rejects.toThrow("no longer eligible");
      expect(state.freeze).toHaveBeenCalledTimes(freezeCount);
      expect(await prepareWordPressContinuousBatch(state.input())).toEqual(
        first,
      );
      expect(state.freeze).toHaveBeenCalledTimes(freezeCount + 3);
      state.bindAndSettle(first);

      state.reserve();
      const second = await prepareWordPressContinuousBatch(state.input());
      expect(second.status).toBe("ready");
      if (second.status !== "ready") return;
      expect(second.snapshotDigests).toEqual([
        digest("4"),
        digest("5"),
        digest("6"),
      ]);
      expect(second.selectionBatchId).not.toBe(first.selectionBatchId);
      state.bindAndSettle(second);

      state.reserve();
      const final = await prepareWordPressContinuousBatch(state.input());
      expect(final).toMatchObject({
        status: "ready",
        snapshotDigests: [digest("7")],
      });
      if (final.status !== "ready") return;
      state.bindAndSettle(final);
      state.reserve();
      expect(
        await prepareWordPressContinuousBatch(state.input()),
      ).toMatchObject({
        status: "hold",
        reason: "insufficient-eligible-candidates",
        frozen: 0,
      });
      expect(state.fetcher).toHaveBeenCalledTimes(1);
      expect(state.targetSource.observe).toHaveBeenCalledTimes(17);
    } finally {
      state.journal.close();
    }
  });

  it("runs a final short batch only from slugs cleared by the injected history decision", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.preFreezeEligibility.mockImplementation(async (slug) =>
        slug === "plugin-1" || slug === "plugin-2"
          ? "eligible"
          : "already-started",
      );
      expect(
        await prepareWordPressContinuousBatch(state.input()),
      ).toMatchObject({
        status: "ready",
        snapshotDigests: [digest("1"), digest("2")],
      });
      expect(state.freeze).toHaveBeenCalledTimes(2);
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(2);
    } finally {
      state.journal.close();
    }
  });

  it("holds an uncertain historical slug instead of treating it as exhausted", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.preFreezeEligibility.mockResolvedValueOnce("hold");
      expect(await prepareWordPressContinuousBatch(state.input())).toEqual({
        status: "hold",
        reason: "candidate-history-unverified",
      });
      expect(state.freeze).not.toHaveBeenCalled();
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });

  it("holds a transiently unavailable nominated observation instead of treating it as exhausted", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.targetSource.observe.mockRejectedValueOnce(
        new Error("temporarily unavailable"),
      );
      expect(await prepareWordPressContinuousBatch(state.input())).toEqual({
        status: "hold",
        reason: "candidate-observation-unverified",
      });
      expect(state.freeze).not.toHaveBeenCalled();
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });

  it("holds changed policies and unlisted nominees before freeze", async () => {
    const state = await setup();
    try {
      state.reserve();
      state.setOwnerReady(false);
      await expect(
        prepareWordPressContinuousBatch(state.input()),
      ).rejects.toThrow("Parent recovery required");
      state.setOwnerReady(true);
      await expect(
        prepareWordPressContinuousBatch({
          ...state.input(),
          policy: { ...state.policy, minimumActiveInstallations: 200_000 },
        }),
      ).rejects.toThrow("A single unbound reserved child is required");
      const inventory = state.collected.inventory;
      const forged = {
        ...inventory,
        candidates: [
          {
            ...inventory.candidates[0]!,
            slug: "not-in-page",
            targetId: "wporg:not-in-page",
          },
          ...inventory.candidates.slice(1),
        ],
      };
      const forgedDigest = await state.store.putFiles({
        "candidate-inventory.json": JSON.stringify(forged),
      });
      const otherJournal = new SqliteContinuousRunJournal(
        join(directories.at(-1)!, "forged.sqlite"),
      );
      try {
        let run = otherJournal.create({
          parentRunId: "forged-parent",
          stateDirectory: directories.at(-1)!,
          configDigest: digest("c"),
          policyDigest: inventory.policy.digest,
          inventoryDigest: forgedDigest,
        });
        run = otherJournal.reserveChild(run.parentRunId, run.revision);
        await expect(
          prepareWordPressContinuousBatch({ ...state.input(), parent: run }),
        ).rejects.toThrow("does not match its sealed source pool");
      } finally {
        otherJournal.close();
      }
      expect(state.freeze).not.toHaveBeenCalled();
    } finally {
      state.journal.close();
    }
  });

  it("returns a typed hold for an expired sealed source pool without freezing or appending", async () => {
    const state = await setup();
    try {
      state.reserve();
      const observed = state.targetSource.observe.mock.calls.length;
      expect(
        await prepareWordPressContinuousBatch({
          ...state.input(),
          clock: () => new Date("2026-10-16T00:00:00Z"),
        }),
      ).toEqual({
        status: "hold",
        reason: "candidate-source-pool-expired",
        selectionPrefixLength: 0,
      });
      expect(state.freeze).not.toHaveBeenCalled();
      expect(state.targetSource.observe).toHaveBeenCalledTimes(observed);
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });

  it("holds when the sealed pool expires during nominated freeze", async () => {
    const state = await setup();
    try {
      state.reserve();
      let currentTime = new Date(now);
      const result = await prepareWordPressContinuousBatch({
        ...state.input(),
        clock: () => currentTime,
        freeze: async (target) => {
          const snapshot = await state.freeze(target);
          currentTime = new Date("2026-10-16T00:00:00Z");
          return snapshot;
        },
      });
      expect(result).toEqual({
        status: "hold",
        reason: "candidate-source-pool-expired",
        selectionPrefixLength: 0,
      });
      expect(state.freeze).toHaveBeenCalledTimes(1);
      expect(state.ledger.read({ type: "target-selected" })).toEqual([]);
    } finally {
      state.journal.close();
    }
  });

  it("holds the exact selection prefix when the pool expires during append", async () => {
    const state = await setup();
    try {
      state.reserve();
      let currentTime = new Date(now);
      let appended = 0;
      const result = await prepareWordPressContinuousBatch({
        ...state.input(),
        clock: () => currentTime,
        ledger: {
          read: state.ledger.read.bind(state.ledger),
          append: async (event) => {
            const result = await state.ledger.append(event);
            if (++appended === 1)
              currentTime = new Date("2026-10-16T00:00:00Z");
            return result;
          },
        },
      });
      expect(result).toEqual({
        status: "hold",
        reason: "candidate-source-pool-expired",
        selectionPrefixLength: 1,
      });
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(1);
    } finally {
      state.journal.close();
    }
  });

  it("keeps an appended selection prefix bound to its expired source pool", async () => {
    const state = await setup();
    try {
      state.reserve();
      let appended = false;
      const interruptedLedger = {
        read: state.ledger.read.bind(state.ledger),
        append: async (event: Parameters<typeof state.ledger.append>[0]) => {
          if (appended) throw new Error("simulated append interruption");
          appended = true;
          return state.ledger.append(event);
        },
      };
      await expect(
        prepareWordPressContinuousBatch({
          ...state.input(),
          ledger: interruptedLedger,
        }),
      ).rejects.toThrow("simulated append interruption");
      const prefix = state.ledger.read({ type: "target-selected" });
      expect(prefix).toHaveLength(1);
      const frozen = state.freeze.mock.calls.length;
      expect(
        await prepareWordPressContinuousBatch({
          ...state.input(),
          clock: () => new Date("2026-10-16T00:00:00Z"),
        }),
      ).toEqual({
        status: "hold",
        reason: "candidate-source-pool-expired",
        selectionPrefixLength: 1,
      });
      expect(state.freeze).toHaveBeenCalledTimes(frozen);
      expect(state.ledger.read({ type: "target-selected" })).toEqual(prefix);
    } finally {
      state.journal.close();
    }
  });

  it("builds one child batch from eligible slugs across linked pages of the same sealed pool", async () => {
    const state = await setup({ slugCount: 10, pageSize: 5 });
    try {
      state.reserve();
      state.preFreezeEligibility.mockImplementation(async (slug) =>
        ["plugin-1", "plugin-2", "plugin-6", "plugin-7"].includes(slug)
          ? "eligible"
          : "already-started",
      );
      expect(
        await prepareWordPressContinuousBatch(state.input()),
      ).toMatchObject({
        status: "hold",
        reason: "insufficient-eligible-candidates",
        frozen: 2,
      });
      const cursor = state.collected.inventory.source.traversal?.nextCursor;
      if (cursor === undefined) throw new Error("Expected next inventory page");
      if (state.selection.inspectBatch === undefined)
        throw new Error("Expected batch inspector");
      const second = await collectWordPressCandidateInventory({
        policy: state.policy,
        inspectBatch: state.selection.inspectBatch,
        cursor,
        previousInventoryDigest: state.collected.digest,
        store: state.store,
        clock: () => new Date(now),
      });
      state.advanceInventory(second.digest);
      const prepared = await prepareWordPressContinuousBatch(state.input());
      expect(prepared).toMatchObject({
        status: "ready",
        snapshotDigests: [digest("1"), digest("2"), digest("6")],
      });
      if (prepared.status !== "ready") return;
      expect(
        state.ledger
          .read({ campaignId: prepared.selectionBatchId })
          .map(({ event }) =>
            event.type === "target-selected" ? event.selectionId : null,
          ),
      ).toEqual([
        "wporg:plugin-1@1.0.0",
        "wporg:plugin-2@1.0.0",
        "wporg:plugin-6@1.0.0",
      ]);
      expect(state.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      state.journal.close();
    }
  });

  it("rejects a continuation page whose previous inventory cannot be proven", async () => {
    const state = await setup({ slugCount: 10, pageSize: 5 });
    try {
      state.reserve();
      const cursor = state.collected.inventory.source.traversal?.nextCursor;
      if (cursor === undefined) throw new Error("Expected next inventory page");
      if (state.selection.inspectBatch === undefined)
        throw new Error("Expected batch inspector");
      const second = await collectWordPressCandidateInventory({
        policy: state.policy,
        inspectBatch: state.selection.inspectBatch,
        cursor,
        previousInventoryDigest: state.collected.digest,
        store: state.store,
        clock: () => new Date(now),
      });
      const forgedDigest = await state.store.putFiles({
        "candidate-inventory.json": JSON.stringify({
          ...second.inventory,
          previousInventoryDigest: digest("f"),
        }),
      });
      state.advanceInventory(forgedDigest);
      await expect(
        prepareWordPressContinuousBatch(state.input()),
      ).rejects.toThrow("Candidate inventory is missing");
      expect(state.freeze).not.toHaveBeenCalled();
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });
});
