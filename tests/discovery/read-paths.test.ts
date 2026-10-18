import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderAttachmentStore,
  readPathsFromCommands,
  recordReadPaths,
} from "../../src/discovery/index.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("readPathsFromCommands", () => {
  it("keeps file paths under the source mount, relative and sorted", () => {
    expect(
      readPathsFromCommands([
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
      ]),
    ).toEqual([
      "a.php",
      "assets/app.js",
      "includes/b.php",
      "includes/x.php",
      "parsed.php",
    ]);
  });

  it("drops paths outside the mount, flags, globs and non-file tokens", () => {
    expect(
      readPathsFromCommands([
        { text: "cat /workspace/wordpress/wp-load.php ../main2/a.php" },
        { text: "cat /etc/passwd.txt /tmp/notes.md" },
        { text: "rg --include=*.php -n foo . includes/ 1,20p $FILE.php" },
        { text: "grep -rn foo a.php:12", cwd: "file://%zz" },
        { text: "find . -name '*.php'" },
      ]),
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
      await recordReadPaths(attachments, evidence, diagnostic.digest),
    ).toBe(`sha256:${"f".repeat(64)}`);
    expect(files).toEqual([{ "read-paths.json": '["child.php"]' }]);
    expect(await recordReadPaths(attachments, evidence, undefined)).toBe(
      undefined,
    );
    expect(
      await recordReadPaths(attachments, evidence, `sha256:${"0".repeat(64)}`),
    ).toBe(undefined);
  });
});
