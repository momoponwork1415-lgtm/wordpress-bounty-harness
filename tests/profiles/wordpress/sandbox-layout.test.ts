import { describe, expect, it } from "vitest";

import {
  WORDPRESS_DEPENDENCY_SOURCE_ROOTS,
  WORDPRESS_SANDBOX_LAYOUT,
  wordpressDependencyPluginMountPath,
} from "../../../src/profiles/wordpress/sandbox-layout.js";

describe("WordPress sandbox layout", () => {
  it("declares the mount paths the agent sees once", () => {
    // These strings reach prompts, Lab input and recorded source paths;
    // changing one is a prompt-visible change, not a refactor.
    expect(WORDPRESS_SANDBOX_LAYOUT).toEqual({
      target: "/workspace/main",
      research: "/workspace/research",
      wordpressCore: "/workspace/wordpress",
      php: "/workspace/php",
      dependencies: "/workspace/dependencies",
    });
    expect(wordpressDependencyPluginMountPath("elementor")).toBe(
      "/workspace/dependencies/elementor",
    );
    expect(WORDPRESS_DEPENDENCY_SOURCE_ROOTS).toEqual([
      {
        path: "/workspace/wordpress",
        label: "@wordpress",
        relative: "../wordpress/",
      },
      { path: "/workspace/php", label: "@php", relative: "../php/" },
      {
        path: "/workspace/dependencies",
        label: "@dependencies",
        relative: "../dependencies/",
      },
    ]);
  });
});
