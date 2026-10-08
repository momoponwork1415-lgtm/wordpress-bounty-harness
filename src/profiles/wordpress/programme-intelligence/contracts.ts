import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const programmeIdentitySchema = z
  .string()
  .regex(/^programme:[a-z0-9][a-z0-9-]*$/);
export const policyTermSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const directoryEligibilityRuleSchema = z.strictObject({
  directoryIdentity: policyTermSchema,
  requiredMembership: policyTermSchema,
  eligibilityEffect: policyTermSchema,
  authorizationCondition: policyTermSchema,
});

export const programmeEligibilityFreshnessPolicySchema = z.strictObject({
  kind: z.literal("programme-eligibility-freshness-policy"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  digest: digestSchema,
  maximumAgeMs: z.strictObject({
    targetSelectionBatch: z.number().int().positive(),
    submissionStaging: z.number().int().positive(),
  }),
});

export const programmeEligibilitySchema = z.strictObject({
  assets: z
    .array(
      z.strictObject({
        kind: policyTermSchema,
        scope: policyTermSchema,
      }),
    )
    .min(1),
  vulnerabilityClasses: z.array(policyTermSchema).min(1),
  attackerRoles: z.array(policyTermSchema).min(1),
  activeInstallThreshold: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("minimum"),
      value: z.number().int().nonnegative(),
    }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
  researcherTiers: z.array(policyTermSchema).min(1),
  exclusions: z.array(policyTermSchema),
  conditions: z.array(policyTermSchema).optional(),
  limits: z
    .array(
      z.strictObject({
        key: policyTermSchema,
        value: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  directoryEligibilityRules: z.array(directoryEligibilityRuleSchema).optional(),
});

export const normalizedProgrammePolicySchema = z.strictObject({
  programmeIdentity: programmeIdentitySchema,
  eligibility: programmeEligibilitySchema,
  programmeOpportunityBand: z.enum([
    "broad",
    "high-impact-only",
    "research-only",
  ]),
});

export const programmePolicyConflictSignalSchema = z.strictObject({
  kind: z.literal("programme-policy-conflict"),
  schemaVersion: z.literal(1),
});

export const programmePolicySourceSnapshotSchema = z.strictObject({
  sourceId: identifierSchema,
  sourceUrl: z.url(),
  retrievedAt: z.string().datetime({ offset: true }),
  contentDigest: digestSchema,
  parserVersion: identifierSchema,
});

export const programmePolicySourceDescriptorSchema = z.strictObject({
  sourceId: identifierSchema,
  sourceUrl: z.url(),
  parserVersion: identifierSchema,
});

export const programmeEligibilitySnapshotSchema = z.strictObject({
  kind: z.literal("programme-eligibility-snapshot"),
  schemaVersion: z.literal(2),
  programmeIdentity: programmeIdentitySchema,
  retrievedAt: z.string().datetime({ offset: true }),
  sources: z.array(programmePolicySourceSnapshotSchema).min(1),
  policy: normalizedProgrammePolicySchema.omit({ programmeIdentity: true }),
  freshnessPolicy: programmeEligibilityFreshnessPolicySchema,
});

export const programmeEligibilitySnapshotRefSchema = z.strictObject({
  kind: z.literal("programme-eligibility-snapshot-ref"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  digest: digestSchema,
});

export const programmeIntelligenceRefreshRequestSchema = z.strictObject({
  kind: z.literal("programme-intelligence-refresh"),
  schemaVersion: z.literal(1),
  programmeIdentity: programmeIdentitySchema,
});

export const programmeEligibilityInspectionRequestSchema = z.strictObject({
  kind: z.literal("programme-eligibility-inspection"),
  schemaVersion: z.literal(1),
  snapshotRef: programmeEligibilitySnapshotRefSchema,
  requiredFor: z.enum(["target-selection-batch", "submission-staging"]),
});

export type ProgrammeEligibilityFreshnessPolicy = z.infer<
  typeof programmeEligibilityFreshnessPolicySchema
>;
export type NormalizedProgrammePolicy = z.infer<
  typeof normalizedProgrammePolicySchema
>;
export type ProgrammeEligibilitySnapshot = z.infer<
  typeof programmeEligibilitySnapshotSchema
>;
export type ProgrammePolicySourceSnapshot = z.infer<
  typeof programmePolicySourceSnapshotSchema
>;
export type ProgrammePolicySourceDescriptor = z.infer<
  typeof programmePolicySourceDescriptorSchema
>;
export type ProgrammeEligibilitySnapshotRef = z.infer<
  typeof programmeEligibilitySnapshotRefSchema
>;
export type ProgrammeIntelligenceRefreshRequest = z.infer<
  typeof programmeIntelligenceRefreshRequestSchema
>;
export type ProgrammeEligibilityInspectionRequest = z.infer<
  typeof programmeEligibilityInspectionRequestSchema
>;

export interface ProgrammePolicySourceContent {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly parserVersion: string;
  readonly bytes: Uint8Array;
}

export interface ProgrammePolicySourceAdapter {
  readonly sourceId: string;
  readonly programmeIdentity: string;
  readonly sourceUrl: string;
  readonly parserVersion: string;
  retrieve(): Promise<Uint8Array>;
  parse(
    bytes: Uint8Array,
    sources?: readonly ProgrammePolicySourceContent[],
  ): Promise<unknown> | unknown;
}

export interface CurrentProgrammeEligibilitySnapshot {
  readonly status: "current";
  readonly snapshot: ProgrammeEligibilitySnapshot;
  readonly snapshotRef: ProgrammeEligibilitySnapshotRef;
}

export interface ProgrammeEligibilityPolicyConflict {
  readonly status: "policy-conflict";
  readonly programmeIdentity: string;
  readonly sources: readonly ProgrammePolicySourceSnapshot[];
}

export interface ProgrammeEligibilityParseFailed {
  readonly status: "parse-failed";
  readonly programmeIdentity: string;
  readonly source: ProgrammePolicySourceSnapshot;
}

export interface ProgrammeEligibilityRefreshFailed {
  readonly status: "stale";
  readonly programmeIdentity: string;
  readonly reason: "refresh-failed";
  readonly requiredSources: readonly ProgrammePolicySourceDescriptor[];
}

export interface ProgrammeEligibilitySnapshotExpired {
  readonly status: "stale";
  readonly programmeIdentity: string;
  readonly reason: "snapshot-expired";
  readonly requiredFor: ProgrammeEligibilityInspectionRequest["requiredFor"];
  readonly snapshotRef: ProgrammeEligibilitySnapshotRef;
  readonly retrievedAt: string;
  readonly maximumAgeMs: number;
  readonly refreshRequired: true;
}

export type ProgrammeEligibilityResult =
  | CurrentProgrammeEligibilitySnapshot
  | ProgrammeEligibilityParseFailed
  | ProgrammeEligibilityPolicyConflict
  | ProgrammeEligibilityRefreshFailed
  | ProgrammeEligibilitySnapshotExpired;

export interface ProgrammeIntelligence {
  refresh(
    request: ProgrammeIntelligenceRefreshRequest,
  ): Promise<ProgrammeEligibilityResult>;
  inspect(
    request: ProgrammeEligibilityInspectionRequest,
  ): Promise<ProgrammeEligibilityResult>;
}

export interface OpenProgrammeIntelligenceOptions {
  readonly storageDirectory: string;
  readonly sourceAdapters: readonly ProgrammePolicySourceAdapter[];
  readonly freshnessPolicy: ProgrammeEligibilityFreshnessPolicy;
  readonly clock?: () => Date;
}
