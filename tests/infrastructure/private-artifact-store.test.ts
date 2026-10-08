import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateArtifactStore,
  PrivateArtifactStoreError,
} from "../../src/infrastructure/private-artifact-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PrivateArtifactStore", () => {
  it("atomically stores and resolves a bounded private artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-store-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 4,
      maxBytes: 1024,
    });
    const staging = await store.stage();
    await writeFile(join(staging.contentDirectory, "artifact.txt"), "proof", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });

    const committed = await store.commit("artifact-one", staging);

    expect(committed).toMatchObject({
      status: "stored",
      artifact: {
        artifactId: "artifact-one",
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        entries: 1,
        bytes: 5,
      },
    });
    if (committed.status === "conflict") {
      throw new Error("Unexpected private artifact conflict");
    }
    await expect(store.resolve(committed.artifact)).resolves.toMatchObject({
      status: "resolved",
      artifact: committed.artifact,
      contentDirectory: expect.any(String),
    });
    await expect(
      store.readFile(committed.artifact, "artifact.txt", 16),
    ).resolves.toMatchObject({
      status: "resolved",
      artifact: committed.artifact,
      bytes: Buffer.from("proof"),
    });
    await expect(
      store.readFile(committed.artifact, "../manifest.json", 16),
    ).resolves.toEqual({ status: "unsafe" });
  });

  it("reports abandoned staging without deleting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-orphan-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 4,
      maxBytes: 1024,
    });
    const staging = await store.stage();
    await writeFile(join(staging.contentDirectory, "partial.txt"), "partial");

    await expect(store.inspectOrphans()).resolves.toEqual([
      { stagingId: expect.stringMatching(/^\.active-artifact-/) },
    ]);
    await expect(lstat(staging.rootDirectory)).resolves.toMatchObject({
      size: expect.any(Number),
    });
  });

  it("reports a missing artifact without creating storage", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "private-artifact-missing-"),
    );
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 4,
      maxBytes: 1024,
    });

    await expect(
      store.resolve({
        artifactId: "missing-artifact",
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        entries: 1,
        bytes: 5,
      }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("detects content changed after promotion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-tamper-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 4,
      maxBytes: 1024,
    });
    const staging = await store.stage();
    await writeFile(join(staging.contentDirectory, "artifact.txt"), "proof");
    const committed = await store.commit("artifact-tamper", staging);
    if (committed.status === "conflict") {
      throw new Error("Unexpected private artifact conflict");
    }
    const resolved = await store.resolve(committed.artifact);
    if (resolved.status !== "resolved") {
      throw new Error("Expected a resolved private artifact fixture");
    }
    await writeFile(join(resolved.contentDirectory, "artifact.txt"), "changed");

    await expect(store.resolve(committed.artifact)).resolves.toEqual({
      status: "integrity-mismatch",
    });
  });

  it("rejects an artifact that exceeds its byte bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-limit-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 1,
      maxBytes: 4,
    });
    const staging = await store.stage();
    await writeFile(join(staging.contentDirectory, "large.txt"), "12345");

    await expect(store.commit("artifact-large", staging)).rejects.toMatchObject(
      {
        name: PrivateArtifactStoreError.name,
        code: "size-limit-exceeded",
      },
    );
  });

  it("rejects path-like artifact identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-path-"));
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 1,
      maxBytes: 1024,
    });
    const staging = await store.stage();
    await writeFile(join(staging.contentDirectory, "artifact.txt"), "proof");

    await expect(store.commit("../escape", staging)).rejects.toMatchObject({
      name: PrivateArtifactStoreError.name,
      code: "invalid-artifact-id",
    });
  });

  it.each(["symbolic", "hard"] as const)(
    "rejects a %s-linked artifact entry",
    async (linkKind) => {
      const directory = await mkdtemp(join(tmpdir(), "private-artifact-link-"));
      directories.push(directory);
      const store = new PrivateArtifactStore({
        rootDirectory: join(directory, "artifacts"),
        maxEntries: 2,
        maxBytes: 1024,
      });
      const outside = join(directory, "outside.txt");
      await writeFile(outside, "outside");
      const staging = await store.stage();
      const linkedPath = join(staging.contentDirectory, "linked.txt");
      if (linkKind === "symbolic") {
        await symlink(outside, linkedPath);
      } else {
        await link(outside, linkedPath);
      }

      await expect(
        store.commit(`artifact-${linkKind}`, staging),
      ).rejects.toMatchObject({
        name: PrivateArtifactStoreError.name,
        code: "unsafe-artifact",
      });
    },
  );

  it("reports a conflict without replacing the stored artifact", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "private-artifact-conflict-"),
    );
    directories.push(directory);
    const store = new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 2,
      maxBytes: 1024,
    });
    const first = await store.stage();
    await writeFile(join(first.contentDirectory, "artifact.txt"), "first");
    const committed = await store.commit("artifact-conflict", first);
    if (committed.status === "conflict") {
      throw new Error("Unexpected first private artifact conflict");
    }
    const second = await store.stage();
    await writeFile(join(second.contentDirectory, "artifact.txt"), "second");

    await expect(store.commit("artifact-conflict", second)).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.resolve(committed.artifact)).resolves.toMatchObject({
      status: "resolved",
      artifact: committed.artifact,
    });
  });

  it("rejects a symbolic-link store root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "private-artifact-root-"));
    directories.push(directory);
    const actualRoot = join(directory, "actual");
    const linkedRoot = join(directory, "linked");
    await mkdir(actualRoot);
    await symlink(actualRoot, linkedRoot);
    const store = new PrivateArtifactStore({
      rootDirectory: linkedRoot,
      maxEntries: 1,
      maxBytes: 1024,
    });

    await expect(store.stage()).rejects.toMatchObject({
      name: PrivateArtifactStoreError.name,
      code: "unsafe-root",
    });
    await expect(
      store.resolve({
        artifactId: "artifact-one",
        digest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        entries: 1,
        bytes: 5,
      }),
    ).resolves.toEqual({ status: "unsafe" });
  });
});
