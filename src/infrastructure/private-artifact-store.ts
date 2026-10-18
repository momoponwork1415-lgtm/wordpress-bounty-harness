import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  measureCanonicalSourceTree,
  SourceTreeError,
  verifyCanonicalSourceTree,
} from "./canonical-source-tree.js";
import { canonicalJson } from "./canonical-json.js";
import { hasErrorCode } from "./immutable-file.js";

/** Every committed artifact keeps its files under `<root>/<artifactId>/content/`. */
const CONTENT_DIRECTORY = "content";

const artifactIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  kind: z.literal("private-artifact-manifest"),
  schemaVersion: z.literal(1),
  artifact: z.strictObject({
    artifactId: artifactIdSchema,
    digest: digestSchema,
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
});

export interface PrivateArtifactDescriptor {
  readonly artifactId: string;
  readonly digest: string;
  readonly entries: number;
  readonly bytes: number;
}

export interface PrivateArtifactStaging {
  readonly rootDirectory: string;
  readonly contentDirectory: string;
}

export type PrivateArtifactCommitResult =
  | {
      readonly status: "stored" | "existing";
      readonly artifact: PrivateArtifactDescriptor;
    }
  | { readonly status: "conflict" };

export type PrivateArtifactResolution =
  | {
      readonly status: "resolved";
      readonly artifact: PrivateArtifactDescriptor;
      readonly contentDirectory: string;
    }
  | {
      readonly status:
        "missing" | "integrity-mismatch" | "size-limit-exceeded" | "unsafe";
    };

export type PrivateArtifactFileResolution =
  | {
      readonly status: "resolved";
      readonly artifact: PrivateArtifactDescriptor;
      readonly bytes: Buffer;
    }
  | Exclude<PrivateArtifactResolution, { readonly status: "resolved" }>;

/**
 * A JSON file read through its schema. `malformed` separates text that is not
 * JSON (`json`) from JSON the schema rejects (`schema`), so a caller can name
 * which one it saw without touching the bytes itself.
 */
export type PrivateArtifactJsonResolution<T> =
  | {
      readonly status: "resolved";
      readonly artifact: PrivateArtifactDescriptor;
      readonly value: T;
    }
  | { readonly status: "malformed"; readonly reason: "json" | "schema" }
  | Exclude<PrivateArtifactResolution, { readonly status: "resolved" }>;

export class PrivateArtifactStore {
  readonly #rootDirectory: string;
  readonly #limits: { readonly maxEntries: number; readonly maxBytes: number };

  constructor(options: {
    readonly rootDirectory: string;
    readonly maxEntries: number;
    readonly maxBytes: number;
  }) {
    if (
      !isAbsolute(options.rootDirectory) ||
      options.rootDirectory.includes("\0") ||
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries <= 0 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 0
    ) {
      throw new TypeError("Private artifact store options are invalid");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#limits = {
      maxEntries: options.maxEntries,
      maxBytes: options.maxBytes,
    };
  }

  /** The host directory this store owns; Private Evidence lives here, outside Git. */
  get rootDirectory(): string {
    return this.#rootDirectory;
  }

  /**
   * Where a committed artifact's files live on this host. A pure path for
   * review material and printed output; nothing is read or verified.
   */
  contentPath(artifactId: string): string {
    const parsed = artifactIdSchema.safeParse(artifactId);
    if (!parsed.success) {
      throw new PrivateArtifactStoreError(
        "invalid-artifact-id",
        "Private artifact identity is invalid",
        parsed.error,
      );
    }
    return join(this.#rootDirectory, parsed.data, CONTENT_DIRECTORY);
  }

  async stage(): Promise<PrivateArtifactStaging> {
    await this.#prepareRoot();
    const rootDirectory = await mkdtemp(
      join(this.#rootDirectory, ".active-artifact-"),
    );
    const contentDirectory = join(rootDirectory, CONTENT_DIRECTORY);
    await mkdir(contentDirectory, { mode: 0o700 });
    return { rootDirectory, contentDirectory };
  }

  /** Content-addressed write of flat named files; the returned digest is the artifact id. */
  async putFiles(
    files: Readonly<Record<string, string | Uint8Array>>,
  ): Promise<string> {
    const names = Object.keys(files);
    if (
      names.length === 0 ||
      names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
    )
      throw new TypeError("Private artifact file names are invalid");
    const staging = await this.stage();
    try {
      for (const name of names)
        await writeFile(join(staging.contentDirectory, name), files[name]!, {
          mode: 0o600,
          flag: "wx",
        });
      const measured = await measureCanonicalSourceTree(
        staging.contentDirectory,
        this.#limits,
      );
      const committed = await this.commit(measured.digest, staging);
      if (committed.status === "conflict")
        throw new Error("Private artifact conflict");
      return committed.artifact.digest;
    } catch (error: unknown) {
      await rm(staging.rootDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async commit(
    candidateArtifactId: string,
    staging: PrivateArtifactStaging,
  ): Promise<PrivateArtifactCommitResult> {
    const parsedArtifactId = artifactIdSchema.safeParse(candidateArtifactId);
    if (!parsedArtifactId.success) {
      throw new PrivateArtifactStoreError(
        "invalid-artifact-id",
        "Private artifact identity is invalid",
        parsedArtifactId.error,
      );
    }
    const artifactId = parsedArtifactId.data;
    await this.#prepareRoot();
    await this.#assertOwnedStaging(staging);
    let measured: Omit<PrivateArtifactDescriptor, "artifactId">;
    try {
      measured = await measureCanonicalSourceTree(
        staging.contentDirectory,
        this.#limits,
      );
    } catch (error: unknown) {
      throw new PrivateArtifactStoreError(
        error instanceof SourceTreeError && error.code === "bounds-exceeded"
          ? "size-limit-exceeded"
          : "unsafe-artifact",
        "Private artifact staging could not be measured safely",
        error,
      );
    }
    const artifact = { artifactId, ...measured };
    const manifest = {
      kind: "private-artifact-manifest" as const,
      schemaVersion: 1 as const,
      artifact,
    };
    await writeFile(
      join(staging.rootDirectory, "manifest.json"),
      canonicalJson(manifest),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const destination = join(this.#rootDirectory, artifactId);
    try {
      await rename(staging.rootDirectory, destination);
      return { status: "stored", artifact };
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST") && !hasErrorCode(error, "ENOTEMPTY")) {
        throw error;
      }
      const existing = await this.resolve(artifact);
      if (existing.status !== "resolved") return { status: "conflict" };
      await rm(staging.rootDirectory, { recursive: true, force: true });
      return { status: "existing", artifact };
    }
  }

  async resolve(
    candidate: PrivateArtifactDescriptor | string,
  ): Promise<PrivateArtifactResolution> {
    let artifactId: string;
    let expected: PrivateArtifactDescriptor | undefined;
    try {
      if (typeof candidate === "string") {
        artifactId = artifactIdSchema.parse(candidate);
      } else {
        expected = manifestSchema.shape.artifact.parse(candidate);
        artifactId = expected.artifactId;
      }
    } catch {
      return { status: "unsafe" };
    }
    const destination = join(this.#rootDirectory, artifactId);
    try {
      const rootStat = await lstat(this.#rootDirectory);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return { status: "unsafe" };
      }
      const destinationStat = await lstat(destination);
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
        return { status: "unsafe" };
      }
      const manifest = await this.#readManifest(destination);
      if (
        manifest.artifact.artifactId !== artifactId ||
        (expected !== undefined &&
          (manifest.artifact.digest !== expected.digest ||
            manifest.artifact.entries !== expected.entries ||
            manifest.artifact.bytes !== expected.bytes))
      ) {
        return { status: "integrity-mismatch" };
      }
      const artifact = manifest.artifact;
      if (
        artifact.entries > this.#limits.maxEntries ||
        artifact.bytes > this.#limits.maxBytes
      ) {
        return { status: "size-limit-exceeded" };
      }
      const contentDirectory = join(destination, CONTENT_DIRECTORY);
      const verified = await verifyCanonicalSourceTree(
        contentDirectory,
        artifact,
      );
      return verified.matches
        ? { status: "resolved", artifact, contentDirectory }
        : { status: "integrity-mismatch" };
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return { status: "missing" };
      return { status: "unsafe" };
    }
  }

  async inspectOrphans(): Promise<readonly { readonly stagingId: string }[]> {
    let entries;
    try {
      const rootStat = await lstat(this.#rootDirectory);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new PrivateArtifactStoreError(
          "unsafe-root",
          "Private artifact root is unsafe",
        );
      }
      entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(".active-artifact-"),
      )
      .map((entry) => ({ stagingId: entry.name }))
      .sort((left, right) => left.stagingId.localeCompare(right.stagingId));
  }

  async readFile(
    artifact: PrivateArtifactDescriptor | string,
    relativePath: string,
    maxBytes: number,
  ): Promise<PrivateArtifactFileResolution> {
    const segments = relativePath.split("/");
    if (
      isAbsolute(relativePath) ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      ) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0
    ) {
      return { status: "unsafe" };
    }
    const resolution = await this.resolve(artifact);
    if (resolution.status !== "resolved") return resolution;
    let handle;
    try {
      handle = await open(
        join(resolution.contentDirectory, ...segments),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1) {
        return { status: "unsafe" };
      }
      if (before.size > Math.min(maxBytes, this.#limits.maxBytes)) {
        return { status: "size-limit-exceeded" };
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes.byteLength !== after.size
      ) {
        return { status: "integrity-mismatch" };
      }
      return { status: "resolved", artifact: resolution.artifact, bytes };
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) return { status: "missing" };
      return { status: "unsafe" };
    } finally {
      await handle?.close();
    }
  }

  /** `readFile` followed by `JSON.parse` and the schema; the bytes never leave this call. */
  async readJson<T>(
    artifact: PrivateArtifactDescriptor | string,
    relativePath: string,
    schema: z.ZodType<T>,
    maxBytes: number,
  ): Promise<PrivateArtifactJsonResolution<T>> {
    const file = await this.readFile(artifact, relativePath, maxBytes);
    if (file.status !== "resolved") return file;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
    } catch {
      return { status: "malformed", reason: "json" };
    }
    const value = schema.safeParse(parsed);
    return value.success
      ? { status: "resolved", artifact: file.artifact, value: value.data }
      : { status: "malformed", reason: "schema" };
  }

  async #prepareRoot(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.#rootDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PrivateArtifactStoreError(
        "unsafe-root",
        "Private artifact root is unsafe",
      );
    }
    await chmod(this.#rootDirectory, 0o700);
  }

  async #assertOwnedStaging(staging: PrivateArtifactStaging): Promise<void> {
    if (
      dirname(staging.rootDirectory) !== this.#rootDirectory ||
      !basename(staging.rootDirectory).startsWith(".active-artifact-") ||
      staging.contentDirectory !==
        join(staging.rootDirectory, CONTENT_DIRECTORY)
    ) {
      throw new PrivateArtifactStoreError(
        "invalid-staging",
        "Private artifact staging does not belong to this store",
      );
    }
    const [rootStat, contentStat] = await Promise.all([
      lstat(staging.rootDirectory),
      lstat(staging.contentDirectory),
    ]);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !contentStat.isDirectory() ||
      contentStat.isSymbolicLink()
    ) {
      throw new PrivateArtifactStoreError(
        "invalid-staging",
        "Private artifact staging is unsafe",
      );
    }
  }

  async #readManifest(destination: string) {
    const handle = await open(
      join(destination, "manifest.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024) {
        throw new Error("Private artifact manifest is unsafe");
      }
      const encoded = await handle.readFile("utf8");
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        Buffer.byteLength(encoded) !== after.size
      ) {
        throw new Error("Private artifact manifest changed while reading");
      }
      const parsed = manifestSchema.parse(JSON.parse(encoded) as unknown);
      if (canonicalJson(parsed) !== encoded) {
        throw new Error("Private artifact manifest is not canonical");
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }
}

export class PrivateArtifactStoreError extends Error {
  constructor(
    readonly code:
      | "invalid-staging"
      | "invalid-artifact-id"
      | "size-limit-exceeded"
      | "unsafe-artifact"
      | "unsafe-root",
    message: string,
    options?: unknown,
  ) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = "PrivateArtifactStoreError";
  }
}
