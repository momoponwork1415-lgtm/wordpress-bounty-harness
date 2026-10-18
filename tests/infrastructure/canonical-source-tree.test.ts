import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";

import { canonicalDigest } from "../../src/infrastructure/canonical-json.js";
import {
  checkSourceAgainstManifest,
  measureCanonicalSourceTree,
  SourceTreeError,
  verifyCanonicalSourceTree,
  walkCanonicalSourceTree,
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
    await expect(walkCanonicalSourceTree(source, limits)).rejects.toMatchObject(
      {
        name: "SourceTreeError",
        code: "path-collision",
        path: "case.txt",
      },
    );
  });

  it("returns the manifest its digest names from the same walk", async () => {
    const source = await sourceDirectory();
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", "one.txt"), "first");
    await writeFile(join(source, "two.txt"), "second");

    const walked = await walkCanonicalSourceTree(source, limits);
    expect(walked.manifest.entries.map((entry) => entry.path)).toEqual([
      "nested/one.txt",
      "two.txt",
    ]);
    expect(canonicalDigest(walked.manifest)).toBe(walked.digest);
    expect(await measureCanonicalSourceTree(source, limits)).toEqual({
      digest: walked.digest,
      entries: 2,
      bytes: 11,
    });
  });

  it("checks an acquired source against its manifest and hands over verified bytes", async () => {
    const source = await sourceDirectory();
    await writeFile(join(source, "a.txt"), "alpha");
    await writeFile(join(source, "b.txt"), "beta");
    const { manifest, digest } = await walkCanonicalSourceTree(source, limits);
    const read = (path: string) => readFile(join(source, path));

    const received: string[] = [];
    await expect(
      checkSourceAgainstManifest(manifest, read, async (entry, bytes) => {
        received.push(`${entry.path}=${Buffer.from(bytes).toString()}`);
      }),
    ).resolves.toEqual({ status: "verified", digest });
    expect(received).toEqual(["a.txt=alpha", "b.txt=beta"]);

    const [a, b] = manifest.entries;
    await expect(
      checkSourceAgainstManifest({ ...manifest, entries: [b!, a!] }, read),
    ).resolves.toMatchObject({ mismatch: { reason: "manifest-order" } });
    // "B.txt" sorts first yet names the same file as "b.txt" on a case-folding disk.
    await writeFile(join(source, "B.txt"), "beta");
    await expect(
      checkSourceAgainstManifest(
        { ...manifest, entries: [{ ...b!, path: "B.txt" }, a!, b!] },
        read,
      ),
    ).resolves.toMatchObject({
      mismatch: { reason: "manifest-path-collision", path: "b.txt" },
    });
    await expect(
      checkSourceAgainstManifest(
        { ...manifest, entries: [{ ...a!, path: "missing.txt" }] },
        read,
      ),
    ).resolves.toMatchObject({
      mismatch: { reason: "manifest-file-unavailable", path: "missing.txt" },
    });
    await writeFile(join(source, "b.txt"), "changed");
    await expect(checkSourceAgainstManifest(manifest, read)).resolves.toEqual({
      status: "mismatch",
      mismatch: expect.objectContaining({
        reason: "manifest-content",
        path: "b.txt",
      }),
    });
    expect(new SourceTreeError("bounds-exceeded").message).toBe(
      "Source tree exceeds its sealed bounds",
    );
  });
});
