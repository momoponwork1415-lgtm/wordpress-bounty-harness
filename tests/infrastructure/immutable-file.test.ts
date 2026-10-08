import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

  it("propagates directory creation failures instead of reporting a content conflict", async () => {
    const blocker = join(await temporaryDirectory(), "file");
    await writeFile(blocker, "preserved");

    await expect(
      persistImmutableFile(join(blocker, "record.json"), Buffer.from("record")),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(blocker, "utf8")).resolves.toBe("preserved");
  });
});
