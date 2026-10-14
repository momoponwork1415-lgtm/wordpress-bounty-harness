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
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
} from "./contracts.js";
import { inspectWordPressLedgerExclusions } from "./ledger-exclusions.js";
import type { WordPressSelectionWithBatchInspection } from "./wordpress-selection.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const existingReportSchema = z.object({
  schemaVersion: z.literal(1),
  policyDigest: digest,
  inventoryDigest: digest,
  sourcePoolDigest: digest,
  selectedSnapshotDigests: z.array(digest).min(3).max(5),
});
const batchIdFor = (parentRunId: string, ordinal: number) =>
  `selection-${canonicalDigest({ parentRunId, ordinal }).slice(7, 39)}`;
const selectedSlug = (selectionId: string) =>
  /^wporg:([a-z0-9][a-z0-9-]*)@[^@]+$/u.exec(selectionId)?.[1] ?? null;

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
  const existing = options.ledger.read({
    campaignId: batchId,
    type: "target-selected",
    limit: 6,
  });

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
  const pool = await readWordPressInventorySourcePool({
    inventory,
    policy,
    store: options.store,
    clock: options.clock,
  });
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
      existing.some(
        ({ event }) =>
          event.type !== "target-selected" ||
          event.promptVariant !== policy.promptVariant ||
          !inventory.candidates.some(
            (candidate) =>
              selectedSlug(event.selectionId) === candidate.slug &&
              !consumedSlugs.has(candidate.slug),
          ),
      )
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
      canonicalJson(existing.map(({ event }) => event.snapshotDigest)) !==
        canonicalJson(report.selectedSnapshotDigests)
    )
      throw new Error("Existing child selection report does not match ledger");
    for (const { event } of existing) {
      if (event.type !== "target-selected")
        throw new Error("Existing child selection event is invalid");
      const slug = selectedSlug(event.selectionId);
      if (
        slug === null ||
        (await options.preFreezeEligibility(slug)) !== "eligible"
      )
        throw new Error("Existing child slug is no longer eligible");
      const observations = await options.selection.inspectNominated(
        policy,
        pool,
        [slug],
      );
      const target = observations[0]?.selection;
      if (
        observations.length !== 1 ||
        observations[0]?.status !== "eligible" ||
        target === undefined ||
        `${target.targetId}@${target.version}` !== event.selectionId
      )
        throw new Error("Existing child target no longer matches policy");
      if ((await options.preFreezeEligibility(slug)) !== "eligible")
        throw new Error(
          "Existing child slug changed eligibility before freeze",
        );
      const snapshot = await options.freeze(target);
      if (snapshot.digest !== event.snapshotDigest)
        throw new Error("Existing child Snapshot changed");
    }
    options.owner.assertReady(options.ownerHandle);
    return {
      status: "ready",
      selectionBatchId: batchId,
      snapshotDigests: report.selectedSnapshotDigests,
      reportDigest,
    };
  }
  const nominees = inventory.candidates
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
    if (chosen.length === policy.maximumTargets) break;
    if ((await options.preFreezeEligibility(nominee.slug)) !== "eligible")
      continue;
    const observations = await options.selection.inspectNominated(
      policy,
      pool,
      [nominee.slug],
    );
    inspected++;
    const observed = observations[0];
    if (
      observations.length !== 1 ||
      observed?.slug !== nominee.slug ||
      observed.status !== "eligible" ||
      observed.selection === undefined
    )
      continue;
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
    if ((await options.preFreezeEligibility(nominee.slug)) !== "eligible")
      continue;
    let snapshot: Pick<Snapshot, "digest">;
    try {
      snapshot = await options.freeze(target);
    } catch {
      continue;
    }
    chosen.push({
      target,
      snapshotDigest: digest.parse(snapshot.digest),
    });
  }
  if (chosen.length < 3)
    return {
      status: "hold",
      reason: "insufficient-eligible-candidates",
      inspected,
      frozen: chosen.length,
    };
  if (new Set(chosen.map((item) => item.snapshotDigest)).size !== chosen.length)
    throw new Error("Continuous child selection repeats a Snapshot");
  options.owner.assertReady(options.ownerHandle);

  const report = {
    schemaVersion: 1,
    policyDigest: canonicalDigest(policy),
    inventoryDigest: child.inventoryDigest,
    sourcePoolDigest: inventory.source.pool?.digest,
    inspectedAt: options.clock().toISOString(),
    sourceStatus: inventory.source.status,
    selectedSnapshotDigests: chosen.map((item) => item.snapshotDigest),
  };
  const reportDigest = await options.store.putFiles({
    "selection-report.json": canonicalJson(report),
  });
  for (const [index, { target, snapshotDigest }] of chosen.entries()) {
    const selectionDigest = await options.store.putFiles({
      "target-selection.json": canonicalJson(target),
    });
    const result = await options.ledger.append({
      schemaVersion: 1,
      identity: `selected-${canonicalDigest({ batchId, index }).slice(7, 39)}`,
      campaignId: batchId,
      snapshotDigest,
      occurredAt: target.selectedAt,
      type: "target-selected",
      selectionId: `${target.targetId}@${target.version}`,
      promptVariant: policy.promptVariant,
      artifacts: [
        { kind: "target-selection", digest: selectionDigest },
        { kind: "selection-report", digest: reportDigest },
      ],
    });
    if (result.status !== "appended")
      throw new Error("Continuous child selection batch conflicted");
  }
  return {
    status: "ready",
    selectionBatchId: batchId,
    snapshotDigests: chosen.map((item) => item.snapshotDigest),
    reportDigest,
  };
}
