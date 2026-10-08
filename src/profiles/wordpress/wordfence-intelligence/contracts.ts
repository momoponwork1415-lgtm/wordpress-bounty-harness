import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const pluginIdentitySchema = z.string().regex(/^wporg:[a-z0-9][a-z0-9-]*$/);
const versionSchema = z.string().min(1).max(64);

function containsOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || trailing < 0xdc00 || trailing > 0xdfff) {
        return false;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const wordfenceSoftwareIdentifierSchema = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine(containsOnlyUnicodeScalars);

export const wordfenceSecretRefSchema = z.strictObject({
  kind: z.literal("secret-ref"),
  id: identifierSchema,
});

export const wordfenceIntelligenceSnapshotRefSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-snapshot-ref"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  digest: digestSchema,
});

export const wordfenceIntelligenceSnapshotSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-snapshot"),
  schemaVersion: z.literal(1),
  retrievedAt: z.string().datetime({ offset: true }),
  source: z.strictObject({
    sourceUrl: z.url(),
    contentDigest: digestSchema,
    parserVersion: z.literal("wordfence-intelligence-production-v3"),
    recordCount: z.number().int().nonnegative(),
    complete: z.literal(true),
  }),
});

export const wordfenceIntelligenceRefreshRequestSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-refresh"),
  schemaVersion: z.literal(1),
});

export const wordfenceIntelligenceInspectionRequestSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-inspection"),
  schemaVersion: z.literal(1),
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema.optional(),
});

export const vulnerabilityHistoryAggregateRequestSchema = z.strictObject({
  kind: z.literal("wordfence-vulnerability-history-aggregate"),
  schemaVersion: z.literal(1),
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
  pluginIdentity: pluginIdentitySchema,
});

export const vulnerabilityHistoryAggregateSchema = z.strictObject({
  kind: z.literal("vulnerability-history-aggregate"),
  schemaVersion: z.literal(1),
  pluginIdentity: pluginIdentitySchema,
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
  recordCount: z.number().int().nonnegative(),
  disclosureDensity: z.strictObject({
    kind: z.literal("records-per-published-year"),
    publishedYears: z.number().int().nonnegative(),
    value: z.number().nonnegative(),
  }),
  lastPublishedAt: z.string().datetime({ offset: true }).optional(),
});

export const immutableFindingRefSchema = z.strictObject({
  id: identifierSchema,
  digest: digestSchema,
});

export const knownRecordAccessAuthorizationRefSchema = z.strictObject({
  kind: z.literal("known-record-access-authorization-ref"),
  schemaVersion: z.literal(2),
  id: identifierSchema,
  digest: digestSchema,
});

const knownRecordAccessAuthorizationBodySchema = z.strictObject({
  kind: z.literal("known-record-access-authorization"),
  schemaVersion: z.literal(2),
  verifiedFindingRef: immutableFindingRefSchema,
  purpose: z.literal("known-duplicate-disposition"),
  subject: z.strictObject({
    pluginIdentity: pluginIdentitySchema,
    verifiedVersion: versionSchema,
    canonicalFileManifestDigest: digestSchema,
  }),
  authorizedAt: z.string().datetime({ offset: true }),
});

export const knownRecordAccessAuthorizationSchema =
  knownRecordAccessAuthorizationBodySchema.extend({
    id: identifierSchema,
    digest: digestSchema,
  });

export const wordfenceKnownRecordInspectionRequestSchema = z.strictObject({
  kind: z.literal("wordfence-known-record-inspection"),
  schemaVersion: z.literal(2),
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
  pluginIdentity: pluginIdentitySchema,
  verifiedVersion: versionSchema,
  canonicalFileManifestDigest: digestSchema,
  authorizationRef: knownRecordAccessAuthorizationRefSchema,
});

const attributionPartySchema = z.strictObject({
  notice: z.string().min(1),
  license: z.string().min(1),
  licenseUrl: z.url(),
});

const affectedVersionIntervalSchema = z.strictObject({
  fromVersion: versionSchema.or(z.literal("*")),
  fromInclusive: z.boolean(),
  toVersion: versionSchema.or(z.literal("*")),
  toInclusive: z.boolean(),
});

export const wordfenceKnownRecordSchema = z.strictObject({
  recordId: z.uuid(),
  affectedVersionIntervals: z.array(affectedVersionIntervalSchema).min(1),
  patchedVersions: z.array(versionSchema),
  cwe: z
    .strictObject({
      id: z.number().int().nonnegative(),
      name: z.string().min(1),
      description: z.string().min(1),
    })
    .optional(),
  cvss: z
    .strictObject({
      vector: z.string().min(1),
      score: z.number().min(0).max(10),
      rating: z.enum(["None", "Low", "Medium", "High", "Critical"]),
    })
    .optional(),
  cve: z
    .string()
    .regex(/^CVE-[0-9]{4}-[0-9]{4,}$/)
    .optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  attribution: z.strictObject({
    message: z.string().min(1),
    wordfence: attributionPartySchema,
    mitre: attributionPartySchema.optional(),
  }),
});

export const wordfenceStoredPluginRecordSchema = z.strictObject({
  pluginSlug: wordfenceSoftwareIdentifierSchema,
  record: wordfenceKnownRecordSchema,
});

const wordfenceRateLimitRetryAfterSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("delay-seconds"),
    seconds: z.number().int().nonnegative().max(86_400),
    capped: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("absolute-time"),
    at: z.string().datetime({ offset: true }),
    capped: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("unspecified") }),
]);

export const wordfenceRateLimitBackoffSchema = z.strictObject({
  kind: z.literal("wordfence-rate-limit-backoff"),
  schemaVersion: z.literal(2),
  automaticRetries: z.literal(0),
  boundedAt: z.string().datetime({ offset: true }),
  maximumDelaySeconds: z.literal(86_400),
  retryAfter: wordfenceRateLimitRetryAfterSchema,
});

export const wordfenceIntelligenceFailureReasonSchema = z.enum([
  "not-refreshed",
  "not-found",
  "authentication-failed",
  "rate-limited",
  "network-failure",
  "partial-response",
  "response-byte-ceiling-exceeded",
  "source-mismatch",
  "schema-drift",
  "attribution-missing",
  "credential-unavailable",
  "storage-failure",
]);

const wordfenceNonRateLimitedFailureReasonSchema =
  wordfenceIntelligenceFailureReasonSchema.exclude(["rate-limited"]);

const wordfenceFailureEnvelope = {
  kind: z.literal("wordfence-intelligence-result"),
  schemaVersion: z.literal(1),
  status: z.literal("failed"),
} as const;

export const wordfenceIntelligenceFailureSchema = z.discriminatedUnion(
  "reason",
  [
    z.strictObject({
      ...wordfenceFailureEnvelope,
      reason: z.literal("rate-limited"),
      backoff: wordfenceRateLimitBackoffSchema,
    }),
    z.strictObject({
      ...wordfenceFailureEnvelope,
      reason: wordfenceNonRateLimitedFailureReasonSchema,
    }),
  ],
);

export const currentWordfenceIntelligenceSnapshotSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-result"),
  schemaVersion: z.literal(1),
  status: z.literal("current"),
  snapshot: wordfenceIntelligenceSnapshotSchema,
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
});

export const wordfenceIntelligenceRefreshAttemptSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-refresh-attempt"),
  schemaVersion: z.literal(1),
  attemptedAt: z.string().datetime({ offset: true }),
  result: wordfenceIntelligenceFailureSchema,
});

export const staleWordfenceIntelligenceSnapshotSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-result"),
  schemaVersion: z.literal(1),
  status: z.literal("stale"),
  snapshot: wordfenceIntelligenceSnapshotSchema,
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
  latestRefresh: wordfenceIntelligenceRefreshAttemptSchema,
});

export const wordfenceIntelligenceResultSchema = z.union([
  currentWordfenceIntelligenceSnapshotSchema,
  staleWordfenceIntelligenceSnapshotSchema,
  wordfenceIntelligenceFailureSchema,
]);

export const wordfenceKnownRecordProjectionSchema = z.strictObject({
  kind: z.literal("wordfence-known-record-projection"),
  schemaVersion: z.literal(2),
  pluginIdentity: pluginIdentitySchema,
  verifiedVersion: versionSchema,
  canonicalFileManifestDigest: digestSchema,
  snapshotRef: wordfenceIntelligenceSnapshotRefSchema,
  authorizationRef: knownRecordAccessAuthorizationRefSchema,
  verifiedFindingRef: immutableFindingRefSchema,
  purpose: z.literal("known-duplicate-disposition"),
  records: z.array(wordfenceKnownRecordSchema),
});

export const wordfenceIntelligenceSourceResponseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  sourceUrl: z.url(),
  complete: z.boolean(),
  redirected: z.boolean().optional(),
  backoff: wordfenceRateLimitBackoffSchema.optional(),
  bytes: z.custom<Uint8Array<ArrayBufferLike>>(
    (value) => value instanceof Uint8Array,
  ),
});

export type WordfenceSecretRef = z.infer<typeof wordfenceSecretRefSchema>;
export type WordfenceIntelligenceSnapshotRef = z.infer<
  typeof wordfenceIntelligenceSnapshotRefSchema
>;
export type WordfenceIntelligenceSnapshot = z.infer<
  typeof wordfenceIntelligenceSnapshotSchema
>;
export type WordfenceIntelligenceRefreshRequest = z.infer<
  typeof wordfenceIntelligenceRefreshRequestSchema
>;
export type WordfenceIntelligenceInspectionRequest = z.infer<
  typeof wordfenceIntelligenceInspectionRequestSchema
>;
export type VulnerabilityHistoryAggregateRequest = z.infer<
  typeof vulnerabilityHistoryAggregateRequestSchema
>;
export type VulnerabilityHistoryAggregate = z.infer<
  typeof vulnerabilityHistoryAggregateSchema
>;
export type WordfenceKnownRecordInspectionRequest = z.infer<
  typeof wordfenceKnownRecordInspectionRequestSchema
>;
export type KnownRecordAccessAuthorizationRef = z.infer<
  typeof knownRecordAccessAuthorizationRefSchema
>;
export type KnownRecordAccessAuthorization = z.infer<
  typeof knownRecordAccessAuthorizationSchema
>;
export type WordfenceKnownRecord = z.infer<typeof wordfenceKnownRecordSchema>;
export type WordfenceStoredPluginRecord = z.infer<
  typeof wordfenceStoredPluginRecordSchema
>;
export type WordfenceKnownRecordProjection = z.infer<
  typeof wordfenceKnownRecordProjectionSchema
>;
export type WordfenceIntelligenceSourceResponse = z.infer<
  typeof wordfenceIntelligenceSourceResponseSchema
>;
export type WordfenceRateLimitBackoff = z.infer<
  typeof wordfenceRateLimitBackoffSchema
>;
export type WordfenceIntelligenceFailureReason = z.infer<
  typeof wordfenceIntelligenceFailureReasonSchema
>;
export type WordfenceIntelligenceFailure = z.infer<
  typeof wordfenceIntelligenceFailureSchema
>;
export type CurrentWordfenceIntelligenceSnapshot = z.infer<
  typeof currentWordfenceIntelligenceSnapshotSchema
>;
export type StaleWordfenceIntelligenceSnapshot = z.infer<
  typeof staleWordfenceIntelligenceSnapshotSchema
>;
export type WordfenceIntelligenceRefreshAttempt = z.infer<
  typeof wordfenceIntelligenceRefreshAttemptSchema
>;
export type WordfenceIntelligenceResult = z.infer<
  typeof wordfenceIntelligenceResultSchema
>;

export interface WordfenceIntelligenceSourceRequest {
  readonly credential: WordfenceSecretRef;
  readonly maximumBytes: number;
}

export interface WordfenceIntelligenceV3Adapter {
  readonly sourceUrl: string;
  retrieveProductionFeed(
    request: WordfenceIntelligenceSourceRequest,
  ): Promise<WordfenceIntelligenceSourceResponse>;
}

export type KnownRecordAccessAuthorizationResolution =
  | {
      readonly status: "authorized";
      readonly authorization: unknown;
    }
  | { readonly status: "denied" };

export interface KnownRecordAccessAuthorizationProvider {
  resolve(
    reference: KnownRecordAccessAuthorizationRef,
  ): Promise<KnownRecordAccessAuthorizationResolution>;
}

export class WordfenceKnownRecordAccessError extends Error {
  readonly code = "known-record-access-denied" as const;

  constructor() {
    super("Wordfence known-record access denied");
    this.name = "WordfenceKnownRecordAccessError";
  }
}

export interface WordfenceIntelligence {
  refresh(
    request: WordfenceIntelligenceRefreshRequest,
  ): Promise<WordfenceIntelligenceResult>;
  inspect(
    request: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult>;
  aggregate(
    request: VulnerabilityHistoryAggregateRequest,
  ): Promise<VulnerabilityHistoryAggregate>;
  inspectKnownRecords(
    request: WordfenceKnownRecordInspectionRequest,
  ): Promise<WordfenceKnownRecordProjection>;
}

export interface OpenWordfenceIntelligenceOptions {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly adapter: WordfenceIntelligenceV3Adapter;
  readonly credential: WordfenceSecretRef;
  readonly maximumFeedBytes?: number;
  readonly knownRecordAuthorizationProvider?: KnownRecordAccessAuthorizationProvider;
  readonly clock?: () => Date;
}

export interface WordfenceIntelligenceV3FetchAdapterOptions {
  readonly credentialResolver?: (
    reference: WordfenceSecretRef,
  ) => Promise<string> | string;
  readonly credentialBroker?: HostPrivateCredentialBroker;
  readonly fetch?: typeof fetch;
  readonly sourceUrl?: string;
  readonly clock?: () => Date;
}

export interface HostPrivateCredentialBroker {
  resolve<T>(
    reference: WordfenceSecretRef,
    use: (credential: string) => Promise<T>,
  ): Promise<T>;
}

export interface OpenSqliteHostPrivateCredentialBrokerOptions {
  readonly databasePath: string;
}

export interface WordfenceIntelligenceRefresh {
  run(
    request: WordfenceIntelligenceRefreshRequest,
  ): Promise<WordfenceIntelligenceResult>;
  inspect(
    request: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult>;
}

export interface OpenWordfenceIntelligenceRefreshOptions {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly credentialBroker: HostPrivateCredentialBroker;
  readonly maximumFeedBytes?: number;
  readonly fetch?: typeof fetch;
  readonly knownRecordAuthorizationProvider?: KnownRecordAccessAuthorizationProvider;
  readonly clock?: () => Date;
}

export function wordfenceIntelligenceFailure(
  reason: WordfenceIntelligenceFailure["reason"],
  backoff?: WordfenceRateLimitBackoff,
): WordfenceIntelligenceFailure {
  return wordfenceIntelligenceFailureSchema.parse({
    kind: "wordfence-intelligence-result",
    schemaVersion: 1,
    status: "failed",
    reason,
    ...(backoff === undefined ? {} : { backoff }),
  });
}
