import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDuplicates } from "../../../src/profiles/wordpress/wordfence-history/index.js";

const directories: string[] = [];
const NOW = new Date("2026-10-08T12:00:00Z");

type FixtureRecord = {
  id: string;
  title: string;
  slug: string;
  softwareType?: "plugin" | "theme";
  signals: readonly string[];
  ranges: Record<string, unknown>;
};

function mirror(
  records: readonly FixtureRecord[],
  lastSuccessfulAt = "2026-10-08T11:00:00Z",
) {
  const directory = mkdtempSync(join(tmpdir(), "wbh-wordfence-history-"));
  directories.push(directory);
  const databasePath = join(directory, "history.sqlite");
  const statePath = join(directory, "state.json");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vulnerabilities (id TEXT PRIMARY KEY, title TEXT NOT NULL, published TEXT, record_json TEXT NOT NULL);
    CREATE TABLE software (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, type TEXT, name TEXT, PRIMARY KEY(vulnerability_id, slug));
    CREATE TABLE signals (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(vulnerability_id, slug, kind, value));
  `);
  db.prepare("INSERT INTO metadata VALUES (?, ?)").run(
    "projection_schema",
    "wordfence-history/v1",
  );
  db.prepare("INSERT INTO metadata VALUES (?, ?)").run(
    "content_sha256",
    "fixture-digest",
  );
  db.prepare("INSERT INTO metadata VALUES (?, ?)").run(
    "record_count",
    String(records.length),
  );
  for (const record of records) {
    const json = JSON.stringify({
      id: record.id,
      software: [{ slug: record.slug, affected_versions: record.ranges }],
    });
    db.prepare("INSERT INTO vulnerabilities VALUES (?, ?, ?, ?)").run(
      record.id,
      record.title,
      "2026-09-01 00:00:00",
      json,
    );
    db.prepare("INSERT INTO software VALUES (?, ?, ?, ?)").run(
      record.id,
      record.slug,
      record.softwareType ?? "plugin",
      "Fixture",
    );
    for (const signal of record.signals) {
      db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?)").run(
        record.id,
        record.slug,
        "primitive",
        signal,
      );
    }
  }
  db.close();
  writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: "wordfence-cache/v1",
      content_sha256: "fixture-digest",
      record_count: records.length,
      last_successful_at: lastSuccessfulAt,
      stale_fallback: false,
    }),
  );
  return { databasePath, statePath };
}

const RANGE = {
  "1.0 - 2.0": {
    from_version: "1.0",
    from_inclusive: true,
    to_version: "2.0",
    to_inclusive: false,
  },
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("findDuplicates", () => {
  it("returns only matching plugin, version, and property as candidates, without deciding duplication", () => {
    const paths = mirror([
      {
        id: "match",
        title: "Synthetic SQLi",
        slug: "target",
        signals: ["sql-injection"],
        ranges: RANGE,
      },
      {
        id: "other-property",
        title: "Synthetic XSS",
        slug: "target",
        signals: ["stored-xss"],
        ranges: RANGE,
      },
      {
        id: "other-plugin",
        title: "Synthetic SQLi",
        slug: "another",
        signals: ["sql-injection"],
        ranges: RANGE,
      },
      {
        id: "same-slug-theme",
        title: "Synthetic SQLi",
        slug: "target",
        softwareType: "theme",
        signals: ["sql-injection"],
        ranges: RANGE,
      },
    ]);

    const result = findDuplicates(
      { plugin: "target", version: "1.5", property: "sqli" },
      { ...paths, now: NOW },
    );

    expect(result.status).toBe("fresh");
    expect(result.candidates).toEqual([
      {
        id: "match",
        title: "Synthetic SQLi",
        published: "2026-09-01 00:00:00",
        match: "matching",
        reasons: [],
      },
    ]);
    expect(result).not.toHaveProperty("duplicate");
  });

  it("excludes versions outside an affected range, including an exclusive endpoint", () => {
    const paths = mirror([
      {
        id: "range",
        title: "Synthetic SQLi",
        slug: "target",
        signals: ["sql-injection"],
        ranges: RANGE,
      },
    ]);

    expect(
      findDuplicates(
        { plugin: "target", version: "2.0", property: "sqli" },
        { ...paths, now: NOW },
      ).candidates,
    ).toEqual([]);
    expect(
      findDuplicates(
        { plugin: "target", version: "0.9", property: "sqli" },
        { ...paths, now: NOW },
      ).candidates,
    ).toEqual([]);
  });

  it("retains uncertain ranges and unmapped properties for human review", () => {
    const paths = mirror([
      {
        id: "uncertain",
        title: "Synthetic finding",
        slug: "target",
        signals: [],
        ranges: {},
      },
    ]);

    expect(
      findDuplicates(
        {
          plugin: "target",
          version: "1.5-beta",
          property: "sensitive-object-access",
        },
        { ...paths, now: NOW },
      ).candidates,
    ).toEqual([
      {
        id: "uncertain",
        title: "Synthetic finding",
        published: "2026-09-01 00:00:00",
        match: "needs-review",
        reasons: ["version-range-unknown", "property-signal-unknown"],
      },
    ]);
  });

  it("shows stale data while still returning reference candidates", () => {
    const paths = mirror(
      [
        {
          id: "old",
          title: "Synthetic SQLi",
          slug: "target",
          signals: ["sql-injection"],
          ranges: RANGE,
        },
      ],
      "2026-10-06T11:00:00Z",
    );

    const result = findDuplicates(
      { plugin: "target", version: "1.5", property: "sqli" },
      { ...paths, now: NOW },
    );

    expect(result.status).toBe("stale");
    expect(result.lastSuccessfulAt).toBe("2026-10-06T11:00:00Z");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["old"]);
  });

  it("shows a failed refresh as stale even if the last successful fetch is recent", () => {
    const paths = mirror([]);
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        schema_version: "wordfence-cache/v1",
        content_sha256: "fixture-digest",
        record_count: 0,
        last_successful_at: "2026-10-08T11:00:00Z",
        stale_fallback: true,
      }),
    );

    expect(
      findDuplicates(
        { plugin: "target", version: "1.5", property: "sqli" },
        { ...paths, now: NOW },
      ).status,
    ).toBe("stale");
  });

  it("reports an unavailable mirror instead of treating it as no matches", () => {
    const paths = mirror([]);
    rmSync(paths.databasePath);

    const result = findDuplicates(
      { plugin: "target", version: "1.5", property: "sqli" },
      { ...paths, now: NOW },
    );

    expect(result.status).toBe("unavailable");
    expect(result.candidates).toEqual([]);
  });

  it("rejects a state file that does not identify the opened projection", () => {
    const paths = mirror([]);
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        schema_version: "wordfence-cache/v1",
        content_sha256: "different-digest",
        record_count: 0,
        last_successful_at: "2026-10-08T11:00:00Z",
      }),
    );

    expect(
      findDuplicates(
        { plugin: "target", version: "1.5", property: "sqli" },
        { ...paths, now: NOW },
      ).status,
    ).toBe("unavailable");
  });
});
