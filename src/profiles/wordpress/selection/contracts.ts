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

const commonSelectionPolicy = {
  kind: z.literal("wordpress-selection-policy"),
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  /** The core image version used when the selected plugin is provisioned. */
  wordpressVersion: coreVersionSchema.optional(),
  promptVariant: z.string().min(1).max(128).optional(),
  revisitPolicy: wordPressRevisitPolicySchema.optional(),
  minimumActiveInstallations: z.number().int().nonnegative(),
  /** Hard ceiling of the default population (ADR 0032, 2026-10-16); the public-record exception for larger plugins is #295. */
  maximumActiveInstallations: z.number().int().positive().optional(),
  maximumObservationAgeDays: z.number().positive(),
  maximumUpdateAgeDays: z.number().positive(),
  maximumTargets: z.number().int().positive(),
  excludedAuthors: z.array(z.string().min(1)),
  excludedSlugs: z.array(slugSchema),
  /** Legacy (ADR 0032 Q5): tag weights are readable for old policies but no longer used by the current one. */
  surfaceTagWeights: z.record(z.string(), z.number().nonnegative()).optional(),
  /** Legacy (ADR 0032 Q5): High Threat tag lists are readable for old policies but no longer used by the current one. */
  highThreatTags: z.array(z.string().min(1)).optional(),
  scoreWeights: z.strictObject({
    installations: z.number().nonnegative(),
    recency: z.number().nonnegative(),
    surface: z.number().nonnegative().optional(),
    highThreat: z.number().nonnegative().optional(),
    history: z.number().nonnegative().optional(),
  }),
  /** Legacy (ADR 0032 Q6): per-target run budgets were never effective in production; the campaign stop rule decides. */
  runBudget: z
    .strictObject({
      default: z.number().int().positive().max(40),
      highThreat: z.number().int().positive().max(40),
    })
    .optional(),
  /** Manual pin: select this version instead of the observed stable version. */
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
    /** Historical manual nominations remain readable; the current rule is set by ADR 0030. */
    historySignals: z
      .record(slugSchema, z.number().int().nonnegative())
      .optional(),
    historySource: z
      .strictObject({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        refreshedAt: z.iso.datetime({ offset: true }),
      })
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
      Object.keys(policy.historySignals ?? {}).every((slug) =>
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
      message: "Pinned, dependency and history slugs must be candidates",
      path: ["candidateSlugs"],
    },
  )
  .refine(
    (policy) =>
      policy.historySignals === undefined || policy.historySource !== undefined,
    { message: "History signals require a source", path: ["historySource"] },
  );

const automaticSelectionPolicy = z
  .strictObject({
    ...commonSelectionPolicy,
    /** Undeclared runtime dependencies resolved to official stable at freeze. */
    pluginDependencySlugs: z
      .record(slugSchema, z.array(slugSchema).max(16))
      .optional(),
    promptVariant: z.string().min(1).max(128),
    revisitPolicy: wordPressRevisitPolicySchema,
    maximumTargets: z.number().int().min(3).max(5),
    /** The core image version pinned when select freezes the chosen targets. */
    wordpressVersion: coreVersionSchema,
    candidateSource: z.strictObject({
      kind: z.literal("wordpress-org"),
      popularPages: z.number().int().min(1).max(20),
      tags: z.array(slugSchema).max(8),
      pagesPerTag: z.number().int().min(1).max(5),
      perPage: z.number().int().min(1).max(50),
      maxCandidates: z.number().int().min(5).max(2000),
      maxAgeDays: z.number().positive().max(7),
    }),
  })
  .refine(
    (policy) =>
      policy.maximumActiveInstallations === undefined ||
      policy.maximumActiveInstallations > policy.minimumActiveInstallations,
    {
      message:
        "maximumActiveInstallations must exceed minimumActiveInstallations",
    },
  );

/** A policy nominates candidates manually or from the directory, never both. */
export const wordPressSelectionPolicySchema = z.union([
  manualSelectionPolicy,
  automaticSelectionPolicy,
]);

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
  | "above-installation-ceiling"
  | "core-requirement-unavailable"
  | "core-version-incompatible"
  | "programme-asset-out-of-scope"
  | "programme-stale"
  | "history-stale";

export interface WordPressTargetSelection extends TargetSelection {
  readonly slug: string;
  readonly activeInstallations: number;
  /** A public tag matched the policy's High Threat surface list. */
  readonly highThreatSurface: boolean;
  /** Legacy upper bound on discovery runs; absent for policies written after ADR 0032. */
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
    highThreatSurface: z.boolean(),
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
    scoreBreakdown: z.strictObject({
      installations: z.number().finite(),
      recency: z.number().finite(),
      surface: z.number().finite(),
      highThreat: z.number().finite(),
      history: z.number().finite(),
    }),
    observationRef: wordPressOrgTargetObservationRefSchema,
    programmeRef: programmeEligibilitySnapshotRefSchema,
  });

export interface WordPressSelectionInspection {
  readonly slug: string;
  readonly status: "eligible" | "ineligible";
  readonly reasons: readonly SelectionReason[];
  readonly selection?: WordPressTargetSelection;
  readonly observedAt?: string;
  readonly enumeration?: {
    readonly sourceKind: "popular" | "tag";
    readonly sourceTag?: string;
    readonly sourcePage: number;
    readonly sourceUrl: string;
    readonly observedAt: string;
    readonly contentDigest: string;
  };
}
