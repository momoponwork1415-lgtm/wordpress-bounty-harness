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
    /** Counts of public low-privilege, high-impact catalog records used to nominate candidates. */
    historySignals: z
      .record(slugSchema, z.number().int().nonnegative())
      .optional(),
    historySource: z
      .strictObject({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        refreshedAt: z.iso.datetime({ offset: true }),
      })
      .optional(),
    minimumActiveInstallations: z.number().int().nonnegative(),
    maximumObservationAgeDays: z.number().positive(),
    maximumUpdateAgeDays: z.number().positive(),
    maximumTargets: z.number().int().positive(),
    excludedAuthors: z.array(z.string().min(1)),
    excludedSlugs: z.array(slugSchema),
    surfaceTagWeights: z.record(z.string(), z.number().nonnegative()),
    /** Public tags that suggest a High Threat surface (file operations, options, authentication). */
    highThreatTags: z.array(z.string().min(1)),
    scoreWeights: z.strictObject({
      installations: z.number().nonnegative(),
      recency: z.number().nonnegative(),
      surface: z.number().nonnegative(),
      highThreat: z.number().nonnegative(),
      history: z.number().nonnegative().optional(),
    }),
    /** Discovery runs per target: deeper where the expected reward is higher. */
    runBudget: z.strictObject({
      default: z.number().int().positive().max(40),
      highThreat: z.number().int().positive().max(40),
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
      ) &&
      Object.keys(policy.historySignals ?? {}).every((slug) =>
        policy.candidateSlugs.includes(slug),
      ),
    {
      message: "Pinned and history slugs must be candidates",
      path: ["candidateSlugs"],
    },
  )
  .refine(
    (policy) =>
      policy.historySignals === undefined || policy.historySource !== undefined,
    { message: "History signals require a source", path: ["historySource"] },
  );

export type WordPressSelectionPolicy = z.infer<
  typeof wordPressSelectionPolicySchema
>;

export type SelectionReason =
  | "observation-unavailable"
  | "distribution-closed"
  | "observation-stale"
  | "update-date-unavailable"
  | "update-stale"
  | "author-unavailable"
  | "excluded-author"
  | "excluded-slug"
  | "below-installation-threshold"
  | "programme-asset-out-of-scope"
  | "programme-stale"
  | "history-stale";

export interface WordPressTargetSelection extends TargetSelection {
  readonly slug: string;
  readonly activeInstallations: number;
  /** A public tag matched the policy's High Threat surface list. */
  readonly highThreatSurface: boolean;
  /** Upper bound on discovery runs for this target; the campaign ceiling still applies. */
  readonly runBudget: number;
  /** The plugin's last update on WordPress.org, standing in for the stable version's release. */
  readonly versionPublishedAt?: string;
  readonly scoreBreakdown: {
    readonly installations: number;
    readonly recency: number;
    readonly surface: number;
    readonly highThreat: number;
    readonly history: number;
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
