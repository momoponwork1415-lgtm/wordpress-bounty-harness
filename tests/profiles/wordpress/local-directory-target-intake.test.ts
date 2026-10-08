import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { openLocalDirectoryTargetIntake } from "../../../src/profiles/wordpress/acquisition/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

describe("LocalDirectoryTargetIntake.intake", () => {
  it("emits a Target Snapshot manifest accepted by Research source integrity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "target-handoff-"));
    const source = join(directory, "source");
    try {
      await mkdir(join(source, "admin"), { recursive: true });
      await writeFile(
        join(source, "plugin.php"),
        "<?php\n/*\nPlugin Name: Handoff Plugin\nVersion: 1.0.0\n*/\n",
      );
      await writeFile(join(source, "admin.php"), "<?php\n");
      await writeFile(join(source, "admin", "view.php"), "<?php\n");
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: join(directory, "storage"),
      });

      const disposition = await intake.intake({
        kind: "manual-target-intake",
        schemaVersion: 1,
        source: { kind: "local-directory", path: source },
        pluginIdentity: { kind: "wporg", slug: "handoff-plugin" },
        requestedVersion: "1.0.0",
        mainPluginFile: "plugin.php",
        provenance: {
          kind: "operator-provided",
          acquisitionRef: { id: "handoff-source", digest: digest("6") },
        },
        policy: {
          kind: "target-intake-policy",
          schemaVersion: 1,
          id: "manual-local-v1",
          digest: digest("2"),
          limits: {
            maxEntries: 100,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10_000_000,
            maxPathBytes: 512,
            maxDepth: 16,
          },
        },
      });
      if (disposition.status !== "ready") {
        throw new Error("Expected a ready Target Intake Packet");
      }
      const expected = {
        digest: disposition.packet.sourceTree.digest,
        entries: disposition.packet.sourceTree.entries,
        bytes: disposition.packet.sourceTree.manifest.entries.reduce(
          (total, file) => total + file.size,
          0,
        ),
      };

      await expect(
        verifyCanonicalSourceTree(source, expected),
      ).resolves.toEqual({
        matches: true,
        observedDigest: expected.digest,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("durably creates the same oracle-free packet from the same bytes at different host paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "target-intake-"));
    const firstSource = join(directory, "first-source");
    const secondSource = join(directory, "second-source");
    const storage = join(directory, "storage");
    const plugin = `<?php
/*
Plugin Name: Example Security Plugin
Version: 2.4.1
*/
add_action('init', static function (): void {});
`;
    try {
      for (const source of [firstSource, secondSource]) {
        await mkdir(join(source, "includes"), { recursive: true });
        await writeFile(join(source, "example.php"), plugin);
        await writeFile(join(source, "includes", "feature.php"), "<?php\n");
        await writeFile(
          join(source, "composer.json"),
          JSON.stringify({ scripts: { install: "target-controlled-command" } }),
        );
      }
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: storage,
      });
      const request = (sourcePath: string) => ({
        kind: "manual-target-intake" as const,
        schemaVersion: 1 as const,
        source: { kind: "local-directory" as const, path: sourcePath },
        pluginIdentity: { kind: "wporg" as const, slug: "example-security" },
        requestedVersion: "2.4.1",
        provenance: {
          kind: "operator-provided" as const,
          acquisitionRef: { id: "manual-copy-1", digest: digest("1") },
        },
        policy: {
          kind: "target-intake-policy" as const,
          schemaVersion: 1 as const,
          id: "manual-local-v1",
          digest: digest("2"),
          limits: {
            maxEntries: 100,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10_000_000,
            maxPathBytes: 512,
            maxDepth: 16,
          },
        },
      });

      const first = await intake.intake(request(firstSource));
      const second = await intake.intake(request(secondSource));

      expect(first).toMatchObject({
        status: "ready",
        packet: {
          kind: "target-intake-packet",
          schemaVersion: 1,
          pluginIdentity: "wporg:example-security",
          version: "2.4.1",
          canonicalInstallDirectory: "example-security",
          mainPluginFile: "example.php",
          pluginBasename: "example-security/example.php",
          targetSnapshot: {
            pluginSlug: "example-security",
            version: "2.4.1",
          },
          sourceTree: { entries: 3 },
        },
      });
      expect(second).toEqual(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the first plugin header version when later source text has a version key", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "target-intake-header-body-"),
    );
    const source = join(directory, "source");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "plugin.php"),
        `<?php
/*
Plugin Name: Header Before Body
Version: 4.0.1
*/
$state = [
  'script' => <<<'JS'
const status = {
  version: 'not_configured',
};
JS,
];
`,
      );
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: join(directory, "storage"),
      });

      await expect(
        intake.intake({
          kind: "manual-target-intake",
          schemaVersion: 1,
          source: { kind: "local-directory", path: source },
          pluginIdentity: { kind: "wporg", slug: "header-before-body" },
          requestedVersion: "4.0.1",
          mainPluginFile: "plugin.php",
          provenance: {
            kind: "operator-provided",
            acquisitionRef: { id: "header-before-body", digest: digest("7") },
          },
          policy: {
            kind: "target-intake-policy",
            schemaVersion: 1,
            id: "manual-local-v1",
            digest: digest("2"),
            limits: {
              maxEntries: 100,
              maxFileBytes: 1_000_000,
              maxTotalBytes: 10_000_000,
              maxPathBytes: 512,
              maxDepth: 16,
            },
          },
        }),
      ).resolves.toMatchObject({
        status: "ready",
        packet: { version: "4.0.1", mainPluginFile: "plugin.php" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects links and version mismatches without publishing a packet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "target-intake-reject-"));
    const source = join(directory, "source");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "plugin.php"),
        "<?php\n/* Plugin Name: Plugin\nVersion: 1.0.0\n*/\n",
      );
      await symlink("plugin.php", join(source, "alias.php"));
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: join(directory, "storage"),
      });
      const rejected = await intake.intake({
        kind: "manual-target-intake",
        schemaVersion: 1,
        source: { kind: "local-directory", path: source },
        pluginIdentity: { kind: "wporg", slug: "plugin" },
        requestedVersion: "2.0.0",
        mainPluginFile: "plugin.php",
        provenance: {
          kind: "operator-provided",
          acquisitionRef: { id: "manual-copy-2", digest: digest("3") },
        },
        policy: {
          kind: "target-intake-policy",
          schemaVersion: 1,
          id: "manual-local-v1",
          digest: digest("2"),
          limits: {
            maxEntries: 100,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10_000_000,
            maxPathBytes: 512,
            maxDepth: 16,
          },
        },
      });
      expect(rejected).toMatchObject({
        status: "rejected",
        reasons: ["link-entry"],
      });
      expect(rejected).not.toHaveProperty("packet");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects hardlinks and quotas before publishing captured source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "target-intake-policy-"));
    const source = join(directory, "source");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "plugin.php"),
        "<?php\n/*\nPlugin Name: Plugin\nVersion: 1.0.0\n*/\n",
      );
      await link(join(source, "plugin.php"), join(source, "hardlink.php"));
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: join(directory, "storage"),
      });

      const disposition = await intake.intake({
        kind: "manual-target-intake",
        schemaVersion: 1,
        source: { kind: "local-directory", path: source },
        pluginIdentity: { kind: "wporg", slug: "plugin" },
        requestedVersion: "1.0.0",
        provenance: {
          kind: "operator-provided",
          acquisitionRef: { id: "manual-copy-3", digest: digest("4") },
        },
        policy: {
          kind: "target-intake-policy",
          schemaVersion: 1,
          id: "manual-local-v1",
          digest: digest("2"),
          limits: {
            maxEntries: 1,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10_000_000,
            maxPathBytes: 512,
            maxDepth: 16,
          },
        },
      });

      expect(disposition).toMatchObject({
        status: "rejected",
        reasons: ["hardlink-entry", "quota-exceeded"],
      });
      expect(disposition).not.toHaveProperty("packet");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defers ambiguous main headers and rejects an explicit version mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "target-intake-header-"));
    const source = join(directory, "source");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(
        join(source, "first.php"),
        "<?php\n/*\nPlugin Name: First\nVersion: 1.0.0\n*/\n",
      );
      await writeFile(
        join(source, "second.php"),
        "<?php\n/*\nPlugin Name: Second\nVersion: 1.0.0\n*/\n",
      );
      const intake = openLocalDirectoryTargetIntake({
        storageDirectory: join(directory, "storage"),
      });
      const base = {
        kind: "manual-target-intake" as const,
        schemaVersion: 1 as const,
        source: { kind: "local-directory" as const, path: source },
        pluginIdentity: { kind: "wporg" as const, slug: "plugin" },
        requestedVersion: "2.0.0",
        provenance: {
          kind: "operator-provided" as const,
          acquisitionRef: { id: "manual-copy-4", digest: digest("5") },
        },
        policy: {
          kind: "target-intake-policy" as const,
          schemaVersion: 1 as const,
          id: "manual-local-v1",
          digest: digest("2"),
          limits: {
            maxEntries: 100,
            maxFileBytes: 1_000_000,
            maxTotalBytes: 10_000_000,
            maxPathBytes: 512,
            maxDepth: 16,
          },
        },
      };

      await expect(intake.intake(base)).resolves.toMatchObject({
        status: "deferred",
        reasons: ["main-plugin-file-ambiguous"],
      });
      await expect(
        intake.intake({ ...base, mainPluginFile: "first.php" }),
      ).resolves.toMatchObject({
        status: "rejected",
        reasons: ["version-mismatch"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
