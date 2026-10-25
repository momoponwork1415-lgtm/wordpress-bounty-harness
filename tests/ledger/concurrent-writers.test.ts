import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger } from "../../src/ledger/index.js";

it("waits for another process's short ledger write transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ledger-writers-"));
  const databasePath = join(directory, "ledger.sqlite");
  const ledger = new Ledger({
    databasePath,
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      maxEntries: 10,
      maxBytes: 1024,
    }),
  });
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("READY\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 750);`,
      databasePath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await Promise.race([
      once(holder.stdout, "data"),
      once(holder, "exit").then(() => {
        throw new Error("Lock holder exited before acquiring the lock");
      }),
    ]);
    await expect(
      ledger.append({
        schemaVersion: 1,
        identity: "concurrent-write",
        campaignId: "campaign-1",
        snapshotDigest: `sha256:${"a".repeat(64)}`,
        occurredAt: "2026-10-25T00:00:00Z",
        type: "human-effort-recorded",
        action: "read",
        minutes: 1,
      }),
    ).resolves.toEqual({ status: "appended" });
    expect(ledger.read()).toHaveLength(1);
  } finally {
    holder.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
