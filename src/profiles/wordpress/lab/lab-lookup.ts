import { z } from "zod";

import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
  type WordPressLabSession,
} from "./lab-session.js";
import { parseBatchRows } from "./state-capture.js";

/**
 * The exploration Lab's storage lookups (ADR 0049): `POST /find` names a
 * marker the agent planted and the Lab reports where the site stored it;
 * `POST /sql` runs one SELECT as the Lab's read-only account. Both read the
 * Lab's own database container and the WordPress container; neither judges
 * anything. The read-only account is the real guard; the shape checks here
 * only keep the request to what the account can answer.
 */

/** Same shape as `dialogMarker`: 10 to 15 digits, no leading 0, so it needs no escaping. */
export const wordpressExplorationFindSchema = z.strictObject({
  marker: z.string().regex(/^[1-9][0-9]{9,14}$/),
});
export type WordPressExplorationFindRequest = z.infer<
  typeof wordpressExplorationFindSchema
>;

export const wordpressExplorationSqlSchema = z.strictObject({
  select: z.string().min(6).max(4000),
});
export type WordPressExplorationSqlRequest = z.infer<
  typeof wordpressExplorationSqlSchema
>;

/**
 * Whether `text` is one SELECT statement in shape: optional leading
 * whitespace, `SELECT` or `WITH … SELECT`, no `;` except one trailing, no
 * comment start (`--`, `/*`, `#`), and none of `INTO OUTFILE`,
 * `INTO DUMPFILE`, `FOR UPDATE`, `LOCK IN SHARE MODE`.
 */
export function isSingleSelect(text: string): boolean {
  const trimmed = text.replace(/\s+$/, "");
  const statement = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (statement.includes(";")) return false;
  if (/--|\/\*|#/.test(statement)) return false;
  if (!/^\s*(select|with)\b/i.test(statement)) return false;
  if (/^\s*with\b/i.test(statement) && !/\bselect\b/i.test(statement))
    return false;
  if (
    /\binto\s+(outfile|dumpfile)\b/i.test(statement) ||
    /\bfor\s+update\b/i.test(statement) ||
    /\block\s+in\s+share\s+mode\b/i.test(statement)
  )
    return false;
  return true;
}

export type WordPressExplorationFindResult =
  | {
      readonly status: "found";
      /** One entry per column whose rows carry the marker, with up to 20 key values per table. */
      readonly database: readonly {
        readonly table: string;
        readonly column: string;
        readonly keys: readonly string[];
      }[];
      /** Paths under `wp-content` that contain the marker, relative to the site root, at most 50. */
      readonly files: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "failed" };

export type WordPressExplorationQueryResult =
  | {
      readonly status: "rows";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: "sql-error";
      readonly message: string;
    }
  | { readonly status: "unavailable" };

/** What the lookups need from a Lab: its two containers, the reader secret and the runner. */
export type LookupLab = Pick<
  WordPressLabSession,
  "database" | "wordpress" | "readerPassword" | "docker"
>;

const TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 64 * 1024;
const STATEMENT_SECONDS = 20;
const MAX_TABLES = 200;
const KEYS_PER_TABLE = 20;
const MAX_FILES = 50;
const MAX_ROWS = 200;
const MAX_MESSAGE = 300;
const SITE_ROOT = "/var/www/html";
const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;
const TEXT_TYPES = [
  "varchar",
  "char",
  "text",
  "tinytext",
  "mediumtext",
  "longtext",
  "blob",
  "tinyblob",
  "mediumblob",
  "longblob",
  "varbinary",
  "json",
];

const quote = (name: string) => `\`${name}\``;
const limitStatement = (select: string) =>
  `SET STATEMENT max_statement_time=${STATEMENT_SECONDS} FOR ${select}`;

async function readerQuery(
  lab: LookupLab,
  sql: string,
  options: { readonly header: boolean },
) {
  return lab.docker(
    [
      "exec",
      lab.database,
      "mariadb",
      `--user=${READ_ONLY_DATABASE_USER}`,
      `--password=${lab.readerPassword}`,
      ...(options.header ? [] : ["--skip-column-names"]),
      "--batch",
      "--execute",
      limitStatement(sql),
      DATABASE_NAME,
    ],
    TIMEOUT_MS,
    OUTPUT_LIMIT,
  );
}

/** The marker's storage places: text-like columns whose rows carry it, and files under `wp-content`. */
export async function findInExplorationLab(
  lab: LookupLab,
  marker: string,
): Promise<WordPressExplorationFindResult> {
  if (!wordpressExplorationFindSchema.shape.marker.safeParse(marker).success)
    return { status: "failed" };
  try {
    const columns = await readerQuery(
      lab,
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${DATABASE_NAME}' AND DATA_TYPE IN (${TEXT_TYPES.map((type) => `'${type}'`).join(",")}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      { header: false },
    );
    if (columns.exitCode !== 0) return { status: "failed" };
    const keys = await readerQuery(
      lab,
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='${DATABASE_NAME}' AND CONSTRAINT_NAME='PRIMARY' AND ORDINAL_POSITION=1`,
      { header: false },
    );
    if (keys.exitCode !== 0) return { status: "failed" };
    const primaryKeys = new Map<string, string>();
    for (const [table, column] of parseBatchRows(keys.stdout))
      if (
        table !== undefined &&
        column !== undefined &&
        IDENTIFIER.test(table) &&
        IDENTIFIER.test(column) &&
        !primaryKeys.has(table)
      )
        primaryKeys.set(table, column);
    const byTable = new Map<string, string[]>();
    for (const [table, column] of parseBatchRows(columns.stdout)) {
      if (
        table === undefined ||
        column === undefined ||
        !IDENTIFIER.test(table) ||
        !IDENTIFIER.test(column)
      )
        continue;
      const list = byTable.get(table) ?? [];
      list.push(column);
      byTable.set(table, list);
    }
    let truncated = byTable.size > MAX_TABLES;
    const database: {
      readonly table: string;
      readonly column: string;
      readonly keys: readonly string[];
    }[] = [];
    for (const [table, names] of [...byTable.entries()].slice(0, MAX_TABLES)) {
      const like = (column: string) => `${quote(column)} LIKE '%${marker}%'`;
      const key = primaryKeys.get(table);
      const result = await readerQuery(
        lab,
        `SELECT ${key === undefined ? "NULL" : quote(key)}, ${names.map((column) => `(${like(column)})`).join(", ")} FROM ${quote(table)} WHERE ${names.map(like).join(" OR ")} LIMIT ${KEYS_PER_TABLE}`,
        { header: false },
      );
      if (result.exitCode !== 0) return { status: "failed" };
      const rows = parseBatchRows(result.stdout);
      if (rows.length >= KEYS_PER_TABLE) truncated = true;
      names.forEach((column, index) => {
        const matched = rows.filter((row) => row[index + 1] === "1");
        if (matched.length === 0) return;
        database.push({
          table,
          column,
          keys: [
            ...new Set(
              matched
                .map((row) => row[0] ?? "")
                .filter((value) => value !== ""),
            ),
          ],
        });
      });
    }
    const grep = await lab.docker(
      [
        "exec",
        lab.wordpress,
        "grep",
        "-rlF",
        "--",
        marker,
        `${SITE_ROOT}/wp-content`,
      ],
      TIMEOUT_MS,
      OUTPUT_LIMIT,
    );
    // grep exits 1 when nothing matched; 2 with output when some file was unreadable.
    if (grep.exitCode !== 0 && grep.exitCode !== 1 && grep.stdout === "")
      return { status: "failed" };
    const paths = grep.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) =>
        line.startsWith(`${SITE_ROOT}/`)
          ? line.slice(SITE_ROOT.length + 1)
          : line,
      );
    if (paths.length > MAX_FILES) truncated = true;
    return {
      status: "found",
      database,
      files: paths.slice(0, MAX_FILES),
      truncated,
    };
  } catch {
    return { status: "failed" };
  }
}

/** Runs one SELECT as the read-only account; up to 200 rows, with the column names. */
export async function queryExplorationLab(
  lab: LookupLab,
  select: string,
): Promise<WordPressExplorationQueryResult> {
  if (!isSingleSelect(select))
    return {
      status: "refused",
      reason: "sql-error",
      message: "not a single SELECT statement",
    };
  const trimmed = select.replace(/\s+$/, "");
  const statement = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  const bounded = /\blimit\s+\d+/i.test(statement)
    ? statement
    : `${statement} LIMIT ${MAX_ROWS + 1}`;
  let result;
  try {
    result = await readerQuery(lab, bounded, { header: true });
  } catch {
    return { status: "unavailable" };
  }
  if (result.exitCode !== 0) {
    const first = result.stderr.split("\n").find((line) => line.trim() !== "");
    return {
      status: "refused",
      reason: "sql-error",
      message: (
        first ??
        `the database gave no answer within ${STATEMENT_SECONDS} s or the result exceeded ${OUTPUT_LIMIT / 1024} KiB`
      ).slice(0, MAX_MESSAGE),
    };
  }
  const [header, ...rows] = parseBatchRows(result.stdout);
  return {
    status: "rows",
    columns: header ?? [],
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
  };
}
