import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openWordPressCoreSource } from "../../../src/profiles/wordpress/acquisition/wordpress-core-source.js";

const roots: string[] = [];
const image = `wordpress@sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    version?: string;
    link?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-core-source-"));
  roots.push(root);
  const calls: (readonly string[])[] = [];
  const source = openWordPressCoreSource({
    dockerExecutablePath: "/usr/bin/docker",
    image,
    stagingDirectory: join(root, "core"),
    expectedVersion: "6.8.3",
    runDocker: async (args) => {
      calls.push(args);
      if (args[0] === "cp") {
        const destination = args[2];
        if (destination === undefined) throw new Error("missing destination");
        await mkdir(join(destination, "wp-includes"), { recursive: true });
        await writeFile(
          join(destination, "wp-includes", "version.php"),
          `<?php $wp_version = '${options.version ?? "6.8.3"}';`,
        );
        await writeFile(join(destination, "z.php"), "<?php // z");
        await writeFile(join(destination, "a.php"), "<?php // a");
        if (options.link)
          await symlink("a.php", join(destination, "linked.php"));
      }
      return {
        kind: "exited" as const,
        exitCode: 0,
        stdout: args[0] === "create" ? containerId : "",
        stderr: "",
      };
    },
  });
  return { source, calls };
}

describe("WordPress core source from the pinned Lab image", () => {
  it("creates without starting, copies once, removes the container and reuses sorted content", async () => {
    const { source, calls } = await fixture();
    const first = await source();
    const second = await source();
    expect(calls.map((args) => args[0])).toEqual(["create", "cp", "rm"]);
    expect(calls[0]).toEqual(["create", "--pull=never", image]);
    expect(calls[1]?.[1]).toBe(`${containerId}:/usr/src/wordpress`);
    expect(calls[2]).toEqual(["rm", "--force", containerId]);
    expect(first[0]).toMatchObject({
      identity: "wordpress-core",
      version: "6.8.3",
    });
    expect(first[0]?.manifest.entries.map((entry) => entry.path)).toEqual([
      "a.php",
      "wp-includes/version.php",
      "z.php",
    ]);
    expect(second[0]?.manifest).toEqual(first[0]?.manifest);
  });

  it("rejects a core version different from the declared version", async () => {
    const { source } = await fixture({ version: "6.8.2" });
    await expect(source()).rejects.toThrow("not the declared 6.8.3");
  });

  it("rejects symbolic links in an extracted source tree", async () => {
    const { source } = await fixture({ link: true });
    await expect(source()).rejects.toThrow("symbolic link");
  });
});
