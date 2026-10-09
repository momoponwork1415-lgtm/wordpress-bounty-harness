import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import {
  measureCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../../../infrastructure/canonical-source-tree.js";
import type {
  AcquiredSource,
  Snapshot,
  SourceAcquisition,
} from "../../../snapshot/index.js";
import type { WordPressSource, WordPressSourceResolver } from "../lab/index.js";
import { WORDPRESS_CORE_IDENTITY } from "./wordpress-core-source.js";

/** Generous bounds for re-measuring a tree whose sealed size is not at hand. */
const MEASURE_LIMITS = { maxEntries: 200_000, maxBytes: 2 * 1024 ** 3 };

/** A frozen source is a WordPress.org plugin or the WordPress core itself. */
const sourceKind = (
  identity: string,
): { kind: "plugin"; slug: string } | { kind: "wordpress-core" } => {
  if (identity === WORDPRESS_CORE_IDENTITY) return { kind: "wordpress-core" };
  const slug = /^wporg:([a-z0-9][a-z0-9-]*)$/.exec(identity)?.[1];
  if (slug === undefined)
    throw new Error("Materialized source needs a WordPress.org identity");
  return { kind: "plugin", slug };
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lays each frozen source out once as a read-only tree under its source digest,
 * so the Lab, the discovery sandbox and the Verifier mount the same bytes.
 */
export function openMaterializedSources(options: {
  readonly rootDirectory: string;
}): WordPressSourceResolver & {
  acquisition<Selection>(
    inner: SourceAcquisition<Selection>,
  ): SourceAcquisition<Selection>;
} {
  const directoryFor = (sourceDigest: string) =>
    join(options.rootDirectory, sourceDigest.slice(7));

  const verified = async (
    sourceDigest: string,
  ): Promise<{ directory: string; tree: ExpectedSourceTree }> => {
    const directory = directoryFor(sourceDigest);
    if (!(await exists(directory)))
      throw new Error("Materialized source is unavailable");
    const tree = await measureCanonicalSourceTree(
      directory,
      MEASURE_LIMITS,
    ).catch(() => undefined);
    if (tree?.digest !== sourceDigest)
      throw new Error("Materialized source differs from its snapshot");
    return { directory, tree };
  };

  const materialize = async (source: AcquiredSource): Promise<void> => {
    const sourceDigest = canonicalDigest(source.manifest);
    if (await exists(directoryFor(sourceDigest))) {
      await verified(sourceDigest);
      return;
    }
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    const staging = join(options.rootDirectory, `.staging-${randomUUID()}`);
    try {
      for (const entry of source.manifest.entries) {
        const bytes = await source.readFile(entry.path);
        const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (bytes.byteLength !== entry.size || digest !== entry.digest)
          throw new Error("Source differs from its manifest");
        const path = join(staging, entry.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
      }
      await rename(staging, directoryFor(sourceDigest));
    } catch (error: unknown) {
      await rm(staging, { recursive: true, force: true });
      // Another freeze may have laid out the same digest first.
      if (
        error instanceof Error &&
        error.message !== "Source differs from its manifest" &&
        (await exists(directoryFor(sourceDigest)))
      ) {
        await verified(sourceDigest);
        return;
      }
      throw error;
    }
  };

  const resolveOne = async (record: {
    readonly identity: string;
    readonly version: string;
    readonly sourceDigest: string;
  }): Promise<WordPressSource> => {
    const { directory, tree } = await verified(record.sourceDigest);
    const kind = sourceKind(record.identity);
    return kind.kind === "plugin"
      ? {
          kind: "plugin",
          pluginSlug: kind.slug,
          sourceDirectory: directory,
          sourceTree: tree,
        }
      : {
          kind: "wordpress-core",
          version: record.version,
          sourceDirectory: directory,
          sourceTree: tree,
        };
  };

  return {
    acquisition: (inner) => ({
      async acquire(selection) {
        const acquired = await inner.acquire(selection);
        for (const source of [acquired.target, ...acquired.dependencies]) {
          sourceKind(source.identity);
          await materialize(source);
        }

        return acquired;
      },
    }),
    async resolve(snapshot: Snapshot) {
      return {
        target: await resolveOne(snapshot.target),
        dependencies: await Promise.all(snapshot.dependencies.map(resolveOne)),
      };
    },
  };
}
