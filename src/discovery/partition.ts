import { z } from "zod";

import { canonicalDigest } from "../infrastructure/canonical-json.js";

/**
 * The shape of what an enumerator returns in a partitioned Trial (design
 * 2026-10-27 §2–§4): an inventory of rows, each with an id and whether a
 * script or the agent produced it, and a proposal that assigns every row to
 * one partition. The Harness checks the shape, collapses rows that say the
 * same thing, and enforces the limits. It never adds a row, never moves a row
 * between partitions and never splits a partition: an over-limit proposal goes
 * back to the enumerator, up to `maxResubmits` times.
 *
 * The vocabulary of `kind` belongs to the profile's role definition; here it
 * is a declared token only.
 */
const token = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const rowId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const partitionId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const inventoryRowSchema = z.strictObject({
  id: rowId,
  /** Whether a mounted tool script printed the row or the agent added it. */
  origin: z.enum(["script", "agent"]),
  kind: token,
  /** A path relative to the mounted source tree. */
  file: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  text: z.string().min(1).max(400),
});
export type InventoryRow = z.infer<typeof inventoryRowSchema>;

export const INVENTORY_MAX_ROWS = 4000;
export const inventorySchema = z.strictObject({
  rows: z.array(inventoryRowSchema).max(INVENTORY_MAX_ROWS),
});
export type Inventory = z.infer<typeof inventorySchema>;

export const partitionProposalSchema = z.strictObject({
  partitions: z
    .array(
      z.strictObject({
        id: partitionId,
        label: z.string().min(1).max(120),
        rowIds: z.array(rowId).min(1).max(INVENTORY_MAX_ROWS),
      }),
    )
    .min(1)
    .max(64),
});
export type PartitionProposal = z.infer<typeof partitionProposalSchema>;

export const partitionLimitsSchema = z.strictObject({
  maxEntriesPerPartition: z.number().int().positive().max(INVENTORY_MAX_ROWS),
  maxPartitions: z.number().int().positive().max(64),
  maxResubmits: z.number().int().nonnegative().max(5),
});
export type PartitionLimits = z.infer<typeof partitionLimitsSchema>;

/** Why a proposal goes back; enum tokens only, so the ledger can carry them. */
export const PARTITION_REJECTION_REASONS = [
  "duplicate-row-id",
  "duplicate-partition-id",
  "unknown-row-id",
  "row-in-several-partitions",
  "row-unassigned",
  "partition-too-large",
  "too-many-partitions",
] as const;
export type PartitionRejectionReason =
  (typeof PARTITION_REJECTION_REASONS)[number];

export type PartitionRejection = {
  readonly reason: PartitionRejectionReason;
  readonly partitionId?: string;
  readonly rowId?: string;
  /** The count that exceeded the limit, for the two size reasons. */
  readonly count?: number;
};

/** One accepted partition, with the rows it holds after collapsing duplicates. */
export type AssignedPartition = {
  readonly id: string;
  readonly label: string;
  readonly ordinal: number;
  readonly rows: readonly InventoryRow[];
  readonly scriptRowCount: number;
  readonly agentRowCount: number;
  /** canonical digest of the partition as handed to its tracer. */
  readonly assignmentDigest: string;
};

export type CollapsedInventory = {
  readonly rows: readonly InventoryRow[];
  /** Rows dropped because an earlier row said the same thing. */
  readonly duplicateRowCount: number;
  /** Dropped row id to the kept row id. */
  readonly collapsed: ReadonlyMap<string, string>;
};

const rowKey = (row: InventoryRow) =>
  canonicalDigest({
    kind: row.kind,
    file: row.file,
    line: row.line ?? null,
    text: row.text,
  });

/**
 * Collapses rows whose kind, file, line and text coincide onto the first of
 * them. Ids must already be unique; this is content identity, not id identity.
 */
export function collapseInventory(inventory: Inventory): CollapsedInventory {
  const keptByKey = new Map<string, string>();
  const collapsed = new Map<string, string>();
  const rows: InventoryRow[] = [];
  for (const row of inventory.rows) {
    const key = rowKey(row);
    const kept = keptByKey.get(key);
    if (kept === undefined) {
      keptByKey.set(key, row.id);
      rows.push(row);
    } else collapsed.set(row.id, kept);
  }
  return { rows, duplicateRowCount: collapsed.size, collapsed };
}

export type PartitionValidation =
  | {
      readonly status: "accepted";
      readonly inventory: CollapsedInventory;
      readonly partitions: readonly AssignedPartition[];
    }
  | {
      readonly status: "rejected";
      readonly inventory: CollapsedInventory;
      readonly rejections: readonly PartitionRejection[];
    };

/**
 * Checks a proposal against its inventory and the limits. Every rejection is
 * listed, so the enumerator sees all of them at once. Row ids that collapsed
 * onto an earlier row are read as that row, which is the one shaping step.
 */
export function validatePartitionProposal(
  input: {
    readonly inventory: Inventory;
    readonly proposal: PartitionProposal;
  },
  limits: Omit<PartitionLimits, "maxResubmits">,
): PartitionValidation {
  const rejections: PartitionRejection[] = [];
  const seenIds = new Set<string>();
  for (const row of input.inventory.rows) {
    if (seenIds.has(row.id))
      rejections.push({ reason: "duplicate-row-id", rowId: row.id });
    seenIds.add(row.id);
  }
  const inventory = collapseInventory(input.inventory);
  const byId = new Map(inventory.rows.map((row) => [row.id, row]));
  const resolve = (id: string) => inventory.collapsed.get(id) ?? id;
  if (input.proposal.partitions.length > limits.maxPartitions)
    rejections.push({
      reason: "too-many-partitions",
      count: input.proposal.partitions.length,
    });
  const owner = new Map<string, string>();
  const seenPartitions = new Set<string>();
  const assigned: AssignedPartition[] = [];
  for (const [index, partition] of input.proposal.partitions.entries()) {
    if (seenPartitions.has(partition.id))
      rejections.push({
        reason: "duplicate-partition-id",
        partitionId: partition.id,
      });
    seenPartitions.add(partition.id);
    const rows: InventoryRow[] = [];
    const own = new Set<string>();
    for (const rawId of partition.rowIds) {
      const id = resolve(rawId);
      const row = byId.get(id);
      if (row === undefined) {
        rejections.push({
          reason: "unknown-row-id",
          partitionId: partition.id,
          rowId: rawId,
        });
        continue;
      }
      if (own.has(id)) continue;
      own.add(id);
      const elsewhere = owner.get(id);
      if (elsewhere !== undefined && elsewhere !== partition.id) {
        rejections.push({
          reason: "row-in-several-partitions",
          partitionId: partition.id,
          rowId: id,
        });
        continue;
      }
      owner.set(id, partition.id);
      rows.push(row);
    }
    if (rows.length > limits.maxEntriesPerPartition)
      rejections.push({
        reason: "partition-too-large",
        partitionId: partition.id,
        count: rows.length,
      });
    const scriptRowCount = rows.filter((row) => row.origin === "script").length;
    assigned.push({
      id: partition.id,
      label: partition.label,
      ordinal: index,
      rows,
      scriptRowCount,
      agentRowCount: rows.length - scriptRowCount,
      assignmentDigest: canonicalDigest({
        id: partition.id,
        label: partition.label,
        rows: rows.map((row) => ({ ...row, line: row.line ?? null })),
      }),
    });
  }
  for (const row of inventory.rows)
    if (!owner.has(row.id))
      rejections.push({ reason: "row-unassigned", rowId: row.id });
  return rejections.length === 0
    ? { status: "accepted", inventory, partitions: assigned }
    : { status: "rejected", inventory, rejections };
}

/**
 * Whether a rejected proposal goes back once more. `resubmits` counts the
 * proposals already sent back; the first proposal is resubmit 0.
 */
export function resubmitDecision(input: {
  readonly resubmits: number;
  readonly maxResubmits: number;
}): "resubmit" | "exhausted" {
  return input.resubmits < input.maxResubmits ? "resubmit" : "exhausted";
}

/** The distinct reasons of a rejection, in declaration order, for the ledger. */
export function rejectionReasonTokens(
  rejections: readonly PartitionRejection[],
): PartitionRejectionReason[] {
  const present = new Set(rejections.map((rejection) => rejection.reason));
  return PARTITION_REJECTION_REASONS.filter((reason) => present.has(reason));
}
