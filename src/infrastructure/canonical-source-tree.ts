import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDigest } from "./canonical-json.js";

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

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function digestRegularFile(path: string): Promise<{
  readonly digest: string;
  readonly size: number;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1) {
      throw new Error("Source tree contains a non-regular or linked file");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      hash.update(bytes);
    }
    const after = await handle.stat();
    if (!sameFile(before, after) || size !== after.size) {
      throw new Error("Source file changed during integrity verification");
    }
    return { digest: `sha256:${hash.digest("hex")}`, size };
  } finally {
    await handle.close();
  }
}

async function canonicalSourceTree(
  root: string,
  limits: CanonicalSourceTreeLimits,
): Promise<ExpectedSourceTree> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Source tree root must be a real directory");
  }

  const entries: Array<{
    readonly path: string;
    readonly digest: string;
    readonly size: number;
  }> = [];
  const collisionKeys = new Set<string>();
  let observedBytes = 0;

  const walk = async (
    directory: string,
    segments: readonly string[],
  ): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const child of children) {
      if (
        child.name.includes("\\") ||
        child.name.includes("\0") ||
        child.name === "." ||
        child.name === ".."
      ) {
        throw new Error("Source tree contains an invalid path");
      }
      const childSegments = [...segments, child.name];
      const relativePath = childSegments.join("/");
      const collisionKey = relativePath.normalize("NFC").toLowerCase();
      if (collisionKeys.has(collisionKey)) {
        throw new Error("Source tree contains a path collision");
      }
      collisionKeys.add(collisionKey);
      const absolutePath = join(directory, child.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error("Source tree contains a symbolic link");
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, childSegments);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw new Error("Source tree contains a non-regular or linked entry");
      }
      const file = await digestRegularFile(absolutePath);
      entries.push({ path: relativePath, ...file });
      observedBytes += file.size;
      if (
        entries.length > limits.maxEntries ||
        observedBytes > limits.maxBytes
      ) {
        throw new Error("Source tree exceeds its sealed bounds");
      }
    }
  };

  await walk(root, []);
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    digest: canonicalDigest({
      kind: "canonical-file-manifest",
      schemaVersion: 1,
      entries,
    }),
    entries: entries.length,
    bytes: observedBytes,
  };
}

export async function measureCanonicalSourceTree(
  root: string,
  limits: CanonicalSourceTreeLimits,
): Promise<ExpectedSourceTree> {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 0
  ) {
    throw new Error("Canonical source tree limits are invalid");
  }
  return canonicalSourceTree(root, limits);
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
