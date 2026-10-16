import type { Ledger, LedgerReadQuery } from "../ledger/index.js";
import { z } from "zod";

/** The maximum size of a serialized private review record, in bytes. */
export const MAX_RECORD_BYTES = 1_000_000;

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const draftSchema = z.strictObject({
  assessmentId: digest,
  candidateId: digest,
  digest,
  revision: z.number().int().positive(),
  destination: id,
  content: z.string().min(1).max(100_000),
  preparedBy: z.enum(["ai", "human"]),
  createdAt: z.iso.datetime(),
});
export const draftSummarySchema = draftSchema
  .pick({
    revision: true,
    destination: true,
    preparedBy: true,
  })
  .loose();

export const duplicateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.enum(["unavailable", "no-match"]) }),
  z.strictObject({
    status: z.literal("possible-match"),
    reference: z.string().min(1).max(256),
  }),
]);

/** Keep reading older private records that used `ref` without rewriting them. */
export function duplicateSummary(input: unknown): string | null {
  const current = duplicateSchema.safeParse(input);
  if (current.success)
    return current.data.status === "possible-match"
      ? `${current.data.status}:${current.data.reference}`
      : current.data.status;
  const legacy = z
    .looseObject({ status: z.literal("possible-match"), ref: z.string() })
    .safeParse(input);
  return legacy.success ? `possible-match:${legacy.data.ref}` : null;
}

/** Read a filtered event history without silently stopping at the first page. */
export function readReviewHistory(
  ledger: Ledger,
  query: Omit<LedgerReadQuery, "afterSequence" | "limit">,
) {
  const records: ReturnType<Ledger["read"]>[number][] = [];
  let afterSequence = 0;
  for (;;) {
    const page = ledger.read({ ...query, afterSequence, limit: 1000 });
    records.push(...page);
    if (page.length < 1000) return records;
    afterSequence = page[page.length - 1]!.sequence;
  }
}
