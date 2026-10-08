import { z } from "zod";

import {
  immutableArtifactRefSchema,
  targetIntakePolicySchema,
  type IntakeDisposition,
  type ReadyIntakeDisposition,
  type TargetIntakeReason,
} from "./contracts.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const versionSchema = z.string().min(1).max(64);

export const wordPressOrgTargetObservationRefSchema = z.strictObject({
  kind: z.literal("wordpress-org-target-observation-ref"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  digest: digestSchema,
});

export const wordPressOrgTargetObservationSchema = z.strictObject({
  kind: z.literal("wordpress-org-target-observation"),
  schemaVersion: z.literal(1),
  pluginIdentity: z.string().regex(/^wporg:[a-z0-9][a-z0-9-]*$/),
  officialSlug: slugSchema,
  displayName: z.string().min(1).max(256),
  stableVersion: versionSchema,
  activeInstallations: z.number().int().nonnegative(),
  lastUpdated: z.string().min(1).max(128),
  observedAt: z.string().datetime({ offset: true }),
  intelligenceSource: z.strictObject({
    kind: z.literal("wordpress-org-plugin-directory"),
    sourceUrl: z.url(),
    retrievedAt: z.string().datetime({ offset: true }),
    contentDigest: digestSchema,
    parserVersion: z.literal("wordpress-org-plugin-information-v1"),
  }),
  downloadProvenance: z.strictObject({
    sourceUrl: z.url(),
  }),
});

export const wordPressOrgObserveRequestSchema = z.strictObject({
  kind: z.literal("wordpress-org-target-observe"),
  schemaVersion: z.literal(1),
  slug: slugSchema,
});

export const wordPressOrgAcquireRequestSchema = z.strictObject({
  kind: z.literal("wordpress-org-target-acquire"),
  schemaVersion: z.literal(1),
  observationRef: wordPressOrgTargetObservationRefSchema,
  requestedVersion: versionSchema,
  policy: targetIntakePolicySchema,
});

export const wordPressOrgAcquisitionOriginalSchema = z.strictObject({
  kind: z.literal("wordpress-org-acquisition-original"),
  schemaVersion: z.literal(1),
  pluginIdentity: z.string().regex(/^wporg:[a-z0-9][a-z0-9-]*$/),
  version: versionSchema,
  sourceUrl: z.url(),
  retrievedAt: z.string().datetime({ offset: true }),
  contentDigest: digestSchema,
  size: z.number().int().nonnegative(),
  observationRef: wordPressOrgTargetObservationRefSchema,
});

export const wordPressOrgSourceRequestSchema = z.strictObject({
  kind: z.enum(["metadata", "archive"]),
  sourceUrl: z.url(),
  maximumBytes: z.number().int().positive(),
});

export const wordPressOrgSourceResponseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  sourceUrl: z.url(),
  bytes: z.custom<Uint8Array<ArrayBufferLike>>(
    (value) => value instanceof Uint8Array,
  ),
});

export type WordPressOrgTargetObservationRef = z.infer<
  typeof wordPressOrgTargetObservationRefSchema
>;
export type WordPressOrgTargetObservation = z.infer<
  typeof wordPressOrgTargetObservationSchema
>;
export type WordPressOrgObserveRequest = z.infer<
  typeof wordPressOrgObserveRequestSchema
>;
export type WordPressOrgAcquireRequest = z.infer<
  typeof wordPressOrgAcquireRequestSchema
>;
export type WordPressOrgAcquisitionOriginal = z.infer<
  typeof wordPressOrgAcquisitionOriginalSchema
>;
export type WordPressOrgSourceRequest = z.infer<
  typeof wordPressOrgSourceRequestSchema
>;
export type WordPressOrgSourceResponse = z.infer<
  typeof wordPressOrgSourceResponseSchema
>;

export interface WordPressOrgSourceAdapter {
  retrieve(
    request: WordPressOrgSourceRequest,
  ): Promise<WordPressOrgSourceResponse>;
}

export interface ObservedWordPressOrgTarget {
  readonly status: "observed";
  readonly observation: WordPressOrgTargetObservation;
  readonly observationRef: WordPressOrgTargetObservationRef;
}

interface WordPressOrgSourceFailureBase {
  readonly status: "failed";
  readonly pluginIdentity: string;
}

export interface WordPressOrgObservationFailure extends WordPressOrgSourceFailureBase {
  readonly operation: "observe";
  readonly reason:
    | "not-found"
    | "rate-limited"
    | "network-failure"
    | "quota-exceeded"
    | "invalid-metadata";
}

export interface WordPressOrgAcquisitionFailure extends WordPressOrgSourceFailureBase {
  readonly operation: "acquire";
  readonly reason:
    | "not-found"
    | "rate-limited"
    | "network-failure"
    | "quota-exceeded"
    | "requested-version-mismatch"
    | "metadata-archive-mismatch";
}

export type WordPressOrgObservationResult =
  ObservedWordPressOrgTarget | WordPressOrgObservationFailure;

interface AcquisitionContext {
  readonly acquisitionOriginal: WordPressOrgAcquisitionOriginal;
  readonly acquisitionOriginalRef: z.infer<typeof immutableArtifactRefSchema>;
}

export interface WordPressOrgAcquisitionFailureWithOriginal
  extends AcquisitionContext, WordPressOrgSourceFailureBase {
  readonly operation: "acquire";
  readonly reason: "metadata-archive-mismatch";
}

export type WordPressOrgSourceFailure =
  WordPressOrgObservationFailure | WordPressOrgAcquisitionFailure;

type DeferredIntakeDisposition = Extract<
  IntakeDisposition,
  { readonly status: "deferred" }
>;
type RejectedIntakeDisposition = Extract<
  IntakeDisposition,
  { readonly status: "rejected" }
>;

export type WordPressOrgAcquisitionWithIntake = AcquisitionContext &
  (
    | {
        readonly status: "ready";
        readonly intake: ReadyIntakeDisposition;
      }
    | {
        readonly status: "deferred";
        readonly intake: DeferredIntakeDisposition;
      }
    | {
        readonly status: "rejected";
        readonly intake: RejectedIntakeDisposition;
      }
  );

export interface WordPressOrgArchiveRejected extends AcquisitionContext {
  readonly status: "rejected";
  readonly reasons: readonly TargetIntakeReason[];
}

export type WordPressOrgAcquisitionResult =
  | WordPressOrgAcquisitionWithIntake
  | WordPressOrgArchiveRejected
  | WordPressOrgAcquisitionFailureWithOriginal
  | WordPressOrgAcquisitionFailure;

export interface WordPressOrgTargetSource {
  observe(
    request: WordPressOrgObserveRequest,
  ): Promise<WordPressOrgObservationResult>;
  acquire(
    request: WordPressOrgAcquireRequest,
  ): Promise<WordPressOrgAcquisitionResult>;
}

export interface OpenWordPressOrgTargetSourceOptions {
  readonly storageDirectory: string;
  readonly adapter?: WordPressOrgSourceAdapter;
  readonly clock?: () => Date;
  readonly metadataMaximumBytes?: number;
}

export interface WordPressOrgFetchAdapterOptions {
  readonly fetch?: typeof fetch;
}
