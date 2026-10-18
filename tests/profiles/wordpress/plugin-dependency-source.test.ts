import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDigest } from "../../../src/infrastructure/canonical-json.js";
import {
  openWordPressOrgPluginDependencySource,
  openWordPressOrgSnapshotSource,
  requiredPluginSlugs,
  type TargetIntakePacket,
  type TargetIntakePolicy,
  type WordPressOrgTargetSource,
} from "../../../src/profiles/wordpress/acquisition/index.js";
import {
  openSnapshot,
  SourceAcquisitionError,
} from "../../../src/snapshot/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const policy: TargetIntakePolicy = {
  kind: "target-intake-policy",
  schemaVersion: 1,
  id: "dependency-test",
  digest: digest("policy"),
  limits: {
    maxEntries: 100,
    maxFileBytes: 1_000_000,
    maxTotalBytes: 4_000_000,
    maxPathBytes: 200,
    maxDepth: 8,
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-plugin-deps-"));
  roots.push(root);
  const storageDirectory = join(root, "wporg");
  const blobs = join(storageDirectory, "target-intake", "blobs");
  await mkdir(blobs, { recursive: true });
  const packet = async (
    slug: string,
    version: string,
    mainFile: string,
  ): Promise<TargetIntakePacket> => {
    const bytes = Buffer.from(mainFile);
    const fileDigest = digest(bytes);
    await writeFile(join(blobs, fileDigest.slice(7)), bytes);
    const manifest = {
      kind: "canonical-file-manifest" as const,
      schemaVersion: 1 as const,
      entries: [
        { path: `${slug}.php`, digest: fileDigest, size: bytes.length },
      ],
    };
    return {
      pluginIdentity: `wporg:${slug}`,
      version,
      canonicalInstallDirectory: slug,
      mainPluginFile: `${slug}.php`,
      sourceTree: { digest: canonicalDigest(manifest), manifest, entries: 1 },
    } as TargetIntakePacket;
  };
  return { storageDirectory, packet };
}

describe("WordPress plugin dependency source", () => {
  it("reads only the main PHP header in WordPress' first 8 KiB", () => {
    expect(
      requiredPluginSlugs(
        Buffer.from(
          "<?php\n/*\nPlugin Name: Addon\nRequires Plugins: elementor, woocommerce */\n",
        ),
      ),
    ).toEqual(["elementor", "woocommerce"]);
    expect(
      requiredPluginSlugs(
        Buffer.from(`${" ".repeat(8192)}Requires Plugins: elementor`),
      ),
    ).toEqual([]);
    expect(() =>
      requiredPluginSlugs(Buffer.from("/* Requires Plugins: ../other */")),
    ).toThrow(SourceAcquisitionError);
  });

  it("pins transitive and explicit plugins before the target and reuses versions", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: elementor */",
    );
    const elementor = await packet(
      "elementor",
      "3.0.0",
      "<?php\n/* Plugin Name: Elementor\nRequires Plugins: widgets */",
    );
    const widgets = await packet(
      "widgets",
      "1.0.0",
      "<?php\n/* Plugin Name: Widgets */",
    );
    const optional = await packet(
      "optional",
      "2.0.0",
      "<?php\n/* Plugin Name: Optional */",
    );
    let latestElementor = "3.0.0";
    const observed: string[] = [];
    const targetSource: WordPressOrgTargetSource = {
      async observe({ slug }) {
        observed.push(slug);
        const sourceDigest = digest(slug);
        return {
          status: "observed",
          observation: {
            stableVersion: slug === "elementor" ? latestElementor : "1.0.0",
          },
          observationRef: {
            kind: "wordpress-org-target-observation-ref",
            schemaVersion: 1,
            id: `observation-${slug}`,
            digest: sourceDigest,
          },
        } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
      },
      async acquire({ observationRef, requestedVersion }) {
        const slug = observationRef.id.slice("observation-".length);
        const acquired =
          slug === "elementor"
            ? elementor
            : slug === "widgets"
              ? widgets
              : optional;
        expect(requestedVersion).toBe(acquired.version);
        return {
          status: "ready",
          intake: { packet: acquired },
        } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
      },
    };
    const acquire = openWordPressOrgPluginDependencySource({
      targetSource,
      storageDirectory,
      policy,
    });
    const first = await acquire(
      target,
      { optional: "2.0.0" },
      [],
      "stable-observed",
    );
    expect(first.map(({ identity }) => identity)).toEqual([
      "wporg:widgets",
      "wporg:elementor",
      "wporg:optional",
    ]);
    expect(observed).toEqual(["elementor", "widgets", "optional"]);
    latestElementor = "4.0.0";
    const second = await acquire(
      target,
      { optional: "2.0.0" },
      [],
      "stable-observed",
    );
    expect(second.map(({ version }) => version)).toEqual([
      "1.0.0",
      "3.0.0",
      "2.0.0",
    ]);
    expect(observed).toHaveLength(3);
    const pinsetDirectory = join(storageDirectory, "plugin-dependency-pins");
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(pinsetDirectory),
    );
    const saved = JSON.parse(
      await readFile(join(pinsetDirectory, files[0]!), "utf8"),
    ) as {
      dependencies: {
        slug: string;
        declaredBy: string[];
        explicitlyPinned: boolean;
      }[];
    };
    expect(saved.dependencies).toMatchObject([
      { slug: "widgets", declaredBy: ["elementor"], explicitlyPinned: false },
      { slug: "elementor", declaredBy: ["addon"], explicitlyPinned: false },
      { slug: "optional", declaredBy: [], explicitlyPinned: true },
    ]);
  });

  it("resolves an undeclared current dependency to stable once and seals the observed source", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon */",
    );
    const elementor = await packet(
      "elementor",
      "3.0.0",
      "<?php\n/* Plugin Name: Elementor */",
    );
    let stableVersion = "3.0.0";
    let observations = 0;
    const targetSource: WordPressOrgTargetSource = {
      async observe({ slug }) {
        expect(slug).toBe("elementor");
        observations++;
        return {
          status: "observed",
          observation: { stableVersion },
          observationRef: {
            kind: "wordpress-org-target-observation-ref",
            schemaVersion: 1,
            id: "observation-elementor",
            digest: digest("elementor"),
          },
        } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
      },
      async acquire({ requestedVersion }) {
        expect(requestedVersion).toBe("3.0.0");
        return {
          status: "ready",
          intake: { packet: elementor },
        } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
      },
    };
    const acquire = openWordPressOrgPluginDependencySource({
      targetSource,
      storageDirectory,
      policy,
    });
    const first = await acquire(target, {}, ["elementor"], "stable-observed");
    expect(
      first.map(({ identity, version, manifest }) => ({
        identity,
        version,
        digest: canonicalDigest(manifest),
      })),
    ).toEqual([
      {
        identity: "wporg:elementor",
        version: "3.0.0",
        digest: elementor.sourceTree.digest,
      },
    ]);
    stableVersion = "4.0.0";
    const replay = await acquire(target, {}, ["elementor"], "stable-observed");
    expect(replay[0]?.version).toBe("3.0.0");
    expect(observations).toBe(1);
    const [file] = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(storageDirectory, "plugin-dependency-pins")),
    );
    const saved = JSON.parse(
      await readFile(
        join(storageDirectory, "plugin-dependency-pins", file!),
        "utf8",
      ),
    ) as {
      explicitSlugs: string[];
      versionPolicy: string;
      dependencies: { declaredBy: string[]; explicitlyPinned: boolean }[];
    };
    expect(saved).toMatchObject({
      explicitSlugs: ["elementor"],
      versionPolicy: "stable-observed",
      dependencies: [{ declaredBy: [], explicitlyPinned: false }],
    });
  });

  it("defers when a declared required plugin is unavailable", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: elementor */",
    );
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: {
        async observe() {
          return {
            status: "failed",
            operation: "observe",
            reason: "not-found",
            pluginIdentity: "wporg:elementor",
          };
        },
        async acquire() {
          throw new Error("not reached");
        },
      },
    });
    await expect(
      acquire(target, {}, [], "stable-observed"),
    ).rejects.toMatchObject({
      kind: "http-response",
      diagnostic: { reason: "required-plugin-observation" },
    });
  });

  it("includes acquired plugin dependencies in the sealed Target Snapshot", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: elementor */",
    );
    const elementor = await packet(
      "elementor",
      "3.0.0",
      "<?php\n/* Plugin Name: Elementor */",
    );
    const observationRef = {
      kind: "wordpress-org-target-observation-ref" as const,
      schemaVersion: 1 as const,
      id: "observation-elementor",
      digest: digest("elementor"),
    };
    const targetSource: WordPressOrgTargetSource = {
      async observe() {
        return {
          status: "observed",
          observation: { stableVersion: "3.0.0" },
          observationRef,
        } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
      },
      async acquire({ observationRef: ref }) {
        return {
          status: "ready",
          intake: {
            packet: ref.id === "observation-addon" ? target : elementor,
          },
        } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
      },
    };
    const snapshot = openSnapshot({
      storageDirectory: join(storageDirectory, "snapshots"),
      source: openWordPressOrgSnapshotSource({
        targetSource,
        storageDirectory,
        pluginDependencies: openWordPressOrgPluginDependencySource({
          targetSource,
          storageDirectory,
          policy,
        }),
      }),
    });
    const sealed = await snapshot.freeze({
      kind: "wordpress-org-target-acquire",
      schemaVersion: 1,
      observationRef: { ...observationRef, id: "observation-addon" },
      requestedVersion: "1.0.0",
      policy,
      dependencyVersionPolicy: "stable-observed",
    });
    expect(sealed.target.identity).toBe("wporg:addon");
    expect(sealed.dependencies).toEqual([
      {
        identity: "wporg:elementor",
        version: "3.0.0",
        sourceDigest: elementor.sourceTree.digest,
      },
    ]);
    expect(await snapshot.verify(sealed.digest)).toBe(true);
  });

  it("requires explicit versions for historical/manual dependency chains", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: elementor */",
    );
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: {
        async observe() {
          throw new Error("No metadata request without an explicit version");
        },
        async acquire() {
          throw new Error("No source request without an explicit version");
        },
      },
    });
    await expect(acquire(target, {}, [], "pinned-only")).rejects.toMatchObject({
      kind: "deferred",
      diagnostic: { reason: "unpinned-required-plugin", slug: "elementor" },
    });
    await expect(
      acquire(target, {}, ["elementor"], "pinned-only"),
    ).rejects.toMatchObject({
      kind: "deferred",
      diagnostic: { reason: "unpinned-required-plugin", slug: "elementor" },
    });
  });
});
