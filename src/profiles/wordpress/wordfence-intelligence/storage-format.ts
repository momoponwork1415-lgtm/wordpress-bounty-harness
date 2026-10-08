import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { z } from "zod";

import { canonicalJson, sha256Digest } from "../acquisition/canonical-json.js";
import {
  wordfenceIntelligenceRefreshAttemptSchema,
  wordfenceIntelligenceSnapshotRefSchema,
  type WordfenceIntelligenceSnapshot,
  type WordfenceIntelligenceSnapshotRef,
  type WordfenceStoredPluginRecord,
} from "./contracts.js";
import { canonicalRecordOrder } from "./plugin-records.js";

const PRODUCTION_REFRESH_ATTEMPT_LEASE_SECONDS = 300;

const wordfenceIndexTableDefinitions = {
  wordfence_intelligence_snapshots:
    "CREATE TABLE wordfence_intelligence_snapshots (snapshot_digest TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL) STRICT",
  wordfence_intelligence_records:
    "CREATE TABLE wordfence_intelligence_records (snapshot_digest TEXT NOT NULL, plugin_slug TEXT NOT NULL, record_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (snapshot_digest, plugin_slug, record_id)) STRICT",
  wordfence_intelligence_current:
    "CREATE TABLE wordfence_intelligence_current (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), snapshot_digest TEXT NOT NULL) STRICT",
  wordfence_intelligence_refresh_state:
    "CREATE TABLE wordfence_intelligence_refresh_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL) STRICT",
  wordfence_intelligence_refresh_attempts:
    "CREATE TABLE wordfence_intelligence_refresh_attempts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, attempted_at TEXT NOT NULL, current_snapshot_digest TEXT) STRICT",
  wordfence_intelligence_refresh_order:
    "CREATE TABLE wordfence_intelligence_refresh_order (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), publication_sequence INTEGER NOT NULL CHECK (publication_sequence >= 0), latest_completed_sequence INTEGER NOT NULL CHECK (latest_completed_sequence >= publication_sequence)) STRICT",
  wordfence_intelligence_record_set_manifests:
    "CREATE TABLE wordfence_intelligence_record_set_manifests (snapshot_digest TEXT PRIMARY KEY, manifest_json TEXT NOT NULL) STRICT",
  wordfence_intelligence_index_metadata:
    "CREATE TABLE wordfence_intelligence_index_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL) STRICT",
} as const;

const wordfenceImplicitIndexDefinitions = [
  {
    name: "sqlite_autoindex_wordfence_intelligence_snapshots_1",
    tableName: "wordfence_intelligence_snapshots",
  },
  {
    name: "sqlite_autoindex_wordfence_intelligence_snapshots_2",
    tableName: "wordfence_intelligence_snapshots",
  },
  {
    name: "sqlite_autoindex_wordfence_intelligence_records_1",
    tableName: "wordfence_intelligence_records",
  },
  {
    name: "sqlite_autoindex_wordfence_intelligence_record_set_manifests_1",
    tableName: "wordfence_intelligence_record_set_manifests",
  },
] as const;

const productionStorageTableDefinition =
  "CREATE TABLE wordfence_intelligence_production_storage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format_json TEXT NOT NULL) STRICT";

export const snapshotRowSchema = z.strictObject({
  snapshot_digest: z.string(),
  snapshot_id: z.string(),
  snapshot_json: z.string(),
});

export const currentSnapshotRowSchema = z.strictObject({
  current_snapshot_digest: z.string(),
  snapshot_digest: z.string().nullable(),
  snapshot_id: z.string().nullable(),
});

export const snapshotRecordRowSchema = z.strictObject({
  plugin_slug: z.string(),
  record_id: z.string(),
  record_json: z.string(),
});

export const recordSetManifestRowSchema = z.strictObject({
  manifest_json: z.string(),
});

const indexMetadataRowSchema = z.strictObject({
  schema_version: z.literal(2),
});

export const recordSetManifestSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-record-set-manifest"),
  schemaVersion: z.literal(1),
  snapshotDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  parserVersion: z.literal("wordfence-intelligence-production-v3"),
  normalizedRowCount: z.number().int().nonnegative(),
  recordSetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const refreshStateRowSchema = z.strictObject({ state_json: z.string() });

export const refreshAttemptRowSchema = z.strictObject({
  sequence: z.number().int().positive(),
  attempted_at: z.iso.datetime({ offset: true }),
  current_snapshot_digest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
});

export const refreshOrderRowSchema = z.strictObject({
  publication_sequence: z.number().int().nonnegative(),
  latest_completed_sequence: z.number().int().nonnegative(),
});

export const sqliteSequenceRowSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
});

const sqliteSchemaRowSchema = z.strictObject({
  type: z.enum(["index", "table", "trigger", "view"]),
  name: z.string(),
  table_name: z.string(),
  sql: z.string().nullable(),
});

const productionStorageRowSchema = z.strictObject({
  format_json: z.string(),
});

const storageIdentityObjectRowSchema = z.strictObject({
  type: z.enum(["index", "table", "trigger", "view"]),
  name: z.string(),
});

const storageIdentityPresenceRowSchema = z.strictObject({
  present: z.literal(1),
});

const productionStorageFormatSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-production-storage-format"),
  schemaVersion: z.literal(2),
  refreshAttemptLeaseSeconds: z.literal(
    PRODUCTION_REFRESH_ATTEMPT_LEASE_SECONDS,
  ),
});

export type ProductionStorageFormat = z.infer<
  typeof productionStorageFormatSchema
>;

export const productionRefreshStateSchema = z.strictObject({
  kind: z.literal("wordfence-intelligence-production-refresh-state"),
  schemaVersion: z.literal(2),
  attemptSequence: z.number().int().positive(),
  currentSnapshotDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  latestRefresh: wordfenceIntelligenceRefreshAttemptSchema,
});

export type SnapshotRow = z.infer<typeof snapshotRowSchema>;

export type ProductionRefreshAttemptToken = Readonly<{
  kind: "wordfence-production-refresh-attempt-token";
  sequence: number;
  attemptedAt: string;
}>;

export class SnapshotConflictError extends Error {
  constructor() {
    super("Wordfence Intelligence snapshot conflict");
    this.name = "SnapshotConflictError";
  }
}

function shortId(prefix: string, digest: string): string {
  return `${prefix}:${digest.slice(7, 31)}`;
}

function recordSetDigest(
  snapshotDigest: string,
  records: readonly WordfenceStoredPluginRecord[],
): string {
  const orderedRecords = canonicalRecordOrder(records);
  const hash = createHash("sha256");
  hash.update(
    canonicalJson({
      kind: "wordfence-intelligence-normalized-record-set",
      schemaVersion: 1,
      snapshotDigest,
      normalizedRowCount: orderedRecords.length,
    }),
  );
  for (const stored of orderedRecords) {
    hash.update("\n");
    hash.update(canonicalJson(stored));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function recordSetManifest(
  snapshot: WordfenceIntelligenceSnapshot,
  reference: WordfenceIntelligenceSnapshotRef,
  records: readonly WordfenceStoredPluginRecord[],
) {
  return recordSetManifestSchema.parse({
    kind: "wordfence-intelligence-record-set-manifest",
    schemaVersion: 1,
    snapshotDigest: reference.digest,
    parserVersion: snapshot.source.parserVersion,
    normalizedRowCount: records.length,
    recordSetDigest: recordSetDigest(reference.digest, records),
  });
}

function schemaCreationSql(includeProductionStorage: boolean): string {
  const definitions = [
    ...Object.values(wordfenceIndexTableDefinitions),
    ...(includeProductionStorage ? [productionStorageTableDefinition] : []),
  ];
  return definitions.join(";\n");
}

function normalizedSchemaSql(sql: string): string {
  return sql
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),])\s*/gu, "$1")
    .trim();
}

function requireExactWordfenceSchema(
  database: Database.Database,
  tableDefinitions: Readonly<Record<string, string>>,
): void {
  const expected = new Map<string, z.infer<typeof sqliteSchemaRowSchema>>();
  const expectedTables = Object.entries(tableDefinitions).map(([name, sql]) =>
    sqliteSchemaRowSchema.parse({
      type: "table",
      name,
      table_name: name,
      sql: normalizedSchemaSql(sql),
    }),
  );
  const expectedIndexes = wordfenceImplicitIndexDefinitions
    .filter((index) => Object.hasOwn(tableDefinitions, index.tableName))
    .map((index) =>
      sqliteSchemaRowSchema.parse({
        type: "index",
        name: index.name,
        table_name: index.tableName,
        sql: null,
      }),
    );
  for (const row of [...expectedTables, ...expectedIndexes]) {
    expected.set(`${row.type}:${row.name}`, row);
  }
  const rows = sqliteSchemaRowSchema.array().parse(
    database
      .prepare(
        `SELECT type, name, tbl_name AS table_name, sql
           FROM sqlite_schema
          WHERE (type = 'table' AND name NOT LIKE 'sqlite_%')
             OR type IN ('index', 'trigger', 'view')
          ORDER BY type, name`,
      )
      .all(),
  );
  if (
    rows.length !== expected.size ||
    rows.some((row) => {
      const candidate = expected.get(`${row.type}:${row.name}`);
      return (
        candidate === undefined ||
        candidate.table_name !== row.table_name ||
        candidate.sql !==
          (row.sql === null ? null : normalizedSchemaSql(row.sql))
      );
    })
  ) {
    throw new SnapshotConflictError();
  }
}

function requireWordfenceSchema(
  database: Database.Database,
  includeProductionStorage: boolean,
): void {
  requireExactWordfenceSchema(database, {
    ...wordfenceIndexTableDefinitions,
    ...(includeProductionStorage
      ? {
          wordfence_intelligence_production_storage:
            productionStorageTableDefinition,
        }
      : {}),
  });
  const metadata = indexMetadataRowSchema.array().parse(
    database
      .prepare(
        `SELECT schema_version
           FROM wordfence_intelligence_index_metadata
          WHERE singleton = 1`,
      )
      .all(),
  );
  if (metadata.length !== 1 || metadata[0]?.schema_version !== 2) {
    throw new SnapshotConflictError();
  }
}

export function productionStorageFormat(): ProductionStorageFormat {
  return productionStorageFormatSchema.parse({
    kind: "wordfence-intelligence-production-storage-format",
    schemaVersion: 2,
    refreshAttemptLeaseSeconds: PRODUCTION_REFRESH_ATTEMPT_LEASE_SECONDS,
  });
}

export function hasProductionStorageOwnershipEvidence(
  database: Database.Database,
): boolean {
  try {
    const objects = storageIdentityObjectRowSchema.array().parse(
      database
        .prepare(
          `SELECT type, name
             FROM sqlite_schema
            WHERE name IN (
              'wordfence_intelligence_production_storage',
              'wordfence_intelligence_refresh_order',
              'wordfence_intelligence_refresh_attempts',
              'wordfence_intelligence_refresh_state'
            )
            ORDER BY name`,
        )
        .all(),
    );
    if (
      objects.some(
        (object) =>
          object.name === "wordfence_intelligence_production_storage" ||
          object.type !== "table",
      )
    ) {
      return true;
    }
    const tables = new Set(objects.map((object) => object.name));
    for (const table of [
      "wordfence_intelligence_refresh_order",
      "wordfence_intelligence_refresh_attempts",
      "wordfence_intelligence_refresh_state",
    ]) {
      if (
        tables.has(table) &&
        storageIdentityPresenceRowSchema
          .optional()
          .parse(
            database.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get(),
          ) !== undefined
      ) {
        return true;
      }
    }
    const hasSqliteSequence = storageIdentityPresenceRowSchema.optional().parse(
      database
        .prepare(
          `SELECT 1 AS present
               FROM sqlite_schema
              WHERE type = 'table'
                AND name = 'sqlite_sequence'`,
        )
        .get(),
    );
    return (
      hasSqliteSequence !== undefined &&
      storageIdentityPresenceRowSchema.optional().parse(
        database
          .prepare(
            `SELECT 1 AS present
               FROM sqlite_sequence
              WHERE name = 'wordfence_intelligence_refresh_attempts'`,
          )
          .get(),
      ) !== undefined
    );
  } catch (error) {
    if (error instanceof SnapshotConflictError) {
      throw error;
    }
    throw new SnapshotConflictError();
  }
}

function readProductionStorageFormat(
  database: Database.Database,
): ProductionStorageFormat {
  requireWordfenceSchema(database, true);
  const markerRows = productionStorageRowSchema.array().parse(
    database
      .prepare(
        `SELECT format_json
           FROM wordfence_intelligence_production_storage
          WHERE singleton = 1`,
      )
      .all(),
  );
  if (markerRows.length !== 1) {
    throw new SnapshotConflictError();
  }
  const marker = productionStorageFormatSchema.parse(
    JSON.parse(markerRows[0]?.format_json ?? ""),
  );
  if (canonicalJson(marker) !== markerRows[0]?.format_json) {
    throw new SnapshotConflictError();
  }
  const orders = refreshOrderRowSchema.array().parse(
    database
      .prepare(
        `SELECT publication_sequence, latest_completed_sequence
           FROM wordfence_intelligence_refresh_order
          WHERE singleton = 1`,
      )
      .all(),
  );
  const allocators = sqliteSequenceRowSchema.array().parse(
    database
      .prepare(
        `SELECT seq
           FROM sqlite_sequence
          WHERE name = 'wordfence_intelligence_refresh_attempts'`,
      )
      .all(),
  );
  if (orders.length !== 1 || allocators.length !== 1) {
    throw new SnapshotConflictError();
  }
  return marker;
}

export function requireProductionStorageFormat(
  database: Database.Database,
): ProductionStorageFormat {
  try {
    return readProductionStorageFormat(database);
  } catch (error) {
    if (error instanceof SnapshotConflictError) {
      throw error;
    }
    throw new SnapshotConflictError();
  }
}

export function requireLocalStorage(database: Database.Database): void {
  try {
    requireWordfenceSchema(database, false);
  } catch {
    throw new SnapshotConflictError();
  }
}

function requireEmptyStorage(database: Database.Database): void {
  if (
    database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get() !== undefined
  ) {
    throw new SnapshotConflictError();
  }
}

function initializeIndexMetadata(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO wordfence_intelligence_index_metadata (
         singleton, schema_version
       ) VALUES (1, 2)`,
    )
    .run();
}

export function initializeLocalStorage(database: Database.Database): void {
  database
    .transaction(() => {
      requireEmptyStorage(database);
      database.exec(schemaCreationSql(false));
      initializeIndexMetadata(database);
    })
    .immediate();
}

export function initializeProductionStorage(database: Database.Database): void {
  const transaction = database.transaction(() => {
    requireEmptyStorage(database);
    database.exec(schemaCreationSql(true));
    database
      .prepare(
        `INSERT INTO wordfence_intelligence_refresh_order (
           singleton, publication_sequence, latest_completed_sequence
         ) VALUES (1, 0, 0)`,
      )
      .run();
    initializeIndexMetadata(database);
    database
      .prepare(
        `INSERT INTO sqlite_sequence (name, seq)
         VALUES ('wordfence_intelligence_refresh_attempts', 0)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO wordfence_intelligence_production_storage (
           singleton, format_json
         ) VALUES (1, ?)`,
      )
      .run(canonicalJson(productionStorageFormat()));
  });
  transaction.immediate();
}

export function snapshotReference(
  snapshot: WordfenceIntelligenceSnapshot,
): WordfenceIntelligenceSnapshotRef {
  const digest = sha256Digest(snapshot);
  return wordfenceIntelligenceSnapshotRefSchema.parse({
    kind: "wordfence-intelligence-snapshot-ref",
    schemaVersion: 1,
    id: shortId("wordfence-snapshot", digest),
    digest,
  });
}
