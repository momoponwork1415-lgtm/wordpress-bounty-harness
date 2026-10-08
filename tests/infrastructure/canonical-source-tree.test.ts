import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  measureCanonicalSourceTree,
  verifyCanonicalSourceTree,
} from "../../src/infrastructure/canonical-source-tree.js";

const directories: string[] = [];
const limits = { maxEntries: 4, maxBytes: 1024 };

async function sourceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "canonical-source-tree-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("canonical source tree", () => {
  it("measures a stable tree and detects changed content", async () => {
    const source = await sourceDirectory();
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", "one.txt"), "first");
    await writeFile(join(source, "two.txt"), "second");

    const expected = await measureCanonicalSourceTree(source, limits);
    expect(expected).toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      entries: 2,
      bytes: 11,
    });
    await expect(verifyCanonicalSourceTree(source, expected)).resolves.toEqual({
      matches: true,
      observedDigest: expected.digest,
    });

    await writeFile(join(source, "two.txt"), "change");
    await expect(
      verifyCanonicalSourceTree(source, expected),
    ).resolves.toMatchObject({
      matches: false,
    });
  });

  it("rejects links and trees beyond the sealed bounds", async () => {
    const source = await sourceDirectory();
    const outside = join(await sourceDirectory(), "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(source, "symbolic.txt"));
    await expect(measureCanonicalSourceTree(source, limits)).rejects.toThrow(
      "symbolic link",
    );

    await rm(join(source, "symbolic.txt"));
    await link(outside, join(source, "hard.txt"));
    await expect(measureCanonicalSourceTree(source, limits)).rejects.toThrow(
      "linked entry",
    );

    await rm(join(source, "hard.txt"));
    await writeFile(join(source, "large.txt"), "12345");
    await expect(
      measureCanonicalSourceTree(source, { maxEntries: 1, maxBytes: 4 }),
    ).rejects.toThrow("sealed bounds");
  });

  it("rejects paths that collide after case normalization", async () => {
    const source = await sourceDirectory();
    await writeFile(join(source, "Case.txt"), "one");
    await writeFile(join(source, "case.txt"), "two");

    await expect(measureCanonicalSourceTree(source, limits)).rejects.toThrow(
      "path collision",
    );
  });
});
