import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDigest } from "./canonical-json.js";
import { bytesDigest } from "./content-digest.js";

export interface ExpectedSourceTree {
  readonly digest: string;
  readonly entries: number;
  readonly bytes: number;
}

export interface SourceTreeVerification {
  readonly matches: boolean;
  readonly observedDigest?: string;
}

export interface CanonicalSourceTreeLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface SourceTreeFile {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

/** The manifest whose canonical digest names a frozen source tree. */
export interface SourceTreeManifest {
  readonly kind: "canonical-file-manifest";
  readonly schemaVersion: 1;
  readonly entries: readonly SourceTreeFile[];
}

/** One walk yields both the sealed measure and the manifest behind its digest. */
export interface WalkedSourceTree extends ExpectedSourceTree {
  readonly manifest: SourceTreeManifest;
}

export type SourceTreeRejection =
  | "root-not-directory"
  | "invalid-path"
  | "path-collision"
  | "symbolic-link"
  | "hard-link"
  | "non-regular-entry"
  | "bounds-exceeded"
  | "changed-while-reading";

const rejectionMessages: Readonly<Record<SourceTreeRejection, string>> = {
  "root-not-directory": "Source tree root must be a real directory",
  "invalid-path": "Source tree contains an invalid path",
  "path-collision": "Source tree contains a path collision",
  "symbolic-link": "Source tree contains a symbolic link",
  "hard-link": "Source tree contains a hard-linked entry",
  "non-regular-entry": "Source tree contains a non-regular entry",
  "bounds-exceeded": "Source tree exceeds its sealed bounds",
  "changed-while-reading": "Source file changed during integrity verification",
};

/** Why a tree was refused; the code is stable, the message is for humans. */
export class SourceTreeError extends Error {
  readonly code: SourceTreeRejection;
  readonly path?: string;

  constructor(code: SourceTreeRejection, path?: string) {
    super(rejectionMessages[code]);
    this.name = "SourceTreeError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function digestRegularFile(
  path: string,
  relativePath: string,
): Promise<{
  readonly digest: string;
  readonly size: number;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile())
      throw new SourceTreeError("non-regular-entry", relativePath);
    if (before.nlink > 1) throw new SourceTreeError("hard-link", relativePath);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      hash.update(bytes);
    }
    const after = await handle.stat();
    if (!sameFile(before, after) || size !== after.size) {
      throw new SourceTreeError("changed-while-reading", relativePath);
    }
    return { digest: `sha256:${hash.digest("hex")}`, size };
  } finally {
    await handle.close();
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function canonicalSourceTree(
  root: string,
  limits: CanonicalSourceTreeLimits,
): Promise<WalkedSourceTree> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SourceTreeError("root-not-directory");
  }

  const entries: SourceTreeFile[] = [];
  const collisionKeys = new Set<string>();
  let observedBytes = 0;

  const walk = async (
    directory: string,
    segments: readonly string[],
  ): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePaths(left.name, right.name));
    for (const child of children) {
      const childSegments = [...segments, child.name];
      const relativePath = childSegments.join("/");
      if (
        child.name.includes("\\") ||
        child.name.includes("\0") ||
        child.name === "." ||
        child.name === ".."
      ) {
        throw new SourceTreeError("invalid-path", relativePath);
      }
      const collisionKey = relativePath.normalize("NFC").toLowerCase();
      if (collisionKeys.has(collisionKey)) {
        throw new SourceTreeError("path-collision", relativePath);
      }
      collisionKeys.add(collisionKey);
      const absolutePath = join(directory, child.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new SourceTreeError("symbolic-link", relativePath);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, childSegments);
        continue;
      }
      if (!stat.isFile()) {
        throw new SourceTreeError("non-regular-entry", relativePath);
      }
      if (stat.nlink > 1) {
        throw new SourceTreeError("hard-link", relativePath);
      }
      const file = await digestRegularFile(absolutePath, relativePath);
      entries.push({ path: relativePath, ...file });
      observedBytes += file.size;
      if (
        entries.length > limits.maxEntries ||
        observedBytes > limits.maxBytes
      ) {
        throw new SourceTreeError("bounds-exceeded", relativePath);
      }
    }
  };

  await walk(root, []);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  const manifest: SourceTreeManifest = {
    kind: "canonical-file-manifest",
    schemaVersion: 1,
    entries,
  };
  return {
    digest: canonicalDigest(manifest),
    entries: entries.length,
    bytes: observedBytes,
    manifest,
  };
}

function assertLimits(limits: CanonicalSourceTreeLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 0
  ) {
    throw new Error("Canonical source tree limits are invalid");
  }
}

/**
 * Walks a real directory once under the strict rules (no links, no
 * case-insensitive or NFC path collisions, files unchanged while read) and
 * returns the manifest together with the digest that names it.
 */
export async function walkCanonicalSourceTree(
  root: string,
  limits: CanonicalSourceTreeLimits,
): Promise<WalkedSourceTree> {
  assertLimits(limits);
  return canonicalSourceTree(root, limits);
}

export async function measureCanonicalSourceTree(
  root: string,
  limits: CanonicalSourceTreeLimits,
): Promise<ExpectedSourceTree> {
  const { digest, entries, bytes } = await walkCanonicalSourceTree(
    root,
    limits,
  );
  return { digest, entries, bytes };
}

export async function verifyCanonicalSourceTree(
  root: string,
  expected: ExpectedSourceTree,
): Promise<SourceTreeVerification> {
  let observed: ExpectedSourceTree;
  try {
    observed = await canonicalSourceTree(root, {
      maxEntries: expected.entries,
      maxBytes: expected.bytes,
    });
  } catch {
    return { matches: false };
  }
  if (
    observed.entries !== expected.entries ||
    observed.bytes !== expected.bytes
  ) {
    return { matches: false };
  }
  const observedDigest = observed.digest;
  return {
    matches: observedDigest === expected.digest,
    observedDigest,
  };
}

export type SourceManifestMismatch =
  | { readonly reason: "manifest-order"; readonly path: string }
  | { readonly reason: "manifest-path-collision"; readonly path: string }
  | {
      readonly reason: "manifest-file-unavailable";
      readonly path: string;
      readonly detail: string;
    }
  | {
      readonly reason: "manifest-content";
      readonly path: string;
      readonly expectedSize: number;
      readonly actualSize: number;
      readonly expectedDigest: string;
      readonly actualDigest: string;
    };

export type SourceManifestCheck =
  | { readonly status: "verified"; readonly digest: string }
  | { readonly status: "mismatch"; readonly mismatch: SourceManifestMismatch };

/**
 * Reads every file an acquired source names and compares it with its manifest
 * entry: strictly ascending paths, no case-insensitive or NFC collisions, and
 * size plus SHA-256 as declared. Verified bytes are handed to `receive` so a
 * caller that lays the tree out does not read them a second time. The digest
 * returned is the one a Snapshot records as `sourceDigest`.
 */
export async function checkSourceAgainstManifest(
  manifest: SourceTreeManifest,
  readFile: (path: string) => Promise<Uint8Array>,
  receive?: (entry: SourceTreeFile, bytes: Uint8Array) => Promise<void>,
): Promise<SourceManifestCheck> {
  const paths = new Set<string>();
  const collisionKeys = new Set<string>();
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (entry.path <= previousPath)
      return {
        status: "mismatch",
        mismatch: { reason: "manifest-order", path: entry.path },
      };
    previousPath = entry.path;
    const key = entry.path.normalize("NFC").toLowerCase();
    if (paths.has(entry.path) || collisionKeys.has(key))
      return {
        status: "mismatch",
        mismatch: { reason: "manifest-path-collision", path: entry.path },
      };
    paths.add(entry.path);
    collisionKeys.add(key);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(entry.path);
    } catch (error) {
      return {
        status: "mismatch",
        mismatch: {
          reason: "manifest-file-unavailable",
          path: entry.path,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const digest = bytesDigest(bytes);
    if (bytes.byteLength !== entry.size || digest !== entry.digest)
      return {
        status: "mismatch",
        mismatch: {
          reason: "manifest-content",
          path: entry.path,
          expectedSize: entry.size,
          actualSize: bytes.byteLength,
          expectedDigest: entry.digest,
          actualDigest: digest,
        },
      };
    if (receive !== undefined) await receive(entry, bytes);
  }
  return { status: "verified", digest: canonicalDigest(manifest) };
}
