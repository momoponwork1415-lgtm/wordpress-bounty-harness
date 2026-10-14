import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import {
  continuousChildCampaignId,
  type ContinuousRunRecord,
} from "../../../infrastructure/continuous-run-journal.js";
import type {
  ContinuousRunOwnerHandle,
  SqliteContinuousRunOwner,
} from "../../../infrastructure/continuous-run-owner.js";
import type { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../../ledger/index.js";
import type { Snapshot } from "../../../snapshot/index.js";
import {
  readWordPressCandidateInventory,
  readWordPressInventorySourcePool,
} from "./candidate-inventory.js";
import {
  wordPressSelectionPolicySchema,
  wordPressTargetSelectionSchema,
  type SelectionReason,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "./contracts.js";
import { inspectWordPressLedgerExclusions } from "./ledger-exclusions.js";
import type { WordPressSelectionWithBatchInspection } from "./wordpress-selection.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const plannedSelectionSchema = z.strictObject({
  selectionId: z.string().min(1).max(128),
  snapshotDigest: digest,
  targetSelectionDigest: digest,
  selectedAt: z.iso.datetime({ offset: true }),
});
type PlannedSelection = z.infer<typeof plannedSelectionSchema>;
const existingReportSchema = z.object({
  schemaVersion: z.literal(1),
  policyDigest: digest,
  inventoryDigest: digest,
  sourcePoolDigest: digest,
  selectedSnapshotDigests: z.array(digest).min(1).max(5),
  /** Added after the first implementation; old fully appended reports omit it. */
  selectionPlan: z.array(plannedSelectionSchema).min(1).max(5).optional(),
});
const batchIdFor = (parentRunId: string, ordinal: number) =>
  `selection-${canonicalDigest({ parentRunId, ordinal }).slice(7, 39)}`;
const selectedSlug = (selectionId: string) =>
  /^wporg:([a-z0-9][a-z0-9-]*)@[^@]+$/u.exec(selectionId)?.[1] ?? null;
const definitiveIneligibilityReasons = new Set<SelectionReason>([
  "distribution-closed",
  "update-stale",
  "excluded-author",
  "excluded-slug",
  "below-installation-threshold",
  "core-version-incompatible",
]);
const selectionEvent = (
  batchId: string,
  index: number,
  planned: PlannedSelection,
  promptVariant: string,
  reportDigest: string,
) => ({
  schemaVersion: 1 as const,
  identity: `selected-${canonicalDigest({ batchId, index }).slice(7, 39)}`,
  campaignId: batchId,
  snapshotDigest: planned.snapshotDigest,
  occurredAt: planned.selectedAt,
  type: "target-selected" as const,
  selectionId: planned.selectionId,
  promptVariant,
  artifacts: [
    { kind: "target-selection", digest: planned.targetSelectionDigest },
    { kind: "selection-report", digest: reportDigest },
  ],
});

export type ContinuousBatchPreparation =
  | {
      readonly status: "ready";
      readonly selectionBatchId: string;
      readonly snapshotDigests: readonly string[];
      readonly reportDigest: string;
    }
  | {
      readonly status: "hold";
      readonly reason: "insufficient-eligible-candidates";
      readonly inspected: number;
      readonly frozen: number;
    }
  | {
      readonly status: "hold";
      readonly reason:
        "candidate-history-unverified" | "candidate-observation-unverified";
    }
  | {
      readonly status: "hold";
      readonly reason: "candidate-source-pool-expired";
      /** A partial selection plan must remain on its original inventory. */
      readonly selectionPrefixLength: number;
    };

/**
 * Prepare a child selection batch from one private inventory page. This uses
 * the unchanged automatic policy. The caller must bind the returned exact
 * batch to the reserved child before invoking campaign run. The injected
 * eligibility check must be backed by the host-common #215 registry; there is
 * deliberately no permissive default.
 */
export async function prepareWordPressContinuousBatch(options: {
  readonly parent: ContinuousRunRecord;
  readonly owner: Pick<SqliteContinuousRunOwner, "assertReady">;
  readonly ownerHandle: ContinuousRunOwnerHandle;
  readonly policy: WordPressSelectionPolicy;
  readonly store: Pick<PrivateArtifactStore, "readFile" | "putFiles">;
  readonly ledger: Pick<Ledger, "read" | "append">;
  readonly selection: Pick<
    WordPressSelectionWithBatchInspection,
    "inspectNominated"
  >;
  readonly freeze: (
    target: WordPressTargetSelection,
  ) => Promise<Pick<Snapshot, "digest">>;
  readonly preFreezeEligibility: (
    slug: string,
  ) => Promise<"eligible" | "already-started" | "hold">;
  readonly clock: () => Date;
}): Promise<ContinuousBatchPreparation> {
  const policy = wordPressSelectionPolicySchema.parse(options.policy);
  if (!("candidateSource" in policy))
    throw new Error("Continuous selection requires automatic policy");
  options.owner.assertReady(options.ownerHandle);
  const child = options.parent.children.at(-1);
  if (
    options.parent.policyDigest !== canonicalDigest(policy) ||
    options.parent.inventoryDigest !== child?.inventoryDigest ||
    options.parent.state !== "RUNNING" ||
    options.parent.stopRequested ||
    child?.status !== "reserved" ||
    child.binding !== null ||
    child.ordinal !== options.parent.children.length - 1 ||
    child.campaignId !==
      continuousChildCampaignId(options.parent.parentRunId, child.ordinal) ||
    options.parent.children
      .slice(0, -1)
      .some((prior) => prior.status !== "settled")
  )
    throw new Error("A single unbound reserved child is required");
  if (options.selection.inspectNominated === undefined)
    throw new Error("Nominated automatic re-observation is unavailable");

  const batchId = batchIdFor(options.parent.parentRunId, child.ordinal);
  let sourceExpiryMs: number | null = null;
  const poolExpired = () =>
    sourceExpiryMs !== null && options.clock().getTime() > sourceExpiryMs;
  const expiredHold = (selectionPrefixLength: number) => ({
    status: "hold" as const,
    reason: "candidate-source-pool-expired" as const,
    selectionPrefixLength,
  });
  const existing = options.ledger.read({
    campaignId: batchId,
    limit: 6,
  });

  const readPlannedTarget = async (planned: PlannedSelection) => {
    const file = await options.store.readFile(
      planned.targetSelectionDigest,
      "target-selection.json",
      2 * 1024 * 1024,
    );
    if (file.status !== "resolved")
      throw new Error("Planned child target selection is unavailable");
    const target = wordPressTargetSelectionSchema.parse(
      JSON.parse(file.bytes.toString("utf8")) as unknown,
    );
    if (
      `${target.targetId}@${target.version}` !== planned.selectionId ||
      target.selectedAt !== planned.selectedAt ||
      target.policy.id !== policy.id ||
      target.policy.digest !== canonicalDigest(policy) ||
      !eligibleCandidates.some(
        (candidate) =>
          candidate.slug === target.slug &&
          candidate.targetId === target.targetId &&
          !consumedSlugs.has(candidate.slug),
      )
    )
      throw new Error("Planned child target selection is inconsistent");
    return target;
  };

  const assertExactPrefix = (
    records: typeof existing,
    plan: readonly PlannedSelection[],
    reportDigest: string,
  ) => {
    if (
      records.length > plan.length ||
      records.some(
        ({ event }, index) =>
          canonicalJson(event) !==
          canonicalJson(
            selectionEvent(
              batchId,
              index,
              plan[index]!,
              policy.promptVariant,
              reportDigest,
            ),
          ),
      )
    )
      throw new Error("Existing child selection is not an exact plan prefix");
  };

  const appendRemainder = async (
    plan: readonly PlannedSelection[],
    reportDigest: string,
    prefixLength: number,
  ) => {
    for (let index = prefixLength; index < plan.length; index++) {
      if (poolExpired()) return index;
      options.owner.assertReady(options.ownerHandle);
      const result = await options.ledger.append(
        selectionEvent(
          batchId,
          index,
          plan[index]!,
          policy.promptVariant,
          reportDigest,
        ),
      );
      if (result.status === "conflict")
        throw new Error("Continuous child selection batch conflicted");
    }
    if (poolExpired()) return plan.length;
    const complete = options.ledger.read({ campaignId: batchId, limit: 6 });
    if (complete.length !== plan.length)
      throw new Error("Continuous child selection batch is incomplete");
    assertExactPrefix(complete, plan, reportDigest);
    return null;
  };

  const consumedSlugs = new Set<string>();
  for (const prior of options.parent.children.slice(0, -1)) {
    if (prior.binding === null)
      throw new Error("Prior child has no selection binding");
    const records = options.ledger.read({
      campaignId: prior.binding.selectionBatchId,
      type: "target-selected",
      limit: 6,
    });
    if (
      records.length !== prior.binding.snapshotDigests.length ||
      records.some(
        ({ event }, index) =>
          event.type !== "target-selected" ||
          event.snapshotDigest !== prior.binding!.snapshotDigests[index],
      )
    )
      throw new Error("Prior child selection batch does not match its binding");
    for (const { event } of records) {
      if (event.type !== "target-selected")
        throw new Error("Invalid prior child selection");
      const slug = selectedSlug(event.selectionId);
      if (slug === null) throw new Error("Prior child slug is unavailable");
      consumedSlugs.add(slug);
    }
  }

  const inventory = await readWordPressCandidateInventory({
    digest: child.inventoryDigest,
    policy,
    store: options.store,
  });
  // Expiry is an expected inventory lifecycle state, not a failed campaign.
  // Preserve an appended prefix so the parent cannot silently replace its
  // source page with new observations before the selection is reconciled.
  const sourceExpiry = inventory.source.pool?.expiresAt;
  const sourceClock = options.clock();
  sourceExpiryMs = sourceExpiry === undefined ? null : Date.parse(sourceExpiry);
  if (
    sourceExpiry !== undefined &&
    sourceClock.getTime() > Date.parse(sourceExpiry)
  )
    return expiredHold(existing.length);
  const pool = await readWordPressInventorySourcePool({
    inventory,
    policy,
    store: options.store,
    clock: () => sourceClock,
  });
  const sealedPoolDigest = inventory.source.pool?.digest;
  if (sealedPoolDigest === undefined)
    throw new Error("Continuous inventory has no sealed source pool");
  // A candidate page can hold fewer than three eligible slugs even when the
  // sealed listing set has enough across pages. Resolve only the exact linked
  // prefix of this same pool, then nominate from the union. A broken or
  // substituted link is an abnormal inventory failure, never exhaustion.
  const pages = [inventory];
  const seenDigests = new Set([child.inventoryDigest]);
  let newest = inventory;
  for (let page = 0; newest.previousInventoryDigest !== undefined; page++) {
    if (page >= 450 || seenDigests.has(newest.previousInventoryDigest))
      throw new Error("Continuous inventory page chain is invalid");
    const previousDigest = newest.previousInventoryDigest;
    seenDigests.add(previousDigest);
    const previous = await readWordPressCandidateInventory({
      digest: previousDigest,
      policy,
      store: options.store,
    });
    const previousTraversal = previous.source.traversal;
    const newestTraversal = newest.source.traversal;
    if (
      previous.source.pool?.digest !== sealedPoolDigest ||
      previous.source.pool.expiresAt !== sourceExpiry ||
      previousTraversal?.complete !== false ||
      previousTraversal.nextCursor?.sourcePoolDigest !== sealedPoolDigest ||
      previousTraversal.nextCursor?.listingSetDigest !==
        newestTraversal?.listingSetDigest ||
      previousTraversal.nextCursor?.nextIndex !== newestTraversal.offset ||
      previousTraversal.offset + previous.observedCandidates !==
        newestTraversal.offset ||
      previousTraversal.observedUniqueCandidates !==
        newestTraversal.observedUniqueCandidates
    )
      throw new Error("Continuous inventory page chain changed source pool");
    await readWordPressInventorySourcePool({
      inventory: previous,
      policy,
      store: options.store,
      clock: () => sourceClock,
    });
    pages.unshift(previous);
    newest = previous;
  }
  if (pages[0]?.source.traversal?.offset !== 0)
    throw new Error("Continuous inventory page chain has no first page");
  if (poolExpired()) return expiredHold(existing.length);
  const eligibleCandidates = pages.flatMap((page) => page.candidates);
  if (
    new Set(eligibleCandidates.map((candidate) => candidate.slug)).size !==
    eligibleCandidates.length
  )
    throw new Error("Continuous inventory page chain repeats a slug");
  if (existing.length > 0) {
    const reportDigests = existing.map(
      ({ event }) =>
        event.artifacts.find((artifact) => artifact.kind === "selection-report")
          ?.digest,
    );
    const reportDigest = reportDigests[0];
    if (
      reportDigest === undefined ||
      existing.length > policy.maximumTargets ||
      reportDigests.some((value) => value !== reportDigest) ||
      existing.some(({ event }) => event.type !== "target-selected")
    )
      throw new Error("Existing child selection batch is inconsistent");
    const file = await options.store.readFile(
      reportDigest,
      "selection-report.json",
      2 * 1024 * 1024,
    );
    if (file.status !== "resolved")
      throw new Error("Existing child selection report is unavailable");
    const report = existingReportSchema.parse(
      JSON.parse(file.bytes.toString("utf8")) as unknown,
    );
    if (
      report.policyDigest !== canonicalDigest(policy) ||
      report.inventoryDigest !== child.inventoryDigest ||
      report.sourcePoolDigest !== inventory.source.pool?.digest ||
      report.selectedSnapshotDigests.length > policy.maximumTargets
    )
      throw new Error("Existing child selection report does not match ledger");
    // Older reports predate the saved plan. They are replayable only when all
    // selections were already appended; a partial old report cannot prove the
    // intended missing target-selection artifact or timestamp.
    const plan =
      report.selectionPlan ??
      (() => {
        if (existing.length !== report.selectedSnapshotDigests.length)
          throw new Error("Legacy partial child selection cannot be resumed");
        return existing.map(({ event }) => {
          if (event.type !== "target-selected")
            throw new Error("Existing child selection event is invalid");
          const targetSelectionDigest = event.artifacts.find(
            (artifact) => artifact.kind === "target-selection",
          )?.digest;
          if (targetSelectionDigest === undefined)
            throw new Error("Existing child target selection is unavailable");
          return {
            selectionId: event.selectionId,
            snapshotDigest: event.snapshotDigest,
            targetSelectionDigest,
            selectedAt: event.occurredAt,
          };
        });
      })();
    if (
      plan.length !== report.selectedSnapshotDigests.length ||
      canonicalJson(plan.map((item) => item.snapshotDigest)) !==
        canonicalJson(report.selectedSnapshotDigests) ||
      new Set(plan.map((item) => item.snapshotDigest)).size !== plan.length ||
      new Set(plan.map((item) => selectedSlug(item.selectionId))).size !==
        plan.length
    )
      throw new Error("Existing child selection plan is inconsistent");
    assertExactPrefix(existing, plan, reportDigest);
    for (const planned of plan) {
      if (poolExpired()) return expiredHold(existing.length);
      const target = await readPlannedTarget(planned);
      const slug = target.slug;
      if ((await options.preFreezeEligibility(slug)) !== "eligible")
        throw new Error("Existing child slug is no longer eligible");
      const observations = await options.selection.inspectNominated(
        policy,
        pool,
        [slug],
      );
      const observedTarget = observations[0]?.selection;
      if (
        observations.length !== 1 ||
        observations[0]?.status !== "eligible" ||
        observedTarget === undefined ||
        `${observedTarget.targetId}@${observedTarget.version}` !==
          planned.selectionId
      )
        throw new Error("Existing child target no longer matches policy");
      if ((await options.preFreezeEligibility(slug)) !== "eligible")
        throw new Error(
          "Existing child slug changed eligibility before freeze",
        );
      const snapshot = await options.freeze(observedTarget);
      if (snapshot.digest !== planned.snapshotDigest)
        throw new Error("Existing child Snapshot changed");
    }
    if (poolExpired()) return expiredHold(existing.length);
    options.owner.assertReady(options.ownerHandle);
    const expiredPrefix = await appendRemainder(
      plan,
      reportDigest,
      existing.length,
    );
    if (expiredPrefix !== null) return expiredHold(expiredPrefix);
    return {
      status: "ready",
      selectionBatchId: batchId,
      snapshotDigests: plan.map((item) => item.snapshotDigest),
      reportDigest,
    };
  }
  const nominees = eligibleCandidates
    .filter((candidate) => !consumedSlugs.has(candidate.slug))
    .sort(
      (left, right) =>
        right.score - left.score || left.slug.localeCompare(right.slug),
    );
  const chosen: {
    readonly target: WordPressTargetSelection;
    readonly snapshotDigest: string;
  }[] = [];
  let inspected = 0;
  for (const nominee of nominees) {
    if (poolExpired()) return expiredHold(0);
    if (chosen.length === policy.maximumTargets) break;
    const initialEligibility = await options.preFreezeEligibility(nominee.slug);
    if (initialEligibility === "hold")
      return { status: "hold", reason: "candidate-history-unverified" };
    if (initialEligibility === "already-started") continue;
    if (poolExpired()) return expiredHold(0);
    const observations = await options.selection.inspectNominated(
      policy,
      pool,
      [nominee.slug],
    );
    inspected++;
    const observed = observations[0];
    if (observations.length !== 1 || observed?.slug !== nominee.slug)
      throw new Error("Nominated inspection did not return its exact slug");
    if (observed.status !== "eligible" || observed.selection === undefined) {
      if (
        observed.status === "ineligible" &&
        observed.reasons.length > 0 &&
        observed.reasons.every((reason) =>
          definitiveIneligibilityReasons.has(reason),
        )
      )
        continue;
      return { status: "hold", reason: "candidate-observation-unverified" };
    }
    const target = observed.selection;
    if (
      target.targetId !== nominee.targetId ||
      target.policy.id !== policy.id ||
      target.policy.digest !== canonicalDigest(policy)
    )
      throw new Error("Nominated target changed identity or policy");
    const ledgerReasons = inspectWordPressLedgerExclusions({
      ledger: options.ledger,
      candidates: [{ slug: target.slug, version: target.version }],
      currentPromptVariant: policy.promptVariant,
      revisitPolicy: policy.revisitPolicy,
    });
    if (ledgerReasons[0]?.reasons.length !== 0) continue;
    // The callback is repeated immediately before freeze. The Trial gate must
    // still atomically reserve this slug before Lab on actual campaign run.
    const beforeFreezeEligibility = await options.preFreezeEligibility(
      nominee.slug,
    );
    if (beforeFreezeEligibility === "hold")
      return { status: "hold", reason: "candidate-history-unverified" };
    if (beforeFreezeEligibility === "already-started") continue;
    // A freeze failure is an abnormal snapshot/source failure. Only an
    // explicit ineligible observation or history decision skips a nominee.
    const snapshot = await options.freeze(target);
    if (poolExpired()) return expiredHold(0);
    chosen.push({
      target,
      snapshotDigest: digest.parse(snapshot.digest),
    });
  }
  // A sealed listing set may end with one or two untouched slugs. Run those
  // only after its final page is proven; an intermediate page must keep
  // refilling until the normal batch size can be reached.
  if (
    chosen.length === 0 ||
    (chosen.length < 3 && inventory.source.traversal?.complete !== true)
  )
    return {
      status: "hold",
      reason: "insufficient-eligible-candidates",
      inspected,
      frozen: chosen.length,
    };
  if (new Set(chosen.map((item) => item.snapshotDigest)).size !== chosen.length)
    throw new Error("Continuous child selection repeats a Snapshot");
  if (poolExpired()) return expiredHold(0);
  options.owner.assertReady(options.ownerHandle);

  // Persist the complete immutable event plan before appending its first
  // event. Once one event exists, its report digest makes a partial batch
  // discoverable and exactly resumable after a crash.
  const selectionPlan: PlannedSelection[] = [];
  for (const { target, snapshotDigest } of chosen) {
    if (poolExpired()) return expiredHold(0);
    const targetSelectionDigest = await options.store.putFiles({
      "target-selection.json": canonicalJson(target),
    });
    selectionPlan.push({
      selectionId: `${target.targetId}@${target.version}`,
      snapshotDigest,
      targetSelectionDigest,
      selectedAt: target.selectedAt,
    });
  }

  const report = {
    schemaVersion: 1,
    policyDigest: canonicalDigest(policy),
    inventoryDigest: child.inventoryDigest,
    sourcePoolDigest: inventory.source.pool?.digest,
    inspectedAt: options.clock().toISOString(),
    sourceStatus: inventory.source.status,
    selectedSnapshotDigests: chosen.map((item) => item.snapshotDigest),
    selectionPlan,
  };
  const reportDigest = await options.store.putFiles({
    "selection-report.json": canonicalJson(report),
  });
  const expiredPrefix = await appendRemainder(selectionPlan, reportDigest, 0);
  if (expiredPrefix !== null) return expiredHold(expiredPrefix);
  return {
    status: "ready",
    selectionBatchId: batchId,
    snapshotDigests: selectionPlan.map((item) => item.snapshotDigest),
    reportDigest,
  };
}
