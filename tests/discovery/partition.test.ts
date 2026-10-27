import { describe, expect, it } from "vitest";

import {
  collapseInventory,
  inventorySchema,
  partitionLimitsSchema,
  partitionProposalSchema,
  rejectionReasonTokens,
  resubmitDecision,
  validatePartitionProposal,
  type Inventory,
  type PartitionProposal,
} from "../../src/discovery/partition.js";

// ADR 0042: the Harness checks the shape and the limits of what the enumerator
// returns. It never adds, moves or splits; an over-limit proposal goes back.

const row = (
  id: string,
  origin: "script" | "agent" = "script",
  extra = {},
) => ({
  id,
  origin,
  kind: "entry",
  file: "inc/a.php",
  line: 1,
  text: `registration ${id}`,
  ...extra,
});
const limits = { maxEntriesPerPartition: 3, maxPartitions: 2 };

describe("inventory and proposal schemas", () => {
  it("accepts rows with an id, an origin and a location, and refuses free shapes", () => {
    expect(
      inventorySchema.safeParse({ rows: [row("r1"), row("r2", "agent")] })
        .success,
    ).toBe(true);
    for (const bad of [
      { rows: [{ ...row("r1"), origin: "harness" }] },
      { rows: [{ ...row("r1"), line: 0 }] },
      { rows: [{ ...row("r1"), extra: 1 }] },
      { rows: [{ ...row("R1") }] },
      { rows: [{ ...row("r1"), kind: "HTML output" }] },
    ])
      expect(inventorySchema.safeParse(bad).success).toBe(false);
    expect(
      partitionProposalSchema.safeParse({
        partitions: [{ id: "p1", label: "Forms", rowIds: ["r1"] }],
      }).success,
    ).toBe(true);
    expect(
      partitionProposalSchema.safeParse({
        partitions: [{ id: "p1", label: "Forms", rowIds: [] }],
      }).success,
    ).toBe(false);
    expect(
      partitionLimitsSchema.safeParse({ ...limits, maxResubmits: 2 }).success,
    ).toBe(true);
    expect(
      partitionLimitsSchema.safeParse({ ...limits, maxResubmits: 6 }).success,
    ).toBe(false);
  });
});

describe("collapseInventory", () => {
  it("collapses rows that say the same thing onto the first and keeps different lines apart", () => {
    const collapsed = collapseInventory({
      rows: [
        row("r1"),
        row("r2", "agent", { text: "registration r1" }),
        row("r3", "agent", { line: 2, text: "registration r1" }),
      ],
    });
    expect(collapsed.rows.map((entry) => entry.id)).toEqual(["r1", "r3"]);
    expect(collapsed.duplicateRowCount).toBe(1);
    expect([...collapsed.collapsed]).toEqual([["r2", "r1"]]);
  });
});

describe("validatePartitionProposal", () => {
  const inventory: Inventory = {
    rows: [
      row("r1"),
      row("r2", "agent", { line: 2 }),
      row("r3", "agent", { line: 3 }),
    ],
  };

  it("accepts a proposal that places every row once within the limits and digests each partition", () => {
    const proposal: PartitionProposal = {
      partitions: [
        { id: "p1", label: "Forms", rowIds: ["r1", "r2"] },
        { id: "p2", label: "Admin", rowIds: ["r3"] },
      ],
    };
    const result = validatePartitionProposal({ inventory, proposal }, limits);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(
      result.partitions.map((p) => [
        p.id,
        p.ordinal,
        p.rows.length,
        p.scriptRowCount,
        p.agentRowCount,
      ]),
    ).toEqual([
      ["p1", 0, 2, 1, 1],
      ["p2", 1, 1, 0, 1],
    ]);
    expect(result.partitions[0]!.assignmentDigest).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(result.partitions[0]!.assignmentDigest).not.toBe(
      result.partitions[1]!.assignmentDigest,
    );
    // The same proposal digests the same way.
    expect(validatePartitionProposal({ inventory, proposal }, limits)).toEqual(
      result,
    );
  });

  it("reads a collapsed row id as the kept row, so one entry listed twice is assigned once", () => {
    const result = validatePartitionProposal(
      {
        inventory: {
          rows: [row("r1"), row("r2", "agent", { text: "registration r1" })],
        },
        proposal: {
          partitions: [{ id: "p1", label: "All", rowIds: ["r1", "r2"] }],
        },
      },
      limits,
    );
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.partitions[0]!.rows.map((entry) => entry.id)).toEqual(["r1"]);
    expect(result.inventory.duplicateRowCount).toBe(1);
  });

  it("lists every rejection at once and never repairs the proposal", () => {
    const result = validatePartitionProposal(
      {
        inventory: {
          rows: [...inventory.rows, row("r1", "agent", { line: 9 })],
        },
        proposal: {
          partitions: [
            { id: "p1", label: "A", rowIds: ["r1", "r2", "r3", "r9"] },
            { id: "p1", label: "B", rowIds: ["r2"] },
            { id: "p3", label: "C", rowIds: ["r3"] },
          ],
        },
      },
      { ...limits, maxEntriesPerPartition: 2 },
    );
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.rejections).toEqual([
      { reason: "duplicate-row-id", rowId: "r1" },
      { reason: "too-many-partitions", count: 3 },
      { reason: "unknown-row-id", partitionId: "p1", rowId: "r9" },
      { reason: "partition-too-large", partitionId: "p1", count: 3 },
      { reason: "duplicate-partition-id", partitionId: "p1" },
      { reason: "row-in-several-partitions", partitionId: "p3", rowId: "r3" },
    ]);
    expect(rejectionReasonTokens(result.rejections)).toEqual([
      "duplicate-row-id",
      "duplicate-partition-id",
      "unknown-row-id",
      "row-in-several-partitions",
      "partition-too-large",
      "too-many-partitions",
    ]);
  });

  it("rejects a row the proposal leaves out instead of assigning it", () => {
    const result = validatePartitionProposal(
      {
        inventory,
        proposal: {
          partitions: [{ id: "p1", label: "A", rowIds: ["r1", "r2"] }],
        },
      },
      limits,
    );
    expect(result).toMatchObject({
      status: "rejected",
      rejections: [{ reason: "row-unassigned", rowId: "r3" }],
    });
  });
});

describe("resubmitDecision", () => {
  it("sends a proposal back until the configured count is used", () => {
    expect(resubmitDecision({ resubmits: 0, maxResubmits: 2 })).toBe(
      "resubmit",
    );
    expect(resubmitDecision({ resubmits: 1, maxResubmits: 2 })).toBe(
      "resubmit",
    );
    expect(resubmitDecision({ resubmits: 2, maxResubmits: 2 })).toBe(
      "exhausted",
    );
    expect(resubmitDecision({ resubmits: 0, maxResubmits: 0 })).toBe(
      "exhausted",
    );
  });
});
