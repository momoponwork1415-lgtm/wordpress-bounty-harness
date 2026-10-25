import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderAttachmentStore,
  readPathsFromCommands,
  recordReadPaths,
} from "../../src/discovery/index.js";

const MOUNTS = [
  "/workspace/wordpress",
  "/workspace/php",
  "/workspace/dependencies/elementor",
  "/workspace/dependencies/php-runtime",
];
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("readPathsFromCommands", () => {
  it("keeps file paths under the source mount, relative and sorted", () => {
    expect(
      readPathsFromCommands(
        [
          { text: "sed -n '1,80p' includes/b.php", cwd: "/workspace/main" },
          {
            text: "nl -ba /workspace/main/a.php | head",
            cwd: "file:///workspace/main/includes",
          },
          { text: "cat ./x.php", cwd: "/workspace/main/includes" },
          {
            text: "true",
            parsed: [{ type: "read", path: "parsed.php" }],
          },
          { text: 'rg -n "foo" "assets/app.js"' },
        ],
        [],
      ),
    ).toEqual([
      "a.php",
      "assets/app.js",
      "includes/b.php",
      "includes/x.php",
      "parsed.php",
    ]);
  });

  it("records the pinned core, PHP and plugin dependency source mounts", () => {
    expect(
      readPathsFromCommands(
        [
          {
            text: "cat /workspace/wordpress/wp-load.php /workspace/php/main/php.c",
          },
          {
            text: "cat includes/base.php",
            cwd: "/workspace/dependencies/elementor",
          },
          { text: "cat /workspace/dependencies/php-runtime/main.php" },
        ],
        MOUNTS,
      ),
    ).toEqual([
      "@dependencies/elementor/includes/base.php",
      "@dependencies/php-runtime/main.php",
      "@php/main/php.c",
      "@wordpress/wp-load.php",
    ]);
  });

  it("drops paths outside supplied mounts, flags, globs and non-file tokens", () => {
    expect(
      readPathsFromCommands(
        [
          { text: "cat /workspace/other/wp-load.php ../main2/a.php" },
          { text: "cat /etc/passwd.txt /tmp/notes.md" },
          { text: "rg --include=*.php -n foo . includes/ 1,20p $FILE.php" },
          { text: "grep -rn foo a.php:12", cwd: "file://%zz" },
          { text: "find . -name '*.php'" },
          // A mount this run did not supply is not a source tree of the run.
          { text: "cat /workspace/wordpress/wp-load.php" },
        ],
        MOUNTS.filter((mount) => mount !== "/workspace/wordpress"),
      ),
    ).toEqual([]);
  });
});

describe("recordReadPaths", () => {
  it("stores read paths from an archived rollout and returns its digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-paths-"));
    directories.push(root);
    const attachments = new ProviderAttachmentStore(root);
    const rollout = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          cwd: "/workspace/main",
          command: ["/bin/bash", "-lc", "sed -n '1,5p' child.php"],
        },
      },
    });
    const diagnostic = await attachments.put(
      "diagnostic",
      Buffer.from(`${rollout}\nnot json`),
    );
    const files: Record<string, string | Uint8Array>[] = [];
    const evidence = {
      async putFiles(entry: Record<string, string | Uint8Array>) {
        files.push(entry);
        return `sha256:${"f".repeat(64)}`;
      },
    };
    expect(
      await recordReadPaths(attachments, evidence, diagnostic.digest, []),
    ).toBe(`sha256:${"f".repeat(64)}`);
    expect(files).toEqual([{ "read-paths.json": '["child.php"]' }]);
    expect(await recordReadPaths(attachments, evidence, undefined, [])).toBe(
      undefined,
    );
    expect(
      await recordReadPaths(
        attachments,
        evidence,
        `sha256:${"0".repeat(64)}`,
        [],
      ),
    ).toBe(undefined);
  });

  it("stores read paths from a Claude transcript's Read, Grep and Glob calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-paths-"));
    directories.push(root);
    const attachments = new ProviderAttachmentStore(root);
    const toolUse = (name: string, input: Record<string, unknown>) => ({
      type: "tool_use",
      id: `toolu_${name}`,
      name,
      input,
    });
    const transcript = [
      { type: "user", message: { content: "Look at the AJAX handlers" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading." },
            toolUse("Read", { file_path: "/workspace/main/includes/ajax.php" }),
            toolUse("Grep", {
              pattern: "wp_ajax_",
              path: "/workspace/main/admin/menu.php",
            }),
            toolUse("Glob", { pattern: "**/*.php", path: "/workspace/main" }),
            toolUse("Read", { file_path: "/workspace/wordpress/wp-load.php" }),
            toolUse("Agent", { prompt: "Check a.php", subagent_type: "x" }),
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_Read" }],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const diagnostic = await attachments.put(
      "diagnostic",
      Buffer.from(transcript),
    );
    const files: Record<string, string | Uint8Array>[] = [];
    const evidence = {
      async putFiles(entry: Record<string, string | Uint8Array>) {
        files.push(entry);
        return `sha256:${"f".repeat(64)}`;
      },
    };
    await recordReadPaths(attachments, evidence, diagnostic.digest, [
      "/workspace/wordpress",
    ]);
    expect(files).toEqual([
      {
        "read-paths.json": JSON.stringify([
          "@wordpress/wp-load.php",
          "admin/menu.php",
          "includes/ajax.php",
        ]),
      },
    ]);
  });
});
