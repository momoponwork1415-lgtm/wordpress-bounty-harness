import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { PrivateArtifactStore } from "../../src/infrastructure/private-artifact-store.js";
import { Ledger, type LedgerEventInput } from "../../src/ledger/index.js";
import { wordPressLegacyHistorySchema } from "../../src/profiles/wordpress/selection/legacy-history.js";

const script = fileURLToPath(
  new URL("../../scripts/export-legacy-slugs.mjs", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const event = (
  identity: string,
  snapshot: string,
  rest: Record<string, unknown>,
): LedgerEventInput =>
  ({
    schemaVersion: 1,
    identity,
    campaignId: "old-campaign",
    snapshotDigest: `sha256:${snapshot.repeat(64)}`,
    occurredAt: "2026-09-01T00:00:00Z",
    ...rest,
  }) as LedgerEventInput;

test("folds the old DB and old ledgers into started / ambiguous and counts what remains per floor", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-export-"));
  roots.push(root);
  // A research DB of unknown shape: the queries are given on the command line.
  const dbPath = join(root, "research.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE runs (plugin TEXT, started INTEGER); INSERT INTO runs VALUES ('db-started', 1), ('db-maybe', 0), ('both', 0);",
  );
  db.close();
  // An old Harness state: one explored slug, one selected but never started.
  const state = join(root, "old-state");
  await mkdir(state);
  const ledger = new Ledger({
    databasePath: join(state, "ledger.sqlite"),
    artifactStore: new PrivateArtifactStore({
      rootDirectory: join(state, "private-evidence"),
      maxEntries: 4,
      maxBytes: 1024,
    }),
  });
  for (const item of [
    event("s1", "a", {
      type: "target-selected",
      selectionId: "wporg:both@1.0.0",
    }),
    event("s2", "b", {
      type: "target-selected",
      selectionId: "wporg:idle@1.0.0",
    }),
    event("r1", "a", {
      type: "discovery-run-started",
      runId: "run-1",
      labId: "lab-1",
      history: { mode: "none" },
      configuration: { promptVariant: "v1", assignmentUnit: "target" },
    }),
  ])
    expect((await ledger.append(item)).status).toBe("appended");
  const reportPath = join(root, "selection-report.json");
  const eligible = (slug: string, activeInstallations: number) => ({
    slug,
    selection: { activeInstallations },
  });
  await writeFile(
    reportPath,
    JSON.stringify({
      inspections: [
        eligible("db-started", 200_000),
        eligible("db-maybe", 60_000),
        eligible("fresh-big", 150_000),
        eligible("fresh-mid", 40_000),
        eligible("idle", 35_000),
        { slug: "ineligible" },
      ],
    }),
  );

  const result = spawnSync(
    process.execPath,
    [
      script,
      "--db",
      dbPath,
      "--db-started-sql",
      "SELECT plugin AS slug FROM runs WHERE started = 1",
      "--db-ambiguous-sql",
      "SELECT plugin AS slug FROM runs WHERE started = 0",
      "--state",
      state,
      "--report",
      reportPath,
      "--reconsider",
      "db-maybe",
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  const exported = wordPressLegacyHistorySchema.parse(
    JSON.parse(result.stdout),
  );
  expect(exported).toMatchObject({
    started: ["both", "db-started"],
    // `both` started in an old ledger, so it is no longer ambiguous.
    ambiguous: ["db-maybe"],
    reconsider: ["db-maybe"],
    sources: [dbPath, state],
  });
  expect(result.stderr).toContain("started 2  ambiguous 1  reconsider 1");
  expect(result.stderr).toContain(
    "floor 100000  enumerable 2  legacy 1  remaining 1",
  );
  expect(result.stderr).toContain(
    "floor 50000  enumerable 3  legacy 1  remaining 2",
  );
  expect(result.stderr).toContain(
    "floor 30000  enumerable 5  legacy 1  remaining 4",
  );

  const relative = spawnSync(process.execPath, [script, "--state", "rel"], {
    encoding: "utf8",
  });
  expect(relative.status).toBe(2);
});
