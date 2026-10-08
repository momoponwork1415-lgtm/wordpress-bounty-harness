import Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson } from "../acquisition/canonical-json.js";
import {
  currentWordfenceIntelligenceSnapshotSchema,
  staleWordfenceIntelligenceSnapshotSchema,
  vulnerabilityHistoryAggregateRequestSchema,
  vulnerabilityHistoryAggregateSchema,
  wordfenceIntelligenceFailure as failure,
  wordfenceIntelligenceInspectionRequestSchema,
  wordfenceIntelligenceFailureSchema,
  wordfenceIntelligenceSnapshotRefSchema,
  wordfenceIntelligenceSnapshotSchema,
  wordfenceKnownRecordProjectionSchema,
  wordfenceStoredPluginRecordSchema,
  type KnownRecordAccessAuthorization,
  type VulnerabilityHistoryAggregate,
  type VulnerabilityHistoryAggregateRequest,
  type WordfenceIntelligenceFailure,
  type WordfenceIntelligenceInspectionRequest,
  type WordfenceIntelligenceResult,
  type WordfenceIntelligenceSnapshot,
  type WordfenceIntelligenceSnapshotRef,
  type WordfenceKnownRecord,
  type WordfenceKnownRecordInspectionRequest,
  type WordfenceKnownRecordProjection,
  type WordfenceStoredPluginRecord,
} from "./contracts.js";

import { canonicalRecordOrder, intervalContains } from "./plugin-records.js";
import {
  type HostPrivateFileIdentity,
  selectedPathMetadataSynchronously,
  HostPrivateStorageError,
  requireMatchingRegularFileMetadata,
  isStorageFailure,
  type PinnedHostPrivateDirectory,
  prepareProductionStorage,
  sameFileIdentity,
  requireProductionStorage,
  verifyStoredArtifact,
  requireProductionIndexIdentity,
} from "./host-private-storage.js";
import {
  type ProductionStorageFormat,
  requireProductionStorageFormat,
  productionStorageFormat,
  initializeProductionStorage,
  initializeLocalStorage,
  requireLocalStorage,
  hasProductionStorageOwnershipEvidence,
  SnapshotConflictError,
  snapshotReference,
  refreshAttemptRowSchema,
  refreshStateRowSchema,
  productionRefreshStateSchema,
  refreshOrderRowSchema,
  recordSetManifest,
  type ProductionRefreshAttemptToken,
  sqliteSequenceRowSchema,
  currentSnapshotRowSchema,
  snapshotRowSchema,
  type SnapshotRow,
  recordSetManifestRowSchema,
  snapshotRecordRowSchema,
  recordSetManifestSchema,
} from "./storage-format.js";

function currentResult(
  snapshot: WordfenceIntelligenceSnapshot,
  snapshotRef: WordfenceIntelligenceSnapshotRef,
): WordfenceIntelligenceResult {
  return currentWordfenceIntelligenceSnapshotSchema.parse({
    kind: "wordfence-intelligence-result",
    schemaVersion: 1,
    status: "current",
    snapshot,
    snapshotRef,
  });
}

export type WordfenceStorageOpenMode =
  "local" | "new-production" | "production";

interface WordfenceSnapshotStoreOptions {
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly clock: () => Date;
}

export class WordfenceSnapshotStore {
  readonly #database: Database.Database;
  readonly #databasePath: string;
  readonly #artifactDirectory: string;
  readonly #clock: () => Date;
  readonly #productionComposition: boolean;
  readonly #productionReadOnly: boolean;
  readonly #productionReadDatabaseIdentity: HostPrivateFileIdentity | undefined;
  readonly #productionStorageFormat: ProductionStorageFormat | undefined;
  readonly #localStorageConflict: boolean;

  constructor(
    options: WordfenceSnapshotStoreOptions,
    storageOpenMode: WordfenceStorageOpenMode = "local",
  ) {
    this.#databasePath = options.databasePath;
    this.#artifactDirectory = options.artifactDirectory;
    this.#clock = options.clock;
    this.#productionComposition = storageOpenMode !== "local";
    const existingLocalMetadata =
      storageOpenMode === "local"
        ? selectedPathMetadataSynchronously(options.databasePath)
        : undefined;
    if (
      existingLocalMetadata !== undefined &&
      !existingLocalMetadata.isFile()
    ) {
      throw new HostPrivateStorageError();
    }
    let database = new Database(
      options.databasePath,
      existingLocalMetadata === undefined
        ? undefined
        : { fileMustExist: true, readonly: true },
    );
    let productionFormat: ProductionStorageFormat | undefined;
    let localStorageConflict = false;
    let productionReadOnly = false;
    let productionReadDatabaseIdentity: HostPrivateFileIdentity | undefined;
    try {
      database.pragma("busy_timeout = 5000");
      if (storageOpenMode === "local") {
        if (existingLocalMetadata !== undefined) {
          requireMatchingRegularFileMetadata(
            existingLocalMetadata,
            selectedPathMetadataSynchronously(options.databasePath),
          );
        }
        const productionOwnership =
          hasProductionStorageOwnershipEvidence(database);
        if (productionOwnership) {
          try {
            productionFormat = requireProductionStorageFormat(database);
            productionReadOnly = true;
            if (existingLocalMetadata === undefined) {
              throw new HostPrivateStorageError();
            }
            const selected = requireMatchingRegularFileMetadata(
              existingLocalMetadata,
              selectedPathMetadataSynchronously(options.databasePath),
            );
            productionReadDatabaseIdentity = {
              device: selected.dev,
              inode: selected.ino,
            };
          } catch (error) {
            if (
              error instanceof SnapshotConflictError ||
              error instanceof HostPrivateStorageError
            ) {
              productionFormat = undefined;
              productionReadOnly = false;
              productionReadDatabaseIdentity = undefined;
              localStorageConflict = true;
            } else {
              throw error;
            }
          }
        } else {
          if (existingLocalMetadata !== undefined) {
            try {
              requireLocalStorage(database);
            } catch (error) {
              if (!(error instanceof SnapshotConflictError)) {
                throw error;
              }
              localStorageConflict = true;
            }
          }
          if (!localStorageConflict) {
            if (existingLocalMetadata !== undefined) {
              database.close();
              const reopenIdentity = requireMatchingRegularFileMetadata(
                existingLocalMetadata,
                selectedPathMetadataSynchronously(options.databasePath),
              );
              database = new Database(options.databasePath);
              requireMatchingRegularFileMetadata(
                reopenIdentity,
                selectedPathMetadataSynchronously(options.databasePath),
              );
              database.pragma("busy_timeout = 5000");
              requireLocalStorage(database);
            }
            database.pragma("journal_mode = WAL");
            if (existingLocalMetadata === undefined) {
              initializeLocalStorage(database);
            }
          }
        }
      } else if (storageOpenMode === "new-production") {
        initializeProductionStorage(database);
        productionFormat = productionStorageFormat();
      } else {
        productionFormat = requireProductionStorageFormat(database);
      }
      if (storageOpenMode !== "local") {
        database.pragma("journal_mode = WAL");
        database.exec("BEGIN IMMEDIATE; COMMIT");
      }
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
    this.#productionReadOnly = productionReadOnly;
    this.#productionReadDatabaseIdentity = productionReadDatabaseIdentity;
    this.#productionStorageFormat = productionFormat;
    this.#localStorageConflict = localStorageConflict;
  }

  close(): void {
    this.#database.close();
  }

  async inspect(
    requestValue: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult> {
    const request =
      wordfenceIntelligenceInspectionRequestSchema.parse(requestValue);
    if (this.#productionReadOnly) {
      return this.#validatedProductionRead(() => {
        const result = this.#productionProjection(request);
        return {
          result,
          ...(result.status === "current" || result.status === "stale"
            ? { contentDigest: result.snapshot.source.contentDigest }
            : {}),
        };
      });
    }
    this.requireLocalStorageOwnership();
    return this.#inspectSnapshot(request);
  }

  requireLocalRefreshOwnership(): void {
    if (this.#productionReadOnly) {
      throw new SnapshotConflictError();
    }
    this.requireLocalStorageOwnership();
  }

  requireLocalStorageOwnership(): void {
    if (
      !this.#productionComposition &&
      (this.#localStorageConflict ||
        (!this.#productionReadOnly &&
          hasProductionStorageOwnershipEvidence(this.#database)))
    ) {
      throw new SnapshotConflictError();
    }
    if (!this.#productionComposition && !this.#productionReadOnly) {
      requireLocalStorage(this.#database);
    }
  }

  async #validatedProductionRead<T>(
    operation: () => {
      readonly result: T;
      readonly contentDigest?: string;
    },
  ): Promise<T> {
    const expectedDatabaseIdentity = this.#productionReadDatabaseIdentity;
    if (expectedDatabaseIdentity === undefined) {
      throw new SnapshotConflictError();
    }
    const prepared = await prepareProductionStorage(
      this.#databasePath,
      this.#artifactDirectory,
    );
    if (
      prepared.mode !== "production" ||
      !sameFileIdentity(
        expectedDatabaseIdentity,
        prepared.indexIdentity.database,
      )
    ) {
      throw new HostPrivateStorageError();
    }
    const storage = await requireProductionStorage(
      this.#databasePath,
      this.#artifactDirectory,
      prepared.indexIdentity,
    );
    let read:
      | {
          readonly result: T;
          readonly contentDigest?: string;
        }
      | undefined;
    try {
      const transaction = this.#database.transaction(() => {
        this.requireCurrentProductionStorageFormat();
        const currentReference = this.#currentReference();
        this.#requireProductionRefreshBindings(currentReference?.digest);
        return operation();
      });
      read = transaction.deferred();
      if (read.contentDigest !== undefined) {
        await verifyStoredArtifact(
          storage.artifactDirectory,
          read.contentDigest,
        );
      }
      await requireProductionIndexIdentity(
        this.#databasePath,
        prepared.indexIdentity,
      );
    } catch (error) {
      try {
        await storage.artifactDirectory.handle.close();
      } catch {
        // Preserve the primary read or integrity failure.
      }
      throw error;
    }
    await storage.artifactDirectory.handle.close();
    if (read === undefined) {
      throw new HostPrivateStorageError();
    }
    return read.result;
  }

  #inspectSnapshot(
    request: WordfenceIntelligenceInspectionRequest,
  ): WordfenceIntelligenceResult {
    const ref = request.snapshotRef ?? this.#currentReference();
    if (ref === undefined) {
      return failure("not-refreshed");
    }
    const snapshot = this.#readSnapshot(ref);
    return currentResult(snapshot, ref);
  }

  async inspectProduction(
    requestValue: WordfenceIntelligenceInspectionRequest,
  ): Promise<WordfenceIntelligenceResult> {
    const request =
      wordfenceIntelligenceInspectionRequestSchema.parse(requestValue);
    const transaction = this.#database.transaction(() => {
      this.requireCurrentProductionStorageFormat();
      return this.#productionProjection(request);
    });
    return transaction.deferred();
  }

  requireCurrentProductionStorageFormat(): void {
    if (!this.#productionComposition && !this.#productionReadOnly) {
      return;
    }
    const expected = this.#productionStorageFormat;
    if (expected === undefined) {
      throw new SnapshotConflictError();
    }
    const current = requireProductionStorageFormat(this.#database);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw new SnapshotConflictError();
    }
  }

  #productionProjection(
    request: WordfenceIntelligenceInspectionRequest,
  ): WordfenceIntelligenceResult {
    const result = this.#inspectSnapshot(request);
    if (result.status === "current" || result.status === "stale") {
      this.#validatedRecordSet(result.snapshot, result.snapshotRef);
    }
    const currentReference = this.#currentReference();
    if (
      request.snapshotRef !== undefined &&
      (currentReference === undefined ||
        request.snapshotRef.id !== currentReference.id ||
        request.snapshotRef.digest !== currentReference.digest)
    ) {
      return result;
    }
    this.#requireProductionRefreshBindings(currentReference?.digest);
    const activeAttempt = refreshAttemptRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT sequence, attempted_at, current_snapshot_digest
               FROM wordfence_intelligence_refresh_attempts
              ORDER BY sequence DESC
              LIMIT 1`,
        )
        .get(),
    );
    const row = refreshStateRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT state_json
             FROM wordfence_intelligence_refresh_state
            WHERE singleton = 1`,
        )
        .get(),
    );
    if (activeAttempt !== undefined) {
      if (result.status === "failed") {
        if (
          result.reason === "not-refreshed" &&
          activeAttempt.current_snapshot_digest === null
        ) {
          return failure("storage-failure");
        }
        if (result.reason === "not-refreshed") {
          throw new SnapshotConflictError();
        }
        return result;
      }
      if (activeAttempt.current_snapshot_digest !== result.snapshotRef.digest) {
        throw new SnapshotConflictError();
      }
      return staleWordfenceIntelligenceSnapshotSchema.parse({
        ...result,
        status: "stale",
        latestRefresh: {
          kind: "wordfence-intelligence-refresh-attempt",
          schemaVersion: 1,
          attemptedAt: activeAttempt.attempted_at,
          result: failure("storage-failure"),
        },
      });
    }
    if (row === undefined) {
      return result;
    }
    const state = productionRefreshStateSchema.parse(
      JSON.parse(row.state_json),
    );
    const currentSnapshotDigest = state.currentSnapshotDigest;
    const latestRefresh = state.latestRefresh;
    if (result.status === "failed") {
      if (
        result.reason === "not-refreshed" &&
        currentSnapshotDigest === undefined
      ) {
        return latestRefresh.result;
      }
      if (result.reason === "not-refreshed") {
        throw new SnapshotConflictError();
      }
      return result;
    }
    if (result.status === "stale") {
      return result;
    }
    if (currentSnapshotDigest !== result.snapshotRef.digest) {
      throw new SnapshotConflictError();
    }
    return staleWordfenceIntelligenceSnapshotSchema.parse({
      ...result,
      status: "stale",
      latestRefresh,
    });
  }

  async requireCurrentProductionArtifact(
    directory: PinnedHostPrivateDirectory,
  ): Promise<void> {
    this.requireCurrentProductionStorageFormat();
    const reference = this.#currentReference();
    if (reference === undefined) {
      return;
    }
    const snapshot = this.#readSnapshot(reference);
    this.#validatedRecordSet(snapshot, reference);
    await verifyStoredArtifact(directory, snapshot.source.contentDigest);
  }

  async aggregate(
    requestValue: VulnerabilityHistoryAggregateRequest,
  ): Promise<VulnerabilityHistoryAggregate> {
    const request =
      vulnerabilityHistoryAggregateRequestSchema.parse(requestValue);
    if (this.#productionReadOnly) {
      return this.#validatedProductionRead(() => {
        const result = this.#aggregate(request);
        const snapshot = this.#readSnapshot(request.snapshotRef);
        return {
          result,
          contentDigest: snapshot.source.contentDigest,
        };
      });
    }
    this.requireLocalStorageOwnership();
    return this.#aggregate(request);
  }

  #aggregate(
    request: VulnerabilityHistoryAggregateRequest,
  ): VulnerabilityHistoryAggregate {
    const snapshot = this.#readSnapshot(request.snapshotRef);
    const records = this.#records(
      snapshot,
      request.snapshotRef,
      request.pluginIdentity.slice("wporg:".length),
    );
    const published = records.flatMap((record) =>
      record.publishedAt === undefined ? [] : [record.publishedAt],
    );
    const years = new Set(published.map((value) => value.slice(0, 4))).size;
    const lastPublishedAt = [...published].sort().at(-1);
    return vulnerabilityHistoryAggregateSchema.parse({
      kind: "vulnerability-history-aggregate",
      schemaVersion: 1,
      pluginIdentity: request.pluginIdentity,
      snapshotRef: request.snapshotRef,
      recordCount: records.length,
      disclosureDensity: {
        kind: "records-per-published-year",
        publishedYears: years,
        value: years === 0 ? 0 : Number((published.length / years).toFixed(6)),
      },
      ...(lastPublishedAt === undefined ? {} : { lastPublishedAt }),
    });
  }

  #knownRecordProjection(
    request: WordfenceKnownRecordInspectionRequest,
    authorization: KnownRecordAccessAuthorization,
  ): WordfenceKnownRecordProjection {
    const snapshot = this.#readSnapshot(request.snapshotRef);
    const records = this.#records(
      snapshot,
      request.snapshotRef,
      request.pluginIdentity.slice("wporg:".length),
    ).filter((record) =>
      record.affectedVersionIntervals.some((interval) =>
        intervalContains(interval, request.verifiedVersion),
      ),
    );
    return wordfenceKnownRecordProjectionSchema.parse({
      kind: "wordfence-known-record-projection",
      schemaVersion: 2,
      pluginIdentity: request.pluginIdentity,
      verifiedVersion: request.verifiedVersion,
      canonicalFileManifestDigest: request.canonicalFileManifestDigest,
      snapshotRef: request.snapshotRef,
      authorizationRef: request.authorizationRef,
      verifiedFindingRef: authorization.verifiedFindingRef,
      purpose: authorization.purpose,
      records,
    });
  }

  storeSnapshot(
    snapshot: WordfenceIntelligenceSnapshot,
    reference: WordfenceIntelligenceSnapshotRef,
    records: readonly WordfenceStoredPluginRecord[],
    productionAttempt: ProductionRefreshAttemptToken | undefined,
  ): WordfenceIntelligenceResult {
    const transaction = this.#database.transaction(() => {
      this.requireCurrentProductionStorageFormat();
      let refreshOrder: z.infer<typeof refreshOrderRowSchema> | undefined;
      if (productionAttempt !== undefined) {
        const currentSnapshotDigest = this.#currentReference()?.digest;
        this.#requireProductionRefreshBindings(currentSnapshotDigest);
        this.#requireActiveAttempt(productionAttempt);
        refreshOrder = this.#refreshOrder();
        if (refreshOrder === undefined) {
          throw new SnapshotConflictError();
        }
      }
      const snapshotJson = canonicalJson(snapshot);
      const existing = this.#snapshotRow(reference.digest);
      if (existing === undefined) {
        this.#database
          .prepare(
            `INSERT INTO wordfence_intelligence_snapshots (
               snapshot_digest, snapshot_id, snapshot_json
             ) VALUES (?, ?, ?)`,
          )
          .run(reference.digest, reference.id, snapshotJson);
        const insertRecord = this.#database.prepare(
          `INSERT INTO wordfence_intelligence_records (
             snapshot_digest, plugin_slug, record_id, record_json
           ) VALUES (?, ?, ?, ?)`,
        );
        for (const stored of records) {
          insertRecord.run(
            reference.digest,
            stored.pluginSlug,
            stored.record.recordId,
            canonicalJson(stored),
          );
        }
        this.#database
          .prepare(
            `INSERT INTO wordfence_intelligence_record_set_manifests (
               snapshot_digest, manifest_json
             ) VALUES (?, ?)`,
          )
          .run(
            reference.digest,
            canonicalJson(recordSetManifest(snapshot, reference, records)),
          );
      } else {
        if (
          existing.snapshot_id !== reference.id ||
          existing.snapshot_json !== snapshotJson
        ) {
          throw new SnapshotConflictError();
        }
        this.#assertStoredRecords(snapshot, reference, records);
      }
      if (productionAttempt === undefined) {
        this.#database
          .prepare(
            `INSERT INTO wordfence_intelligence_current (
               singleton, snapshot_digest
             ) VALUES (1, ?)
             ON CONFLICT(singleton) DO UPDATE SET
               snapshot_digest = excluded.snapshot_digest`,
          )
          .run(reference.digest);
        return currentResult(snapshot, reference);
      }
      if (refreshOrder === undefined) {
        throw new SnapshotConflictError();
      }
      const deletion = this.#database
        .prepare(
          `DELETE FROM wordfence_intelligence_refresh_attempts
                WHERE sequence = ?`,
        )
        .run(productionAttempt.sequence);
      if (deletion.changes !== 1) {
        throw new SnapshotConflictError();
      }
      const publishes =
        productionAttempt.sequence >= refreshOrder.publication_sequence;
      const publicationSequence = publishes
        ? productionAttempt.sequence
        : refreshOrder.publication_sequence;
      if (publishes) {
        this.#database
          .prepare(
            `INSERT INTO wordfence_intelligence_current (
               singleton, snapshot_digest
             ) VALUES (1, ?)
             ON CONFLICT(singleton) DO UPDATE SET
               snapshot_digest = excluded.snapshot_digest`,
          )
          .run(reference.digest);
        this.#database
          .prepare(
            `UPDATE wordfence_intelligence_refresh_attempts
                SET current_snapshot_digest = ?`,
          )
          .run(reference.digest);
        const state = this.#refreshState();
        if (
          state !== undefined &&
          state.attemptSequence > productionAttempt.sequence
        ) {
          this.#database
            .prepare(
              `UPDATE wordfence_intelligence_refresh_state
                  SET state_json = ?
                WHERE singleton = 1`,
            )
            .run(
              canonicalJson({
                ...state,
                currentSnapshotDigest: reference.digest,
              }),
            );
        } else {
          this.#database
            .prepare(
              `DELETE FROM wordfence_intelligence_refresh_state
               WHERE singleton = 1`,
            )
            .run();
        }
      }
      this.#database
        .prepare(
          `UPDATE wordfence_intelligence_refresh_order
              SET publication_sequence = ?,
                  latest_completed_sequence = ?
            WHERE singleton = 1`,
        )
        .run(
          publicationSequence,
          Math.max(
            refreshOrder.latest_completed_sequence,
            productionAttempt.sequence,
          ),
        );
      return this.#productionProjection({
        kind: "wordfence-intelligence-inspection",
        schemaVersion: 1,
      });
    });
    return transaction.immediate();
  }

  #assertStoredRecords(
    snapshot: WordfenceIntelligenceSnapshot,
    reference: WordfenceIntelligenceSnapshotRef,
    records: readonly WordfenceStoredPluginRecord[],
  ): void {
    const persisted = this.#validatedRecordSet(snapshot, reference);
    const expected = canonicalRecordOrder(records);
    if (
      persisted.length !== expected.length ||
      persisted.some((stored, index) => {
        const candidate = expected[index];
        return (
          candidate === undefined ||
          canonicalJson(stored) !== canonicalJson(candidate)
        );
      })
    ) {
      throw new SnapshotConflictError();
    }
  }

  recordRefreshStart():
    ProductionRefreshAttemptToken | WordfenceIntelligenceResult | undefined {
    if (!this.#productionComposition) {
      return undefined;
    }
    try {
      const transaction = this.#database.transaction(() => {
        this.requireCurrentProductionStorageFormat();
        const currentSnapshotDigest = this.#currentReference()?.digest;
        this.#requireProductionRefreshBindings(currentSnapshotDigest);
        const attemptedAt = this.#clock().toISOString();
        const format = this.#productionStorageFormat;
        if (format === undefined) {
          throw new SnapshotConflictError();
        }
        const order = this.#requireRefreshOrder();
        const activeAttempts = refreshAttemptRowSchema.array().parse(
          this.#database
            .prepare(
              `SELECT sequence, attempted_at, current_snapshot_digest
                 FROM wordfence_intelligence_refresh_attempts
                ORDER BY sequence`,
            )
            .all(),
        );
        const attemptedAtMillis = Date.parse(attemptedAt);
        const leaseMillis = format.refreshAttemptLeaseSeconds * 1_000;
        if (
          activeAttempts.some(
            (attempt) =>
              Date.parse(attempt.attempted_at) + leaseMillis >
              attemptedAtMillis,
          )
        ) {
          return this.#productionProjection({
            kind: "wordfence-intelligence-inspection",
            schemaVersion: 1,
          });
        }
        const recoveredAttempt = activeAttempts.at(-1);
        if (recoveredAttempt !== undefined) {
          const deletion = this.#database
            .prepare("DELETE FROM wordfence_intelligence_refresh_attempts")
            .run();
          if (deletion.changes !== activeAttempts.length) {
            throw new SnapshotConflictError();
          }
          if (recoveredAttempt.sequence > order.publication_sequence) {
            const state = productionRefreshStateSchema.parse({
              kind: "wordfence-intelligence-production-refresh-state",
              schemaVersion: 2,
              attemptSequence: recoveredAttempt.sequence,
              ...(currentSnapshotDigest === undefined
                ? {}
                : { currentSnapshotDigest }),
              latestRefresh: {
                kind: "wordfence-intelligence-refresh-attempt",
                schemaVersion: 1,
                attemptedAt: recoveredAttempt.attempted_at,
                result: failure("storage-failure"),
              },
            });
            this.#database
              .prepare(
                `INSERT INTO wordfence_intelligence_refresh_state (
                   singleton, state_json
                 ) VALUES (1, ?)
                 ON CONFLICT(singleton) DO UPDATE SET
                   state_json = excluded.state_json`,
              )
              .run(canonicalJson(state));
          }
          this.#database
            .prepare(
              `UPDATE wordfence_intelligence_refresh_order
                  SET latest_completed_sequence = ?
                WHERE singleton = 1`,
            )
            .run(
              Math.max(
                order.latest_completed_sequence,
                recoveredAttempt.sequence,
              ),
            );
        }
        const insertion = this.#database
          .prepare(
            `INSERT INTO wordfence_intelligence_refresh_attempts (
               attempted_at, current_snapshot_digest
             ) VALUES (?, ?)`,
          )
          .run(attemptedAt, currentSnapshotDigest ?? null);
        return {
          kind: "wordfence-production-refresh-attempt-token",
          sequence: refreshAttemptRowSchema.shape.sequence.parse(
            Number(insertion.lastInsertRowid),
          ),
          attemptedAt,
        } satisfies ProductionRefreshAttemptToken;
      });
      return transaction.immediate();
    } catch (error) {
      if (isStorageFailure(error)) {
        return failure("storage-failure");
      }
      throw error;
    }
  }

  recordRefreshFailure(
    result: WordfenceIntelligenceFailure,
    productionAttempt?: ProductionRefreshAttemptToken,
  ): WordfenceIntelligenceResult {
    const parsed = wordfenceIntelligenceFailureSchema.parse(result);
    if (!this.#productionComposition) {
      return parsed;
    }
    try {
      const transaction = this.#database.transaction(() => {
        this.requireCurrentProductionStorageFormat();
        const currentSnapshotDigest = this.#currentReference()?.digest;
        if (productionAttempt === undefined) {
          throw new SnapshotConflictError();
        }
        this.#requireProductionRefreshBindings(currentSnapshotDigest);
        this.#requireActiveAttempt(productionAttempt);
        const order = this.#refreshOrder();
        if (order === undefined) {
          throw new SnapshotConflictError();
        }
        const deletion = this.#database
          .prepare(
            `DELETE FROM wordfence_intelligence_refresh_attempts
                  WHERE sequence = ?`,
          )
          .run(productionAttempt.sequence);
        if (deletion.changes !== 1) {
          throw new SnapshotConflictError();
        }
        const existingState = this.#refreshState();
        if (
          productionAttempt.sequence > order.publication_sequence &&
          (existingState === undefined ||
            productionAttempt.sequence >= existingState.attemptSequence)
        ) {
          const state = productionRefreshStateSchema.parse({
            kind: "wordfence-intelligence-production-refresh-state",
            schemaVersion: 2,
            attemptSequence: productionAttempt.sequence,
            ...(currentSnapshotDigest === undefined
              ? {}
              : { currentSnapshotDigest }),
            latestRefresh: {
              kind: "wordfence-intelligence-refresh-attempt",
              schemaVersion: 1,
              attemptedAt: productionAttempt.attemptedAt,
              result: parsed,
            },
          });
          this.#database
            .prepare(
              `INSERT INTO wordfence_intelligence_refresh_state (
                 singleton, state_json
               ) VALUES (1, ?)
               ON CONFLICT(singleton) DO UPDATE SET
                 state_json = excluded.state_json`,
            )
            .run(canonicalJson(state));
        }
        this.#database
          .prepare(
            `UPDATE wordfence_intelligence_refresh_order
                SET latest_completed_sequence = ?
              WHERE singleton = 1`,
          )
          .run(
            Math.max(
              order.latest_completed_sequence,
              productionAttempt.sequence,
            ),
          );
        return this.#productionProjection({
          kind: "wordfence-intelligence-inspection",
          schemaVersion: 1,
        });
      });
      return transaction.immediate();
    } catch (error) {
      if (isStorageFailure(error)) {
        return failure("storage-failure");
      }
      throw error;
    }
  }

  #refreshState(): z.infer<typeof productionRefreshStateSchema> | undefined {
    const row = refreshStateRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT state_json
             FROM wordfence_intelligence_refresh_state
            WHERE singleton = 1`,
        )
        .get(),
    );
    try {
      return row === undefined
        ? undefined
        : productionRefreshStateSchema.parse(JSON.parse(row.state_json));
    } catch {
      throw new SnapshotConflictError();
    }
  }

  #refreshOrder(): z.infer<typeof refreshOrderRowSchema> | undefined {
    return refreshOrderRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT publication_sequence, latest_completed_sequence
             FROM wordfence_intelligence_refresh_order
            WHERE singleton = 1`,
        )
        .get(),
    );
  }

  #requireRefreshOrder(): z.infer<typeof refreshOrderRowSchema> {
    const order = this.#refreshOrder();
    if (order === undefined) {
      throw new SnapshotConflictError();
    }
    return order;
  }

  #allocatedRefreshSequence(): number {
    const allocator = sqliteSequenceRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT seq
             FROM sqlite_sequence
            WHERE name = 'wordfence_intelligence_refresh_attempts'`,
        )
        .get(),
    );
    if (allocator === undefined) {
      throw new SnapshotConflictError();
    }
    return allocator.seq;
  }

  #requireActiveAttempt(attempt: ProductionRefreshAttemptToken): void {
    const row = refreshAttemptRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT sequence, attempted_at, current_snapshot_digest
             FROM wordfence_intelligence_refresh_attempts
            WHERE sequence = ?`,
        )
        .get(attempt.sequence),
    );
    if (row === undefined || row.attempted_at !== attempt.attemptedAt) {
      throw new SnapshotConflictError();
    }
  }

  #requireProductionRefreshBindings(
    currentSnapshotDigest: string | undefined,
  ): void {
    const state = this.#refreshState();
    if (state !== undefined) {
      if (state.currentSnapshotDigest !== currentSnapshotDigest) {
        throw new SnapshotConflictError();
      }
    }
    const attempts = refreshAttemptRowSchema.array().parse(
      this.#database
        .prepare(
          `SELECT sequence, attempted_at, current_snapshot_digest
             FROM wordfence_intelligence_refresh_attempts
            ORDER BY sequence`,
        )
        .all(),
    );
    if (
      attempts.some(
        (attempt) =>
          (attempt.current_snapshot_digest ?? undefined) !==
          currentSnapshotDigest,
      )
    ) {
      throw new SnapshotConflictError();
    }
    const allocatedSequence = this.#allocatedRefreshSequence();
    const order = this.#refreshOrder();
    if (order === undefined) {
      throw new SnapshotConflictError();
    }
    const activeSequence = attempts.at(-1)?.sequence ?? 0;
    const newerAttempts = attempts.filter(
      (attempt) => attempt.sequence > order.latest_completed_sequence,
    );
    if (
      order.publication_sequence > order.latest_completed_sequence ||
      order.publication_sequence > allocatedSequence ||
      order.latest_completed_sequence > allocatedSequence ||
      allocatedSequence !==
        Math.max(order.latest_completed_sequence, activeSequence) ||
      attempts.some(
        (attempt) => attempt.sequence === order.latest_completed_sequence,
      ) ||
      newerAttempts.length !==
        allocatedSequence - order.latest_completed_sequence ||
      newerAttempts.some(
        (attempt, index) =>
          attempt.sequence !== order.latest_completed_sequence + index + 1,
      )
    ) {
      throw new SnapshotConflictError();
    }
    if (order.publication_sequence > 0 && currentSnapshotDigest === undefined) {
      throw new SnapshotConflictError();
    }
    if (
      order.latest_completed_sequence > order.publication_sequence &&
      state === undefined
    ) {
      throw new SnapshotConflictError();
    }
    if (state !== undefined) {
      if (
        state.attemptSequence !== order.latest_completed_sequence ||
        state.attemptSequence <= order.publication_sequence
      ) {
        throw new SnapshotConflictError();
      }
    } else if (
      attempts.length === 0 &&
      state === undefined &&
      order.latest_completed_sequence !== order.publication_sequence
    ) {
      throw new SnapshotConflictError();
    }
  }

  #currentReference(): WordfenceIntelligenceSnapshotRef | undefined {
    const row = currentSnapshotRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT c.snapshot_digest AS current_snapshot_digest,
                  s.snapshot_digest,
                  s.snapshot_id
           FROM wordfence_intelligence_current c
           LEFT JOIN wordfence_intelligence_snapshots s
             ON s.snapshot_digest = c.snapshot_digest
          WHERE c.singleton = 1`,
        )
        .get(),
    );
    if (row === undefined) {
      return undefined;
    }
    if (
      row.snapshot_digest === null ||
      row.snapshot_id === null ||
      row.current_snapshot_digest !== row.snapshot_digest
    ) {
      throw new SnapshotConflictError();
    }
    return wordfenceIntelligenceSnapshotRefSchema.parse({
      kind: "wordfence-intelligence-snapshot-ref",
      schemaVersion: 1,
      id: row.snapshot_id,
      digest: row.snapshot_digest,
    });
  }

  #readSnapshot(
    referenceValue: WordfenceIntelligenceSnapshotRef,
  ): WordfenceIntelligenceSnapshot {
    const reference =
      wordfenceIntelligenceSnapshotRefSchema.parse(referenceValue);
    const row = this.#snapshotRow(reference.digest);
    if (row === undefined) {
      throw new Error("Unknown Wordfence Intelligence snapshot");
    }
    const snapshot = wordfenceIntelligenceSnapshotSchema.parse(
      JSON.parse(row.snapshot_json),
    );
    const expected = snapshotReference(snapshot);
    if (
      row.snapshot_id !== reference.id ||
      expected.id !== reference.id ||
      expected.digest !== reference.digest
    ) {
      throw new Error("Wordfence Intelligence snapshot integrity mismatch");
    }
    return snapshot;
  }

  #snapshotRow(digest: string): SnapshotRow | undefined {
    return snapshotRowSchema.optional().parse(
      this.#database
        .prepare(
          `SELECT snapshot_digest, snapshot_id, snapshot_json
           FROM wordfence_intelligence_snapshots
          WHERE snapshot_digest = ?`,
        )
        .get(digest),
    );
  }

  #records(
    snapshot: WordfenceIntelligenceSnapshot,
    reference: WordfenceIntelligenceSnapshotRef,
    pluginSlug: string,
  ): readonly WordfenceKnownRecord[] {
    return this.#validatedRecordSet(snapshot, reference)
      .filter((stored) => stored.pluginSlug === pluginSlug)
      .map((stored) => stored.record);
  }

  #validatedRecordSet(
    snapshot: WordfenceIntelligenceSnapshot,
    reference: WordfenceIntelligenceSnapshotRef,
  ): readonly WordfenceStoredPluginRecord[] {
    try {
      const manifestRow = recordSetManifestRowSchema.optional().parse(
        this.#database
          .prepare(
            `SELECT manifest_json
             FROM wordfence_intelligence_record_set_manifests
            WHERE snapshot_digest = ?`,
          )
          .get(reference.digest),
      );
      const rows = snapshotRecordRowSchema.array().parse(
        this.#database
          .prepare(
            `SELECT plugin_slug, record_id, record_json
             FROM wordfence_intelligence_records
            WHERE snapshot_digest = ?`,
          )
          .all(reference.digest),
      );
      if (manifestRow === undefined) {
        throw new SnapshotConflictError();
      }
      const manifest = recordSetManifestSchema.parse(
        JSON.parse(manifestRow.manifest_json),
      );
      const records = canonicalRecordOrder(
        rows.map((row) => {
          const stored = wordfenceStoredPluginRecordSchema.parse(
            JSON.parse(row.record_json),
          );
          if (
            stored.pluginSlug !== row.plugin_slug ||
            stored.record.recordId !== row.record_id
          ) {
            throw new SnapshotConflictError();
          }
          return stored;
        }),
      );
      const expectedManifest = recordSetManifest(snapshot, reference, records);
      if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
        throw new SnapshotConflictError();
      }
      return records;
    } catch (error) {
      if (error instanceof SnapshotConflictError) {
        throw error;
      }
      throw new SnapshotConflictError();
    }
  }

  async readKnownRecords(
    request: WordfenceKnownRecordInspectionRequest,
    authorization: KnownRecordAccessAuthorization,
  ): Promise<WordfenceKnownRecordProjection> {
    if (this.#productionReadOnly) {
      return this.#validatedProductionRead(() => {
        const result = this.#knownRecordProjection(request, authorization);
        const snapshot = this.#readSnapshot(request.snapshotRef);
        return {
          result,
          contentDigest: snapshot.source.contentDigest,
        };
      });
    }
    return this.#knownRecordProjection(request, authorization);
  }
}
