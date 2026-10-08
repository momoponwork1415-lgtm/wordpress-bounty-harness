import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { openMaterializedSources } from "../../../src/profiles/wordpress/acquisition/index.js";
import {
  openSnapshot,
  type AcquiredSource,
  type SourceAcquisition,
} from "../../../src/snapshot/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function source(
  identity: string,
  files: Readonly<Record<string, string>>,
): AcquiredSource {
  const entries = Object.entries(files)
    .map(([path, content]) => ({
      path,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      size: Buffer.byteLength(content),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  return {
    identity,
    version: "1.0.0",
    manifest: { kind: "canonical-file-manifest", schemaVersion: 1, entries },
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error("absent");
      return Buffer.from(content);
    },
  };
}

async function setup(acquired: {
  target: AcquiredSource;
  dependencies: readonly AcquiredSource[];
}) {
  const root = await mkdtemp(join(tmpdir(), "wbh-sources-"));
  directories.push(root);
  const sources = openMaterializedSources({
    rootDirectory: join(root, "sources"),
  });
  const inner: SourceAcquisition<string> = {
    acquire: async () => acquired,
  };
  const snapshots = openSnapshot({
    storageDirectory: join(root, "snapshots"),
    source: sources.acquisition(inner),
  });
  return { sources, snapshots };
}

describe("materialized snapshot sources", () => {
  it("lays every frozen source out as a read-only tree that matches the snapshot digest", async () => {
    const { sources, snapshots } = await setup({
      target: source("wporg:example-plugin", {
        "example-plugin.php": "<?php // main",
        "includes/a.php": "<?php // a",
      }),
      dependencies: [source("wporg:woocommerce", { "woocommerce.php": "x" })],
    });
    const snapshot = await snapshots.freeze("example-plugin");
    const resolved = await sources.resolve(snapshot);

    expect(resolved.target.pluginSlug).toBe("example-plugin");
    expect(resolved.target.sourceTree.digest).toBe(
      snapshot.target.sourceDigest,
    );
    expect(resolved.dependencies.map((item) => item.pluginSlug)).toEqual([
      "woocommerce",
    ]);
    for (const item of [resolved.target, ...resolved.dependencies])
      expect(
        (await verifyCanonicalSourceTree(item.sourceDirectory, item.sourceTree))
          .matches,
      ).toBe(true);
    const mode = (
      await stat(join(resolved.target.sourceDirectory, "includes/a.php"))
    ).mode;
    expect(mode & 0o222).toBe(0);

    // A second freeze of the same source reuses the tree.
    await expect(snapshots.freeze("example-plugin")).resolves.toEqual(snapshot);
  });

  it("refuses a tree that no longer matches its snapshot", async () => {
    const { sources, snapshots } = await setup({
      target: source("wporg:example-plugin", {
        "example-plugin.php": "<?php // main",
      }),
      dependencies: [],
    });
    const snapshot = await snapshots.freeze("example-plugin");
    const resolved = await sources.resolve(snapshot);
    const file = join(resolved.target.sourceDirectory, "example-plugin.php");
    await chmod(file, 0o644);
    await writeFile(file, "<?php // changed");

    await expect(sources.resolve(snapshot)).rejects.toThrow(
      "Materialized source differs from its snapshot",
    );
    await expect(snapshots.freeze("example-plugin")).rejects.toThrow(
      "Materialized source differs from its snapshot",
    );
  });

  it("refuses a snapshot whose source was never materialized", async () => {
    const { sources } = await setup({
      target: source("wporg:example-plugin", { "a.php": "a" }),
      dependencies: [],
    });
    await expect(
      sources.resolve({
        kind: "source-snapshot",
        schemaVersion: 1,
        target: {
          identity: "wporg:example-plugin",
          version: "1.0.0",
          sourceDigest: `sha256:${"b".repeat(64)}`,
        },
        dependencies: [],
        digest: `sha256:${"c".repeat(64)}`,
      }),
    ).rejects.toThrow("Materialized source is unavailable");
  });

  it("refuses a manifest whose bytes differ before writing anything", async () => {
    const target = source("wporg:example-plugin", { "a.php": "a" });
    const { snapshots } = await setup({
      target: { ...target, readFile: async () => Buffer.from("tampered") },
      dependencies: [],
    });
    await expect(snapshots.freeze("example-plugin")).rejects.toThrow(
      "Source differs from its manifest",
    );
  });
});
