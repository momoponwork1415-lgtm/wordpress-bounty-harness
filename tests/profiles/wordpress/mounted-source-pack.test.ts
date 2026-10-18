import { describe, expect, it } from "vitest";

import { mountedWordPressSourcePack } from "../../../src/profiles/wordpress/acquisition/mounted-source-pack.js";
import type { WordPressSourceResolver } from "../../../src/profiles/wordpress/lab/index.js";

const tree = { digest: `sha256:${"a".repeat(64)}`, entries: 1, bytes: 1 };
const sources: Awaited<ReturnType<WordPressSourceResolver["resolve"]>> = {
  target: {
    kind: "plugin",
    pluginSlug: "target",
    sourceDirectory: "/frozen/target",
    sourceTree: tree,
  },
  dependencies: [
    {
      kind: "wordpress-core",
      version: "6.8.3",
      sourceDirectory: "/frozen/core",
      sourceTree: tree,
    },
    {
      kind: "php-source",
      version: "8.3.35",
      sourceDirectory: "/frozen/php",
      sourceTree: tree,
    },
    {
      kind: "plugin",
      pluginSlug: "elementor",
      sourceDirectory: "/frozen/elementor",
      sourceTree: tree,
    },
  ],
};

describe("mountedWordPressSourcePack", () => {
  it("maps one frozen source set to the shared discovery and verifier mounts", () => {
    expect(mountedWordPressSourcePack(sources)).toEqual({
      target: { path: "/workspace/main", directory: "/frozen/target", tree },
      core: { path: "/workspace/wordpress", directory: "/frozen/core", tree },
      dependencies: [
        { path: "/workspace/php", directory: "/frozen/php", tree },
        {
          path: "/workspace/dependencies/elementor",
          directory: "/frozen/elementor",
          tree,
        },
      ],
    });
  });

  it("requires runtime sources for new discovery while preserving old Snapshot mounts", () => {
    const historical = {
      ...sources,
      dependencies: sources.dependencies.filter(
        (source) => source.kind !== "php-source",
      ),
    };
    expect(mountedWordPressSourcePack(historical).dependencies).toEqual([
      {
        path: "/workspace/dependencies/elementor",
        directory: "/frozen/elementor",
        tree,
      },
    ]);
    expect(() =>
      mountedWordPressSourcePack(historical, { requireRuntimeSources: true }),
    ).toThrow();
  });

  it("rejects duplicate plugin mount paths", () => {
    expect(() =>
      mountedWordPressSourcePack({
        ...sources,
        dependencies: [...sources.dependencies, sources.dependencies[3]!],
      }),
    ).toThrow();
  });

  it("rejects a dependency slug outside the sandbox mount contract", () => {
    expect(() =>
      mountedWordPressSourcePack({
        ...sources,
        dependencies: [
          ...sources.dependencies,
          {
            kind: "plugin",
            pluginSlug: `a${"b".repeat(64)}`,
            sourceDirectory: "/frozen/oversize",
            sourceTree: tree,
          },
        ],
      }),
    ).toThrow();
  });
});
