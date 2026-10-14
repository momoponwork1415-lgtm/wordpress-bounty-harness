import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import { persistImmutableFile } from "../infrastructure/immutable-file.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );

export const sourceManifestSchema = z.strictObject({
  kind: z.literal("canonical-file-manifest"),
  schemaVersion: z.literal(1),
  entries: z
    .array(
      z.strictObject({
        path: pathSchema,
        digest: digestSchema,
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export const sourceAcquisitionFailureKindSchema = z.enum([
  "dns",
  "connect-timeout",
  "request-timeout",
  "network",
  "http-response",
  "source-mismatch",
  "quota-exceeded",
  "invalid-archive",
  "deferred",
]);

export type SourceAcquisitionFailureKind = z.infer<
  typeof sourceAcquisitionFailureKindSchema
>;

/** A safe failure kind travels with a private diagnostic through the pipeline. */
export class SourceAcquisitionError extends Error {
  readonly kind: SourceAcquisitionFailureKind;
  readonly diagnostic: unknown;

  constructor(kind: SourceAcquisitionFailureKind, diagnostic: unknown) {
    super(`Source acquisition did not complete: ${kind}`);
    this.name = "SourceAcquisitionError";
    this.kind = kind;
    this.diagnostic = diagnostic;
  }
}

export interface AcquiredSource {
  readonly identity: string;
  readonly version: string;
  readonly manifest: SourceManifest;
  readFile(path: string): Promise<Uint8Array>;
}

/** A profile supplies source and its provenance; snapshot knows only this contract. */
export interface SourceAcquisition<Selection> {
  acquire(selection: Selection): Promise<{
    readonly target: AcquiredSource;
    readonly dependencies: readonly AcquiredSource[];
  }>;
}

export const snapshotSchema = z.strictObject({
  kind: z.literal("source-snapshot"),
  schemaVersion: z.literal(1),
  target: z.strictObject({
    identity: z.string().min(1),
    version: z.string().min(1),
    sourceDigest: digestSchema,
  }),
  dependencies: z.array(
    z.strictObject({
      identity: z.string().min(1),
      version: z.string().min(1),
      sourceDigest: digestSchema,
    }),
  ),
});

export type Snapshot = z.infer<typeof snapshotSchema> & {
  readonly digest: string;
};

async function seal(source: AcquiredSource): Promise<{
  identity: string;
  version: string;
  sourceDigest: string;
}> {
  if (source.identity.length === 0 || source.version.length === 0) {
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "source-identity-or-version-missing",
    });
  }
  const parsed = sourceManifestSchema.safeParse(source.manifest);
  if (!parsed.success)
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "invalid-manifest",
      detail: parsed.error.message,
    });
  const manifest = parsed.data;
  const paths = new Set<string>();
  const collisionKeys = new Set<string>();
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (entry.path <= previousPath)
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "manifest-order",
        path: entry.path,
      });
    previousPath = entry.path;
    const key = entry.path.normalize("NFC").toLowerCase();
    if (paths.has(entry.path) || collisionKeys.has(key)) {
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "manifest-path-collision",
        path: entry.path,
      });
    }
    paths.add(entry.path);
    collisionKeys.add(key);
    let bytes: Uint8Array;
    try {
      bytes = await source.readFile(entry.path);
    } catch (error) {
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "manifest-file-unavailable",
        path: entry.path,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== entry.size || digest !== entry.digest) {
      throw new SourceAcquisitionError("source-mismatch", {
        reason: "manifest-content",
        path: entry.path,
        expectedSize: entry.size,
        actualSize: bytes.byteLength,
        expectedDigest: entry.digest,
        actualDigest: digest,
      });
    }
  }
  return {
    identity: source.identity,
    version: source.version,
    sourceDigest: canonicalDigest(manifest),
  };
}

export function openSnapshot<Selection>(options: {
  readonly storageDirectory: string;
  readonly source: SourceAcquisition<Selection>;
}) {
  return {
    async freeze(selection: Selection): Promise<Snapshot> {
      const acquired = await options.source.acquire(selection);
      const target = await seal(acquired.target);
      const dependencies = await Promise.all(acquired.dependencies.map(seal));
      const record = snapshotSchema.parse({
        kind: "source-snapshot",
        schemaVersion: 1,
        target,
        dependencies,
      });
      const digest = canonicalDigest(record);
      const path = join(options.storageDirectory, `${digest.slice(7)}.json`);
      if (
        (await persistImmutableFile(
          path,
          Buffer.from(canonicalJson(record)),
        )) !== "stored"
      ) {
        throw new SourceAcquisitionError("source-mismatch", {
          reason: "snapshot-artifact-conflict",
          digest,
        });
      }
      return { ...record, digest };
    },
    async verify(digest: string): Promise<boolean> {
      if (!digestSchema.safeParse(digest).success) return false;
      try {
        const bytes = await readFile(
          join(options.storageDirectory, `${digest.slice(7)}.json`),
          "utf8",
        );
        const record = snapshotSchema.parse(JSON.parse(bytes) as unknown);
        return (
          bytes === canonicalJson(record) && canonicalDigest(record) === digest
        );
      } catch {
        return false;
      }
    },
  };
}
