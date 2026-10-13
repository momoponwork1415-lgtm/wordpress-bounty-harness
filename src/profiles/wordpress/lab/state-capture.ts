import { createHash } from "node:crypto";

import { z } from "zod";

import type { DockerResult, Resources } from "./index.js";
import { DATABASE_NAME } from "./wordpress-initialization.js";

/**
 * Whole-site state the Lab reads from its own MySQL around the Verifier run
 * (#186): every option, every user with roles, and per-table row counts with
 * checksums. Classification-independent, deterministic, and never shown to the
 * Verifier. Values stay in Private Evidence; the ledger holds digests.
 */
export const WORDPRESS_LAB_STATE_SCHEMA_ID = "wordpress-lab-state/v1";
export const WORDPRESS_LAB_STATE_DIFF_SCHEMA_ID = "wordpress-lab-state-diff/v1";

const tableName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

export const wordpressLabStateSchema = z.strictObject({
  schema: z.literal(WORDPRESS_LAB_STATE_SCHEMA_ID),
  capturedAt: z.iso.datetime(),
  tablePrefix: z.string().regex(/^[A-Za-z0-9_]{0,32}$/),
  options: z.array(
    z.strictObject({
      name: z.string().max(191),
      value: z.string(),
      autoload: z.string().max(20),
    }),
  ),
  users: z.array(
    z.strictObject({
      id: z.string().regex(/^\d+$/),
      login: z.string().max(60),
      email: z.string().max(100),
      registered: z.string().max(32),
      /** SHA-256 of the stored hash; a changed digest means a password change. */
      passwordDigest: z.string().regex(/^[a-f0-9]{64}$/),
      roles: z.array(z.string().max(64)),
    }),
  ),
  tables: z.array(
    z.strictObject({
      name: tableName,
      rows: z.number().int().nonnegative(),
      checksum: z.string().max(32),
    }),
  ),
});
export type WordPressLabState = z.infer<typeof wordpressLabStateSchema>;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** `mariadb --batch` escapes tab, newline, backslash and NUL; NULL prints as \N. */
export function parseBatchRows(output: string): string[][] {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) =>
    line
      .split("\t")
      .map((cell) =>
        cell === "\\N"
          ? ""
          : cell.replace(/\\(.)/g, (_match, escaped: string) =>
              escaped === "t"
                ? "\t"
                : escaped === "n"
                  ? "\n"
                  : escaped === "0"
                    ? "\0"
                    : escaped,
            ),
      ),
  );
}

/** Role names out of a serialized `capabilities` array; anything unparseable yields none. */
export function rolesFromCapabilities(serialized: string): string[] {
  const roles: string[] = [];
  for (const match of serialized.matchAll(/s:\d+:"([^"]{1,64})";b:1;/g))
    roles.push(match[1]!);
  return roles.sort();
}

type RunDocker = (
  args: readonly string[],
  timeoutMs?: number,
  maxOutputBytes?: number,
) => Promise<DockerResult>;

const OUTPUT_LIMIT = 32 * 1024 * 1024;

async function query(
  resource: Resources,
  docker: RunDocker,
  sql: string,
): Promise<string[][]> {
  const result = await docker(
    [
      "exec",
      resource.database,
      "mariadb",
      "--user=root",
      `--password=${resource.databasePassword}`,
      "--skip-column-names",
      "--batch",
      "--execute",
      sql,
      DATABASE_NAME,
    ],
    120_000,
    OUTPUT_LIMIT,
  );
  if (result.exitCode !== 0) throw new Error("Lab database query failed");
  return parseBatchRows(result.stdout);
}

/** Reads the whole site state through the Lab's own database container. */
export async function captureWordPressLabState(input: {
  readonly resource: Resources;
  readonly docker: RunDocker;
  readonly now: () => Date;
}): Promise<WordPressLabState> {
  const { resource, docker } = input;
  const tables = (await query(resource, docker, "SHOW TABLES"))
    .map((row) => row[0] ?? "")
    .filter((name) => tableName.safeParse(name).success)
    .sort();
  const optionsTable =
    tables.find((name) => name === "wp_options") ??
    tables.find((name) => /_options$/.test(name));
  if (optionsTable === undefined) throw new Error("Options table is missing");
  const tablePrefix = optionsTable.slice(0, -"options".length);
  const options = (
    await query(
      resource,
      docker,
      `SELECT option_name, option_value, autoload FROM \`${optionsTable}\` ORDER BY option_name`,
    )
  ).map((row) => ({
    name: row[0] ?? "",
    value: row[1] ?? "",
    autoload: row[2] ?? "",
  }));
  const users = (
    await query(
      resource,
      docker,
      `SELECT u.ID, u.user_login, u.user_email, u.user_registered, SHA2(u.user_pass, 256), COALESCE(m.meta_value, '') FROM \`${tablePrefix}users\` u LEFT JOIN \`${tablePrefix}usermeta\` m ON m.user_id = u.ID AND m.meta_key = '${tablePrefix}capabilities' ORDER BY u.ID`,
    )
  ).map((row) => ({
    id: row[0] ?? "0",
    login: row[1] ?? "",
    email: row[2] ?? "",
    registered: row[3] ?? "",
    passwordDigest: row[4] ?? sha256(""),
    roles: rolesFromCapabilities(row[5] ?? ""),
  }));
  const counts = new Map(
    (
      await query(
        resource,
        docker,
        tables
          .map((name) => `SELECT '${name}', COUNT(*) FROM \`${name}\``)
          .join(" UNION ALL "),
      )
    ).map((row) => [row[0] ?? "", Number(row[1] ?? "0")]),
  );
  const checksums = new Map(
    (
      await query(
        resource,
        docker,
        `CHECKSUM TABLE ${tables.map((name) => `\`${name}\``).join(", ")}`,
      )
    ).map((row) => [(row[0] ?? "").replace(/^.*\./, ""), row[1] ?? ""]),
  );
  return wordpressLabStateSchema.parse({
    schema: WORDPRESS_LAB_STATE_SCHEMA_ID,
    capturedAt: input.now().toISOString(),
    tablePrefix,
    options,
    users,
    tables: tables.map((name) => ({
      name,
      rows: counts.get(name) ?? 0,
      checksum: checksums.get(name) ?? "",
    })),
  });
}

const optionChange = z.strictObject({
  name: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  beforeDigest: z.string().optional(),
  afterDigest: z.string().optional(),
});
const userRecord = wordpressLabStateSchema.shape.users.element;
export const wordpressLabStateDiffSchema = z.strictObject({
  schema: z.literal(WORDPRESS_LAB_STATE_DIFF_SCHEMA_ID),
  before: z.strictObject({ capturedAt: z.iso.datetime(), digest: z.string() }),
  after: z.strictObject({ capturedAt: z.iso.datetime(), digest: z.string() }),
  options: z.strictObject({
    added: z.array(optionChange),
    removed: z.array(optionChange),
    changed: z.array(optionChange),
  }),
  users: z.strictObject({
    added: z.array(userRecord),
    removed: z.array(userRecord),
    changed: z.array(
      z.strictObject({
        login: z.string(),
        before: userRecord,
        after: userRecord,
      }),
    ),
  }),
  tables: z.strictObject({
    added: z.array(tableName),
    removed: z.array(tableName),
    changed: z.array(
      z.strictObject({
        name: tableName,
        rowsBefore: z.number().int().nonnegative(),
        rowsAfter: z.number().int().nonnegative(),
        checksumChanged: z.boolean(),
      }),
    ),
  }),
  summary: z.strictObject({
    optionsAdded: z.number().int().nonnegative(),
    optionsRemoved: z.number().int().nonnegative(),
    optionsChanged: z.number().int().nonnegative(),
    usersAdded: z.number().int().nonnegative(),
    usersRemoved: z.number().int().nonnegative(),
    usersChanged: z.number().int().nonnegative(),
    tablesChanged: z.number().int().nonnegative(),
  }),
});
export type WordPressLabStateDiff = z.infer<typeof wordpressLabStateDiffSchema>;

/** Deterministic diff of two captures; the inputs are compared by name, never by position. */
export function diffWordPressLabState(
  before: WordPressLabState,
  after: WordPressLabState,
  digests: { readonly before: string; readonly after: string },
): WordPressLabStateDiff {
  const byName = <T extends { readonly name: string }>(items: readonly T[]) =>
    new Map(items.map((item) => [item.name, item]));
  const beforeOptions = byName(before.options);
  const afterOptions = byName(after.options);
  const options: WordPressLabStateDiff["options"] = {
    added: [],
    removed: [],
    changed: [],
  };
  for (const [name, option] of afterOptions) {
    const previous = beforeOptions.get(name);
    if (previous === undefined)
      options.added.push({
        name,
        after: option.value,
        afterDigest: sha256(option.value),
      });
    else if (
      previous.value !== option.value ||
      previous.autoload !== option.autoload
    )
      options.changed.push({
        name,
        before: previous.value,
        after: option.value,
        beforeDigest: sha256(previous.value),
        afterDigest: sha256(option.value),
      });
  }
  for (const [name, option] of beforeOptions)
    if (!afterOptions.has(name))
      options.removed.push({
        name,
        before: option.value,
        beforeDigest: sha256(option.value),
      });

  const byLogin = (items: WordPressLabState["users"]) =>
    new Map(items.map((item) => [item.login, item]));
  const beforeUsers = byLogin(before.users);
  const afterUsers = byLogin(after.users);
  const users: WordPressLabStateDiff["users"] = {
    added: [],
    removed: [],
    changed: [],
  };
  for (const [login, user] of afterUsers) {
    const previous = beforeUsers.get(login);
    if (previous === undefined) users.added.push(user);
    else if (JSON.stringify(previous) !== JSON.stringify(user))
      users.changed.push({ login, before: previous, after: user });
  }
  for (const [login, user] of beforeUsers)
    if (!afterUsers.has(login)) users.removed.push(user);

  const beforeTables = byName(before.tables);
  const afterTables = byName(after.tables);
  const tables: WordPressLabStateDiff["tables"] = {
    added: [],
    removed: [],
    changed: [],
  };
  for (const [name, table] of afterTables) {
    const previous = beforeTables.get(name);
    if (previous === undefined) tables.added.push(name);
    else if (
      previous.rows !== table.rows ||
      previous.checksum !== table.checksum
    )
      tables.changed.push({
        name,
        rowsBefore: previous.rows,
        rowsAfter: table.rows,
        checksumChanged: previous.checksum !== table.checksum,
      });
  }
  for (const name of beforeTables.keys())
    if (!afterTables.has(name)) tables.removed.push(name);

  const sortByName = <T extends { readonly name: string }>(items: T[]) =>
    items.sort((left, right) => left.name.localeCompare(right.name));
  return wordpressLabStateDiffSchema.parse({
    schema: WORDPRESS_LAB_STATE_DIFF_SCHEMA_ID,
    before: { capturedAt: before.capturedAt, digest: digests.before },
    after: { capturedAt: after.capturedAt, digest: digests.after },
    options: {
      added: sortByName(options.added),
      removed: sortByName(options.removed),
      changed: sortByName(options.changed),
    },
    users: {
      added: users.added.sort((l, r) => l.login.localeCompare(r.login)),
      removed: users.removed.sort((l, r) => l.login.localeCompare(r.login)),
      changed: users.changed.sort((l, r) => l.login.localeCompare(r.login)),
    },
    tables: {
      added: tables.added.sort(),
      removed: tables.removed.sort(),
      changed: sortByName(tables.changed),
    },
    summary: {
      optionsAdded: options.added.length,
      optionsRemoved: options.removed.length,
      optionsChanged: options.changed.length,
      usersAdded: users.added.length,
      usersRemoved: users.removed.length,
      usersChanged: users.changed.length,
      tablesChanged: tables.changed.length,
    },
  });
}
