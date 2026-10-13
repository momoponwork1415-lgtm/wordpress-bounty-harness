import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { measureCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { acquirePinnedWordPressOrgSvnSource } from "../../../src/profiles/wordpress/acquisition/index.js";

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
