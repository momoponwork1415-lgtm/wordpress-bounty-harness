import { describe, expect, it } from "vitest";

import {
  blindRubricEntriesSchema,
  blindRubricEntrySchema,
} from "../../src/evaluation/blind-rubric.js";

const entry = {
  schemaVersion: 1,
  caseId: "synthetic-case",
  findingId: "synthetic-finding",
  location: { rating: "match" },
  rootCause: { rating: "partial", note: "A separate control may apply" },
  attackerConditions: { rating: "unknown" },
  impact: { rating: "mismatch" },
  verdict: "partial",
  assessedBy: "reviewer",
  assessedAt: "2026-10-10T01:00:00Z",
};

describe("blind rubric input", () => {
  it("records four human assessments and one verdict without run configuration", () => {
    expect(blindRubricEntrySchema.parse(entry)).toEqual(entry);
    expect(
      blindRubricEntrySchema.safeParse({ ...entry, arm: "b" }).success,
    ).toBe(false);
    expect(
      blindRubricEntrySchema.safeParse({
        ...entry,
        verificationStatus: "runtime-confirmed",
      }).success,
    ).toBe(false);
  });

  it("rejects missing dimensions, unknown verdicts, and duplicate pairs", () => {
    const { rootCause: _rootCause, ...missing } = entry;
    expect(blindRubricEntrySchema.safeParse(missing).success).toBe(false);
    expect(
      blindRubricEntrySchema.safeParse({ ...entry, verdict: "confirmed" })
        .success,
    ).toBe(false);
    expect(blindRubricEntriesSchema.safeParse([entry, entry]).success).toBe(
      false,
    );
    expect(
      blindRubricEntriesSchema.safeParse([
        entry,
        { ...entry, findingId: "another-finding" },
      ]).success,
    ).toBe(true);
  });
});
