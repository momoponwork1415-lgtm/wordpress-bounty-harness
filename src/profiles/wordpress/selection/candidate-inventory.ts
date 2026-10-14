import { z } from "zod";

import {
  canonicalDigestPreservingProperties,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { WordPressOrgCandidateCursor } from "./wordpress-org-candidate-enumerator.js";
import {
  wordPressSelectionPolicySchema,
  wordPressTargetSelectionSchema,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "./contracts.js";
import type { WordPressSelectionBatchInspection } from "./wordpress-selection.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative();
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const cursorSchema = z.strictObject({
  kind: z.literal("wordpress-org-candidate-cursor"),
  schemaVersion: z.literal(1),
  listingSetDigest: digestSchema,
  nextIndex: countSchema,
});
const traversalSchema = z.strictObject({
  listingSetDigest: digestSchema,
  offset: countSchema,
  observedUniqueCandidates: countSchema,
  complete: z.boolean(),
  nextCursor: cursorSchema.optional(),
});
const definitiveIneligibilityReasons = new Set([
  "distribution-closed",
  "update-stale",
  "excluded-author",
  "excluded-slug",
  "below-installation-threshold",
  "core-version-incompatible",
]);
/** Deliberately omits the observation/programme refs required by freeze(). */
const inventoryCandidateSchema = z.strictObject({
  targetId: z.string().regex(/^wporg:[a-z0-9][a-z0-9-]*$/),
  slug: slugSchema,
  version: z.string().min(1).max(64),
  activeInstallations: countSchema,
  candidateTag: slugSchema.optional(),
  versionPublishedAt: z.iso.datetime({ offset: true }).optional(),
  score: z.number().finite(),
  scoreBreakdown: z.strictObject({
    installations: z.number().finite(),
    recency: z.number().finite(),
    surface: z.number().finite(),
    highThreat: z.number().finite(),
    history: z.number().finite(),
  }),
});
export type WordPressInventoryCandidate = z.infer<
  typeof inventoryCandidateSchema
>;
const candidateInventorySchema = z.strictObject({
  kind: z.literal("wordpress-candidate-inventory"),
  schemaVersion: z.literal(1),
  policy: z.strictObject({ id: z.string().min(1), digest: digestSchema }),
  collectedAt: z.iso.datetime({ offset: true }),
  source: z.strictObject({
    status: z.enum(["available", "stale", "unavailable"]),
    requestedListingCoverage: z.enum([
      "all-observed",
      "partial",
      "none-observed",
    ]),
    listings: z.strictObject({
      available: countSchema,
      stale: countSchema,
      unavailable: countSchema,
      missing: countSchema,
    }),
    /** Missing only in inventory artifacts written before cursor support. */
    traversal: traversalSchema.optional(),
  }),
  observedCandidates: countSchema,
  ineligibleByReason: z.record(z.string(), countSchema),
  candidates: z.array(inventoryCandidateSchema).max(500),
});

export type WordPressCandidateInventory = z.infer<
  typeof candidateInventorySchema
>;

const fileName = "candidate-inventory.json";
const maximumFileBytes = 2 * 1024 * 1024;

function validateInventory(
  value: unknown,
  policy: WordPressSelectionPolicy,
): WordPressCandidateInventory {
  const inventory = candidateInventorySchema.parse(value);
  const traversal = inventory.source.traversal;
  const maxCandidates =
    "candidateSource" in policy ? policy.candidateSource.maxCandidates : 0;
  const inspectedThrough =
    (traversal?.offset ?? 0) + inventory.observedCandidates;
  if (
    inventory.policy.id !== policy.id ||
    inventory.policy.digest !== canonicalDigestPreservingProperties(policy) ||
    inventory.candidates.length > maxCandidates ||
    inventory.observedCandidates < inventory.candidates.length ||
    inventory.candidates.some(
      (candidate) => candidate.targetId !== `wporg:${candidate.slug}`,
    ) ||
    new Set(inventory.candidates.map((candidate) => candidate.slug)).size !==
      inventory.candidates.length ||
    (traversal !== undefined &&
      (inspectedThrough > traversal.observedUniqueCandidates ||
        inventory.observedCandidates !==
          Math.min(
            maxCandidates,
            traversal.observedUniqueCandidates - traversal.offset,
          ) ||
        traversal.complete !==
          (inspectedThrough === traversal.observedUniqueCandidates) ||
        (traversal.complete
          ? traversal.nextCursor !== undefined
          : traversal.nextCursor === undefined ||
            traversal.nextCursor.nextIndex !== inspectedThrough ||
            traversal.nextCursor.listingSetDigest !==
              traversal.listingSetDigest)))
  )
    throw new Error("Candidate inventory does not match its selection policy");
  return inventory;
}

function publicCandidate(
  selection: WordPressTargetSelection,
  policy: WordPressSelectionPolicy,
): WordPressInventoryCandidate {
  const target = wordPressTargetSelectionSchema.parse(selection);
  if (
    target.targetId !== `wporg:${target.slug}` ||
    target.policy.id !== policy.id ||
    target.policy.digest !== canonicalDigestPreservingProperties(policy)
  )
    throw new Error("Candidate inspection does not match its policy");
  return {
    targetId: target.targetId,
    slug: target.slug,
    version: target.version,
    activeInstallations: target.activeInstallations,
    ...(target.candidateTag ? { candidateTag: target.candidateTag } : {}),
    ...(target.versionPublishedAt
      ? { versionPublishedAt: target.versionPublishedAt }
      : {}),
    score: target.score,
    scoreBreakdown: target.scoreBreakdown,
  };
}

/**
 * Save one bounded page of eligible public metadata, without acquiring source
 * or freezing a Snapshot. The cursor preserves the observed listing set.
 * The result is a proposal only: a start must re-observe eligibility and pass
 * the global Trial-history and active-claim gates (#215, #228).
 */
export async function collectWordPressCandidateInventory(options: {
  readonly policy: WordPressSelectionPolicy;
  readonly inspectBatch: (
    policy: WordPressSelectionPolicy,
    cursor?: WordPressOrgCandidateCursor,
  ) => Promise<WordPressSelectionBatchInspection>;
  readonly cursor?: WordPressOrgCandidateCursor;
  readonly store: Pick<PrivateArtifactStore, "putFiles">;
  readonly clock: () => Date;
}): Promise<{
  readonly digest: string;
  readonly inventory: WordPressCandidateInventory;
}> {
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  if (!("candidateSource" in policy))
    throw new Error(
      "Candidate inventory requires an automatic selection policy",
    );
  const batch = await options.inspectBatch(policy, options.cursor);
  if (
    batch.sourceStatus === "manual" ||
    batch.sourceTraversal === undefined ||
    (options.cursor !== undefined &&
      (batch.sourceTraversal.offset !== options.cursor.nextIndex ||
        batch.sourceTraversal.listingSetDigest !==
          options.cursor.listingSetDigest)) ||
    batch.inspections.length !==
      Math.min(
        policy.candidateSource.maxCandidates,
        batch.sourceTraversal.observedUniqueCandidates -
          batch.sourceTraversal.offset,
      ) ||
    batch.inspections.length > policy.candidateSource.maxCandidates
  )
    throw new Error("Candidate enumeration does not match its policy");

  const ineligibleByReason: Record<string, number> = {};
  const candidates = batch.inspections.flatMap((item) => {
    if (item.status !== "eligible" || item.selection === undefined) {
      for (const reason of new Set(item.reasons))
        ineligibleByReason[reason] = (ineligibleByReason[reason] ?? 0) + 1;
      return [];
    }
    if (item.slug !== item.selection.slug)
      throw new Error("Candidate inspection slug does not match selection");
    return [publicCandidate(item.selection, policy)];
  });
  candidates.sort(
    (left, right) =>
      right.score - left.score || left.slug.localeCompare(right.slug),
  );
  const expectedListings = new Set<string>();
  for (let page = 1; page <= policy.candidateSource.popularPages; page++)
    expectedListings.add(`popular:${page}`);
  for (const tag of new Set(policy.candidateSource.tags))
    for (let page = 1; page <= policy.candidateSource.pagesPerTag; page++)
      expectedListings.add(`tag:${tag}:${page}`);
  const reportedListings = new Set<string>();
  for (const listing of batch.sourceListings) {
    const key =
      listing.kind === "popular"
        ? `popular:${listing.page}`
        : `tag:${listing.tag}:${listing.page}`;
    if (!expectedListings.has(key) || reportedListings.has(key))
      throw new Error("Candidate listing identity does not match its policy");
    reportedListings.add(key);
  }
  const listings = {
    available: batch.sourceListings.filter(
      (item) => item.status === "available",
    ).length,
    stale: batch.sourceListings.filter((item) => item.status === "stale")
      .length,
    unavailable: batch.sourceListings.filter(
      (item) => item.status === "unavailable",
    ).length,
    missing: expectedListings.size - reportedListings.size,
  };
  const requestedListingCoverage =
    listings.available === 0
      ? "none-observed"
      : listings.stale + listings.unavailable + listings.missing > 0
        ? "partial"
        : "all-observed";
  const inventory = validateInventory(
    {
      kind: "wordpress-candidate-inventory",
      schemaVersion: 1,
      policy: {
        id: policy.id,
        digest: canonicalDigestPreservingProperties(policy),
      },
      collectedAt: options.clock().toISOString(),
      source: {
        status: batch.sourceStatus,
        requestedListingCoverage,
        listings,
        traversal: batch.sourceTraversal,
      },
      observedCandidates: batch.inspections.length,
      ineligibleByReason,
      candidates,
    },
    policy,
  );
  const digest = await options.store.putFiles({
    [fileName]: canonicalJson(inventory),
  });
  return { digest, inventory };
}

/** Prove source traversal from page zero, with no failed listing or uncertain inspection.
 * This does not decide whether eligible slugs remain unstarted (#215).
 */
export function hasTraversedWordPressCandidateSource(
  inventories: readonly WordPressCandidateInventory[],
): boolean {
  if (inventories.length === 0) return false;
  const policyDigest = inventories[0]?.policy.digest;
  const listingSetDigest = inventories[0]?.source.traversal?.listingSetDigest;
  if (listingSetDigest === undefined) return false;
  const first = inventories[0];
  if (first === undefined) return false;
  const expectedListings =
    first.source.listings.available +
    first.source.listings.stale +
    first.source.listings.unavailable +
    first.source.listings.missing;
  if (expectedListings === 0) return false;
  const observedUniqueCandidates =
    first.source.traversal?.observedUniqueCandidates;
  let nextIndex = 0;
  for (const [index, inventory] of inventories.entries()) {
    const traversal = inventory.source.traversal;
    if (
      inventory.policy.digest !== policyDigest ||
      inventory.source.status !== "available" ||
      inventory.source.requestedListingCoverage !== "all-observed" ||
      inventory.source.listings.available !== expectedListings ||
      inventory.source.listings.stale !== 0 ||
      inventory.source.listings.unavailable !== 0 ||
      inventory.source.listings.missing !== 0 ||
      Object.entries(inventory.ineligibleByReason).some(
        ([reason, count]) =>
          count > 0 && !definitiveIneligibilityReasons.has(reason),
      ) ||
      traversal?.listingSetDigest !== listingSetDigest ||
      traversal.observedUniqueCandidates !== observedUniqueCandidates ||
      traversal.offset !== nextIndex
    )
      return false;
    nextIndex += inventory.observedCandidates;
    if (traversal.complete)
      return (
        nextIndex === observedUniqueCandidates &&
        index === inventories.length - 1
      );
    if (
      nextIndex >= traversal.observedUniqueCandidates ||
      traversal.nextCursor?.nextIndex !== nextIndex ||
      traversal.nextCursor.listingSetDigest !== listingSetDigest
    )
      return false;
  }
  return false;
}

/** Resume a stored proposal by digest. An unavailable source is never read as exhaustion. */
export async function readWordPressCandidateInventory(options: {
  readonly digest: string;
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
}): Promise<WordPressCandidateInventory> {
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  const file = await options.store.readFile(
    digestSchema.parse(options.digest),
    fileName,
    maximumFileBytes,
  );
  if (file.status !== "resolved")
    throw new Error(`Candidate inventory is ${file.status}`);
  return validateInventory(JSON.parse(file.bytes.toString("utf8")), policy);
}
