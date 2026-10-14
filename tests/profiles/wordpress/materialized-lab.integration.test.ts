import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { verifyCanonicalSourceTree } from "../../../src/infrastructure/canonical-source-tree.js";
import { openMaterializedSources } from "../../../src/profiles/wordpress/acquisition/index.js";
import { openWordPressLab } from "../../../src/profiles/wordpress/lab/index.js";
import {
  openSnapshot,
  type AcquiredSource,
} from "../../../src/snapshot/index.js";

const imagesJson = process.env.WBH_REAL_LAB_IMAGES;

it.skipIf(imagesJson === undefined)(
  "activates a materialized plugin in a real runsc Lab after umask 077",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-umask-lab-"));
    const plugin = "wbh-umask-fixture";
    const files = {
      [`${plugin}.php`]:
        '<?php\n/*\nPlugin Name: WBH Umask Fixture\nVersion: 1.0.0\n*/\nrequire __DIR__ . "/includes/helper.php";\n',
      "includes/helper.php": "<?php\n// Harmless Lab fixture.\n",
    };
    const entries = Object.entries(files)
      .map(([path, content]) => ({
        path,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        size: Buffer.byteLength(content),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : 1));
    const target: AcquiredSource = {
      identity: `wporg:${plugin}`,
      version: "1.0.0",
      manifest: { kind: "canonical-file-manifest", schemaVersion: 1, entries },
      async readFile(path) {
        const content = files[path as keyof typeof files];
        if (content === undefined) throw new Error("Fixture file unavailable");
        return Buffer.from(content);
      },
    };
    const sources = openMaterializedSources({
      rootDirectory: join(root, "sources"),
    });
    const snapshots = openSnapshot({
      storageDirectory: join(root, "snapshots"),
      source: sources.acquisition({
        acquire: async () => ({ target, dependencies: [] }),
      }),
    });

    try {
      const previousUmask = process.umask(0o077);
      let snapshot;
      try {
        snapshot = await snapshots.freeze(plugin);
      } finally {
        process.umask(previousUmask);
      }
      const frozen = await sources.resolve(snapshot);
      expect(frozen.target.kind).toBe("plugin");
      const sourceDirectory = frozen.target.sourceDirectory;
      expect((await stat(sourceDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(sourceDirectory, "includes"))).mode & 0o777).toBe(
        0o700,
      );
      expect(
        (await stat(join(sourceDirectory, `${plugin}.php`))).mode & 0o777,
      ).toBe(0o400);
      // Reuse the same strict-mode digest tree, as a later campaign would.
      expect(await snapshots.freeze(plugin)).toEqual(snapshot);

      const images = JSON.parse(imagesJson!) as {
        database: string;
        wordpress: string;
        wordpressCli: string;
        browser: string;
        recorder: string;
      };
      const lab = openWordPressLab({
        dockerExecutablePath: "/usr/bin/docker",
        images,
        source: sources,
      });
      const provisioned = await lab.provision(snapshot, {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        siteTitle: "Umask fixture",
        initialPosts: [],
        customerRole: false,
      });
      try {
        expect(provisioned).toMatchObject({ status: "ready" });
      } finally {
        if (provisioned.status === "ready")
          expect(await lab.teardown(provisioned.handle)).toEqual({
            status: "removed",
          });
      }
      expect(
        (
          await verifyCanonicalSourceTree(
            sourceDirectory,
            frozen.target.sourceTree,
          )
        ).matches,
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
