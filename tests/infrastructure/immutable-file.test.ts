import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const writeGate = vi.hoisted(() => ({
  signal: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      const [path, data, options] = args;
      const { signal, release } = writeGate;
      if (!signal || !release || !(data instanceof Uint8Array))
        return original.writeFile(...args);
      Object.assign(writeGate, { signal: undefined, release: undefined });
      await original.writeFile(path, data.subarray(0, 1), options);
      signal();
      await release;
      await original.appendFile(path, data.subarray(1));
    },
  };
});

import { persistImmutableFile } from "../../src/infrastructure/immutable-file.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "immutable-file-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("persistImmutableFile", () => {
  it("stores exact bytes and accepts an identical artifact again", async () => {
    const path = join(await temporaryDirectory(), "nested", "record.json");
    const bytes = Buffer.from('{"label":"保存記録"}\n', "utf8");

    await expect(persistImmutableFile(path, bytes)).resolves.toBe("stored");
    await expect(persistImmutableFile(path, bytes)).resolves.toBe("stored");
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it("leaves the existing bytes intact when a different artifact conflicts", async () => {
    const path = join(await temporaryDirectory(), "record.json");
    await writeFile(path, "original");

    await expect(
      persistImmutableFile(path, Buffer.from("replacement")),
    ).resolves.toBe("conflict");
    await expect(readFile(path, "utf8")).resolves.toBe("original");
  });

  it("keeps the final path absent until all bytes are ready", async () => {
    const path = join(await temporaryDirectory(), "record.json");
    let signal!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeGate.signal = signal;
    writeGate.release = blocked;

    const pending = persistImmutableFile(path, Buffer.from("complete record"));
    await started;
    try {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
    }
    await expect(pending).resolves.toBe("stored");
    await expect(readFile(path, "utf8")).resolves.toBe("complete record");
  });

  it("never replaces the winner of simultaneous publications", async () => {
    const path = join(await temporaryDirectory(), "record.json");
    const different = await Promise.all([
      persistImmutableFile(path, Buffer.from("first")),
      persistImmutableFile(path, Buffer.from("second")),
    ]);
    expect(different.sort()).toEqual(["conflict", "stored"]);
    const winner = await readFile(path);
    expect(["first", "second"]).toContain(winner.toString());
    await expect(
      Promise.all([
        persistImmutableFile(path, winner),
        persistImmutableFile(path, winner),
      ]),
    ).resolves.toEqual(["stored", "stored"]);
    await expect(readFile(path)).resolves.toEqual(winner);
  });

  it("propagates directory creation failures instead of reporting a content conflict", async () => {
    const blocker = join(await temporaryDirectory(), "file");
    await writeFile(blocker, "preserved");

    await expect(
      persistImmutableFile(join(blocker, "record.json"), Buffer.from("record")),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(blocker, "utf8")).resolves.toBe("preserved");
  });
});
