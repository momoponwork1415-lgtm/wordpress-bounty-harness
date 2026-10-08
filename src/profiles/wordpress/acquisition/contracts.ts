import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        ),
    "Expected a normalized POSIX relative path",
  );

export const immutableArtifactRefSchema = z.strictObject({
  id: identifierSchema,
  digest: digestSchema,
});

export const targetIntakePolicySchema = z.strictObject({
  kind: z.literal("target-intake-policy"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  digest: digestSchema,
  limits: z.strictObject({
    maxEntries: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    maxPathBytes: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
  }),
});

const pluginIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("wporg"), slug: slugSchema }),
  z.strictObject({
    kind: z.literal("premium"),
    vendor: slugSchema,
    product: slugSchema,
  }),
]);

const targetProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("operator-provided"),
    acquisitionRef: immutableArtifactRefSchema,
  }),
  z.strictObject({
    kind: z.literal("wordpress-org"),
    sourceUrl: z.url(),
    acquisitionRef: immutableArtifactRefSchema,
  }),
]);

export const manualTargetIntakeRequestSchema = z.strictObject({
  kind: z.literal("manual-target-intake"),
  schemaVersion: z.literal(1),
  source: z.strictObject({
    kind: z.literal("local-directory"),
    path: z.string().min(1),
  }),
  pluginIdentity: pluginIdentitySchema,
  requestedVersion: z.string().min(1).max(64),
  mainPluginFile: relativePathSchema.optional(),
  canonicalInstallDirectory: slugSchema.optional(),
  provenance: targetProvenanceSchema,
  policy: targetIntakePolicySchema,
});

export const targetIntakeReasonSchema = z.enum([
  "source-not-directory",
  "link-entry",
  "hardlink-entry",
  "non-regular-entry",
  "path-collision",
  "quota-exceeded",
  "main-plugin-file-missing",
  "main-plugin-file-ambiguous",
  "main-plugin-file-invalid",
  "version-evidence-missing",
  "version-mismatch",
  "canonical-install-directory-missing",
  "archive-invalid",
  "path-traversal",
  "multiple-plugin-roots",
]);

const sourceFileEntrySchema = z.strictObject({
  path: relativePathSchema,
  digest: digestSchema,
  size: z.number().int().nonnegative(),
});

const canonicalFileManifestSchema = z.strictObject({
  kind: z.literal("canonical-file-manifest"),
  schemaVersion: z.literal(1),
  entries: z.array(sourceFileEntrySchema).min(1),
});

export const targetIntakePacketSchema = z.strictObject({
  kind: z.literal("target-intake-packet"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  pluginIdentity: z.string().min(1),
  version: z.string().min(1).max(64),
  canonicalInstallDirectory: slugSchema,
  mainPluginFile: relativePathSchema,
  pluginBasename: relativePathSchema,
  targetSnapshot: z.strictObject({
    id: identifierSchema,
    pluginSlug: slugSchema,
    version: z.string().min(1).max(64),
    digest: digestSchema,
  }),
  sourceTree: z.strictObject({
    digest: digestSchema,
    entries: z.number().int().positive(),
    manifest: canonicalFileManifestSchema,
  }),
  sourceCapture: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("captured-local-directory"),
      digest: digestSchema,
      files: z.array(sourceFileEntrySchema).min(1),
    }),
    z.strictObject({
      kind: z.literal("captured-wordpress-org-archive"),
      digest: digestSchema,
      files: z.array(sourceFileEntrySchema).min(1),
    }),
  ]),
  versionEvidence: z.strictObject({
    requestedVersion: z.string().min(1).max(64),
    mainHeaderVersion: z.string().min(1).max(64),
    mainFileDigest: digestSchema,
  }),
  provenance: targetProvenanceSchema,
  policy: immutableArtifactRefSchema,
});

export const intakeReceiptSchema = z.strictObject({
  kind: z.literal("target-intake-receipt"),
  schemaVersion: z.literal(1),
  id: identifierSchema,
  requestDigest: digestSchema,
  policy: immutableArtifactRefSchema,
  status: z.enum(["ready", "deferred", "rejected"]),
  reasons: z.array(targetIntakeReasonSchema),
  packetRef: immutableArtifactRefSchema.optional(),
});

const dispositionBase = {
  receipt: intakeReceiptSchema,
  receiptRef: immutableArtifactRefSchema,
};

export const readyIntakeDispositionSchema = z.strictObject({
  status: z.literal("ready"),
  ...dispositionBase,
  packet: targetIntakePacketSchema,
  packetRef: immutableArtifactRefSchema,
});

export const intakeDispositionSchema = z.discriminatedUnion("status", [
  readyIntakeDispositionSchema,
  z.strictObject({
    status: z.literal("deferred"),
    ...dispositionBase,
    reasons: z.array(targetIntakeReasonSchema).min(1),
  }),
  z.strictObject({
    status: z.literal("rejected"),
    ...dispositionBase,
    reasons: z.array(targetIntakeReasonSchema).min(1),
  }),
]);

export type ManualTargetIntakeRequest = z.infer<
  typeof manualTargetIntakeRequestSchema
>;
export type TargetIntakePolicy = z.infer<typeof targetIntakePolicySchema>;
export type TargetIntakeReason = z.infer<typeof targetIntakeReasonSchema>;
export type TargetIntakePacket = z.infer<typeof targetIntakePacketSchema>;
export type IntakeReceipt = z.infer<typeof intakeReceiptSchema>;
export type ReadyIntakeDisposition = z.infer<
  typeof readyIntakeDispositionSchema
>;
export type IntakeDisposition = z.infer<typeof intakeDispositionSchema>;

export interface TargetIntake {
  intake(request: ManualTargetIntakeRequest): Promise<IntakeDisposition>;
}
