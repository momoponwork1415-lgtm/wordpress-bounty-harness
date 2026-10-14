import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { canonicalDigestPreservingProperties } from "../../../src/infrastructure/canonical-json.js";
import { PrivateArtifactStore } from "../../../src/infrastructure/private-artifact-store.js";
import {
  collectWordPressCandidateInventory,
  loadWordPressSelectionPolicy,
  readWordPressCandidateInventory,
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
      });
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
      expect(stored.inventory.source.listings.missing).toBe(16);
    });
  });
});
