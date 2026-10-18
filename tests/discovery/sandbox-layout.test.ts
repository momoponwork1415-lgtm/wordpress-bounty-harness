import { describe, expect, it } from "vitest";

import {
  SANDBOX_RESEARCH_MOUNT_PATH,
  SANDBOX_SOURCE_MOUNT_PATH,
  dependencyMountLabel,
  dependencyMountPathSchema,
  dependencyMountPathsAreDisjoint,
  dependencyMountPathsOf,
  mountedSourcePath,
  mountedSourcePathPattern,
  sourceRelativePath,
} from "../../src/discovery/sandbox-layout.js";

const mounts = ["/workspace/wordpress", "/workspace/dependencies/elementor"];

describe("sandbox layout", () => {
  it("fixes the target and notes mounts as the sandbox's own contract", () => {
    expect(SANDBOX_SOURCE_MOUNT_PATH).toBe("/workspace/main");
    expect(SANDBOX_RESEARCH_MOUNT_PATH).toBe("/workspace/research");
  });

  it("admits dependency mounts of one or two segments beside the fixed mounts", () => {
    for (const path of [
      "/workspace/wordpress",
      "/workspace/php",
      "/workspace/dependencies/elementor",
    ])
      expect(dependencyMountPathSchema.safeParse(path).success).toBe(true);
    for (const path of [
      "/workspace/main",
      "/workspace/research",
      "/workspace/main/core",
      "/workspace",
      "/opt/codex-support",
      "/workspace/a/b/c",
      "/workspace/Wordpress",
      "/workspace/wordpress/",
      "workspace/wordpress",
    ])
      expect(dependencyMountPathSchema.safeParse(path).success).toBe(false);
  });

  it("requires distinct mounts that do not nest", () => {
    expect(dependencyMountPathsAreDisjoint(mounts)).toBe(true);
    expect(dependencyMountPathsAreDisjoint([])).toBe(true);
    expect(dependencyMountPathsAreDisjoint([...mounts, mounts[0]!])).toBe(
      false,
    );
    expect(
      dependencyMountPathsAreDisjoint([
        "/workspace/dependencies",
        "/workspace/dependencies/elementor",
      ]),
    ).toBe(false);
    expect(dependencyMountPathsAreDisjoint(["/workspace/main/x"])).toBe(false);
  });

  it("lists a run's mounts with the primary dependency first", () => {
    expect(
      dependencyMountPathsOf({
        dependencySource: { path: "/workspace/wordpress" },
        dependencySources: [{ path: "/workspace/php" }],
      }),
    ).toEqual(["/workspace/wordpress", "/workspace/php"]);
    expect(dependencyMountPathsOf({})).toEqual([]);
  });

  it("records files by mount label and keeps target files relative", () => {
    expect(dependencyMountLabel("/workspace/wordpress")).toBe("@wordpress");
    expect(dependencyMountLabel("/workspace/dependencies/elementor")).toBe(
      "@dependencies/elementor",
    );
    expect(sourceRelativePath(mounts, "/workspace/main/includes/a.php")).toBe(
      "includes/a.php",
    );
    expect(sourceRelativePath(mounts, "/workspace/wordpress/wp-load.php")).toBe(
      "@wordpress/wp-load.php",
    );
    expect(
      sourceRelativePath(mounts, "/workspace/dependencies/elementor/x.php"),
    ).toBe("@dependencies/elementor/x.php");
    expect(sourceRelativePath(mounts, "/workspace/php/main.c")).toBe(undefined);
    expect(sourceRelativePath(mounts, "/workspace/main")).toBe(undefined);
    expect(mountedSourcePath(mounts, "/workspace/wordpress/wp-load.php")).toBe(
      "/workspace/wordpress/wp-load.php",
    );
    expect(mountedSourcePath(mounts, "/workspace/research/notes.md")).toBe(
      undefined,
    );
  });

  it("finds mounted file paths inside command text", () => {
    const text =
      "sed -n '1,5p' /workspace/main/a.php; cat /workspace/wordpress/b.php /workspace/php/c.c";
    expect(
      [...text.matchAll(mountedSourcePathPattern(mounts))].map((m) => m[0]),
    ).toEqual(["/workspace/main/a.php", "/workspace/wordpress/b.php"]);
  });
});
