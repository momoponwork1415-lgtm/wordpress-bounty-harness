import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

const parentId = z.string().min(1).max(128);
const ownerPid = z.number().int().positive();
const token = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const ownerRow = z.object({
  parent_id: parentId,
  owner_pid: ownerPid,
  token_digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["active", "recovery-required"]),
  acquired_at: instant,
  reconciliation_digest: digest.nullable(),
});
const observationRow = ownerRow.pick({ owner_pid: true, status: true });
const handleSchema = z.strictObject({ parentRunId: parentId, token });

export type ContinuousRunOwnerHandle = z.infer<typeof handleSchema>;
export type PidLiveness = "alive" | "dead" | "unknown";
export type ContinuousRunOwnerObservation =
  | {
      readonly pidLiveness: "no-claim";
      readonly claimStatus: null;
      readonly ownerPid: null;
    }
  | {
      readonly pidLiveness: "unknown";
      readonly claimStatus: null;
      readonly ownerPid: null;
      readonly reason: "owner-store-unavailable";
    }
  | {
      readonly pidLiveness: PidLiveness;
      readonly claimStatus: "active" | "recovery-required";
      readonly ownerPid: number;
    };
export type ContinuousRunOwnerResult =
  | {
      readonly status: "acquired";
      readonly handle: ContinuousRunOwnerHandle;
      readonly recoveryRequired: boolean;
    }
  | {
      readonly status: "busy";
      readonly reason: "live-owner" | "owner-liveness-unknown";
      readonly ownerPid: number;
    };

function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}

/** A point-in-time observation only. PID presence never proves a live worker
 * or authorizes recovery; the owner claim and external state still need the
 * normal reconciliation path. This never creates or updates the owner DB. */
export function observeContinuousRunOwner(
  databasePath: string,
  value: string,
  options: { readonly pidLiveness?: (pid: number) => PidLiveness } = {},
): ContinuousRunOwnerObservation {
  const id = parentId.parse(value);
  try {
    statSync(databasePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { pidLiveness: "no-claim", claimStatus: null, ownerPid: null };
    return {
      pidLiveness: "unknown",
      claimStatus: null,
      ownerPid: null,
      reason: "owner-store-unavailable",
    };
  }

  let row: z.infer<typeof observationRow> | null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    const result = db
      .prepare(
        "SELECT owner_pid, status FROM continuous_run_owners WHERE parent_id = ?",
      )
      .get(id);
    row = result === undefined ? null : observationRow.parse(result);
  } catch {
    return {
      pidLiveness: "unknown",
      claimStatus: null,
      ownerPid: null,
      reason: "owner-store-unavailable",
    };
  } finally {
    db?.close();
  }
  if (row === null)
    return { pidLiveness: "no-claim", claimStatus: null, ownerPid: null };
  let liveness: PidLiveness;
  try {
    liveness = (options.pidLiveness ?? pidLiveness)(row.owner_pid);
  } catch {
    liveness = "unknown";
  }
  return {
    pidLiveness: liveness,
    claimStatus: row.status,
    ownerPid: row.owner_pid,
  };
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Host-common parent ownership. A dead PID transfers ownership only into recovery. */
export class SqliteContinuousRunOwner {
  readonly #db: DatabaseSync;
  readonly #clock: () => Date;
  readonly #pidLiveness: (pid: number) => PidLiveness;

  constructor(
    databasePath: string,
    options: {
      readonly clock?: () => Date;
      readonly pidLiveness?: (pid: number) => PidLiveness;
    } = {},
  ) {
    this.#clock = options.clock ?? (() => new Date());
    this.#pidLiveness = options.pidLiveness ?? pidLiveness;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS continuous_run_owners (
        parent_id TEXT PRIMARY KEY,
        owner_pid INTEGER NOT NULL,
        token_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'recovery-required')),
        acquired_at TEXT NOT NULL,
        reconciliation_digest TEXT
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

  #get(parentRunId: string): z.infer<typeof ownerRow> | null {
    const row = this.#db
      .prepare("SELECT * FROM continuous_run_owners WHERE parent_id = ?")
      .get(parentRunId);
    return row === undefined ? null : ownerRow.parse(row);
  }

  /** No timeout may displace a live or uncertain owner. */
  tryAcquire(
    value: string,
    pid: number = process.pid,
  ): ContinuousRunOwnerResult {
    const id = parentId.parse(value);
    ownerPid.parse(pid);
    return this.#transaction(() => {
      const current = this.#get(id);
      if (current !== null) {
        const liveness = this.#pidLiveness(current.owner_pid);
        if (liveness !== "dead")
          return {
            status: "busy",
            reason:
              liveness === "alive" ? "live-owner" : "owner-liveness-unknown",
            ownerPid: current.owner_pid,
          };
      }
      const capability = randomBytes(32).toString("hex");
      const hashed = tokenDigest(capability).toString("hex");
      const acquiredAt = this.#clock().toISOString();
      if (current === null) {
        this.#db
          .prepare(
            "INSERT INTO continuous_run_owners (parent_id, owner_pid, token_digest, status, acquired_at, reconciliation_digest) VALUES (?, ?, ?, 'active', ?, NULL)",
          )
          .run(id, pid, hashed, acquiredAt);
      } else {
        this.#db
          .prepare(
            "UPDATE continuous_run_owners SET owner_pid = ?, token_digest = ?, status = 'recovery-required', acquired_at = ?, reconciliation_digest = NULL WHERE parent_id = ?",
          )
          .run(pid, hashed, acquiredAt, id);
      }
      return {
        status: "acquired",
        handle: { parentRunId: id, token: capability },
        recoveryRequired: current !== null,
      };
    });
  }

  #owned(value: ContinuousRunOwnerHandle): z.infer<typeof ownerRow> {
    const handle = handleSchema.parse(value);
    const current = this.#get(handle.parentRunId);
    if (current === null) throw new Error("No parent run owner claim");
    if (
      !timingSafeEqual(
        tokenDigest(handle.token),
        Buffer.from(current.token_digest, "hex"),
      )
    )
      throw new Error("Parent run owner capability does not match");
    return current;
  }

  /** Call only after external ledger and host-resource reconciliation succeeds.
   * The digest is an audit reference, not proof checked by this class. */
  markReconciled(
    handle: ContinuousRunOwnerHandle,
    evidenceDigest: string,
  ): void {
    digest.parse(evidenceDigest);
    this.#transaction(() => {
      const current = this.#owned(handle);
      if (current.status !== "recovery-required")
        throw new Error("Parent run is not awaiting recovery");
      this.#db
        .prepare(
          "UPDATE continuous_run_owners SET status = 'active', reconciliation_digest = ? WHERE parent_id = ?",
        )
        .run(evidenceDigest, current.parent_id);
    });
  }

  /** Call before dispatching each child campaign. */
  assertReady(handle: ContinuousRunOwnerHandle): void {
    const current = this.#owned(handle);
    if (current.status !== "active")
      throw new Error("Parent run requires recovery before dispatch");
  }

  /** Preserve uncertainty when a child or its resources cannot be reconciled. */
  requireRecovery(handle: ContinuousRunOwnerHandle): void {
    this.#transaction(() => {
      const current = this.#owned(handle);
      this.#db
        .prepare(
          "UPDATE continuous_run_owners SET status = 'recovery-required', reconciliation_digest = NULL WHERE parent_id = ?",
        )
        .run(current.parent_id);
    });
  }

  /** A recovery-required claim cannot be dropped to bypass reconciliation. */
  release(handle: ContinuousRunOwnerHandle): void {
    this.#transaction(() => {
      const current = this.#owned(handle);
      if (current.status !== "active")
        throw new Error("Only a reconciled parent run may release ownership");
      this.#db
        .prepare("DELETE FROM continuous_run_owners WHERE parent_id = ?")
        .run(current.parent_id);
    });
  }
}
