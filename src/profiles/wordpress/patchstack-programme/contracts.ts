import { z } from "zod";

import { programmeEligibilitySchema } from "../programme-intelligence/contracts.js";

export const patchstackProgrammeSourceKindSchema = z.enum([
  "rules",
  "report-form",
  "mvdp-directory",
  "marketing",
]);

export const patchstackProgrammePageDocumentSchema = z.strictObject({
  kind: z.literal("patchstack-programme-page"),
  schemaVersion: z.literal(2),
  sourceKind: patchstackProgrammeSourceKindSchema,
  precedence: z.number().int().min(1).max(4),
  assertions: z.strictObject({
    eligibility: programmeEligibilitySchema.partial().optional(),
    programmeOpportunityBand: z
      .enum(["broad", "high-impact-only", "research-only"])
      .optional(),
    directoryEligibilityRules: z
      .array(
        z.strictObject({
          directoryIdentity: z.literal(
            "managed-vulnerability-disclosure-programme",
          ),
          requiredMembership: z.literal("listed-plugin"),
          eligibilityEffect: z.literal("contributor-attacker-role-exception"),
          authorizationCondition: z.literal("mvdp-scope-exception"),
        }),
      )
      .min(1)
      .optional(),
  }),
});

export type PatchstackProgrammeSourceKind = z.infer<
  typeof patchstackProgrammeSourceKindSchema
>;
export type PatchstackProgrammePageDocument = z.infer<
  typeof patchstackProgrammePageDocumentSchema
>;

export interface PatchstackProgrammePageAdapter {
  readonly sourceKind: PatchstackProgrammeSourceKind;
  readonly sourceUrl: string;
  readonly parserVersion: string;
  retrieve(): Promise<Uint8Array>;
  parse(bytes: Uint8Array): Promise<unknown> | unknown;
}

export interface CreatePatchstackProgrammeAdaptersOptions {
  readonly pages: readonly PatchstackProgrammePageAdapter[];
}
