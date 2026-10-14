import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { canonicalDigest, canonicalJson } from "./canonical-json.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const reason = z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,127}$/);
export const continuousRunStateSchema = z.enum([
  "RUNNING",
  "WAIT_QUOTA",
  "WAIT_REVIEW",
  "STOPPING",
  "RECOVERING",
  "STOPPED",
]);
export type ContinuousRunState = z.infer<typeof continuousRunStateSchema>;

const creationSchema = z.strictObject({
  parentRunId: id,
  configDigest: digest,
  policyDigest: digest,
  inventoryDigest: digest,
});

const transitionSchema = z.strictObject({
  state: continuousRunStateSchema,
  reason: reason.nullable(),
  nextCheckAt: instant.nullable(),
  inventoryDigest: digest.optional(),
  lastLedgerSequence: z.number().int().nonnegative().optional(),
});
const bindingSchema = z.strictObject({
  selectionBatchId: id,
  snapshotDigests: z.array(digest).min(1).max(5),
});

const runRowSchema = z.object({
  parent_id: id,
  config_digest: digest,
  policy_digest: digest,
  initial_inventory_digest: digest,
  inventory_digest: digest,
  state: continuousRunStateSchema,
  reason: reason.nullable(),
  next_check_at: instant.nullable(),
  stop_requested: z.number().int().min(0).max(1),
  last_ledger_sequence: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  created_at: instant,
  updated_at: instant,
});

const childRowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  campaign_id: id,
  inventory_digest: digest,
  selection_batch_id: id.nullable(),
  snapshot_digests_json: z.string().nullable(),
  status: z.enum(["reserved", "settled"]),
  reserved_at: instant,
  settled_at: instant.nullable(),
});

export type ContinuousChild = {
  readonly ordinal: number;
  readonly campaignId: string;
  readonly inventoryDigest: string;
  readonly binding: {
    readonly selectionBatchId: string;
    readonly snapshotDigests: readonly string[];
  } | null;
  readonly status: "reserved" | "settled";
  readonly reservedAt: string;
  readonly settledAt: string | null;
};

export type ContinuousRunRecord = {
  readonly parentRunId: string;
  readonly configDigest: string;
  readonly policyDigest: string;
  readonly initialInventoryDigest: string;
  readonly inventoryDigest: string;
  readonly state: ContinuousRunState;
  readonly reason: string | null;
  readonly nextCheckAt: string | null;
  readonly stopRequested: boolean;
  readonly lastLedgerSequence: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly children: readonly ContinuousChild[];
};

/** A stable child identity can be recovered after a crash before any Trial starts. */
export function continuousChildCampaignId(
  parentRunId: string,
  ordinal: number,
): string {
  id.parse(parentRunId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new Error("Invalid child ordinal");
  return `continuous-${canonicalDigest({ parentRunId, ordinal }).slice(7, 39)}`;
}

/** Private operational journal; child campaign events remain in the append-only ledger. */
export class SqliteContinuousRunJournal {
  readonly #db: DatabaseSync;
  readonly #clock: () => Date;

  constructor(databasePath: string, clock: () => Date = () => new Date()) {
    this.#clock = clock;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS continuous_runs (
        parent_id TEXT PRIMARY KEY,
        config_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        initial_inventory_digest TEXT NOT NULL,
        inventory_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        reason TEXT,
        next_check_at TEXT,
        stop_requested INTEGER NOT NULL,
        last_ledger_sequence INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuous_children (
        parent_id TEXT NOT NULL REFERENCES continuous_runs(parent_id),
        ordinal INTEGER NOT NULL,
        campaign_id TEXT NOT NULL UNIQUE,
        inventory_digest TEXT NOT NULL,
        selection_batch_id TEXT,
        snapshot_digests_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('reserved', 'settled')),
        reserved_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (parent_id, ordinal)
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(parentRunId: string): ContinuousRunRecord | null {
    const parentId = id.parse(parentRunId);
    const raw = this.#db
      .prepare("SELECT * FROM continuous_runs WHERE parent_id = ?")
      .get(parentId);
    if (raw === undefined) return null;
    const row = runRowSchema.parse(raw);
    const children = this.#db
      .prepare(
        "SELECT ordinal, campaign_id, inventory_digest, selection_batch_id, snapshot_digests_json, status, reserved_at, settled_at FROM continuous_children WHERE parent_id = ? ORDER BY ordinal",
      )
      .all(parentId)
      .map((child) => {
        const parsed = childRowSchema.parse(child);
        if (
          (parsed.selection_batch_id === null) !==
          (parsed.snapshot_digests_json === null)
        )
          throw new Error("Incomplete child binding in journal");
        const binding =
          parsed.selection_batch_id === null
            ? null
            : bindingSchema.parse({
                selectionBatchId: parsed.selection_batch_id,
                snapshotDigests: JSON.parse(parsed.snapshot_digests_json!),
              });
        return {
          ordinal: parsed.ordinal,
          campaignId: parsed.campaign_id,
          inventoryDigest: parsed.inventory_digest,
          binding,
          status: parsed.status,
          reservedAt: parsed.reserved_at,
          settledAt: parsed.settled_at,
        };
      });
    return {
      parentRunId: row.parent_id,
      configDigest: row.config_digest,
      policyDigest: row.policy_digest,
      initialInventoryDigest: row.initial_inventory_digest,
      inventoryDigest: row.inventory_digest,
      state: row.state,
      reason: row.reason,
      nextCheckAt: row.next_check_at,
      stopRequested: row.stop_requested === 1,
      lastLedgerSequence: row.last_ledger_sequence,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      children,
    };
  }

  #current(parentRunId: string, expectedRevision: number): ContinuousRunRecord {
    const current = this.get(parentRunId);
    if (current === null) throw new Error("Continuous run not found");
    if (current.revision !== expectedRevision)
      throw new Error("Continuous run revision conflict");
    return current;
  }

  create(value: unknown): ContinuousRunRecord {
    const input = creationSchema.parse(value);
    return this.#transaction(() => {
      const now = this.#clock().toISOString();
      this.#db
        .prepare(
          "INSERT INTO continuous_runs (parent_id, config_digest, policy_digest, initial_inventory_digest, inventory_digest, state, reason, next_check_at, stop_requested, last_ledger_sequence, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', NULL, NULL, 0, 0, 0, ?, ?)",
        )
        .run(
          input.parentRunId,
          input.configDigest,
          input.policyDigest,
          input.inventoryDigest,
          input.inventoryDigest,
          now,
          now,
        );
      return this.get(input.parentRunId)!;
    });
  }

  transition(
    parentRunId: string,
    expectedRevision: number,
    value: unknown,
  ): ContinuousRunRecord {
    const next = transitionSchema.parse(value);
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      if (current.stopRequested && next.state === "RUNNING")
        throw new Error("Stop request must be cleared before running");
      if (next.state === "WAIT_QUOTA" && next.nextCheckAt === null)
        throw new Error("Quota wait needs a next check time");
      if (next.state !== "RUNNING" && next.reason === null)
        throw new Error("Non-running state needs a reason code");
      const sequence = next.lastLedgerSequence ?? current.lastLedgerSequence;
      if (sequence < current.lastLedgerSequence)
        throw new Error("Ledger progress cannot move backwards");
      this.#db
        .prepare(
          "UPDATE continuous_runs SET inventory_digest = ?, state = ?, reason = ?, next_check_at = ?, last_ledger_sequence = ?, revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(
          next.inventoryDigest ?? current.inventoryDigest,
          next.state,
          next.reason,
          next.nextCheckAt,
          sequence,
          this.#clock().toISOString(),
          parentRunId,
        );
      return this.get(parentRunId)!;
    });
  }

  /** Stop is idempotent and preempts a stale worker's next CAS transition. */
  requestStop(
    parentRunId: string,
    reasonCode = "operator-stop",
  ): ContinuousRunRecord {
    const stopReason = reason.parse(reasonCode);
    return this.#transaction(() => {
      const current = this.get(parentRunId);
      if (current === null) throw new Error("Continuous run not found");
      if (current.stopRequested) return current;
      this.#db
        .prepare(
          "UPDATE continuous_runs SET stop_requested = 1, state = ?, reason = ?, next_check_at = NULL, revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(
          current.state === "STOPPED" ? "STOPPED" : "STOPPING",
          stopReason,
          this.#clock().toISOString(),
          parentRunId,
        );
      return this.get(parentRunId)!;
    });
  }

  /**
   * An operator may start a stopped parent again after checking its children.
   * A reserved child requires an external ledger/claim/owner reconciliation;
   * its identity must be retained so a stopped Trial is never replaced.
   */
  resume(
    parentRunId: string,
    expectedRevision: number,
    options: { readonly reservedChildReconciled?: true } = {},
  ): ContinuousRunRecord {
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      if (current.state !== "STOPPED")
        throw new Error("Only a stopped continuous run can resume");
      if (
        current.children.some((child) => child.status === "reserved") &&
        options.reservedChildReconciled !== true
      )
        throw new Error("Reconcile the reserved child before resuming");
      this.#db
        .prepare(
          "UPDATE continuous_runs SET stop_requested = 0, state = 'RUNNING', reason = NULL, next_check_at = NULL, revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(this.#clock().toISOString(), parentRunId);
      return this.get(parentRunId)!;
    });
  }

  /** Durable intent precedes selecting or starting any child campaign. */
  reserveChild(
    parentRunId: string,
    expectedRevision: number,
  ): ContinuousRunRecord {
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      if (current.state !== "RUNNING" || current.stopRequested)
        throw new Error("Continuous run is not accepting children");
      if (current.children.at(-1)?.status === "reserved") return current;
      const ordinal = current.children.length;
      this.#db
        .prepare(
          "INSERT INTO continuous_children (parent_id, ordinal, campaign_id, inventory_digest, status, reserved_at, settled_at) VALUES (?, ?, ?, ?, 'reserved', ?, NULL)",
        )
        .run(
          parentRunId,
          ordinal,
          continuousChildCampaignId(parentRunId, ordinal),
          current.inventoryDigest,
          this.#clock().toISOString(),
        );
      this.#db
        .prepare(
          "UPDATE continuous_runs SET revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(this.#clock().toISOString(), parentRunId);
      return this.get(parentRunId)!;
    });
  }

  /**
   * Refill an unbound child from the next verified inventory page. The caller
   * must first prove that this child has no selection ledger events; a bound
   * child always keeps its original inventory and Snapshot set.
   */
  advanceUnboundChildInventory(
    parentRunId: string,
    expectedRevision: number,
    ordinal: number,
    inventoryDigest: string,
  ): ContinuousRunRecord {
    const nextDigest = digest.parse(inventoryDigest);
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      const child = current.children[ordinal];
      if (
        current.state !== "RUNNING" ||
        current.stopRequested ||
        child === undefined ||
        child.status !== "reserved" ||
        child.binding !== null ||
        ordinal !== current.children.length - 1
      )
        throw new Error("Only the active unbound child may advance inventory");
      if (nextDigest === current.inventoryDigest)
        throw new Error("Continuous inventory did not advance");
      this.#db
        .prepare(
          "UPDATE continuous_children SET inventory_digest = ? WHERE parent_id = ? AND ordinal = ?",
        )
        .run(nextDigest, parentRunId, ordinal);
      this.#db
        .prepare(
          "UPDATE continuous_runs SET inventory_digest = ?, revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(nextDigest, this.#clock().toISOString(), parentRunId);
      return this.get(parentRunId)!;
    });
  }

  /** Fix the child's selected Snapshot set; never replace it on resume. */
  bindChild(
    parentRunId: string,
    expectedRevision: number,
    ordinal: number,
    value: unknown,
  ): ContinuousRunRecord {
    const binding = bindingSchema.parse(value);
    if (
      new Set(binding.snapshotDigests).size !== binding.snapshotDigests.length
    )
      throw new Error("Child binding repeats a Snapshot");
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      const child = current.children[ordinal];
      if (child === undefined || child.status !== "reserved")
        throw new Error("Child reservation is not active");
      if (child.binding !== null) {
        if (canonicalJson(child.binding) !== canonicalJson(binding))
          throw new Error("Child selection binding conflict");
        return current;
      }
      this.#db
        .prepare(
          "UPDATE continuous_children SET selection_batch_id = ?, snapshot_digests_json = ? WHERE parent_id = ? AND ordinal = ?",
        )
        .run(
          binding.selectionBatchId,
          canonicalJson(binding.snapshotDigests),
          parentRunId,
          ordinal,
        );
      this.#db
        .prepare(
          "UPDATE continuous_runs SET revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(this.#clock().toISOString(), parentRunId);
      return this.get(parentRunId)!;
    });
  }

  settleChild(
    parentRunId: string,
    expectedRevision: number,
    ordinal: number,
    lastLedgerSequence: number,
  ): ContinuousRunRecord {
    return this.#transaction(() => {
      const current = this.#current(parentRunId, expectedRevision);
      const child = current.children[ordinal];
      if (child === undefined || child.status !== "reserved")
        throw new Error("Child reservation is not active");
      if (child.binding === null)
        throw new Error(
          "Child selection binding is required before settlement",
        );
      if (
        !Number.isSafeInteger(lastLedgerSequence) ||
        lastLedgerSequence < current.lastLedgerSequence
      )
        throw new Error("Ledger progress cannot move backwards");
      this.#db
        .prepare(
          "UPDATE continuous_children SET status = 'settled', settled_at = ? WHERE parent_id = ? AND ordinal = ?",
        )
        .run(this.#clock().toISOString(), parentRunId, ordinal);
      this.#db
        .prepare(
          "UPDATE continuous_runs SET last_ledger_sequence = ?, revision = revision + 1, updated_at = ? WHERE parent_id = ?",
        )
        .run(lastLedgerSequence, this.#clock().toISOString(), parentRunId);
      return this.get(parentRunId)!;
    });
  }
}
