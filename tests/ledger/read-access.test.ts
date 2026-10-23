import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import {
  Ledger,
  ledgerEventV1Schema,
  type LedgerEventInput,
} from "../../src/ledger/index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ledger-read-"));
  directories.push(directory);
  return {
    directory,
    databasePath: join(directory, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 10,
      maxBytes: 1024,
    }),
  };
}

const effort: LedgerEventInput = {
  schemaVersion: 1,
  identity: "effort-1",
  campaignId: "campaign-1",
  snapshotDigest: `sha256:${"a".repeat(64)}`,
  occurredAt: "2026-10-23T00:00:00Z",
  type: "human-effort-recorded",
  action: "read",
  minutes: 7,
};

describe("Ledger read-only access", () => {
  it("reads existing records and derived views without changing the database", async () => {
    const options = await fixture();
    const writer = new Ledger(options);
    await writer.append(effort);
    const before = await readFile(options.databasePath);

    const reader = new Ledger({ ...options, readOnly: true });
    expect(reader.read()).toEqual(writer.read());
    expect(reader.readAll()).toEqual(writer.readAll());
    expect(reader.funnel("campaign-1")).toEqual(writer.funnel("campaign-1"));
    expect(await readFile(options.databasePath)).toEqual(before);
    expect(await readdir(options.directory)).toEqual(["ledger.sqlite"]);
  });

  it("does not create a missing database or artifact directory", async () => {
    const options = await fixture();
    expect(() => new Ledger({ ...options, readOnly: true })).toThrow();
    expect(await readdir(options.directory)).toEqual([]);
  });

  it("does not initialize tables in an existing database", async () => {
    const options = await fixture();
    const database = new DatabaseSync(options.databasePath);
    database.exec("CREATE TABLE unrelated (value TEXT)");
    database.close();
    const before = await readFile(options.databasePath);

    const reader = new Ledger({ ...options, readOnly: true });
    expect(() => reader.read()).toThrow(/no such table/);
    expect(await readFile(options.databasePath)).toEqual(before);
  });

  it("rejects every append before resolving artifacts, including existing identities", async () => {
    const options = await fixture();
    const writer = new Ledger(options);
    await writer.append(effort);
    const before = await readFile(options.databasePath);
    const reader = new Ledger({ ...options, readOnly: true });
    const resolve = vi.spyOn(options.artifactStore, "resolve");

    await expect(reader.append(effort)).rejects.toThrow("read-only ledger");
    await expect(
      reader.append({
        ...effort,
        identity: "effort-2",
        artifacts: [{ kind: "note", digest: effort.snapshotDigest }],
      }),
    ).rejects.toThrow("read-only ledger");
    expect(resolve).not.toHaveBeenCalled();
    expect(reader.read()).toHaveLength(1);
    expect(await readFile(options.databasePath)).toEqual(before);
  });
});

describe("Ledger event type filters", () => {
  it("accepts every type in the event contract and filters rather than returning unrelated records", async () => {
    const ledger = new Ledger(await fixture());
    await ledger.append(effort);
    for (const option of ledgerEventV1Schema.options) {
      const type = option.shape.type.value;
      expect(ledger.read({ type })).toHaveLength(type === effort.type ? 1 : 0);
      expect(ledger.readAll({ type })).toHaveLength(
        type === effort.type ? 1 : 0,
      );
    }
  });

  it("rejects an unknown event type instead of treating it as an empty result", async () => {
    const ledger = new Ledger(await fixture());
    const type = "unknown-event" as LedgerEventInput["type"];
    expect(() => ledger.read({ type })).toThrow();
    expect(() => ledger.readAll({ type })).toThrow();
  });
});
