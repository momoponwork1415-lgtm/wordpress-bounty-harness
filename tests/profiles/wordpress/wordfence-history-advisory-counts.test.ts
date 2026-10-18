import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { advisoryHistoryDefaults } from "../../../src/profiles/wordpress/selection/index.js";
import { openWordfenceAdvisoryHistory } from "../../../src/profiles/wordpress/wordfence-history/advisory-counts.js";

const directories: string[] = [];
const CONTENT_SHA256 = "a".repeat(64);
const AS_OF = "2026-10-14T01:39:10Z";
const NOW = new Date("2026-10-15T00:00:00Z");
const DAY = 86_400_000;

type Record = {
  id: string;
  slug: string;
  published: string | null;
  informational?: boolean;
  type?: "plugin" | "theme";
  primitives?: readonly string[];
  terminals?: readonly string[];
};

/** The projection `refresh_wordfence.py` writes, with titles that must never be read. */
function mirror(
  records: readonly Record[],
  state: {
    lastSuccessfulAt?: string;
    contentSha256?: string;
    staleFallback?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "wbh-advisory-counts-"));
  directories.push(directory);
  const databasePath = join(directory, "history.sqlite");
  const statePath = join(directory, "state.json");
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE vulnerabilities (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, cwe_id INTEGER, cwe_name TEXT, published TEXT, informational INTEGER NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE software (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, type TEXT, name TEXT, PRIMARY KEY(vulnerability_id, slug));
    CREATE TABLE signals (vulnerability_id TEXT NOT NULL, slug TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(vulnerability_id, slug, kind, value));
  `);
  for (const [key, value] of [
    ["projection_schema", "wordfence-history/v1"],
    ["content_sha256", CONTENT_SHA256],
    ["record_count", String(records.length)],
  ])
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value);
  for (const record of records) {
    db.prepare(
      "INSERT INTO vulnerabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.id,
      `SECRET TITLE ${record.id}`,
      "SECRET DESCRIPTION",
      79,
      "SECRET CWE",
      record.published,
      record.informational === true ? 1 : 0,
      JSON.stringify({ id: record.id, title: "SECRET" }),
    );
    db.prepare("INSERT INTO software VALUES (?, ?, ?, ?)").run(
      record.id,
      record.slug,
      record.type ?? "plugin",
      "Fixture",
    );
    for (const value of record.primitives ?? [])
      db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?)").run(
        record.id,
        record.slug,
        "primitive",
        value,
      );
    for (const value of record.terminals ?? [])
      db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?)").run(
        record.id,
        record.slug,
        "terminal",
        value,
      );
    // A composition signal with a paying-class name must not count.
    db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?)").run(
      record.id,
      record.slug,
      "composition",
      "sql-injection",
    );
  }
  db.close();
  writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: "wordfence-cache/v1",
      content_sha256: state.contentSha256 ?? CONTENT_SHA256,
      record_count: records.length,
      last_successful_at: state.lastSuccessfulAt ?? AS_OF,
      stale_fallback: state.staleFallback ?? false,
    }),
  );
  return { databasePath, statePath };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const window = (days: number) => ({
  fromMs: Date.parse(AS_OF) - days * DAY,
  toMs: Date.parse(AS_OF),
  payingClasses: advisoryHistoryDefaults.payingClasses,
});

describe("openWordfenceAdvisoryHistory", () => {
  it("counts non-informational plugin records inside the window and the newest date, nothing else", () => {
    const paths = mirror([
      {
        id: "recent-xss",
        slug: "target",
        published: "2026-10-01 12:00:00",
        primitives: ["stored-xss"],
      },
      {
        id: "recent-sqli",
        slug: "target",
        published: "2026-06-30 00:00:00",
        primitives: ["sql-injection"],
      },
      {
        id: "recent-rce",
        slug: "target",
        published: "2026-05-01 00:00:00",
        primitives: ["arbitrary-file-upload"],
        terminals: ["remote-code-execution"],
      },
      {
        id: "recent-other",
        slug: "target",
        published: "2026-03-01 00:00:00",
        primitives: ["reflected-xss"],
      },
      { id: "no-signal", slug: "target", published: "2026-02-01 00:00:00" },
      {
        id: "too-old",
        slug: "target",
        published: "2025-10-13 00:00:00",
        primitives: ["stored-xss"],
      },
      {
        id: "informational",
        slug: "target",
        published: "2026-09-01 00:00:00",
        informational: true,
        primitives: ["stored-xss"],
      },
      {
        id: "theme",
        slug: "target",
        published: "2026-09-01 00:00:00",
        type: "theme",
        primitives: ["stored-xss"],
      },
      { id: "undated", slug: "target", published: null },
      {
        id: "other-plugin",
        slug: "another",
        published: "2026-09-01 00:00:00",
        primitives: ["stored-xss"],
      },
    ]);
    const opened = openWordfenceAdvisoryHistory(paths).open({
      now: NOW,
      maximumAgeMs: 2 * DAY,
    });
    expect(opened.status).toBe("open");
    if (opened.status !== "open") return;
    expect(opened.mirror.asOf).toBe(AS_OF);
    expect(opened.mirror.digest).toBe(`sha256:${CONTENT_SHA256}`);
    expect(opened.mirror.recordCount).toBe(10);
    expect(opened.mirror.lastRefreshFailed).toBe(false);
    const counted = opened.mirror.count("target", window(365));
    // Five dated plugin records in the window; three carry a paying class (one of
    // them twice, counted once); the composition-kind name never counts.
    expect(counted).toEqual({
      count: 5,
      payingClassCount: 3,
      latestPublished: "2026-10-01T12:00:00.000Z",
    });
    expect(JSON.stringify(counted)).not.toContain("SECRET");
    // A narrower window drops the older records; an unknown slug has none.
    expect(opened.mirror.count("target", window(30))).toEqual({
      count: 1,
      payingClassCount: 1,
      latestPublished: "2026-10-01T12:00:00.000Z",
    });
    expect(opened.mirror.count("unknown", window(365))).toEqual({
      count: 0,
      payingClassCount: 0,
    });
    // The policy's own class list replaces the default; terminal-kind outcome
    // classes match like primitive-kind technique classes.
    expect(
      opened.mirror.count("target", {
        ...window(365),
        payingClasses: ["reflected-xss"],
      }).payingClassCount,
    ).toBe(1);
    expect(
      opened.mirror.count("target", {
        ...window(365),
        payingClasses: ["remote-code-execution"],
      }).payingClassCount,
    ).toBe(1);
    opened.mirror.close();
  });

  it("reports stale and inconsistent mirrors instead of opening them", () => {
    const stale = openWordfenceAdvisoryHistory(
      mirror([], { lastSuccessfulAt: "2026-10-12T00:00:00Z" }),
    ).open({ now: NOW, maximumAgeMs: 2 * DAY });
    expect(stale).toEqual({
      status: "stale",
      lastSuccessfulAt: "2026-10-12T00:00:00Z",
      ageMs: 3 * DAY,
    });
    // A failed refresh attempt on data still inside the age limit opens, flagged.
    const flagged = openWordfenceAdvisoryHistory(
      mirror([], { staleFallback: true }),
    ).open({ now: NOW, maximumAgeMs: 2 * DAY });
    expect(flagged.status).toBe("open");
    if (flagged.status === "open")
      expect(flagged.mirror.lastRefreshFailed).toBe(true);
    // A failed refresh on data past the age limit is still stale.
    expect(
      openWordfenceAdvisoryHistory(
        mirror([], {
          lastSuccessfulAt: "2026-10-12T00:00:00Z",
          staleFallback: true,
        }),
      ).open({ now: NOW, maximumAgeMs: 2 * DAY }).status,
    ).toBe("stale");
    expect(
      openWordfenceAdvisoryHistory(
        mirror([], { lastSuccessfulAt: "2026-10-16T00:00:00Z" }),
      ).open({ now: NOW, maximumAgeMs: 2 * DAY }),
    ).toEqual({
      status: "unavailable",
      reason: "state timestamp is in the future",
    });
    // The same mirror opens under a looser policy.
    expect(
      openWordfenceAdvisoryHistory(
        mirror([], { lastSuccessfulAt: "2026-10-12T00:00:00Z" }),
      ).open({ now: NOW, maximumAgeMs: 4 * DAY }).status,
    ).toBe("open");
    expect(
      openWordfenceAdvisoryHistory(
        mirror([], { contentSha256: "b".repeat(64) }),
      ).open({ now: NOW, maximumAgeMs: 2 * DAY }),
    ).toEqual({ status: "unavailable", reason: "database and state disagree" });
    const paths = mirror([]);
    expect(
      openWordfenceAdvisoryHistory({
        databasePath: paths.databasePath,
        statePath: join(paths.statePath, "missing"),
      }).open({ now: NOW, maximumAgeMs: 2 * DAY }),
    ).toEqual({ status: "unavailable", reason: "state is unreadable" });
  });
});
