import { z } from "zod";

import type { TargetSelection } from "../../../selection/index.js";
import {
  capturedWordPressOrgSvnPinSchema,
  wordPressOrgTargetObservationRefSchema,
  type CapturedWordPressOrgSvnPin,
  type WordPressOrgTargetObservationRef,
} from "../acquisition/index.js";
import {
  programmeEligibilitySnapshotRefSchema,
  type ProgrammeEligibilitySnapshotRef,
} from "../programme-intelligence/index.js";
import { wordPressRevisitPolicySchema } from "./ledger-exclusions.js";
import { wordPressOrgPluginIdentitySchema } from "../target-identity.js";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const coreVersionSchema = z
  .string()
  .max(32)
  .regex(/^[0-9]+(?:\.[0-9]+){1,3}$/);

const operatorCandidateSchema = z.strictObject({
  slug: slugSchema,
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export type WordPressOperatorCandidate = z.infer<
  typeof operatorCandidateSchema
>;

const commonSelectionPolicy = {
  kind: z.literal("wordpress-selection-policy"),
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  /** The core image version used when the selected plugin is provisioned. */
  wordpressVersion: coreVersionSchema.optional(),
  promptVariant: z.string().min(1).max(128).optional(),
  revisitPolicy: wordPressRevisitPolicySchema.optional(),
  minimumActiveInstallations: z.number().int().nonnegative(),
  maximumObservationAgeDays: z.number().positive(),
  maximumUpdateAgeDays: z.number().positive(),
  maximumTargets: z.number().int().positive(),
  excludedAuthors: z.array(z.string().min(1)),
  excludedSlugs: z.array(slugSchema),
} as const;

const manualSelectionPolicy = z
  .strictObject({
    ...commonSelectionPolicy,
    candidateSlugs: z.array(slugSchema),
    /** Historical/manual dependencies must have explicit versions. */
    pluginDependencyPins: z
      .record(
        slugSchema,
        z.record(
          slugSchema,
          z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/),
        ),
      )
      .optional(),
    /** A previously captured official SVN revision for a manually pinned version. */
    targetSourcePins: z
      .record(slugSchema, capturedWordPressOrgSvnPinSchema)
      .optional(),
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
      Object.keys(policy.pluginDependencyPins ?? {}).every((slug) =>
        policy.candidateSlugs.includes(slug),
      ) &&
      Object.keys(policy.targetSourcePins ?? {}).every(
        (slug) =>
          policy.candidateSlugs.includes(slug) &&
          policy.pinnedVersions?.[slug] !== undefined,
      ),
    {
      message: "Pinned and dependency slugs must be candidates",
      path: ["candidateSlugs"],
    },
  );

const automaticSelectionPolicy = z.strictObject({
  ...commonSelectionPolicy,
  /** Operator nominations carry references only; they never override eligibility. */
  operatorCandidates: z
    .array(operatorCandidateSchema)
    .refine(
      (candidates) =>
        new Set(candidates.map(({ slug }) => slug)).size === candidates.length,
      { message: "Operator candidate slugs must be unique" },
    )
    .optional(),
  /** Undeclared runtime dependencies resolved to official stable at freeze. */
  pluginDependencySlugs: z
    .record(slugSchema, z.array(slugSchema).max(16))
    .optional(),
  promptVariant: z.string().min(1).max(128),
  revisitPolicy: wordPressRevisitPolicySchema,
  maximumTargets: z.number().int().min(3).max(10),
  /** The core image version pinned when select freezes the chosen targets. */
  wordpressVersion: coreVersionSchema,
  candidateSource: z.strictObject({
    kind: z.literal("wordpress-org"),
    tags: z.array(slugSchema).max(8),
    perPage: z.number().int().min(1).max(50),
    maxAgeDays: z.number().positive().max(7),
  }),
});

/** A policy nominates candidates manually or from the directory, never both. */
export const wordPressSelectionPolicySchema = z.union([
  manualSelectionPolicy,
  automaticSelectionPolicy,
]);

export type WordPressSelectionPolicy = z.infer<
  typeof wordPressSelectionPolicySchema
>;

export type SelectionReason =
  | "operator-candidate-version-mismatch"
  | "observation-unavailable"
  | "distribution-closed"
  | "observation-stale"
  | "update-date-unavailable"
  | "update-stale"
  | "author-unavailable"
  | "excluded-author"
  | "excluded-slug"
  | "below-installation-threshold"
  | "core-requirement-unavailable"
  | "core-version-incompatible"
  | "programme-asset-out-of-scope"
  | "programme-stale";

/** Counts and dates from the public advisory mirror; no record content (ADR 0037). */
export interface WordPressTargetAdvisoryHistory {
  readonly count: number;
  readonly payingClassCount: number;
  readonly latestPublished?: string | undefined;
  readonly mirrorAsOf: string;
  readonly mirrorDigest: string;
}

export interface WordPressTargetSelection extends TargetSelection {
  readonly slug: string;
  readonly activeInstallations: number;
  readonly reason?: "initial" | "version-increased" | undefined;
  /** Legacy, read only: stored selections written before 2026-10-19 carry the High Threat tag match. */
  readonly highThreatSurface?: boolean | undefined;
  /** Legacy, read only: stored selections written before 2026-10-19 may carry a per-target run budget. */
  readonly runBudget?: number | undefined;
  /** The WordPress.org tag listing that nominated this target (ADR 0032 Q3), absent for popular or manual nominations. */
  readonly candidateTag?: string | undefined;
  /** The plugin's last update on WordPress.org, standing in for the stable version's release. */
  readonly versionPublishedAt?: string | undefined;
  /** Selection-time operator pins; the snapshot also seals the acquired bytes. */
  readonly pluginDependencyPins?: Readonly<Record<string, string>> | undefined;
  readonly targetSourcePin?: CapturedWordPressOrgSvnPin | undefined;
  readonly pluginDependencySlugs?: readonly string[] | undefined;
  readonly dependencyVersionPolicy?:
    "stable-observed" | "pinned-only" | undefined;
  /** Legacy, read only: ranking fields on stored selections. */
  readonly scoreBreakdown?:
    | {
        readonly installations: number;
        readonly recency: number;
        /** Legacy, read only: tag-surface points of selections written before 2026-10-19. */
        readonly surface?: number | undefined;
        /** Legacy, read only: High Threat points of selections written before 2026-10-19. */
        readonly highThreat?: number | undefined;
        readonly history: number;
        /** Absent in records written before ADR 0037. */
        readonly historyPayingClass?: number | undefined;
        /** Absent in records written before the ADR 0037 addendum of 2026-10-19. */
        readonly recordRecency?: number | undefined;
      }
    | undefined;
  /** Legacy, read only: advisory counts in stored selections. */
  readonly advisoryHistory?: WordPressTargetAdvisoryHistory | undefined;
  /** Legacy, read only: the 1-based cascade step in stored selections. */
  readonly cascadeStep?: number | undefined;
  readonly observationRef: WordPressOrgTargetObservationRef;
  readonly programmeRef: ProgrammeEligibilitySnapshotRef;
}

/** Validate a private selection before replaying its reserved snapshot. */
export const wordPressTargetSelectionSchema: z.ZodType<WordPressTargetSelection> =
  z.strictObject({
    targetId: wordPressOrgPluginIdentitySchema,
    slug: slugSchema,
    version: z.string().min(1).max(64),
    score: z.number().finite(),
    selectedAt: z.iso.datetime({ offset: true }),
    policy: z.strictObject({
      id: z.string().min(1).max(128),
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
    activeInstallations: z.number().int().nonnegative(),
    reason: z.enum(["initial", "version-increased"]).optional(),
    /** Legacy, read only (old stored selections). */
    highThreatSurface: z.boolean().optional(),
    /** Legacy, read only (old stored selections). */
    runBudget: z.number().int().positive().max(40).optional(),
    candidateTag: slugSchema.optional(),
    versionPublishedAt: z.iso.datetime({ offset: true }).optional(),
    pluginDependencyPins: z
      .record(slugSchema, z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/))
      .optional(),
    targetSourcePin: capturedWordPressOrgSvnPinSchema.optional(),
    pluginDependencySlugs: z.array(slugSchema).max(16).optional(),
    dependencyVersionPolicy: z
      .enum(["stable-observed", "pinned-only"])
      .optional(),
    scoreBreakdown: z
      .strictObject({
        installations: z.number().finite(),
        recency: z.number().finite(),
        /** Legacy, read only (old stored selections). */
        surface: z.number().finite().optional(),
        /** Legacy, read only (old stored selections). */
        highThreat: z.number().finite().optional(),
        history: z.number().finite(),
        historyPayingClass: z.number().finite().optional(),
        recordRecency: z.number().finite().optional(),
      })
      .optional(),
    advisoryHistory: z
      .strictObject({
        count: z.number().int().nonnegative(),
        payingClassCount: z.number().int().nonnegative(),
        latestPublished: z.iso.datetime({ offset: true }).optional(),
        mirrorAsOf: z.iso.datetime({ offset: true }),
        mirrorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .optional(),
    cascadeStep: z.number().int().positive().optional(),
    observationRef: wordPressOrgTargetObservationRefSchema,
    programmeRef: programmeEligibilitySnapshotRefSchema,
  });

export interface WordPressSelectionInspection {
  readonly slug: string;
  readonly status: "eligible" | "ineligible";
  readonly reasons: readonly SelectionReason[];
  readonly selection?: WordPressTargetSelection;
  readonly observedAt?: string;
  /** Kept in the selection report only, never in the target handed to discovery. */
  readonly operatorCandidate?: WordPressOperatorCandidate;
  readonly enumeration?: {
    readonly sourceKind: "popular" | "tag";
    readonly sourceTag?: string;
    readonly sourcePage: number;
    readonly sourceUrl: string;
    readonly observedAt: string;
    readonly contentDigest: string;
  };
}
