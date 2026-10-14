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

async function setup() {
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
      perPage: 7,
      maxCandidates: 7,
      maxAgeDays: 1,
    },
  };
  const slugs = Array.from({ length: 7 }, (_, i) => `plugin-${i + 1}`);
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
      expect(
        await prepareWordPressContinuousBatch(state.input()),
      ).toMatchObject({
        status: "hold",
        reason: "insufficient-eligible-candidates",
        frozen: 1,
      });
      expect(state.fetcher).toHaveBeenCalledTimes(1);
      expect(state.targetSource.observe).toHaveBeenCalledTimes(17);
    } finally {
      state.journal.close();
    }
  });

  it("requires the injected pre-freeze history decision and leaves a short batch unbound", async () => {
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
        status: "hold",
        reason: "insufficient-eligible-candidates",
        frozen: 2,
      });
      expect(state.freeze).toHaveBeenCalledTimes(2);
      expect(state.ledger.read({ type: "target-selected" })).toHaveLength(0);
    } finally {
      state.journal.close();
    }
  });

  it("holds changed policies, expired pools and unlisted nominees before freeze", async () => {
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
      await expect(
        prepareWordPressContinuousBatch({
          ...state.input(),
          clock: () => new Date("2026-10-16T00:00:00Z"),
        }),
      ).rejects.toThrow("expired");
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
});
