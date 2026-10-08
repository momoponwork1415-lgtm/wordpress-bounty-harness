import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { extractCampaignHistory } from "../../../src/profiles/wordpress/wordfence-history/index.js";

it("extracts only pre-cutoff target catalog data from the local mirror", () => {
  const directory = mkdtempSync(join(tmpdir(), "wbh-history-campaign-"));
  try {
    const databasePath = join(directory, "history.sqlite");
    const statePath = join(directory, "state.json");
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE vulnerabilities (id TEXT PRIMARY KEY, title TEXT NOT NULL, published TEXT, record_json TEXT NOT NULL);
      CREATE TABLE software (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, type TEXT, name TEXT, PRIMARY KEY(vulnerability_id, slug));
      CREATE TABLE signals (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(vulnerability_id, slug, kind, value));
    `);
    for (const [key, value] of [
      ["projection_schema", "wordfence-history/v1"],
      ["content_sha256", "fixture-digest"],
      ["record_count", "4"],
    ])
      db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value);
    for (const [id, published, slug] of [
      ["before", "2026-01-01 00:00:00", "target"],
      ["at-cutoff", "2026-02-01 00:00:00", "target"],
      ["after", "2026-03-01 00:00:00", "target"],
      ["other", "2026-01-01 00:00:00", "other"],
    ]) {
      db.prepare("INSERT INTO vulnerabilities VALUES (?, ?, ?, ?)").run(
        id,
        "Synthetic public title",
        published,
        JSON.stringify({
          description: "Do not transmit this advisory body",
          poc: "Do not transmit this payload",
          software: [
            {
              slug,
              affected_versions: { "1.0 - 1.4": {} },
              patched_versions: ["1.5"],
            },
          ],
        }),
      );
      db.prepare("INSERT INTO software VALUES (?, ?, ?, ?)").run(
        id,
        slug,
        "plugin",
        "Fixture",
      );
      db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?)").run(
        id,
        slug,
        "primitive",
        "sql-injection",
      );
    }
    db.close();
    writeFileSync(
      statePath,
      JSON.stringify({
        schema_version: "wordfence-cache/v1",
        content_sha256: "fixture-digest",
        record_count: 4,
        last_successful_at: "2026-02-01T01:00:00Z",
        stale_fallback: false,
      }),
    );

    const result = extractCampaignHistory("target", "2026-02-01T00:00:00Z", {
      databasePath,
      statePath,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Mirror unavailable");
    expect(result.history.records).toEqual([
      {
        id: "before",
        kind: "sql-injection",
        affectedVersions: ["1.0 - 1.4"],
        fixedVersions: ["1.5"],
        publishedAt: "2026-01-01T00:00:00.000Z",
        title: "Synthetic public title",
        changedFiles: [],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("Do not transmit");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
