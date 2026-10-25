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
  it("reads declared dependencies from an imported target outside the ZIP store", async () => {
    const { packet, storageDirectory } = await fixture();
    const mainFile =
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: elementor */";
    const target = await packet("addon", "2.0.16", mainFile);
    const elementor = await packet(
      "elementor",
      "4.2.0",
      "<?php\n/* Plugin Name: Elementor */",
    );
    const source = {
      identity: target.pluginIdentity,
      version: target.version,
      manifest: target.sourceTree.manifest,
      async readFile(path: string) {
        expect(path).toBe(target.mainPluginFile);
        return Buffer.from(mainFile);
      },
    };
    await rm(
      join(
        storageDirectory,
        "target-intake",
        "blobs",
        target.sourceTree.manifest.entries[0]!.digest.slice(7),
      ),
    );
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: {
        async observe({ slug }) {
          expect(slug).toBe("elementor");
          return {
            status: "observed",
            observation: { stableVersion: "4.2.0" },
            observationRef: {
              kind: "wordpress-org-target-observation-ref",
              schemaVersion: 1,
              id: "observation-elementor",
              digest: digest("elementor"),
            },
          } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
        },
        async acquire() {
          return {
            status: "ready",
            intake: { packet: elementor },
          } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
        },
      },
    });
    expect(
      await acquire(target, { elementor: "4.2.0" }, [], "pinned-only", source),
    ).toMatchObject([{ identity: "wporg:elementor", version: "4.2.0" }]);
    await expect(
      acquire(target, { elementor: "4.2.0" }, [], "pinned-only", {
        ...source,
        version: "wrong",
      }),
    ).rejects.toThrow(SourceAcquisitionError);
  });

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

  it("maps the WC version headers to woocommerce without duplicating Requires Plugins", () => {
    const wc = (lines: string) =>
      Buffer.from(`<?php\n/*\nPlugin Name: Addon\n${lines}\n*/\n`);
    expect(requiredPluginSlugs(wc("WC requires at least: 8.0"))).toEqual([
      "woocommerce",
    ]);
    expect(requiredPluginSlugs(wc("WC tested up to: 9.4"))).toEqual([
      "woocommerce",
    ]);
    expect(
      requiredPluginSlugs(
        wc(" * WC requires at least: 8.0\n * WC tested up to: 9.4"),
      ),
    ).toEqual(["woocommerce"]);
    expect(
      requiredPluginSlugs(
        wc("Requires Plugins: woocommerce\nWC requires at least: 8.0"),
      ),
    ).toEqual(["woocommerce"]);
    expect(
      requiredPluginSlugs(
        wc("Requires Plugins: elementor\nWC requires at least: 8.0"),
      ),
    ).toEqual(["elementor", "woocommerce"]);
    expect(requiredPluginSlugs(wc("Requires Plugins: elementor"))).toEqual([
      "elementor",
    ]);
    expect(requiredPluginSlugs(wc("Requires at least: 6.0"))).toEqual([]);
    expect(requiredPluginSlugs(wc("WC requires at least:"))).toEqual([]);
    expect(
      requiredPluginSlugs(
        Buffer.from(`${" ".repeat(8192)}WC requires at least: 8.0`),
      ),
    ).toEqual([]);
  });

  it("pins woocommerce once from the WC header and never makes it depend on itself", async () => {
    const { packet, storageDirectory } = await fixture();
    const target = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nWC requires at least: 8.0 */",
    );
    const woocommerce = await packet(
      "woocommerce",
      "9.4.0",
      "<?php\n/* Plugin Name: WooCommerce\nWC requires at least: 9.0 */",
    );
    const observed: string[] = [];
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: {
        async observe({ slug }) {
          observed.push(slug);
          return {
            status: "observed",
            observation: { stableVersion: "9.4.0" },
            observationRef: {
              kind: "wordpress-org-target-observation-ref",
              schemaVersion: 1,
              id: `observation-${slug}`,
              digest: digest(slug),
            },
          } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
        },
        async acquire() {
          return {
            status: "ready",
            intake: { packet: woocommerce },
          } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
        },
      },
    });
    // The header and the policy list both name woocommerce: one dependency.
    expect(
      await acquire(target, {}, ["woocommerce"], "stable-observed"),
    ).toMatchObject([{ identity: "wporg:woocommerce", version: "9.4.0" }]);
    expect(observed).toEqual(["woocommerce"]);
    // Header alone, no policy entry.
    expect(await acquire(target, {}, [], "stable-observed")).toMatchObject([
      { identity: "wporg:woocommerce", version: "9.4.0" },
    ]);
  });

  it("caps the header slugs after adding the WC-header woocommerce", () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => `dep-${i}`).join(", ");
    expect(
      requiredPluginSlugs(Buffer.from(`/* Requires Plugins: ${sixteen} */`)),
    ).toHaveLength(16);
    expect(() =>
      requiredPluginSlugs(
        Buffer.from(
          `/*\nRequires Plugins: ${sixteen}\nWC requires at least: 8.0\n*/`,
        ),
      ),
    ).toThrow(SourceAcquisitionError);
  });

  it("treats a WC-header woocommerce as optional under pinned-only and records the skip", async () => {
    const { packet, storageDirectory } = await fixture();
    // TranslatePress 3.3.1 style: no Requires Plugins, only the WC header.
    const target = await packet(
      "translatepress-multilingual",
      "3.3.1",
      "<?php\n/*\nPlugin Name: TranslatePress\nWC requires at least: 2.5.0\nWC tested up to: 10.2.2\n*/",
    );
    const woocommerce = await packet(
      "woocommerce",
      "9.4.0",
      "<?php\n/* Plugin Name: WooCommerce\nWC requires at least: 9.0 */",
    );
    const observed: string[] = [];
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: {
        async observe({ slug }) {
          observed.push(slug);
          return {
            status: "observed",
            observation: { stableVersion: "9.9.9" },
            observationRef: {
              kind: "wordpress-org-target-observation-ref",
              schemaVersion: 1,
              id: `observation-${slug}`,
              digest: digest(slug),
            },
          } as Awaited<ReturnType<WordPressOrgTargetSource["observe"]>>;
        },
        async acquire() {
          return {
            status: "ready",
            intake: { packet: woocommerce },
          } as Awaited<ReturnType<WordPressOrgTargetSource["acquire"]>>;
        },
      },
    });
    expect(await acquire(target, {}, [], "pinned-only")).toEqual([]);
    expect(observed).toEqual([]);
    const pinsetDirectory = join(storageDirectory, "plugin-dependency-pins");
    const readPinsets = async () => {
      const fs = await import("node:fs/promises");
      return Promise.all(
        (await fs.readdir(pinsetDirectory)).map(
          async (file) =>
            JSON.parse(await readFile(join(pinsetDirectory, file), "utf8")) as {
              explicitPins: Record<string, string>;
              dependencies: { slug: string }[];
              skippedDependencies?: unknown;
            },
        ),
      );
    };
    expect(await readPinsets()).toMatchObject([
      {
        explicitPins: {},
        dependencies: [],
        skippedDependencies: [
          {
            slug: "woocommerce",
            declaredBy: ["translatepress-multilingual"],
            reason: "header-derived-unpinned",
          },
        ],
      },
    ]);
    // A saved pinset is reused on the repeat freeze.
    expect(await acquire(target, {}, [], "pinned-only")).toEqual([]);

    // With a pin the same header resolves woocommerce at the pinned version.
    expect(
      await acquire(target, { woocommerce: "9.4.0" }, [], "pinned-only"),
    ).toMatchObject([{ identity: "wporg:woocommerce", version: "9.4.0" }]);
    const pinned = (await readPinsets()).find(
      ({ explicitPins }) => explicitPins.woocommerce === "9.4.0",
    );
    expect(pinned).toMatchObject({ dependencies: [{ slug: "woocommerce" }] });
    expect(pinned).not.toHaveProperty("skippedDependencies");

    // stable-observed keeps the header rule for production targets.
    expect(await acquire(target, {}, [], "stable-observed")).toMatchObject([
      { identity: "wporg:woocommerce" },
    ]);
  });

  it("keeps woocommerce strict under pinned-only when Requires Plugins or the policy names it", async () => {
    const { packet, storageDirectory } = await fixture();
    const unreachable = {
      async observe(): Promise<never> {
        throw new Error("No metadata request without an explicit version");
      },
      async acquire(): Promise<never> {
        throw new Error("No source request without an explicit version");
      },
    };
    const acquire = openWordPressOrgPluginDependencySource({
      storageDirectory,
      policy,
      targetSource: unreachable,
    });
    const required = await packet(
      "addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Addon\nRequires Plugins: woocommerce\nWC requires at least: 8.0 */",
    );
    await expect(
      acquire(required, {}, [], "pinned-only"),
    ).rejects.toMatchObject({
      kind: "deferred",
      diagnostic: { reason: "unpinned-required-plugin", slug: "woocommerce" },
    });
    const headerOnly = await packet(
      "other-addon",
      "1.0.0",
      "<?php\n/* Plugin Name: Other\nWC tested up to: 9.4 */",
    );
    await expect(
      acquire(headerOnly, {}, ["woocommerce"], "pinned-only"),
    ).rejects.toMatchObject({
      kind: "deferred",
      diagnostic: { reason: "unpinned-required-plugin", slug: "woocommerce" },
    });
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
    expect(await snapshot.load(sealed.digest)).toMatchObject({
      status: "loaded",
    });
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
