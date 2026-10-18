import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import {
  acquirePinnedWordPressOrgSvnSource,
  openMaterializedSources,
  openCapturedWordPressOrgSvnSource,
  openWordPressOrgSnapshotSource,
  type WordPressOrgTargetSource,
} from "../../../src/profiles/wordpress/acquisition/index.js";
import {
  openSnapshot,
  SourceAcquisitionError,
  type AcquiredSource,
} from "../../../src/snapshot/index.js";

const policy = {
  kind: "target-intake-policy" as const,
  schemaVersion: 1 as const,
  id: "pinned-svn-test-v1",
  digest: `sha256:${"a".repeat(64)}`,
  limits: {
    maxEntries: 100,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
    maxPathBytes: 512,
    maxDepth: 16,
  },
};

describe("pinned WordPress.org SVN source", () => {
  const memorySource = (identity: string, version: string): AcquiredSource => {
    const bytes = Buffer.from(`${identity}@${version}\n`);
    const manifest = {
      kind: "canonical-file-manifest" as const,
      schemaVersion: 1 as const,
      entries: [
        {
          path: "source.txt",
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          size: bytes.length,
        },
      ],
    };
    return {
      identity,
      version,
      manifest,
      async readFile(path) {
        if (path !== "source.txt") throw new Error("Missing file");
        return bytes;
      },
    };
  };

  it("captures a revision with its source provenance and immutable bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pinned-svn-"));
    const sourceDirectory = join(root, "export");
    const storageDirectory = join(root, "intake");
    try {
      await mkdir(sourceDirectory);
      await writeFile(
        join(sourceDirectory, "example.php"),
        "<?php\n/* Plugin Name: Example\nVersion: 2.0.16\n*/\n",
      );
      const expectedTree = await measureCanonicalSourceTree(sourceDirectory, {
        maxEntries: 100,
        maxBytes: 10_000_000,
      });
      const result = await acquirePinnedWordPressOrgSvnSource({
        sourceDirectory,
        storageDirectory,
        slug: "example",
        version: "2.0.16",
        mainPluginFile: "example.php",
        sourceUrl: "https://plugins.svn.wordpress.org/example/trunk/",
        revision: 3628543,
        expectedTree,
        policy,
      });

      expect(result.packet).toMatchObject({
        version: "2.0.16",
        sourceCapture: { kind: "captured-wordpress-org-svn-export" },
        provenance: {
          kind: "wordpress-org-svn",
          sourceUrl: "https://plugins.svn.wordpress.org/example/trunk/",
          revision: 3628543,
          acquisitionRef: { digest: expectedTree.digest },
        },
      });
      expect(result.packet.sourceTree.digest).toBe(expectedTree.digest);
      expect(
        JSON.parse(
          await readFile(
            join(
              storageDirectory,
              "objects",
              `${expectedTree.digest.slice(7)}.json`,
            ),
            "utf8",
          ),
        ),
      ).toEqual(result.packet.sourceTree.manifest);
      expect(await result.source.readFile("example.php")).toEqual(
        await readFile(join(sourceDirectory, "example.php")),
      );
      await expect(result.source.readFile("missing.php")).rejects.toThrow(
        "absent from source manifest",
      );
      const pin = {
        kind: "captured-wordpress-org-svn-export" as const,
        storageDirectory,
        packetDigest: canonicalDigest(result.packet),
        sourceTreeDigest: expectedTree.digest,
        revision: 3628543,
      };
      const reopened = await openCapturedWordPressOrgSvnSource({
        pin,
        slug: "example",
        version: "2.0.16",
        policy,
      });
      expect(reopened.packet).toEqual(result.packet);
      expect(await reopened.source.readFile("example.php")).toEqual(
        await readFile(join(sourceDirectory, "example.php")),
      );
      await expect(
        openCapturedWordPressOrgSvnSource({
          pin: { ...pin, revision: 3628544 },
          slug: "example",
          version: "2.0.16",
          policy,
        }),
      ).rejects.toThrow(SourceAcquisitionError);
      await expect(
        openCapturedWordPressOrgSvnSource({
          pin,
          slug: "another-plugin",
          version: "2.0.16",
          policy,
        }),
      ).rejects.toThrow(SourceAcquisitionError);
      await expect(
        openCapturedWordPressOrgSvnSource({
          pin,
          slug: "example",
          version: "2.0.16",
          policy: {
            ...policy,
            limits: { ...policy.limits, maxFileBytes: 1 },
          },
        }),
      ).rejects.toThrow();
      await expect(
        openCapturedWordPressOrgSvnSource({
          pin,
          slug: "example",
          version: "2.0.16",
          policy: { ...policy, digest: canonicalDigest("another-policy") },
        }),
      ).rejects.toThrow(SourceAcquisitionError);
      await writeFile(
        join(storageDirectory, "objects", `${pin.packetDigest.slice(7)}.json`),
        JSON.stringify({ ...result.packet, version: "changed" }),
      );
      await expect(
        openCapturedWordPressOrgSvnSource({
          pin,
          slug: "example",
          version: "2.0.16",
          policy,
        }),
      ).rejects.toThrow(SourceAcquisitionError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes an imported target with dependency, Core and PHP source without ZIP acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "pinned-svn-snapshot-"));
    try {
      const sourceDirectory = join(root, "export");
      const storageDirectory = join(root, "intake");
      await mkdir(sourceDirectory);
      await writeFile(
        join(sourceDirectory, "example.php"),
        "<?php\n/* Plugin Name: Example\nVersion: 2.0.16\n*/\n",
      );
      const expectedTree = await measureCanonicalSourceTree(sourceDirectory, {
        maxEntries: 100,
        maxBytes: 10_000_000,
      });
      const captured = await acquirePinnedWordPressOrgSvnSource({
        sourceDirectory,
        storageDirectory,
        slug: "example",
        version: "2.0.16",
        mainPluginFile: "example.php",
        sourceUrl: "https://plugins.svn.wordpress.org/example/trunk/",
        revision: 3628543,
        expectedTree,
        policy,
      });
      const targetSource = {
        async observe() {
          throw new Error("Archive observation must not run");
        },
        async acquire() {
          throw new Error("Archive acquisition must not run");
        },
      } as WordPressOrgTargetSource;
      const sources = openMaterializedSources({
        rootDirectory: join(root, "materialized"),
      });
      const snapshots = openSnapshot({
        storageDirectory: join(root, "snapshots"),
        source: sources.acquisition(
          openWordPressOrgSnapshotSource({
            targetSource,
            storageDirectory: join(root, "unused-zip-store"),
            dependencies: async () => [
              memorySource("wordpress-core", "6.8.3"),
              memorySource("php-runtime-source", "8.3.28"),
            ],
            pluginDependencies: async (packet, pins) => {
              expect(packet).toEqual(captured.packet);
              expect(pins).toEqual({ elementor: "4.2.0" });
              return [memorySource("wporg:elementor", "4.2.0")];
            },
          }),
        ),
      });
      const request = {
        kind: "wordpress-org-target-acquire" as const,
        schemaVersion: 1 as const,
        observationRef: {
          kind: "wordpress-org-target-observation-ref" as const,
          schemaVersion: 1 as const,
          id: "observation-example",
          digest: `sha256:${"b".repeat(64)}`,
        },
        requestedVersion: "2.0.16",
        policy,
        capturedSvnTarget: {
          slug: "example",
          pin: {
            kind: "captured-wordpress-org-svn-export" as const,
            storageDirectory,
            packetDigest: canonicalDigest(captured.packet),
            sourceTreeDigest: expectedTree.digest,
            revision: 3628543,
          },
        },
        pluginDependencyPins: { elementor: "4.2.0" },
        dependencyVersionPolicy: "pinned-only" as const,
      };
      const frozen = await snapshots.freeze(request);
      expect(frozen.target).toEqual({
        identity: "wporg:example",
        version: "2.0.16",
        sourceDigest: expectedTree.digest,
      });
      expect(frozen.dependencies.map((item) => item.identity)).toEqual([
        "wordpress-core",
        "php-runtime-source",
        "wporg:elementor",
      ]);
      expect(await snapshots.verify(frozen.digest)).toBe(true);
      expect((await sources.resolve(frozen)).dependencies).toHaveLength(3);
      const blobDigest = captured.packet.sourceTree.manifest.entries[0]!.digest;
      await writeFile(
        join(storageDirectory, "blobs", blobDigest.slice(7)),
        "altered",
      );
      await expect(snapshots.freeze(request)).rejects.toThrow(
        SourceAcquisitionError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects changed bytes and false SVN origins before publishing a packet", async () => {
    const root = await mkdtemp(join(tmpdir(), "pinned-svn-reject-"));
    const sourceDirectory = join(root, "export");
    try {
      await mkdir(sourceDirectory);
      await writeFile(
        join(sourceDirectory, "example.php"),
        "<?php\n/* Plugin Name: Example\nVersion: 2.0.16\n*/\n",
      );
      const expectedTree = await measureCanonicalSourceTree(sourceDirectory, {
        maxEntries: 100,
        maxBytes: 10_000_000,
      });
      const request = {
        sourceDirectory,
        storageDirectory: join(root, "intake"),
        slug: "example",
        version: "2.0.16",
        mainPluginFile: "example.php",
        sourceUrl: "https://plugins.svn.wordpress.org/example/trunk/",
        revision: 3628543,
        expectedTree,
        policy,
      };
      await expect(
        acquirePinnedWordPressOrgSvnSource({
          ...request,
          sourceUrl: "https://example.invalid/example/trunk/",
        }),
      ).rejects.toThrow("Expected a pinned WordPress.org SVN trunk source");
      await expect(
        acquirePinnedWordPressOrgSvnSource({
          ...request,
          sourceUrl:
            "https://operator@plugins.svn.wordpress.org/example/trunk/",
        }),
      ).rejects.toThrow("Expected a pinned WordPress.org SVN trunk source");
      await expect(
        acquirePinnedWordPressOrgSvnSource({
          ...request,
          sourceUrl: "https://plugins.svn.wordpress.org:8443/example/trunk/",
        }),
      ).rejects.toThrow("Expected a pinned WordPress.org SVN trunk source");
      await writeFile(join(sourceDirectory, "example.php"), "changed");
      await expect(acquirePinnedWordPressOrgSvnSource(request)).rejects.toThrow(
        "differs from its pinned source tree",
      );
      await expect(readFile(join(root, "intake", "objects"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
