import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { ledgerEventV1Schema } from "../../../ledger/index.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const id = z.string().min(1).max(128);

export const repeatTrialInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Every known historical --state directory, including the default one. */
  stateDirectories: z.array(z.string().min(1)).min(1),
  inventoriedBy: z.string().min(1).max(128),
  inventoriedAt: z.iso.datetime({ offset: true }),
});

export const repeatTrialApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stateDirectory: z.string().min(1),
  slug,
  snapshotDigest: digest,
  promptDigest: digest,
  campaignId: id,
  trialOrdinal: z.number().int().nonnegative(),
  approvedBy: z.string().min(1).max(128),
  approvedAt: z.iso.datetime({ offset: true }),
  /** Operational purpose only; unpublished Finding details stay in Private Evidence. */
  purpose: z.string().min(1).max(500),
});

/**
 * A partial, metadata-only legacy audit may identify slugs that must be held.
 * Its digest refers to audit evidence outside Git; it never certifies that all
 * historical sources have been searched.
 */
export const repeatTrialAmbiguityManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  auditDigest: digest,
  ambiguousSlugs: z.array(slug),
});

export type InitialSlugEligibility =
  | { readonly status: "prior-start"; readonly startedTrials: number }
  | { readonly status: "hold-ambiguous"; readonly auditDigest: string }
  | {
      readonly status: "coverage-incomplete";
      readonly reason:
        "state-inventory-uninitialized" | "legacy-history-unverified";
    }
  /** Reserved for a future verified, complete coverage import. Never emitted today. */
  | { readonly status: "eligible"; readonly coverageDigest: string };

export type RepeatTrialStart = {
  readonly stateDirectory: string;
  readonly slug: string;
  readonly snapshotDigest: string;
  readonly promptDigest: string;
  readonly campaignId: string;
  readonly trialOrdinal: number;
};

export interface RepeatTrialGate {
  ensureReady(stateDirectory: string): void;
  inspectInitialSlug(
    slug: string,
    ambiguityManifest?: unknown,
  ): InitialSlugEligibility;
  assertMayStart(start: RepeatTrialStart): void;
  reserve(start: RepeatTrialStart): string | undefined;
  bootstrap(inventory: unknown): { readonly importedTrials: number };
  approve(approval: unknown): void;
}

type PriorTrial = {
  readonly slug: string;
  readonly snapshotDigest: string;
  readonly promptDigest: string;
  readonly campaignId: string;
  readonly trialOrdinal: number;
};

const historicalRow = z.object({ event_json: z.string() });
const registeredStart = z.object({
  slug: z.string(),
  prompt_digest: z.string(),
});
const slugOfSelection = (selectionId: string): string | null =>
  /^wporg:([a-z0-9][a-z0-9-]*)@/u.exec(selectionId)?.[1] ?? null;

function stateDirectory(path: string): string {
  if (!isAbsolute(path))
    throw new Error("Trial gate state paths must be absolute");
  return realpathSync(resolve(path));
}

function startKey(start: RepeatTrialStart): string {
  return canonicalDigest({
    stateDirectory: stateDirectory(start.stateDirectory),
    campaignId: start.campaignId,
    snapshotDigest: start.snapshotDigest,
    trialOrdinal: start.trialOrdinal,
  });
}

function approvalKey(start: RepeatTrialStart): string {
  return canonicalDigest({
    stateDirectory: stateDirectory(start.stateDirectory),
    slug: start.slug,
    snapshotDigest: start.snapshotDigest,
    promptDigest: start.promptDigest,
    campaignId: start.campaignId,
    trialOrdinal: start.trialOrdinal,
  });
}

/**
 * Host-common, append-only Trial index. The operator supplies the inventory of
 * historical state directories once; a newly encountered state is imported
 * before it may run. Import refuses a started Trial with no unique slug.
 */
export class SqliteRepeatTrialGate implements RepeatTrialGate {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS trial_gate_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trial_gate_states (
        state_directory TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS trial_gate_starts (
        start_key TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        prompt_digest TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        trial_ordinal INTEGER NOT NULL,
        state_directory TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trial_gate_starts_slug
        ON trial_gate_starts (slug);
      CREATE TABLE IF NOT EXISTS trial_gate_approvals (
        approval_key TEXT PRIMARY KEY,
        approval_digest TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        consumed_by TEXT
      );
    `);
  }

  #initialized(): boolean {
    return (
      this.#db
        .prepare("SELECT value FROM trial_gate_meta WHERE key = 'inventory'")
        .get() !== undefined
    );
  }

  /**
   * Read-only pre-freeze assessment for an automated initial-Trial inventory.
   * This registry imports known state ledgers but cannot prove that old research
   * databases and archives were exhaustively inventoried. Until a separate
   * complete coverage import exists, an unseen slug is never declared eligible.
   */
  inspectInitialSlug(
    value: string,
    ambiguityManifest?: unknown,
  ): InitialSlugEligibility {
    const candidate = slug.parse(value);
    const manifest =
      ambiguityManifest === undefined
        ? undefined
        : repeatTrialAmbiguityManifestSchema.parse(ambiguityManifest);
    if (!this.#initialized())
      return {
        status: "coverage-incomplete",
        reason: "state-inventory-uninitialized",
      };
    const started = this.#db
      .prepare("SELECT COUNT(*) AS count FROM trial_gate_starts WHERE slug = ?")
      .get(candidate);
    const startedTrials = z
      .object({ count: z.number().int().nonnegative() })
      .parse(started).count;
    if (startedTrials > 0) return { status: "prior-start", startedTrials };
    if (manifest?.ambiguousSlugs.includes(candidate))
      return { status: "hold-ambiguous", auditDigest: manifest.auditDigest };
    return {
      status: "coverage-incomplete",
      reason: "legacy-history-unverified",
    };
  }

  #readHistoricalState(directory: string): readonly PriorTrial[] {
    const path = join(directory, "ledger.sqlite");
    if (!existsSync(path)) return [];
    const ledger = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = ledger
        .prepare(
          "SELECT event_json FROM ledger_events WHERE event_type IN ('target-selected', 'discovery-run-started') ORDER BY sequence",
        )
        .all();
      const selections = new Map<string, string>();
      const starts: PriorTrial[] = [];
      const nextOrdinal = new Map<string, number>();
      for (const row of rows) {
        const event = ledgerEventV1Schema.parse(
          JSON.parse(historicalRow.parse(row).event_json) as unknown,
        );
        const key = `${event.campaignId}\0${event.snapshotDigest}`;
        if (event.type === "target-selected") {
          const selectedSlug = slugOfSelection(event.selectionId);
          if (selectedSlug === null) continue;
          const prior = selections.get(key);
          if (prior !== undefined && prior !== selectedSlug)
            throw new Error(
              `Trial inventory has conflicting target selections in ${directory}`,
            );
          selections.set(key, selectedSlug);
        } else if (
          event.type === "discovery-run-started" &&
          (event.runKind ?? "explore") === "explore"
        ) {
          // A run is mapped after reading all selections, so historical event
          // order and resumed campaign writes cannot affect the mapping.
          const ordinal = nextOrdinal.get(key) ?? 0;
          nextOrdinal.set(key, ordinal + 1);
          starts.push({
            slug: "",
            snapshotDigest: event.snapshotDigest,
            promptDigest:
              event.configuration.promptDigest ??
              event.configuration.objectiveDigest ??
              "",
            campaignId: event.campaignId,
            // The current campaign resumes at the number of explore starts.
            // Normalize old records without ordinals to that same numbering.
            trialOrdinal: ordinal,
          });
        }
      }
      return starts.map((start) => {
        const selectedSlug = selections.get(
          `${start.campaignId}\0${start.snapshotDigest}`,
        );
        if (selectedSlug === undefined)
          throw new Error(
            `Trial inventory cannot identify a started plugin in ${directory}`,
          );
        return { ...start, slug: selectedSlug };
      });
    } finally {
      ledger.close();
    }
  }

  #importState(directory: string): number {
    const registered = this.#db
      .prepare("SELECT 1 FROM trial_gate_states WHERE state_directory = ?")
      .get(directory);
    if (registered !== undefined) return 0;
    const starts = this.#readHistoricalState(directory);
    for (const start of starts) {
      const key = canonicalDigest({
        stateDirectory: directory,
        campaignId: start.campaignId,
        snapshotDigest: start.snapshotDigest,
        trialOrdinal: start.trialOrdinal,
      });
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO trial_gate_starts (start_key, slug, snapshot_digest, prompt_digest, campaign_id, trial_ordinal, state_directory, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'import')",
        )
        .run(
          key,
          start.slug,
          start.snapshotDigest,
          start.promptDigest,
          start.campaignId,
          start.trialOrdinal,
          directory,
        );
    }
    this.#db
      .prepare("INSERT INTO trial_gate_states (state_directory) VALUES (?)")
      .run(directory);
    return starts.length;
  }

  bootstrap(value: unknown): { readonly importedTrials: number } {
    const inventory = repeatTrialInventorySchema.parse(value);
    if (this.#initialized())
      throw new Error("Trial gate inventory is already initialized");
    const directories = inventory.stateDirectories.map(stateDirectory);
    if (new Set(directories).size !== directories.length)
      throw new Error("Trial gate inventory repeats a state directory");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#initialized())
        throw new Error("Trial gate inventory is already initialized");
      let importedTrials = 0;
      for (const directory of directories)
        importedTrials += this.#importState(directory);
      this.#db
        .prepare(
          "INSERT INTO trial_gate_meta (key, value) VALUES ('inventory', ?)",
        )
        .run(canonicalDigest({ inventory, directories }));
      this.#db.exec("COMMIT");
      return { importedTrials };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureReady(path: string): void {
    if (!this.#initialized())
      throw new Error(
        "Trial gate is uninitialized; import an explicit inventory before discovery",
      );
    const directory = stateDirectory(path);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#importState(directory);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #validateStart(value: RepeatTrialStart): RepeatTrialStart {
    return repeatTrialApprovalSchema
      .omit({
        schemaVersion: true,
        approvedBy: true,
        approvedAt: true,
        purpose: true,
      })
      .parse(value);
  }

  #assertMayStart(start: RepeatTrialStart): void {
    const existing = this.#db
      .prepare(
        "SELECT slug, prompt_digest FROM trial_gate_starts WHERE start_key = ?",
      )
      .get(startKey(start));
    if (existing !== undefined) {
      const recorded = registeredStart.parse(existing);
      if (
        recorded.slug !== start.slug ||
        recorded.prompt_digest !== start.promptDigest
      )
        throw new Error("Reserved Trial identity differs from its prior start");
      return;
    }
    const prior = this.#db
      .prepare("SELECT 1 FROM trial_gate_starts WHERE slug = ? LIMIT 1")
      .get(start.slug);
    if (prior === undefined) {
      if (this.inspectInitialSlug(start.slug).status !== "eligible")
        throw new Error(
          "Initial discovery Trial is held until historical coverage is verified",
        );
      return;
    }
    const approval = this.#db
      .prepare(
        "SELECT 1 FROM trial_gate_approvals WHERE approval_key = ? AND consumed_by IS NULL",
      )
      .get(approvalKey(start));
    if (approval === undefined)
      throw new Error(
        `Additional discovery Trial requires one human approval: slug ${start.slug}, snapshot ${start.snapshotDigest}, prompt ${start.promptDigest}, campaign ${start.campaignId}, ordinal ${start.trialOrdinal}, state ${stateDirectory(start.stateDirectory)}`,
      );
  }

  assertMayStart(value: RepeatTrialStart): void {
    const start = this.#validateStart(value);
    this.ensureReady(start.stateDirectory);
    this.#assertMayStart(start);
  }

  reserve(value: RepeatTrialStart): string | undefined {
    const start = this.#validateStart(value);
    this.ensureReady(start.stateDirectory);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertMayStart(start);
      const key = startKey(start);
      const existing = this.#db
        .prepare("SELECT 1 FROM trial_gate_starts WHERE start_key = ?")
        .get(key);
      if (existing === undefined) {
        const prior = this.#db
          .prepare("SELECT 1 FROM trial_gate_starts WHERE slug = ? LIMIT 1")
          .get(start.slug);
        if (prior !== undefined) {
          const consumed = this.#db
            .prepare(
              "UPDATE trial_gate_approvals SET consumed_by = ? WHERE approval_key = ? AND consumed_by IS NULL",
            )
            .run(key, approvalKey(start));
          if (Number(consumed.changes) !== 1)
            throw new Error("Trial approval was already consumed");
        }
        this.#db
          .prepare(
            "INSERT INTO trial_gate_starts (start_key, slug, snapshot_digest, prompt_digest, campaign_id, trial_ordinal, state_directory, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'live')",
          )
          .run(
            key,
            start.slug,
            start.snapshotDigest,
            start.promptDigest,
            start.campaignId,
            start.trialOrdinal,
            stateDirectory(start.stateDirectory),
          );
      }
      this.#db.exec("COMMIT");
      const approval = this.#db
        .prepare(
          "SELECT approval_digest FROM trial_gate_approvals WHERE consumed_by = ?",
        )
        .get(key);
      return approval === undefined
        ? undefined
        : digest.parse(
            z.object({ approval_digest: z.string() }).parse(approval)
              .approval_digest,
          );
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  approve(value: unknown): void {
    const approval = repeatTrialApprovalSchema.parse(value);
    this.ensureReady(approval.stateDirectory);
    const start = this.#validateStart({
      stateDirectory: approval.stateDirectory,
      slug: approval.slug,
      snapshotDigest: approval.snapshotDigest,
      promptDigest: approval.promptDigest,
      campaignId: approval.campaignId,
      trialOrdinal: approval.trialOrdinal,
    });
    const key = approvalKey(start);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.#db
          .prepare("SELECT 1 FROM trial_gate_starts WHERE slug = ? LIMIT 1")
          .get(start.slug) === undefined
      )
        throw new Error(
          "An additional Trial cannot be approved before the first Trial starts",
        );
      if (
        this.#db
          .prepare("SELECT 1 FROM trial_gate_starts WHERE start_key = ?")
          .get(startKey(start)) !== undefined
      )
        throw new Error(
          "Trial has already started; approval cannot be backdated",
        );
      const result = this.#db
        .prepare(
          "INSERT OR IGNORE INTO trial_gate_approvals (approval_key, approval_digest, approval_json, consumed_by) VALUES (?, ?, ?, NULL)",
        )
        .run(key, canonicalDigest(approval), JSON.stringify(approval));
      if (Number(result.changes) !== 1)
        throw new Error("This exact Trial already has an approval");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
