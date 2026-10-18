import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import { measureCanonicalSourceTree } from "../../src/infrastructure/canonical-source-tree.js";
import {
  acquiredSourceFromIntakePacket,
  openLocalDirectoryTargetIntake,
  openMaterializedSources,
  openPhpRuntimeSource,
  openWordPressCoreSource,
} from "../../src/profiles/wordpress/acquisition/index.js";
import { openSnapshot } from "../../src/snapshot/index.js";

/**
 * Invariant 5 compares Target Snapshot digests, so every tree accepted today
 * must digest to the same value after any change to the walk. These values
 * were computed on main at 67020f8, before the walks were unified.
 */
const PINS = {
  tree: "sha256:cbe306dfaceea6f7a3299944b7732ecff8abb6b0dd1dce4cca79681962ad55c5",
  core: "sha256:6f8aa58b08b5ff582119dc24cb9dc83529cec5eebd6600ee100071a2ceeece53",
  php: "sha256:f218140071ab75a9fb180d03f9f18961f5a7ff2ae1e792e09dda2c17e703c47e",
  intakeTree:
    "sha256:cbe306dfaceea6f7a3299944b7732ecff8abb6b0dd1dce4cca79681962ad55c5",
  intakeTarget:
    "sha256:6997ee50711a53fc16ce484f78f27c36b0c53098bd34c2fb144a30a124b00b09",
  snapshot:
    "sha256:a7f3a0f78620b9dd7f33c3603b7e69a20fdb2b2e5e2330a0335d5d3f9d1cfd6e",
};

const FIXTURE: Readonly<Record<string, string>> = {
  "plugin.php": "<?php\n/*\nPlugin Name: Pin Fixture\nVersion: 1.2.3\n*/\n",
  "a-b.php": "<?php // dash\n",
  "a.php": "<?php // plain\n",
  "readme.txt": "== Pin ==\n",
  "empty.txt": "",
  "assets/z.css": "body{}\n",
  "includes/a.php": "<?php // a\n",
  "includes/sub/deep.txt": "deep\n",
};

const image = `wordpress@sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
const policy = {
  kind: "target-intake-policy" as const,
  schemaVersion: 1 as const,
  id: "manual-local-v1",
  digest: `sha256:${"2".repeat(64)}`,
  limits: {
    maxEntries: 100,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 10_000_000,
    maxPathBytes: 512,
    maxDepth: 16,
  },
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function writeFixture(directory: string): Promise<void> {
  for (const [path, content] of Object.entries(FIXTURE)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

const exited = (stdout: string) => ({
  kind: "exited" as const,
  exitCode: 0,
  stdout,
  stderr: "",
});

describe("source tree digest pins", () => {
  it("digests the same fixture to the pinned values through every entry path", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-digest-pins-"));
    roots.push(root);
    const fixture = join(root, "fixture");
    await writeFixture(fixture);

    const tree = await measureCanonicalSourceTree(fixture, {
      maxEntries: 100,
      maxBytes: 1_000_000,
    });

    const coreSource = openWordPressCoreSource({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      stagingDirectory: join(root, "core"),
      expectedVersion: "6.8.3",
      runDocker: async (args) => {
        if (args[0] === "cp") {
          const destination = args[2]!;
          await cp(fixture, destination, { recursive: true });
          await mkdir(join(destination, "wp-includes"), { recursive: true });
          await writeFile(
            join(destination, "wp-includes", "version.php"),
            "<?php $wp_version = '6.8.3';",
          );
        }
        return exited(args[0] === "create" ? containerId : "");
      },
    });
    const [core] = await coreSource();

    const phpRoot = join(root, "php-8.3.35");
    await cp(fixture, phpRoot, { recursive: true });
    await mkdir(join(phpRoot, "main"), { recursive: true });
    await writeFile(
      join(phpRoot, "main", "php_version.h"),
      '#define PHP_VERSION "8.3.35"\n',
    );
    const archive = join(root, "php.tar.xz");
    const packed = spawnSync(
      "/usr/bin/tar",
      ["-cJf", archive, "-C", root, "php-8.3.35"],
      { encoding: "utf8" },
    );
    if (packed.status !== 0) throw new Error(packed.stderr);
    const checksum = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const phpSource = openPhpRuntimeSource({
      dockerExecutablePath: "/usr/bin/docker",
      image,
      stagingDirectory: join(root, "php"),
      runDocker: async (args) => {
        if (args[0] === "cp") await copyFile(archive, args[2]!);
        return exited(
          args[0] === "create"
            ? containerId
            : args[0] === "image"
              ? JSON.stringify(["PHP_VERSION=8.3.35", `PHP_SHA256=${checksum}`])
              : "",
        );
      },
    });
    const [php] = await phpSource();

    const intakeStorage = join(root, "intake");
    const disposition = await openLocalDirectoryTargetIntake({
      storageDirectory: intakeStorage,
    }).intake({
      kind: "manual-target-intake",
      schemaVersion: 1,
      source: { kind: "local-directory", path: fixture },
      pluginIdentity: { kind: "wporg", slug: "pin-fixture" },
      requestedVersion: "1.2.3",
      mainPluginFile: "plugin.php",
      provenance: {
        kind: "operator-provided",
        acquisitionRef: { id: "pin", digest: `sha256:${"6".repeat(64)}` },
      },
      policy,
    });
    if (disposition.status !== "ready") throw new Error(disposition.status);
    const packet = disposition.packet;

    const sources = openMaterializedSources({
      rootDirectory: join(root, "sources"),
    });
    const snapshot = await openSnapshot({
      storageDirectory: join(root, "snapshots"),
      source: sources.acquisition({
        acquire: async () => ({
          target: acquiredSourceFromIntakePacket(packet, intakeStorage),
          dependencies: [core!, php!],
        }),
      }),
    }).freeze(undefined);

    const observed = {
      tree: tree.digest,
      core: canonicalDigest(core!.manifest),
      php: canonicalDigest(php!.manifest),
      intakeTree: packet.sourceTree.digest,
      intakeTarget: packet.targetSnapshot.digest,
      snapshot: snapshot.digest,
    };
    expect(tree).toMatchObject({ entries: 8, bytes: 114 });
    expect(packet.sourceTree.digest).toBe(tree.digest);
    expect(snapshot.target.sourceDigest).toBe(tree.digest);
    expect(snapshot.dependencies.map((item) => item.sourceDigest)).toEqual([
      observed.core,
      observed.php,
    ]);
    expect(observed).toEqual(PINS);
  });
});
