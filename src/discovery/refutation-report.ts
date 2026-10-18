import { z } from "zod";

/** A source-only opinion. It is never a verification verdict. */
export const refutationReportSchema = z.strictObject({
  verdict: z.enum(["refuted", "upheld", "undecided"]),
  reasonCode: z.enum([
    "guard-effective",
    "input-unreachable",
    "self-only-impact",
    "precondition-unrealistic",
    "sink-not-reached",
    "claim-misread",
    "unknown",
  ]),
  sourceTrace: z.array(
    z.strictObject({
      file: z.string().min(1),
      function: z.string().min(1),
      line: z.number().int().positive(),
    }),
  ),
  note: z.string().max(1000),
});
export type RefutationReport = z.infer<typeof refutationReportSchema>;
