import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openSnapshot, type AcquiredSource } from "../../src/snapshot/index.js";

const bytes = Buffer.from("fixed source");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function source(read: () => Promise<Uint8Array>): AcquiredSource {
  return {
    identity: "example:target",
    version: "1.0",
    manifest: {
      kind: "canonical-file-manifest",
      schemaVersion: 1,
      entries: [{ path: "source.txt", digest, size: bytes.length }],
    },
    readFile: read,
  };
}

describe("snapshot", () => {
  it("freezes target and dependency source through a profile contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snapshot-"));
    try {
      const snapshot = openSnapshot({
        storageDirectory: directory,
        source: {
          async acquire() {
            return {
              target: source(async () => bytes),
              dependencies: [source(async () => bytes)],
            };
          },
        },
      });
      const frozen = await snapshot.freeze(undefined);
      expect(frozen.target.sourceDigest).toMatch(/^sha256:/);
      expect(frozen.dependencies).toHaveLength(1);
      expect(await snapshot.verify(frozen.digest)).toBe(true);
      const path = join(directory, `${frozen.digest.slice(7)}.json`);
      await writeFile(path, `${await readFile(path, "utf8")} `);
      expect(await snapshot.verify(frozen.digest)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects source bytes that differ from the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snapshot-"));
    try {
      const snapshot = openSnapshot({
        storageDirectory: directory,
        source: {
          async acquire() {
            return {
              target: source(async () => Buffer.from("changed")),
              dependencies: [],
            };
          },
        },
      });
      await expect(snapshot.freeze(undefined)).rejects.toThrow(
        "Source differs",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
