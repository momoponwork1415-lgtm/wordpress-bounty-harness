import { describe, expect, it } from "vitest";

import type { DockerResult } from "../../../src/profiles/wordpress/lab/lab-docker.js";
import {
  findInExplorationLab,
  isSingleSelect,
  queryExplorationLab,
  wordpressExplorationFindSchema,
  wordpressExplorationSqlSchema,
  type LookupLab,
} from "../../../src/profiles/wordpress/lab/lab-lookup.js";

describe("isSingleSelect", () => {
  it.each([
    "SELECT 1",
    "  select option_name from wp_options where option_name like 'a%'",
    "SELECT * FROM wp_posts LIMIT 5;",
    "WITH m AS (SELECT post_id FROM wp_postmeta) SELECT * FROM m",
    "SELECT 1\n  FROM wp_users\n",
  ])("accepts %j", (text) => {
    expect(isSingleSelect(text)).toBe(true);
  });

  it.each([
    "DELETE FROM wp_users",
    "UPDATE wp_options SET option_value = 1",
    "SELECT 1; DROP TABLE wp_users",
    "SELECT 1;;",
    "SELECT 1 -- comment",
    "SELECT /* x */ 1",
    "SELECT 1 # comment",
    "SELECT 1 INTO OUTFILE '/tmp/x'",
    "SELECT 1 INTO DUMPFILE '/tmp/x'",
    "SELECT * FROM wp_users FOR UPDATE",
    "SELECT * FROM wp_users LOCK IN SHARE MODE",
    "WITH m AS (VALUES (1)) VALUES (1)",
    "SELECTX 1",
    "",
    "(SELECT 1)",
  ])("refuses %j", (text) => {
    expect(isSingleSelect(text)).toBe(false);
  });
});

describe("lookup request schemas", () => {
  it("takes a marker of 10 to 15 digits without a leading 0 and nothing else", () => {
    expect(
      wordpressExplorationFindSchema.safeParse({ marker: "1234567890" })
        .success,
    ).toBe(true);
    for (const body of [
      { marker: "0123456789" },
      { marker: "123456789" },
      { marker: "1234567890123456" },
      { marker: "1234567890", table: "wp_options" },
      {},
    ])
      expect(wordpressExplorationFindSchema.safeParse(body).success).toBe(
        false,
      );
    expect(
      wordpressExplorationSqlSchema.safeParse({ select: "SELECT 1" }).success,
    ).toBe(true);
    for (const body of [
      { select: "SEL" },
      { select: "x".repeat(4001) },
      { select: "SELECT 1", limit: 5 },
    ])
      expect(wordpressExplorationSqlSchema.safeParse(body).success).toBe(false);
  });
});

type Call = { readonly args: readonly string[]; readonly timeoutMs: number };

function fakeLab(
  respond: (args: readonly string[]) => DockerResult | undefined,
): { readonly lab: LookupLab; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    lab: {
      database: "wbh-db",
      wordpress: "wbh-wp",
      readerPassword: "reader-secret",
      async docker(args, timeoutMs = 60_000) {
        calls.push({ args, timeoutMs });
        return respond(args) ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

const ok = (stdout: string): DockerResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const sqlOf = (args: readonly string[]) =>
  args[args.indexOf("--execute") + 1] ?? "";

describe("findInExplorationLab", () => {
  it("lists the columns and keys that carry the marker and the wp-content files, as the reader account", async () => {
    const { lab, calls } = fakeLab((args) => {
      if (args[2] === "grep")
        return ok(
          "/var/www/html/wp-content/uploads/cache/a.json\n/var/www/html/wp-content/debug.log\n",
        );
      const sql = sqlOf(args);
      if (sql.includes("information_schema.COLUMNS"))
        return ok(
          "wp_options\toption_name\nwp_options\toption_value\nwp_postmeta\tmeta_value\nbad name\tx\n",
        );
      if (sql.includes("information_schema.KEY_COLUMN_USAGE"))
        return ok("wp_options\toption_id\n");
      if (sql.includes("FROM `wp_options`")) return ok("3\t0\t1\n9\t1\t1\n");
      if (sql.includes("FROM `wp_postmeta`")) return ok("");
      return undefined;
    });
    const found = await findInExplorationLab(lab, "1234567890");
    expect(found).toEqual({
      status: "found",
      database: [
        { table: "wp_options", column: "option_name", keys: ["9"] },
        { table: "wp_options", column: "option_value", keys: ["3", "9"] },
      ],
      files: ["wp-content/uploads/cache/a.json", "wp-content/debug.log"],
      truncated: false,
    });
    // Every database read is the reader account's, time-bounded per statement.
    const database = calls.filter((call) => call.args[1] === "wbh-db");
    expect(database).toHaveLength(4);
    for (const call of database) {
      expect(call.args.slice(0, 5)).toEqual([
        "exec",
        "wbh-db",
        "mariadb",
        "--user=wbh_reader",
        "--password=reader-secret",
      ]);
      expect(sqlOf(call.args)).toMatch(
        /^SET STATEMENT max_statement_time=20 FOR /,
      );
      expect(call.timeoutMs).toBe(30_000);
    }
    // Names are quoted after validation; the unparseable table is skipped, the one
    // without a primary key selects NULL.
    expect(sqlOf(database[2]!.args)).toContain(
      "SELECT `option_id`, (`option_name` LIKE '%1234567890%'), (`option_value` LIKE '%1234567890%') FROM `wp_options` WHERE `option_name` LIKE '%1234567890%' OR `option_value` LIKE '%1234567890%' LIMIT 20",
    );
    expect(sqlOf(database[3]!.args)).toContain(
      "SELECT NULL, (`meta_value` LIKE '%1234567890%') FROM `wp_postmeta`",
    );
    expect(calls.at(-1)?.args).toEqual([
      "exec",
      "wbh-wp",
      "grep",
      "-rlF",
      "--",
      "1234567890",
      "/var/www/html/wp-content",
    ]);
  });

  it("reports an empty search as found with nothing, and a cut list as truncated", async () => {
    const empty = fakeLab((args) => {
      if (args[2] === "grep") return { exitCode: 1, stdout: "", stderr: "" };
      const sql = sqlOf(args);
      if (sql.includes("information_schema.COLUMNS"))
        return ok("wp_options\toption_value\n");
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return ok("");
      return ok("");
    });
    expect(await findInExplorationLab(empty.lab, "1234567890")).toEqual({
      status: "found",
      database: [],
      files: [],
      truncated: false,
    });
    const cut = fakeLab((args) => {
      if (args[2] === "grep")
        return ok(
          Array.from(
            { length: 51 },
            (_, i) => `/var/www/html/wp-content/f${i}`,
          ).join("\n") + "\n",
        );
      const sql = sqlOf(args);
      if (sql.includes("information_schema.COLUMNS"))
        return ok("wp_options\toption_value\n");
      if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return ok("");
      return ok(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 ? "NULL\t1" : "\\N\t1",
        ).join("\n") + "\n",
      );
    });
    const found = await findInExplorationLab(cut.lab, "1234567890");
    expect(found.status).toBe("found");
    if (found.status !== "found") throw new Error(found.status);
    expect(found.truncated).toBe(true);
    expect(found.files).toHaveLength(50);
    // The NULL key column yields no key values.
    expect(found.database).toEqual([
      { table: "wp_options", column: "option_value", keys: [] },
    ]);
  });

  it("fails when the database does not answer or the marker is not a marker", async () => {
    const broken = fakeLab(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "denied",
    }));
    expect(await findInExplorationLab(broken.lab, "1234567890")).toEqual({
      status: "failed",
    });
    const { lab, calls } = fakeLab(() => undefined);
    expect(await findInExplorationLab(lab, "' OR 1=1 --")).toEqual({
      status: "failed",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("queryExplorationLab", () => {
  it("runs the SELECT with a header, bounds it at 201 rows and passes 200 back", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => `${i}\tv${i}`).join(
      "\n",
    );
    const { lab, calls } = fakeLab(() => ok(`id\tvalue\n${rows}\n`));
    const result = await queryExplorationLab(lab, "SELECT id, value FROM t;");
    expect(result).toMatchObject({
      status: "rows",
      columns: ["id", "value"],
      truncated: true,
    });
    if (result.status !== "rows") throw new Error(result.status);
    expect(result.rows).toHaveLength(200);
    expect(result.rows[0]).toEqual(["0", "v0"]);
    expect(calls[0]?.args).toEqual([
      "exec",
      "wbh-db",
      "mariadb",
      "--user=wbh_reader",
      "--password=reader-secret",
      "--skip-print-query-on-error",
      "--batch",
      "--execute",
      "SET STATEMENT max_statement_time=20 FOR SELECT id, value FROM t LIMIT 201",
      "wordpress",
    ]);
    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  it("keeps the statement's own LIMIT and reads an empty result as columns only", async () => {
    const { lab, calls } = fakeLab(() => ok("a\n"));
    expect(await queryExplorationLab(lab, "SELECT a FROM t LIMIT 5")).toEqual({
      status: "rows",
      columns: ["a"],
      rows: [],
      truncated: false,
    });
    expect(sqlOf(calls[0]!.args)).toBe(
      "SET STATEMENT max_statement_time=20 FOR SELECT a FROM t LIMIT 5",
    );
  });

  it("passes the database's first error line on as sql-error, at most 300 characters", async () => {
    const { lab } = fakeLab(() => ({
      exitCode: 1,
      stdout: "",
      // The pinned MariaDB client prints a ruler and the echoed statement
      // before the ERROR line unless --skip-print-query-on-error is given.
      stderr: `--------------\nSET STATEMENT max_statement_time=20 FOR SELECT * FROM nowhere\n--------------\n\nERROR 1146 (42S02) at line 1: Table 'wordpress.nowhere' doesn't exist ${"x".repeat(400)}\nmore\n`,
    }));
    const result = await queryExplorationLab(lab, "SELECT * FROM nowhere");
    expect(result).toMatchObject({ status: "refused", reason: "sql-error" });
    if (result.status !== "refused") throw new Error(result.status);
    expect(result.message).toHaveLength(300);
    expect(result.message).toContain("Table 'wordpress.nowhere' doesn't exist");
    expect(result.message.startsWith("ERROR 1146")).toBe(true);
    // A kill for time or size comes back without a message: a fixed one stands in.
    const silent = fakeLab(() => ({ exitCode: -1, stdout: "", stderr: "" }));
    expect(await queryExplorationLab(silent.lab, "SELECT 1")).toMatchObject({
      status: "refused",
      reason: "sql-error",
      message: expect.stringContaining("64 KiB"),
    });
  });

  it("refuses anything but a single SELECT before asking the database", async () => {
    const { lab, calls } = fakeLab(() => undefined);
    expect(await queryExplorationLab(lab, "DROP TABLE t")).toEqual({
      status: "refused",
      reason: "sql-error",
      message: "not a single SELECT statement",
    });
    expect(calls).toHaveLength(0);
  });
});
