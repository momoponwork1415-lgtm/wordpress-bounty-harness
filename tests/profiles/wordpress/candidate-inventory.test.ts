import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDigestPreservingProperties } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import {
  collectWordPressCandidateInventory,
  createWordPressSelection,
  hasTraversedWordPressCandidateSource,
  hasVerifiedWordPressCandidateSourceCoverage,
  loadWordPressSelectionPolicy,
  readWordPressCandidateInventory,
  readWordPressCandidateInventoryCursor,
  type WordPressSelectionBatchInspection,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "../../../src/profiles/wordpress/selection/index.js";

const now = "2026-10-14T00:00:00.000Z";
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const availableListing = (
  kind: "popular" | "tag",
  page: number,
  tag?: string,
) => ({
  kind,
  page,
  ...(tag === undefined ? {} : { tag }),
  sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
  checkedAt: now,
  status: "available" as const,
  observedAt: now,
  contentDigest: digest("c"),
});
const unavailableListing = (page: number) => ({
  kind: "popular" as const,
  page,
  sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
  checkedAt: now,
  status: "unavailable" as const,
  reason: "network-failure" as const,
});
const traversal = (total: number, offset = 0, limit = 500) => {
  const nextIndex = Math.min(total, offset + limit);
  return {
    listingSetDigest: digest("d"),
    offset,
    observedUniqueCandidates: total,
    complete: nextIndex === total,
    ...(nextIndex === total
      ? {}
      : {
          nextCursor: {
            kind: "wordpress-org-candidate-cursor" as const,
            schemaVersion: 1 as const,
            listingSetDigest: digest("d"),
            nextIndex,
          },
        }),
  };
};

function candidate(
  number: number,
  policy: WordPressSelectionPolicy,
): WordPressTargetSelection {
  const slug = `plugin-${String(number).padStart(3, "0")}`;
  return {
    targetId: `wporg:${slug}`,
    slug,
    version: "1.2.3",
    activeInstallations: 100_000,
    highThreatSurface: false,
    score: number,
    scoreBreakdown: {
      installations: number,
      recency: 0,
      surface: 0,
      highThreat: 0,
      history: 0,
    },
    selectedAt: now,
    policy: {
      id: policy.id,
      digest: canonicalDigestPreservingProperties(policy),
    },
    observationRef: {
      kind: "wordpress-org-target-observation-ref",
      schemaVersion: 1,
      id: `observation-${slug}`,
      digest: digest("a"),
    },
    programmeRef: {
      kind: "programme-eligibility-snapshot-ref",
      schemaVersion: 1,
      id: "programme-wordfence",
      digest: digest("b"),
    },
  };
}

async function withStore(
  run: (store: PrivateArtifactStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "wp-candidate-inventory-"));
  try {
    await run(
      new PrivateArtifactStore({
        rootDirectory: directory,
        maxEntries: 4,
        maxBytes: 3 * 1024 * 1024,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("WordPress candidate inventory", () => {
  it("keeps a bounded private listing pool across mutable pages while rechecking targets and programme", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      if (!("candidateSource" in policy))
        throw new Error("Expected automatic policy");
      let currentTime = now;
      let listingChanged = false;
      let failNextObservation = false;
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("request[page]"));
        const group = url.searchParams.get("request[tag]") ?? "popular";
        const slugs = Array.from(
          { length: 50 },
          (_, index) => `${group}-${page}-${index}`,
        );
        return new Response(
          JSON.stringify({
            info: { page },
            plugins: (listingChanged ? ["changed-plugin"] : slugs).map(
              (slug) => ({ slug }),
            ),
          }),
          { status: 200, headers: { Date: new Date(now).toUTCString() } },
        );
      });
      const programmeRef = {
        kind: "programme-eligibility-snapshot-ref" as const,
        schemaVersion: 1 as const,
        id: "wordfence-policy",
        digest: digest("b"),
      };
      const targetSource = {
        observe: vi.fn(async ({ slug }: { slug: string }) => {
          if (failNextObservation) {
            failNextObservation = false;
            return {
              status: "failed" as const,
              operation: "observe" as const,
              reason: "not-found" as const,
              pluginIdentity: `wporg:${slug}`,
            };
          }
          return {
            status: "observed" as const,
            observation: {
              pluginIdentity: `wporg:${slug}`,
              stableVersion: "1.2.3",
              activeInstallations: 100_000,
              lastUpdated: "2026-10-13 12:00am GMT",
              observedAt: currentTime,
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
          };
        }),
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
      const selection = createWordPressSelection({
        targetSource: targetSource as never,
        programme: programme as never,
        programmeRef,
        clock: () => new Date(currentTime),
        fetch: fetcher,
      });
      if (selection.inspectBatch === undefined)
        throw new Error("Expected batch inspector");
      const first = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: selection.inspectBatch,
        store,
        clock: () => new Date(currentTime),
      });
      expect(first.inventory.source.traversal?.observedUniqueCandidates).toBe(
        900,
      );
      expect(first.inventory.candidates).toHaveLength(500);
      expect(first.inventory.source.pool?.digest).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      const cursor = first.inventory.source.traversal?.nextCursor;
      if (cursor === undefined) throw new Error("Expected pool cursor");
      expect(cursor.sourcePoolDigest).toBe(first.inventory.source.pool?.digest);
      expect(
        await readWordPressCandidateInventoryCursor({
          digest: first.digest,
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).toEqual(cursor);
      await expect(
        readWordPressCandidateInventoryCursor({
          digest: first.digest,
          policy: { ...policy, minimumActiveInstallations: 200_000 },
          store,
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("does not match its selection policy");
      await expect(
        readWordPressCandidateInventoryCursor({
          digest: first.digest,
          policy,
          store: {
            readFile: (digest, name, maxBytes) =>
              name === "candidate-source-pool.json"
                ? Promise.resolve({ status: "missing" as const })
                : store.readFile(digest, name, maxBytes),
          },
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("Candidate source pool is missing");
      const observedFetches = fetcher.mock.calls.length;
      listingChanged = true;
      failNextObservation = true;
      const uncertainSecond = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: selection.inspectBatch,
        cursor,
        store,
        clock: () => new Date(currentTime),
      });
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [first.inventory, uncertainSecond.inventory],
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).toBe(false);
      const second = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: selection.inspectBatch,
        cursor,
        store,
        clock: () => new Date(currentTime),
      });
      expect(fetcher).toHaveBeenCalledTimes(observedFetches);
      expect(second.inventory.candidates).toHaveLength(400);
      expect(second.inventory.source.traversal?.complete).toBe(true);
      await expect(
        readWordPressCandidateInventoryCursor({
          digest: second.digest,
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("no verified next page");
      expect(targetSource.observe).toHaveBeenCalledTimes(1_300);
      expect(programme.inspect).toHaveBeenCalledTimes(3);
      expect(
        hasTraversedWordPressCandidateSource(
          [first.inventory, second.inventory],
          () => new Date(currentTime),
        ),
      ).toBe(true);
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [first.inventory, second.inventory],
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).toBe(true);
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [first.inventory, second.inventory],
          policy: { ...policy, minimumActiveInstallations: 200_000 },
          store,
          clock: () => new Date(currentTime),
        }),
      ).toBe(false);
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [
            first.inventory,
            {
              ...second.inventory,
              source: {
                ...second.inventory.source,
                traversal: {
                  ...second.inventory.source.traversal!,
                  listingSetDigest: digest("e"),
                },
              },
            },
          ],
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).toBe(false);
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [first.inventory, second.inventory],
          policy,
          store: { readFile: async () => ({ status: "missing" }) },
          clock: () => new Date(currentTime),
        }),
      ).toBe(false);
      await expect(
        collectWordPressCandidateInventory({
          policy: { ...policy, minimumActiveInstallations: 200_000 },
          inspectBatch: selection.inspectBatch,
          cursor,
          store,
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("does not match its selection policy");
      currentTime = "2026-10-16T00:00:00.000Z";
      await expect(
        readWordPressCandidateInventoryCursor({
          digest: first.digest,
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("source pool is stale");
      expect(
        hasTraversedWordPressCandidateSource(
          [first.inventory, second.inventory],
          () => new Date(currentTime),
        ),
      ).toBe(false);
      expect(
        await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: [first.inventory, second.inventory],
          policy,
          store,
          clock: () => new Date(currentTime),
        }),
      ).toBe(false);
      await expect(
        collectWordPressCandidateInventory({
          policy,
          inspectBatch: selection.inspectBatch,
          cursor,
          store,
          clock: () => new Date(currentTime),
        }),
      ).rejects.toThrow("source pool is stale");
      expect(fetcher).toHaveBeenCalledTimes(observedFetches);
      expect(targetSource.observe).toHaveBeenCalledTimes(1_300);
    });
  });

  it("preserves a large ranked candidate pool without the five-target selection cutoff and resumes by digest", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      if (!("candidateSource" in policy))
        throw new Error("Expected automatic policy");
      const inspections = Array.from({ length: 300 }, (_, index) => ({
        slug: candidate(index, policy).slug,
        status: "eligible" as const,
        reasons: [],
        selection: candidate(index, policy),
      }));
      const inspectBatch = vi.fn(
        async (): Promise<WordPressSelectionBatchInspection> => ({
          inspections: [
            ...inspections,
            {
              slug: "ineligible-plugin",
              status: "ineligible",
              reasons: ["below-installation-threshold"],
            },
          ],
          sourceStatus: "available",
          sourceTraversal: traversal(301),
          sourceListings: [
            ...Array.from(
              { length: policy.candidateSource.popularPages },
              (_, page) => availableListing("popular", page + 1),
            ),
            ...policy.candidateSource.tags.flatMap((tag) =>
              Array.from(
                { length: policy.candidateSource.pagesPerTag },
                (_, page) => availableListing("tag", page + 1, tag),
              ),
            ),
          ],
        }),
      );
      const stored = await collectWordPressCandidateInventory({
        policy,
        inspectBatch,
        store,
        clock: () => new Date(now),
      });
      expect(inspectBatch).toHaveBeenCalledOnce();
      expect(stored.inventory.observedCandidates).toBe(301);
      expect(stored.inventory.candidates).toHaveLength(300);
      expect(stored.inventory.candidates[0]?.score).toBe(299);
      expect(stored.inventory.source.requestedListingCoverage).toBe(
        "all-observed",
      );
      expect(hasTraversedWordPressCandidateSource([stored.inventory])).toBe(
        false,
      );
      expect(stored.inventory.candidates[0]).not.toHaveProperty(
        "observationRef",
      );
      expect(stored.inventory.candidates[0]).not.toHaveProperty("programmeRef");
      expect(stored.inventory.ineligibleByReason).toEqual({
        "below-installation-threshold": 1,
      });
      expect(
        await readWordPressCandidateInventory({
          digest: stored.digest,
          policy,
          store,
        }),
      ).toEqual(stored.inventory);
      expect(inspectBatch).toHaveBeenCalledOnce();
      await expect(
        readWordPressCandidateInventory({
          digest: stored.digest,
          policy: { ...policy, minimumActiveInstallations: 200_000 },
          store,
        }),
      ).rejects.toThrow("does not match its selection policy");
    });
  });

  it("records an unavailable source distinctly from an exhausted eligible pool", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      const stored = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: async () => ({
          inspections: [],
          sourceStatus: "unavailable",
          sourceTraversal: traversal(0),
          sourceListings: [unavailableListing(1)],
        }),
        store,
        clock: () => new Date(now),
      });
      expect(stored.inventory.candidates).toEqual([]);
      expect(stored.inventory.source).toEqual({
        status: "unavailable",
        requestedListingCoverage: "none-observed",
        listings: { available: 0, stale: 0, unavailable: 1, missing: 17 },
        traversal: traversal(0),
      });
      expect(hasTraversedWordPressCandidateSource([stored.inventory])).toBe(
        false,
      );
    });
  });

  it("marks a partly failed listing batch as partial even when its overall status is available", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      const stored = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: async () => ({
          inspections: [],
          sourceStatus: "available",
          sourceTraversal: traversal(0),
          sourceListings: [
            availableListing("popular", 1),
            unavailableListing(2),
          ],
        }),
        store,
        clock: () => new Date(now),
      });
      expect(stored.inventory.candidates).toHaveLength(0);
      expect(stored.inventory.source.requestedListingCoverage).toBe("partial");
      expect(hasTraversedWordPressCandidateSource([stored.inventory])).toBe(
        false,
      );
      expect(stored.inventory.source.listings.missing).toBe(16);
    });
  });

  it("does not certify an unsealed empty listing batch as exhaustion", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      if (!("candidateSource" in policy))
        throw new Error("Expected automatic policy");
      const sourceListings = [
        ...Array.from(
          { length: policy.candidateSource.popularPages },
          (_, page) => availableListing("popular", page + 1),
        ),
        ...policy.candidateSource.tags.flatMap((tag) =>
          Array.from(
            { length: policy.candidateSource.pagesPerTag },
            (_, page) => availableListing("tag", page + 1, tag),
          ),
        ),
      ];
      const stored = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: async () => ({
          inspections: [],
          sourceStatus: "available",
          sourceTraversal: traversal(0),
          sourceListings,
        }),
        store,
        clock: () => new Date(now),
      });
      expect(stored.inventory.candidates).toEqual([]);
      expect(hasTraversedWordPressCandidateSource([stored.inventory])).toBe(
        false,
      );
      const uncertain = await collectWordPressCandidateInventory({
        policy,
        inspectBatch: async () => ({
          inspections: [
            {
              slug: "temporarily-unavailable",
              status: "ineligible",
              reasons: ["observation-unavailable"],
            },
          ],
          sourceStatus: "available",
          sourceTraversal: traversal(1),
          sourceListings,
        }),
        store,
        clock: () => new Date(now),
      });
      expect(hasTraversedWordPressCandidateSource([uncertain.inventory])).toBe(
        false,
      );
    });
  });

  it("persists a continuation page after the 500-candidate cap without declaring exhaustion", async () => {
    await withStore(async (store) => {
      const policy = await loadWordPressSelectionPolicy();
      if (!("candidateSource" in policy))
        throw new Error("Expected automatic policy");
      const inspectBatch = vi.fn(
        async (
          _policy: WordPressSelectionPolicy,
          cursor?: { nextIndex: number },
        ) => {
          const offset = cursor?.nextIndex ?? 0;
          const limit = policy.candidateSource.maxCandidates;
          return {
            inspections: Array.from(
              { length: Math.min(limit, 550 - offset) },
              (_, index) => ({
                slug: candidate(offset + index, policy).slug,
                status: "eligible" as const,
                reasons: [],
                selection: candidate(offset + index, policy),
              }),
            ),
            sourceStatus: "available" as const,
            sourceTraversal: traversal(550, offset, limit),
            sourceListings: [
              ...Array.from(
                { length: policy.candidateSource.popularPages },
                (_, page) => availableListing("popular", page + 1),
              ),
              ...policy.candidateSource.tags.flatMap((tag) =>
                Array.from(
                  { length: policy.candidateSource.pagesPerTag },
                  (_, page) => availableListing("tag", page + 1, tag),
                ),
              ),
            ],
          };
        },
      );
      const first = await collectWordPressCandidateInventory({
        policy,
        inspectBatch,
        store,
        clock: () => new Date(now),
      });
      expect(first.inventory.candidates).toHaveLength(500);
      expect(first.inventory.source.requestedListingCoverage).toBe(
        "all-observed",
      );
      expect(hasTraversedWordPressCandidateSource([first.inventory])).toBe(
        false,
      );
      const replayed = await readWordPressCandidateInventory({
        digest: first.digest,
        policy,
        store,
      });
      const cursor = replayed.source.traversal?.nextCursor;
      expect(cursor?.nextIndex).toBe(500);
      if (cursor === undefined) throw new Error("Expected continuation cursor");
      const second = await collectWordPressCandidateInventory({
        policy,
        inspectBatch,
        cursor,
        store,
        clock: () => new Date(now),
      });
      expect(second.inventory.candidates).toHaveLength(50);
      expect(hasTraversedWordPressCandidateSource([second.inventory])).toBe(
        false,
      );
      expect(
        hasTraversedWordPressCandidateSource([replayed, second.inventory]),
      ).toBe(false);
      expect(
        hasTraversedWordPressCandidateSource([second.inventory, replayed]),
      ).toBe(false);
      expect(
        hasTraversedWordPressCandidateSource([
          replayed,
          {
            ...second.inventory,
            source: {
              ...second.inventory.source,
              traversal: {
                ...second.inventory.source.traversal!,
                listingSetDigest: digest("e"),
              },
            },
          },
        ]),
      ).toBe(false);
      expect(
        new Set([
          ...first.inventory.candidates.map((item) => item.slug),
          ...second.inventory.candidates.map((item) => item.slug),
        ]).size,
      ).toBe(550);
      expect(
        (
          await readWordPressCandidateInventory({
            digest: first.digest,
            policy,
            store,
          })
        ).source.traversal?.nextCursor,
      ).toEqual(cursor);
      expect(inspectBatch).toHaveBeenCalledTimes(2);
    });
  });
});
