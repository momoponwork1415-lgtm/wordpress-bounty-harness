import { z } from "zod";

import type { TargetSelection } from "../../../selection/index.js";
import type { WordPressOrgTargetObservationRef } from "../acquisition/index.js";
import type { ProgrammeEligibilitySnapshotRef } from "../programme-intelligence/index.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const wordPressSelectionPolicySchema = z
  .strictObject({
    kind: z.literal("wordpress-selection-policy"),
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128),
    candidateSlugs: z.array(slugSchema),
    minimumActiveInstallations: z.number().int().nonnegative(),
    maximumObservationAgeDays: z.number().positive(),
    maximumUpdateAgeDays: z.number().positive(),
    maximumTargets: z.number().int().positive(),
    excludedAuthors: z.array(z.string().min(1)),
    excludedSlugs: z.array(slugSchema),
    surfaceTagWeights: z.record(z.string(), z.number().nonnegative()),
    scoreWeights: z.strictObject({
      installations: z.number().nonnegative(),
      recency: z.number().nonnegative(),
      surface: z.number().nonnegative(),
    }),
    /** Manual pin: select this version instead of the observed stable version. */
    pinnedVersions: z
      .record(slugSchema, z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/))
      .optional(),
  })
  .refine(
    (policy) =>
      Object.keys(policy.pinnedVersions ?? {}).every((slug) =>
        policy.candidateSlugs.includes(slug),
      ),
    { message: "Pinned slugs must be candidates", path: ["pinnedVersions"] },
  );

export type WordPressSelectionPolicy = z.infer<
  typeof wordPressSelectionPolicySchema
>;

export type SelectionReason =
  | "observation-unavailable"
  | "observation-stale"
  | "update-date-unavailable"
  | "update-stale"
  | "author-unavailable"
  | "excluded-author"
  | "excluded-slug"
  | "below-installation-threshold"
  | "programme-asset-out-of-scope"
  | "programme-stale";

export interface WordPressTargetSelection extends TargetSelection {
  readonly slug: string;
  readonly activeInstallations: number;
  readonly scoreBreakdown: {
    readonly installations: number;
    readonly recency: number;
    readonly surface: number;
  };
  readonly observationRef: WordPressOrgTargetObservationRef;
  readonly programmeRef: ProgrammeEligibilitySnapshotRef;
}

export interface WordPressSelectionInspection {
  readonly slug: string;
  readonly status: "eligible" | "ineligible";
  readonly reasons: readonly SelectionReason[];
  readonly selection?: WordPressTargetSelection;
}
