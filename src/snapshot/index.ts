import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import {
  checkSourceAgainstManifest,
  type SourceTreeManifest,
} from "../infrastructure/canonical-source-tree.js";
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
  /** Validated against `sourceManifestSchema` before it is sealed. */
  readonly manifest: SourceTreeManifest;
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
  const checked = await checkSourceAgainstManifest(parsed.data, (path) =>
    source.readFile(path),
  );
  if (checked.status !== "verified")
    throw new SourceAcquisitionError("source-mismatch", checked.mismatch);
  return {
    identity: source.identity,
    version: source.version,
    sourceDigest: checked.digest,
  };
}

export type SnapshotLoad =
  | { readonly status: "loaded"; readonly snapshot: Snapshot }
  | {
      readonly status: "unavailable";
      readonly reason:
        "invalid-digest" | "missing" | "malformed" | "digest-mismatch";
    };

export interface SnapshotReader {
  /** The frozen Target Snapshot named by its digest, re-verified byte for byte. */
  load(digest: string): Promise<SnapshotLoad>;
}

/** Only this module knows how a frozen Snapshot is laid out on disk. */
function snapshotPath(storageDirectory: string, digest: string): string {
  return join(storageDirectory, `${digest.slice(7)}.json`);
}

export function openSnapshotReader(options: {
  readonly storageDirectory: string;
}): SnapshotReader {
  return {
    async load(digest) {
      if (!digestSchema.safeParse(digest).success)
        return { status: "unavailable", reason: "invalid-digest" };
      let bytes: string;
      try {
        bytes = await readFile(
          snapshotPath(options.storageDirectory, digest),
          "utf8",
        );
      } catch {
        return { status: "unavailable", reason: "missing" };
      }
      let record: z.infer<typeof snapshotSchema>;
      try {
        record = snapshotSchema.parse(JSON.parse(bytes) as unknown);
      } catch {
        return { status: "unavailable", reason: "malformed" };
      }
      if (bytes !== canonicalJson(record) || canonicalDigest(record) !== digest)
        return { status: "unavailable", reason: "digest-mismatch" };
      return { status: "loaded", snapshot: { ...record, digest } };
    },
  };
}

export function openSnapshot<Selection>(options: {
  readonly storageDirectory: string;
  readonly source: SourceAcquisition<Selection>;
}): SnapshotReader & {
  freeze(selection: Selection): Promise<Snapshot>;
} {
  const reader = openSnapshotReader(options);
  return {
    load: reader.load,
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
      if (
        (await persistImmutableFile(
          snapshotPath(options.storageDirectory, digest),
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
  };
}
