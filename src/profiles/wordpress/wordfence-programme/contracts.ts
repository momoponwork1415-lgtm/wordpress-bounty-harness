import { z } from "zod";

import { programmeEligibilitySchema } from "../programme-intelligence/contracts.js";

export const wordfenceProgrammeSourceKindSchema = z.enum([
  "programme",
  "terms",
  "report-form",
]);

export const wordfenceProgrammePageDocumentSchema = z.strictObject({
  kind: z.literal("wordfence-programme-page"),
  schemaVersion: z.literal(2),
  sourceKind: wordfenceProgrammeSourceKindSchema,
  assertions: z.strictObject({
    eligibility: programmeEligibilitySchema.partial().optional(),
    programmeOpportunityBand: z
      .enum(["broad", "high-impact-only", "research-only"])
      .optional(),
  }),
});

export type WordfenceProgrammeSourceKind = z.infer<
  typeof wordfenceProgrammeSourceKindSchema
>;
export type WordfenceProgrammePageDocument = z.infer<
  typeof wordfenceProgrammePageDocumentSchema
>;

export interface WordfenceProgrammePageAdapter {
  readonly sourceKind: WordfenceProgrammeSourceKind;
  readonly sourceUrl: string;
  readonly parserVersion: string;
  retrieve(): Promise<Uint8Array>;
  parse(bytes: Uint8Array): Promise<unknown> | unknown;
}

export interface CreateWordfenceProgrammeAdaptersOptions {
  readonly pages: readonly WordfenceProgrammePageAdapter[];
}
