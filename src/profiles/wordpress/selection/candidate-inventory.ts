import { z } from "zod";

import {
  canonicalDigestPreservingProperties,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import {
  enumerateWordPressOrgCandidates,
  parseWordPressOrgCandidateSourcePool,
  type WordPressOrgCandidateCursor,
  type WordPressOrgCandidateSourcePool,
} from "./wordpress-org-candidate-enumerator.js";
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
  sourcePoolDigest: digestSchema.optional(),
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
  /** Absent for the first page and older artifacts without chain linkage. */
  previousInventoryDigest: digestSchema.optional(),
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
    /** The sealed listing observation; this is not a Snapshot. */
    pool: z
      .strictObject({
        digest: digestSchema,
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .optional(),
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
const sourcePoolFileName = "candidate-source-pool.json";
const maximumFileBytes = 2 * 1024 * 1024;
const dayMilliseconds = 86_400_000;
const sourcePoolArtifactSchema = z.strictObject({
  kind: z.literal("wordpress-candidate-source-pool"),
  schemaVersion: z.literal(1),
  policy: z.strictObject({ id: z.string().min(1), digest: digestSchema }),
  sourcePool: z.unknown(),
});

async function readSourcePool(
  digest: string,
  policy: WordPressSelectionPolicy,
  store: Pick<PrivateArtifactStore, "readFile">,
): Promise<WordPressOrgCandidateSourcePool> {
  const file = await store.readFile(
    digestSchema.parse(digest),
    sourcePoolFileName,
    maximumFileBytes,
  );
  if (file.status !== "resolved")
    throw new Error(
      `Candidate source pool is ${file.status}; collect a fresh pool`,
    );
  const artifact = sourcePoolArtifactSchema.parse(
    JSON.parse(file.bytes.toString("utf8")) as unknown,
  );
  if (
    artifact.policy.id !== policy.id ||
    artifact.policy.digest !== canonicalDigestPreservingProperties(policy)
  )
    throw new Error(
      "Candidate source pool does not match its selection policy",
    );
  return parseWordPressOrgCandidateSourcePool(artifact.sourcePool);
}

function poolExpiresAt(
  pool: WordPressOrgCandidateSourcePool,
  maxAgeDays: number,
): string {
  const oldest = Math.min(
    ...pool.listings.map((listing) => Date.parse(listing.observedAt)),
  );
  if (!Number.isFinite(oldest))
    throw new Error("Candidate source pool has no observed listing");
  return new Date(oldest + maxAgeDays * dayMilliseconds).toISOString();
}

async function assertSourcePoolPage(
  pool: WordPressOrgCandidateSourcePool,
  policy: Extract<WordPressSelectionPolicy, { candidateSource: unknown }>,
  batch: WordPressSelectionBatchInspection,
  cursor: WordPressOrgCandidateCursor | undefined,
  clock: () => Date,
): Promise<void> {
  const expected = await enumerateWordPressOrgCandidates({
    ...policy.candidateSource,
    sourcePool: pool,
    cursor: cursor ?? {
      kind: "wordpress-org-candidate-cursor",
      schemaVersion: 1,
      listingSetDigest: pool.listingSetDigest,
      nextIndex: 0,
    },
    clock,
  });
  if (
    batch.sourceStatus !== expected.status ||
    canonicalJson(batch.sourceListings) !== canonicalJson(expected.listings) ||
    batch.sourceTraversal?.listingSetDigest !==
      expected.traversal.listingSetDigest ||
    batch.sourceTraversal.offset !== expected.traversal.offset ||
    batch.sourceTraversal.observedUniqueCandidates !==
      expected.traversal.observedUniqueCandidates ||
    batch.sourceTraversal.complete !== expected.traversal.complete ||
    canonicalJson(batch.inspections.map((item) => item.slug)) !==
      canonicalJson(expected.candidates.map((item) => item.slug))
  )
    throw new Error(
      "Candidate source pool page does not match batch inspection",
    );
}

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
    (inventory.previousInventoryDigest !== undefined &&
      (traversal === undefined || traversal.offset === 0)) ||
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
              traversal.listingSetDigest))) ||
    (inventory.source.pool !== undefined &&
      (inventory.source.status !== "available" ||
        inventory.source.requestedListingCoverage !== "all-observed" ||
        (!traversal?.complete &&
          traversal?.nextCursor?.sourcePoolDigest !==
            inventory.source.pool.digest))) ||
    (inventory.source.pool === undefined &&
      traversal?.nextCursor?.sourcePoolDigest !== undefined)
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
    sourcePool?: WordPressOrgCandidateSourcePool,
  ) => Promise<WordPressSelectionBatchInspection>;
  readonly cursor?: WordPressOrgCandidateCursor;
  /** Link a resumed page to the artifact that supplied its verified cursor. */
  readonly previousInventoryDigest?: string;
  readonly store: Pick<PrivateArtifactStore, "putFiles" | "readFile">;
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
  if (options.previousInventoryDigest !== undefined) {
    if (options.cursor === undefined)
      throw new Error("Previous inventory requires a continuation cursor");
    const verifiedCursor = await readWordPressCandidateInventoryCursor({
      digest: options.previousInventoryDigest,
      policy,
      store: options.store,
      clock: options.clock,
    });
    if (canonicalJson(verifiedCursor) !== canonicalJson(options.cursor))
      throw new Error("Continuation cursor does not match previous inventory");
  }
  const priorPoolDigest = options.cursor?.sourcePoolDigest;
  const priorPool =
    priorPoolDigest === undefined
      ? undefined
      : await readSourcePool(priorPoolDigest, policy, options.store);
  const batch = await options.inspectBatch(policy, options.cursor, priorPool);
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
  let sourcePoolDigest = priorPoolDigest;
  let sourcePool = priorPool;
  if (
    sourcePool === undefined &&
    options.cursor === undefined &&
    requestedListingCoverage === "all-observed" &&
    batch.sourcePool !== undefined
  ) {
    sourcePool = parseWordPressOrgCandidateSourcePool(batch.sourcePool);
    if (
      sourcePool.listingSetDigest !== batch.sourceTraversal.listingSetDigest ||
      sourcePool.candidates.length !==
        batch.sourceTraversal.observedUniqueCandidates ||
      canonicalJson(sourcePool.listings) !== canonicalJson(batch.sourceListings)
    )
      throw new Error(
        "Candidate source pool does not match its listing observation",
      );
    await assertSourcePoolPage(
      sourcePool,
      policy,
      batch,
      options.cursor,
      options.clock,
    );
    sourcePoolDigest = await options.store.putFiles({
      [sourcePoolFileName]: canonicalJson({
        kind: "wordpress-candidate-source-pool",
        schemaVersion: 1,
        policy: {
          id: policy.id,
          digest: canonicalDigestPreservingProperties(policy),
        },
        sourcePool,
      }),
    });
  }
  if (
    sourcePool !== undefined &&
    (requestedListingCoverage !== "all-observed" ||
      sourcePool.listingSetDigest !== batch.sourceTraversal.listingSetDigest ||
      sourcePool.candidates.length !==
        batch.sourceTraversal.observedUniqueCandidates ||
      canonicalJson(sourcePool.listings) !==
        canonicalJson(batch.sourceListings))
  )
    throw new Error(
      "Candidate source pool replay does not match its listing observation",
    );
  if (sourcePool !== undefined && priorPool !== undefined)
    await assertSourcePoolPage(
      sourcePool,
      policy,
      batch,
      options.cursor,
      options.clock,
    );
  const pool =
    sourcePool === undefined || sourcePoolDigest === undefined
      ? undefined
      : {
          digest: sourcePoolDigest,
          expiresAt: poolExpiresAt(
            sourcePool,
            policy.candidateSource.maxAgeDays,
          ),
        };
  const sourceTraversal = {
    ...batch.sourceTraversal,
    ...(pool === undefined || batch.sourceTraversal.nextCursor === undefined
      ? {}
      : {
          nextCursor: {
            ...batch.sourceTraversal.nextCursor,
            sourcePoolDigest: pool.digest,
          },
        }),
  };
  const inventory = validateInventory(
    {
      kind: "wordpress-candidate-inventory",
      schemaVersion: 1,
      policy: {
        id: policy.id,
        digest: canonicalDigestPreservingProperties(policy),
      },
      collectedAt: options.clock().toISOString(),
      ...(options.previousInventoryDigest === undefined
        ? {}
        : { previousInventoryDigest: options.previousInventoryDigest }),
      source: {
        status: batch.sourceStatus,
        requestedListingCoverage,
        listings,
        ...(pool === undefined ? {} : { pool }),
        traversal: sourceTraversal,
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

/** Check inventory metadata for a complete, fresh sealed traversal.
 * Use hasVerifiedWordPressCandidateSourceCoverage before an exhaustion decision:
 * this synchronous check cannot detect a private artifact deleted after collection.
 * Neither check decides whether eligible slugs remain unstarted (#215).
 */
export function hasTraversedWordPressCandidateSource(
  inventories: readonly WordPressCandidateInventory[],
  clock: () => Date = () => new Date(),
): boolean {
  if (inventories.length === 0) return false;
  const policyDigest = inventories[0]?.policy.digest;
  const listingSetDigest = inventories[0]?.source.traversal?.listingSetDigest;
  if (listingSetDigest === undefined) return false;
  const first = inventories[0];
  if (first === undefined) return false;
  const pool = first.source.pool;
  const now = clock().getTime();
  if (
    pool === undefined ||
    !Number.isFinite(now) ||
    now > Date.parse(pool.expiresAt)
  )
    return false;
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
      inventory.source.pool?.digest !== pool.digest ||
      inventory.source.pool.expiresAt !== pool.expiresAt ||
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
      traversal.nextCursor.listingSetDigest !== listingSetDigest ||
      traversal.nextCursor.sourcePoolDigest !== pool.digest
    )
      return false;
  }
  return false;
}

/** Re-resolve the private source pool before treating complete traversal as exhaustion evidence. */
export async function hasVerifiedWordPressCandidateSourceCoverage(options: {
  readonly inventories: readonly WordPressCandidateInventory[];
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
  readonly clock: () => Date;
}): Promise<boolean> {
  if (!hasTraversedWordPressCandidateSource(options.inventories, options.clock))
    return false;
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  const first = options.inventories[0];
  if (
    !("candidateSource" in policy) ||
    first?.source.pool === undefined ||
    first.policy.id !== policy.id ||
    first.policy.digest !== canonicalDigestPreservingProperties(policy)
  )
    return false;
  try {
    const pool = await readSourcePool(
      first.source.pool.digest,
      policy,
      options.store,
    );
    const replay = await enumerateWordPressOrgCandidates({
      ...policy.candidateSource,
      cursor: {
        kind: "wordpress-org-candidate-cursor",
        schemaVersion: 1,
        listingSetDigest: pool.listingSetDigest,
        nextIndex: 0,
      },
      sourcePool: pool,
      clock: options.clock,
    });
    return (
      poolExpiresAt(pool, policy.candidateSource.maxAgeDays) ===
        first.source.pool.expiresAt &&
      replay.listings.length === first.source.listings.available &&
      replay.traversal.listingSetDigest ===
        first.source.traversal?.listingSetDigest &&
      replay.traversal.observedUniqueCandidates ===
        first.source.traversal.observedUniqueCandidates &&
      canonicalJson(replay.listings) === canonicalJson(pool.listings)
    );
  } catch {
    return false;
  }
}

/** Resolve a linked inventory chain before using complete traversal as source coverage. */
export async function hasVerifiedWordPressCandidateInventoryChainCoverage(options: {
  readonly digest: string;
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
  readonly clock: () => Date;
}): Promise<boolean> {
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  if (!("candidateSource" in policy)) return false;
  const reverseChain: WordPressCandidateInventory[] = [];
  const seen = new Set<string>();
  let digest = options.digest;
  try {
    // The pool holds at most 2,250 candidates; policy pages have size at least five.
    for (let page = 0; page < 450; page++) {
      if (seen.has(digest)) return false;
      seen.add(digest);
      const inventory = await readWordPressCandidateInventory({
        digest,
        policy,
        store: options.store,
      });
      const traversal = inventory.source.traversal;
      if (traversal === undefined) return false;
      if (page === 0 && !traversal.complete) return false;
      reverseChain.push(inventory);
      if (traversal.offset === 0) {
        if (inventory.previousInventoryDigest !== undefined) return false;
        return await hasVerifiedWordPressCandidateSourceCoverage({
          inventories: reverseChain.reverse(),
          policy,
          store: options.store,
          clock: options.clock,
        });
      }
      if (inventory.previousInventoryDigest === undefined) return false;
      digest = inventory.previousInventoryDigest;
    }
  } catch {
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

/** Resume only a verified page of the same sealed, still-fresh source pool. */
export async function readWordPressCandidateInventoryCursor(options: {
  readonly digest: string;
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
  readonly clock: () => Date;
}): Promise<WordPressOrgCandidateCursor> {
  const inventory = await readWordPressCandidateInventory(options);
  const traversal = inventory.source.traversal;
  const cursor = traversal?.nextCursor;
  const recordedPool = inventory.source.pool;
  if (
    traversal === undefined ||
    cursor === undefined ||
    recordedPool === undefined ||
    cursor.sourcePoolDigest !== recordedPool.digest ||
    inventory.source.status !== "available" ||
    inventory.source.requestedListingCoverage !== "all-observed"
  )
    throw new Error("Candidate inventory has no verified next page");
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  if (!("candidateSource" in policy))
    throw new Error("Candidate inventory requires automatic selection");
  const pool = await readSourcePool(recordedPool.digest, policy, options.store);
  const replay = await enumerateWordPressOrgCandidates({
    ...policy.candidateSource,
    sourcePool: pool,
    cursor: { ...cursor, nextIndex: traversal.offset },
    clock: options.clock,
  });
  if (
    poolExpiresAt(pool, policy.candidateSource.maxAgeDays) !==
      recordedPool.expiresAt ||
    pool.listings.length !== inventory.source.listings.available ||
    inventory.source.listings.stale !== 0 ||
    inventory.source.listings.unavailable !== 0 ||
    inventory.source.listings.missing !== 0 ||
    replay.traversal.listingSetDigest !== traversal.listingSetDigest ||
    replay.traversal.observedUniqueCandidates !==
      traversal.observedUniqueCandidates ||
    replay.candidates.length !== inventory.observedCandidates ||
    replay.traversal.nextCursor === undefined ||
    canonicalJson(replay.traversal.nextCursor) !== canonicalJson(cursor)
  )
    throw new Error("Candidate inventory does not match its source pool");
  return cursor;
}

/** Resolve a page's sealed listing provenance before nominating any slug. */
export async function readWordPressInventorySourcePool(options: {
  readonly inventory: WordPressCandidateInventory;
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile">;
  readonly clock: () => Date;
}): Promise<WordPressOrgCandidateSourcePool> {
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  if (!("candidateSource" in policy))
    throw new Error("Source pool requires automatic selection policy");
  const inventory = validateInventory(options.inventory, policy);
  const ref = inventory.source.pool;
  if (
    ref === undefined ||
    inventory.source.status !== "available" ||
    inventory.source.requestedListingCoverage !== "all-observed" ||
    inventory.source.traversal === undefined ||
    options.clock().getTime() > Date.parse(ref.expiresAt)
  )
    throw new Error("Candidate source pool is unavailable or expired");
  const pool = await readSourcePool(ref.digest, policy, options.store);
  const verified = await enumerateWordPressOrgCandidates({
    ...policy.candidateSource,
    sourcePool: pool,
    cursor: {
      kind: "wordpress-org-candidate-cursor",
      schemaVersion: 1,
      listingSetDigest: pool.listingSetDigest,
      nextIndex: inventory.source.traversal.offset,
    },
    clock: options.clock,
  });
  const expectedExpiry = poolExpiresAt(pool, policy.candidateSource.maxAgeDays);
  const fromPage = new Map(
    verified.candidates.map((candidate) => [candidate.slug, candidate]),
  );
  if (
    pool.listingSetDigest !== inventory.source.traversal.listingSetDigest ||
    expectedExpiry !== ref.expiresAt ||
    verified.status !== "available" ||
    verified.traversal.observedUniqueCandidates !==
      inventory.source.traversal.observedUniqueCandidates ||
    verified.candidates.length !== inventory.observedCandidates ||
    inventory.candidates.some((candidate) => {
      const original = fromPage.get(candidate.slug);
      return (
        original === undefined || original.sourceTag !== candidate.candidateTag
      );
    })
  )
    throw new Error(
      "Candidate inventory does not match its sealed source pool",
    );
  return pool;
}
