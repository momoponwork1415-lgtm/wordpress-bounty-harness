import { z } from "zod";

const identifier = z.string().trim().min(1).max(128);
const assessment = z.strictObject({
  rating: z.enum(["match", "partial", "mismatch", "unknown"]),
  note: z.string().trim().min(1).max(2000).optional(),
});

/** Human judgment kept in Private Evidence, never in discovery or the ledger. */
export const blindRubricEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: identifier,
  findingId: identifier,
  location: assessment,
  rootCause: assessment,
  attackerConditions: assessment,
  impact: assessment,
  verdict: z.enum(["target-hit", "partial", "non-target"]),
  assessedBy: identifier,
  assessedAt: z.iso.datetime({ offset: true }),
});

export const blindRubricEntriesSchema = z
  .array(blindRubricEntrySchema)
  .min(1)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const pair = `${entry.caseId}\0${entry.findingId}`;
      if (seen.has(pair)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate case and Finding pair",
          path: [index],
        });
      }
      seen.add(pair);
    }
  });

export type BlindRubricEntry = z.infer<typeof blindRubricEntrySchema>;
