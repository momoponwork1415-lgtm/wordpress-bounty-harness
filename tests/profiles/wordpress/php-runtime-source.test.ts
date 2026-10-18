import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openPhpRuntimeSource } from "../../../src/profiles/wordpress/acquisition/php-runtime-source.js";

const roots: string[] = [];
const image = `wordpress@sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    readonly reportedVersion?: string;
    readonly sourceVersion?: string;
    readonly badChecksum?: boolean;
    readonly missingArchive?: boolean;
    readonly link?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wbh-php-source-"));
  roots.push(root);
  const sourceRoot = join(root, "php-8.3.35");
  await mkdir(join(sourceRoot, "main"), { recursive: true });
  await writeFile(
    join(sourceRoot, "main", "php_version.h"),
    `#define PHP_VERSION "${options.sourceVersion ?? "8.3.35"}"\n`,
  );
  await writeFile(join(sourceRoot, "a.c"), "/* source */\n");
  if (options.link) await symlink("a.c", join(sourceRoot, "linked.c"));
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
  const calls: (readonly string[])[] = [];
  const source = openPhpRuntimeSource({
    dockerExecutablePath: "/usr/bin/docker",
    image,
    stagingDirectory: join(root, "frozen"),
    runDocker: async (args) => {
      calls.push(args);
      if (args[0] === "cp" && options.missingArchive)
        return {
          kind: "exited" as const,
          exitCode: 1,
          stdout: "",
          stderr: "archive missing",
        };
      if (args[0] === "cp") {
        const destination = args[2];
        if (destination === undefined) throw new Error("missing destination");
        await copyFile(archive, destination);
      }
      return {
        kind: "exited" as const,
        exitCode: 0,
        stdout:
          args[0] === "create"
            ? containerId
            : args[0] === "image"
              ? JSON.stringify([
                  `PHP_VERSION=${options.reportedVersion ?? "8.3.35"}`,
                  `PHP_SHA256=${options.badChecksum ? "0".repeat(64) : checksum}`,
                ])
              : "",
        stderr: "",
      };
    },
  });
  return { source, calls };
}

describe("PHP runtime source from the pinned WordPress Lab image", () => {
  it("checks the archive and source versions, extracts without starting, and reuses the frozen tree", async () => {
    const { source, calls } = await fixture();
    const first = await source();
    const second = await source();
    expect(calls.map((args) => args[0])).toEqual([
      "image",
      "create",
      "cp",
      "rm",
      "image",
    ]);
    expect(calls[1]).toEqual(["create", "--pull=never", image]);
    expect(calls[2]?.[1]).toBe(`${containerId}:/usr/src/php.tar.xz`);
    expect(first[0]).toMatchObject({
      identity: "php-runtime-source",
      version: "8.3.35",
    });
    expect(first[0]?.manifest.entries.map((entry) => entry.path)).toEqual([
      "a.c",
      "main/php_version.h",
    ]);
    expect(second[0]?.manifest).toEqual(first[0]?.manifest);
  });

  it("rejects a different archive checksum", async () => {
    const { source, calls } = await fixture({ badChecksum: true });
    await expect(source()).rejects.toMatchObject({
      kind: "source-mismatch",
      diagnostic: { reason: "php-archive-checksum-mismatch" },
    });
    expect(calls.map((args) => args[0])).toEqual([
      "image",
      "create",
      "cp",
      "rm",
    ]);
  });

  it("records a missing archive as a source mismatch", async () => {
    const { source, calls } = await fixture({ missingArchive: true });
    await expect(source()).rejects.toMatchObject({
      kind: "source-mismatch",
      diagnostic: { reason: "php-archive-unavailable" },
    });
    expect(calls.map((args) => args[0])).toEqual([
      "image",
      "create",
      "cp",
      "rm",
    ]);
  });

  it("rejects PHP source that does not match the runtime metadata", async () => {
    const { source } = await fixture({ sourceVersion: "8.3.34" });
    await expect(source()).rejects.toMatchObject({
      kind: "source-mismatch",
      diagnostic: { reason: "php-source-version-mismatch" },
    });
  });

  it("rejects links in the archive before extraction", async () => {
    const { source } = await fixture({ link: true });
    await expect(source()).rejects.toMatchObject({
      kind: "invalid-archive",
      diagnostic: { reason: "php-archive-special-entry" },
    });
  });
});
