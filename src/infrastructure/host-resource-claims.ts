import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

const key = z.string().regex(/^[a-z0-9][a-z0-9:._/-]{0,255}$/);
const providerKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absolutePath = z.string().regex(/^\/[^\0]+$/);
export const RECOVERY_SETTLE_MS = 120_000;

export const hostResourceLimitsSchema = z.strictObject({
  maxTargets: z.number().int().min(1).max(64),
  providers: z.record(providerKey, z.number().int().min(1).max(64)),
});

const requestSchema = z.strictObject({
  targetKey: key,
  ownerKey: key,
  ownerPid: z.number().int().positive(),
  stateDirectory: absolutePath,
  campaignId: z.string().min(1).max(128),
  snapshotDigest: digest,
  providerKeys: z.array(providerKey).min(1).max(8),
  /** Starts when the claim is acquired, so a capacity wait cannot expire it. */
  leaseDurationMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000),
});

const rowSchema = z.object({
  claim_id: z.string().uuid(),
  target_key: key,
  owner_key: key,
  owner_pid: z.number().int().positive(),
  state_directory: absolutePath,
  campaign_id: z.string().min(1).max(128),
  snapshot_digest: digest,
  provider_keys_json: z.string(),
  deadline_at: z.iso.datetime({ offset: true }),
  status: z.enum(["active", "recovery-needed", "released"]),
  acquired_at: z.iso.datetime({ offset: true }),
  first_absent_at: z.iso.datetime({ offset: true }).nullable(),
});
const activeRowSchema = rowSchema.extend({
  status: z.enum(["active", "recovery-needed"]),
});

export type HostResourceClaimHandle = {
  readonly claimId: string;
  /** Process-private capability. Never put this in a ledger or status output. */
  readonly token: string;
};

export type HostResourceClaimRequest = z.infer<typeof requestSchema>;
export type HostResourceClaimResult =
  | { readonly status: "acquired"; readonly handle: HostResourceClaimHandle }
  | {
      readonly status: "waiting";
      readonly reason: "target-busy" | "host-capacity" | "provider-capacity";
      readonly providerKey?: string;
    };

type ClaimRow = z.infer<typeof rowSchema>;
type ActiveClaimRow = z.infer<typeof activeRowSchema>;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Uncertain errors, including EPERM, must retain the claim.
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

/** A host-common SQLite claim table. A deadline is an alarm, never permission to reuse a slot. */
export class SqliteHostResourceClaims {
  readonly #db: DatabaseSync;
  readonly #clock: () => Date;

  constructor(
    databasePath: string,
    limits: unknown,
    clock: () => Date = () => new Date(),
  ) {
    const parsedLimits = hostResourceLimitsSchema.parse(limits);
    this.#clock = clock;
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS host_resource_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_resource_claims (
        claim_id TEXT PRIMARY KEY,
        target_key TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        state_directory TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        provider_keys_json TEXT NOT NULL,
        token_digest TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'recovery-needed', 'released')),
        acquired_at TEXT NOT NULL,
        released_at TEXT,
        reconciliation_digest TEXT,
        first_absent_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS host_resource_active_target
        ON host_resource_claims (target_key)
        WHERE status IN ('active', 'recovery-needed');
    `);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO host_resource_meta (key, value) VALUES ('limits', ?)",
        )
        .run(canonicalJson(parsedLimits));
      const current = this.#readLimits();
      if (canonicalJson(current) !== canonicalJson(parsedLimits)) {
        if (this.#activeRows().length !== 0)
          throw new Error(
            "Host resource limits differ while claims are active",
          );
        this.#db
          .prepare(
            "UPDATE host_resource_meta SET value = ? WHERE key = 'limits'",
          )
          .run(canonicalJson(parsedLimits));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #readLimits(): z.infer<typeof hostResourceLimitsSchema> {
    const row = z
      .object({ value: z.string() })
      .parse(
        this.#db
          .prepare("SELECT value FROM host_resource_meta WHERE key = 'limits'")
          .get(),
      );
    return hostResourceLimitsSchema.parse(JSON.parse(row.value) as unknown);
  }

  /** An operator may tune capacity only while every claim is released. */
  setLimits(value: unknown): void {
    const limits = hostResourceLimitsSchema.parse(value);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#activeRows().length !== 0)
        throw new Error(
          "Host resource limits cannot change while claims are active",
        );
      this.#db
        .prepare("UPDATE host_resource_meta SET value = ? WHERE key = 'limits'")
        .run(canonicalJson(limits));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #activeRows(): ActiveClaimRow[] {
    return this.#db
      .prepare(
        "SELECT claim_id, target_key, owner_key, owner_pid, state_directory, campaign_id, snapshot_digest, provider_keys_json, deadline_at, status, acquired_at, first_absent_at FROM host_resource_claims WHERE status != 'released' ORDER BY acquired_at, claim_id",
      )
      .all()
      .map((row) => activeRowSchema.parse(row));
  }

  tryAcquire(value: unknown): HostResourceClaimResult {
    const request = requestSchema.parse(value);
    const providers = [...new Set(request.providerKeys)];
    if (providers.length !== request.providerKeys.length)
      throw new Error("Resource claim repeats a provider");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const limits = this.#readLimits();
      for (const provider of providers)
        if (limits.providers[provider] === undefined)
          throw new Error(`No host capacity is configured for ${provider}`);
      const active = this.#activeRows();
      let waiting:
        Exclude<HostResourceClaimResult, { status: "acquired" }> | undefined;
      if (active.some((claim) => claim.target_key === request.targetKey))
        waiting = { status: "waiting", reason: "target-busy" };
      else if (active.length >= limits.maxTargets)
        waiting = { status: "waiting", reason: "host-capacity" };
      else {
        for (const provider of providers) {
          const inUse = active.filter((claim) =>
            z
              .array(providerKey)
              .parse(JSON.parse(claim.provider_keys_json) as unknown)
              .includes(provider),
          ).length;
          if (inUse >= limits.providers[provider]!) {
            waiting = {
              status: "waiting",
              reason: "provider-capacity",
              providerKey: provider,
            };
            break;
          }
        }
      }
      if (waiting !== undefined) {
        this.#db.exec("COMMIT");
        return waiting;
      }
      const claimId = randomUUID();
      const token = randomBytes(32).toString("hex");
      const acquiredAt = this.#clock();
      const deadlineAt = new Date(
        acquiredAt.getTime() + request.leaseDurationMs,
      ).toISOString();
      this.#db
        .prepare(
          "INSERT INTO host_resource_claims (claim_id, target_key, owner_key, owner_pid, state_directory, campaign_id, snapshot_digest, provider_keys_json, token_digest, deadline_at, status, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        )
        .run(
          claimId,
          request.targetKey,
          request.ownerKey,
          request.ownerPid,
          request.stateDirectory,
          request.campaignId,
          request.snapshotDigest,
          JSON.stringify(providers),
          createHash("sha256").update(token).digest("hex"),
          deadlineAt,
          acquiredAt.toISOString(),
        );
      this.#db.exec("COMMIT");
      return { status: "acquired", handle: { claimId, token } };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async waitForClaim(
    value: HostResourceClaimRequest,
    options: {
      readonly signal?: AbortSignal;
      readonly pollMs?: number;
      readonly onWait?: (
        reason: Exclude<HostResourceClaimResult, { status: "acquired" }>,
      ) => void;
    } = {},
  ): Promise<HostResourceClaimHandle> {
    const pollMs = options.pollMs ?? 1000;
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000)
      throw new Error("Invalid resource claim polling interval");
    for (;;) {
      options.signal?.throwIfAborted();
      const result = this.tryAcquire(value);
      if (result.status === "acquired") return result.handle;
      options.onWait?.(result);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          options.signal?.removeEventListener("abort", aborted);
          resolve();
        };
        const timer = setTimeout(done, pollMs);
        const aborted = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", aborted);
          reject(options.signal?.reason ?? new Error("Wait aborted"));
        };
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
      });
    }
  }

  #owned(handle: HostResourceClaimHandle): ClaimRow {
    const row = this.#db
      .prepare(
        "SELECT claim_id, target_key, owner_key, owner_pid, state_directory, campaign_id, snapshot_digest, provider_keys_json, deadline_at, status, acquired_at, first_absent_at, token_digest FROM host_resource_claims WHERE claim_id = ?",
      )
      .get(handle.claimId);
    const owned = rowSchema.extend({ token_digest: z.string() }).parse(row);
    const actual = createHash("sha256").update(handle.token).digest("hex");
    if (actual !== owned.token_digest)
      throw new Error("Resource claim capability does not match");
    return owned;
  }

  release(handle: HostResourceClaimHandle): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#owned(handle);
      if (row.status !== "active")
        throw new Error("Only a clean active claim may be released");
      this.#db
        .prepare(
          "UPDATE host_resource_claims SET status = 'released', released_at = ? WHERE claim_id = ? AND status = 'active'",
        )
        .run(this.#clock().toISOString(), handle.claimId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  requireRecovery(handle: HostResourceClaimHandle): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#owned(handle);
      if (row.status !== "active")
        throw new Error("Only an active claim may enter recovery");
      this.#db
        .prepare(
          "UPDATE host_resource_claims SET status = 'recovery-needed' WHERE claim_id = ? AND status = 'active'",
        )
        .run(handle.claimId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Expiry only changes the alarm state; it never frees target or provider capacity. */
  flagOverdueForRecovery(claimId: string): boolean {
    z.string().uuid().parse(claimId);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#activeRows().find(
        (claim) => claim.claim_id === claimId,
      );
      const overdue =
        row?.status === "active" &&
        Date.parse(row.deadline_at) <= this.#clock().getTime() &&
        !processIsAlive(row.owner_pid);
      if (overdue)
        this.#db
          .prepare(
            "UPDATE host_resource_claims SET status = 'recovery-needed' WHERE claim_id = ? AND status = 'active'",
          )
          .run(claimId);
      this.#db.exec("COMMIT");
      return overdue;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A dead owner's claim is reusable only after a fresh ledger and Docker inspection. */
  async reconcileAbsent(
    claimId: string,
    inspect: (claim: {
      readonly targetKey: string;
      readonly ownerKey: string;
      readonly stateDirectory: string;
      readonly campaignId: string;
      readonly snapshotDigest: string;
      readonly deadlineAt: string;
    }) => Promise<{
      readonly ledgerInspected: true;
      readonly unresolvedRunIds: readonly string[];
      readonly labHasResources: boolean;
      readonly brokerHasResources: boolean;
      readonly evidenceDigest: string;
    }>,
  ): Promise<boolean> {
    z.string().uuid().parse(claimId);
    const claim = this.#activeRows().find((row) => row.claim_id === claimId);
    if (claim === undefined) throw new Error("No active claim has that id");
    if (processIsAlive(claim.owner_pid))
      throw new Error("Claim owner process is still alive");
    if (claim.status === "active") {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db
          .prepare(
            "UPDATE host_resource_claims SET status = 'recovery-needed' WHERE claim_id = ? AND status = 'active'",
          )
          .run(claimId);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    const observed = await inspect({
      targetKey: claim.target_key,
      ownerKey: claim.owner_key,
      stateDirectory: claim.state_directory,
      campaignId: claim.campaign_id,
      snapshotDigest: claim.snapshot_digest,
      deadlineAt: claim.deadline_at,
    });
    digest.parse(observed.evidenceDigest);
    // Unfinished ledger starts remain visible and the repeat-Trial gate still
    // counts them. They do not prove a live Trial after the owner and every
    // disposable runtime resource are absent.
    if (processIsAlive(claim.owner_pid))
      throw new Error("Claim owner process became live during reconciliation");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#activeRows().find(
        (row) => row.claim_id === claimId,
      );
      if (current?.status !== "recovery-needed")
        throw new Error("Claim is not awaiting reconciliation");
      if (observed.labHasResources || observed.brokerHasResources) {
        this.#db
          .prepare(
            "UPDATE host_resource_claims SET first_absent_at = NULL WHERE claim_id = ?",
          )
          .run(claimId);
        this.#db.exec("COMMIT");
        return false;
      }
      const now = this.#clock();
      if (current.first_absent_at === null) {
        this.#db
          .prepare(
            "UPDATE host_resource_claims SET first_absent_at = ? WHERE claim_id = ?",
          )
          .run(now.toISOString(), claimId);
        this.#db.exec("COMMIT");
        return false;
      }
      // A Docker create already in flight when its owner died may finish
      // after the first empty listing. Require a fresh second observation.
      if (
        now.getTime() - Date.parse(current.first_absent_at) <
        RECOVERY_SETTLE_MS
      ) {
        this.#db.exec("COMMIT");
        return false;
      }
      const changed = this.#db
        .prepare(
          "UPDATE host_resource_claims SET status = 'released', released_at = ?, reconciliation_digest = ? WHERE claim_id = ? AND status = 'recovery-needed'",
        )
        .run(now.toISOString(), observed.evidenceDigest, claimId);
      if (Number(changed.changes) !== 1)
        throw new Error("Claim is not awaiting reconciliation");
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  status(): {
    readonly maxTargets: number;
    readonly usedTargets: number;
    readonly providers: Readonly<
      Record<string, { readonly used: number; readonly limit: number }>
    >;
    readonly claims: readonly {
      readonly claimId: string;
      readonly targetKey: string;
      readonly ownerKey: string;
      readonly ownerPid: number;
      readonly ownerAlive: boolean;
      readonly stateDirectory: string;
      readonly campaignId: string;
      readonly snapshotDigest: string;
      readonly status: "active" | "recovery-needed";
      readonly deadlineAt: string;
      readonly overdue: boolean;
      readonly firstAbsentAt: string | null;
      readonly recoveryEligibleAt: string | null;
    }[];
  } {
    const rows = this.#activeRows();
    const limits = this.#readLimits();
    const providers = Object.fromEntries(
      Object.entries(limits.providers).map(([provider, limit]) => [
        provider,
        {
          used: rows.filter((row) =>
            z
              .array(providerKey)
              .parse(JSON.parse(row.provider_keys_json) as unknown)
              .includes(provider),
          ).length,
          limit,
        },
      ]),
    );
    return {
      maxTargets: limits.maxTargets,
      usedTargets: rows.length,
      providers,
      claims: rows.map((row) => ({
        claimId: row.claim_id,
        targetKey: row.target_key,
        ownerKey: row.owner_key,
        ownerPid: row.owner_pid,
        ownerAlive: processIsAlive(row.owner_pid),
        stateDirectory: row.state_directory,
        campaignId: row.campaign_id,
        snapshotDigest: row.snapshot_digest,
        status: row.status,
        deadlineAt: row.deadline_at,
        overdue: Date.parse(row.deadline_at) <= this.#clock().getTime(),
        firstAbsentAt: row.first_absent_at,
        recoveryEligibleAt:
          row.first_absent_at === null
            ? null
            : new Date(
                Date.parse(row.first_absent_at) + RECOVERY_SETTLE_MS,
              ).toISOString(),
      })),
    };
  }
}
