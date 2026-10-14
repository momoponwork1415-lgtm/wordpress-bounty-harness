import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
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

/**
 * Metadata-only result of a separate, complete legacy audit. The gate checks
 * the shape and internal consistency, but cannot discover omitted sources or
 * authenticate the auditor. Import only an independently reviewed audit whose
 * evidence lives outside Git. An old start is slug-only: it cannot resume a
 * current campaign or manufacture a current Trial identity.
 */
export const repeatTrialCoverageManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stateInventoryDigest: digest,
  auditDigest: digest,
  auditedBy: id,
  approvedBy: id,
  cutoffAt: z.iso.datetime({ offset: true }),
  auditedAt: z.iso.datetime({ offset: true }),
  approvedAt: z.iso.datetime({ offset: true }),
  legacyWritersStoppedAt: z.iso.datetime({ offset: true }),
  sourceFreezeEvidenceDigest: digest,
  sources: z
    .array(
      z.strictObject({
        sourceClass: z.enum([
          "state-ledgers",
          "legacy-research-databases",
          "legacy-queues",
          "archives",
        ]),
        rosterDigest: digest,
        contentDigest: digest,
        evidenceDigest: digest,
        sourceCount: z.number().int().nonnegative(),
        complete: z.literal(true),
        unknownSlugStarts: z.literal(0),
      }),
    )
    .length(4),
  legacyStarts: z.array(
    z.strictObject({
      slug,
      minimumStartedTrials: z.number().int().positive(),
      evidenceDigest: digest,
    }),
  ),
  heldSlugs: z.array(z.strictObject({ slug, evidenceDigest: digest })),
});

export type InitialSlugEligibility =
  /** Lower bound because old slug-only records may overlap current state ledgers. */
  | { readonly status: "prior-start"; readonly startedTrials: number }
  | { readonly status: "hold-ambiguous"; readonly auditDigest: string }
  | {
      readonly status: "coverage-incomplete";
      readonly reason:
        | "state-inventory-uninitialized"
        | "legacy-history-unverified"
        | "coverage-invalidated";
    }
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
  confirmStarted(start: RepeatTrialStart): void;
  bootstrap(inventory: unknown): { readonly importedTrials: number };
  importCoverage(manifest: unknown): string;
  approve(approval: unknown): void;
}

type PriorTrial = {
  readonly slug: string;
  readonly snapshotDigest: string;
  readonly promptDigest: string;
  readonly campaignId: string;
  readonly trialOrdinal: number;
};

type CoverageAnomalyCode =
  | "unregistered-starts"
  | "unreadable-or-malformed-ledger"
  | "missing-ledger"
  | "precut-ledger";

class CoverageSourceUncertain extends Error {
  constructor(
    readonly code: CoverageAnomalyCode,
    readonly starts: readonly PriorTrial[] = [],
  ) {
    super(`State history requires a new legacy coverage audit (${code})`);
  }
}

const historicalRow = z.object({ event_json: z.string() });
const registeredStart = z.object({
  slug: z.string(),
  prompt_digest: z.string(),
  source: z.enum(["import", "live"]),
  ledger_status: z.enum(["pending", "observed"]).nullable(),
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
    this.#db = new DatabaseSync(databasePath, { timeout: 5_000 });
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
      CREATE TABLE IF NOT EXISTS trial_gate_start_state (
        start_key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'observed'))
      );
      CREATE TABLE IF NOT EXISTS trial_gate_approvals (
        approval_key TEXT PRIMARY KEY,
        approval_digest TEXT NOT NULL,
        approval_json TEXT NOT NULL,
        consumed_by TEXT
      );
      CREATE TABLE IF NOT EXISTS trial_gate_legacy_starts (
        slug TEXT PRIMARY KEY,
        minimum_started_trials INTEGER NOT NULL,
        evidence_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trial_gate_holds (
        slug TEXT PRIMARY KEY,
        evidence_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trial_gate_coverage_anomalies (
        state_directory TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        evidence_digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trial_gate_unexpected_starts (
        slug TEXT PRIMARY KEY,
        minimum_started_trials INTEGER NOT NULL,
        evidence_digest TEXT NOT NULL
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
   * Coverage is trusted only after an independently audited manifest has been
   * atomically imported. A caller-supplied partial ambiguity hint is advisory
   * before that import; all holds must be persisted in the complete import.
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#inspectInitialSlug(candidate, manifest);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #inspectInitialSlug(
    candidate: string,
    manifest?: z.infer<typeof repeatTrialAmbiguityManifestSchema>,
  ): InitialSlugEligibility {
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
    const legacy = this.#db
      .prepare(
        "SELECT minimum_started_trials FROM trial_gate_legacy_starts WHERE slug = ?",
      )
      .get(candidate);
    const legacyCount =
      legacy === undefined
        ? 0
        : z
            .object({ minimum_started_trials: z.number().int().positive() })
            .parse(legacy).minimum_started_trials;
    const unexpected = this.#db
      .prepare(
        "SELECT minimum_started_trials FROM trial_gate_unexpected_starts WHERE slug = ?",
      )
      .get(candidate);
    const unexpectedCount =
      unexpected === undefined
        ? 0
        : z
            .object({ minimum_started_trials: z.number().int().positive() })
            .parse(unexpected).minimum_started_trials;
    if (startedTrials > 0 || legacyCount > 0 || unexpectedCount > 0)
      return {
        status: "prior-start",
        startedTrials: Math.max(startedTrials, legacyCount, unexpectedCount),
      };
    if (
      this.#db
        .prepare(
          "SELECT 1 FROM trial_gate_meta WHERE key = 'coverage-invalidated'",
        )
        .get() !== undefined
    )
      return { status: "coverage-incomplete", reason: "coverage-invalidated" };
    const coverage = this.#db
      .prepare("SELECT value FROM trial_gate_meta WHERE key = 'coverage'")
      .get();
    const held = this.#db
      .prepare("SELECT evidence_digest FROM trial_gate_holds WHERE slug = ?")
      .get(candidate);
    if (
      coverage !== undefined &&
      manifest?.ambiguousSlugs.includes(candidate) &&
      held === undefined
    )
      throw new Error(
        "New ambiguity requires a reviewed coverage revision before eligibility",
      );
    if (held !== undefined)
      return {
        status: "hold-ambiguous",
        auditDigest: digest.parse(
          z
            .object({ value: z.string() })
            .parse(
              this.#db
                .prepare(
                  "SELECT value FROM trial_gate_meta WHERE key = 'coverage-audit'",
                )
                .get(),
            ).value,
        ),
      };
    if (manifest?.ambiguousSlugs.includes(candidate))
      return { status: "hold-ambiguous", auditDigest: manifest.auditDigest };
    if (coverage !== undefined)
      return {
        status: "eligible",
        coverageDigest: digest.parse(
          z.object({ value: z.string() }).parse(coverage).value,
        ),
      };
    return {
      status: "coverage-incomplete",
      reason: "legacy-history-unverified",
    };
  }

  importCoverage(value: unknown): string {
    const manifest = repeatTrialCoverageManifestSchema.parse(value);
    const classes = new Set(
      manifest.sources.map((source) => source.sourceClass),
    );
    if (classes.size !== 4)
      throw new Error(
        "Coverage must have one complete cut of every source class",
      );
    if (Date.parse(manifest.auditedAt) < Date.parse(manifest.cutoffAt))
      throw new Error("Coverage audit predates its source cutoff");
    if (
      Date.parse(manifest.legacyWritersStoppedAt) >
      Date.parse(manifest.cutoffAt)
    )
      throw new Error("Legacy sources were not frozen before the cutoff");
    if (Date.parse(manifest.approvedAt) < Date.parse(manifest.auditedAt))
      throw new Error("Coverage approval predates the audit");
    const slugs = [
      ...manifest.legacyStarts.map((entry) => entry.slug),
      ...manifest.heldSlugs.map((entry) => entry.slug),
    ];
    if (new Set(slugs).size !== slugs.length)
      throw new Error("Coverage repeats a slug across starts and holds");
    const coverageDigest = canonicalDigest(manifest);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const inventory = this.#db
        .prepare("SELECT value FROM trial_gate_meta WHERE key = 'inventory'")
        .get();
      if (inventory === undefined)
        throw new Error("State inventory must be bootstrapped before coverage");
      if (
        z.object({ value: z.string() }).parse(inventory).value !==
        manifest.stateInventoryDigest
      )
        throw new Error("Coverage refers to a different state inventory");
      if (
        this.#db
          .prepare("SELECT 1 FROM trial_gate_meta WHERE key = 'coverage'")
          .get() !== undefined
      )
        throw new Error("Coverage has already been imported");
      // The manifest cannot release initial Trials if a bootstrapped state
      // acquired an unregistered start after its inventory was captured.
      for (const directory of this.#registeredStateDirectories())
        this.#recheckRegisteredState(directory);
      for (const entry of manifest.legacyStarts)
        this.#db
          .prepare(
            "INSERT INTO trial_gate_legacy_starts (slug, minimum_started_trials, evidence_digest) VALUES (?, ?, ?)",
          )
          .run(entry.slug, entry.minimumStartedTrials, entry.evidenceDigest);
      for (const entry of manifest.heldSlugs)
        this.#db
          .prepare(
            "INSERT INTO trial_gate_holds (slug, evidence_digest) VALUES (?, ?)",
          )
          .run(entry.slug, entry.evidenceDigest);
      this.#db
        .prepare(
          "INSERT INTO trial_gate_meta (key, value) VALUES ('coverage', ?)",
        )
        .run(coverageDigest);
      this.#db
        .prepare(
          "INSERT INTO trial_gate_meta (key, value) VALUES ('coverage-audit', ?)",
        )
        .run(manifest.auditDigest);
      this.#db
        .prepare(
          "INSERT INTO trial_gate_meta (key, value) VALUES ('coverage-cutoff', ?)",
        )
        .run(manifest.cutoffAt);
      this.#db.exec("COMMIT");
      return coverageDigest;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #readHistoricalState(directory: string): readonly PriorTrial[] {
    const path = join(directory, "ledger.sqlite");
    if (!existsSync(path)) return [];
    const ledger = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
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
    const covered =
      this.#db
        .prepare("SELECT 1 FROM trial_gate_meta WHERE key = 'coverage'")
        .get() !== undefined;
    let precutLedger = false;
    if (covered) {
      const cutoff = z
        .object({ value: z.string() })
        .parse(
          this.#db
            .prepare(
              "SELECT value FROM trial_gate_meta WHERE key = 'coverage-cutoff'",
            )
            .get(),
        ).value;
      const ledgerPath = join(directory, "ledger.sqlite");
      try {
        if (!existsSync(ledgerPath)) {
          // A fresh, unused directory is normal. A populated directory with
          // no ledger could be an unexamined legacy state.
          if (
            statSync(directory).birthtimeMs <= Date.parse(cutoff) ||
            readdirSync(directory).length > 0
          )
            throw new CoverageSourceUncertain("missing-ledger");
        } else
          precutLedger = statSync(ledgerPath).birthtimeMs <= Date.parse(cutoff);
      } catch (error) {
        if (error instanceof CoverageSourceUncertain) throw error;
        throw new CoverageSourceUncertain("unreadable-or-malformed-ledger");
      }
    }
    let starts: readonly PriorTrial[];
    try {
      starts = this.#readHistoricalState(directory);
    } catch (error) {
      if (covered)
        throw new CoverageSourceUncertain("unreadable-or-malformed-ledger");
      throw error;
    }
    if (precutLedger)
      throw new CoverageSourceUncertain("precut-ledger", starts);
    if (covered && starts.length > 0)
      throw new CoverageSourceUncertain("unregistered-starts", starts);
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

  #registeredStateDirectories(): readonly string[] {
    return this.#db
      .prepare(
        "SELECT state_directory FROM trial_gate_states ORDER BY state_directory",
      )
      .all()
      .map(
        (row) =>
          z.object({ state_directory: z.string() }).parse(row).state_directory,
      );
  }

  /** A live reservation may precede its ledger event; an imported start may not disappear. */
  #recheckRegisteredState(directory: string): void {
    try {
      if (!statSync(directory).isDirectory())
        throw new CoverageSourceUncertain("missing-ledger");
      const recorded = this.#db
        .prepare(
          "SELECT s.start_key, s.slug, s.prompt_digest, s.source, m.status AS ledger_status FROM trial_gate_starts s LEFT JOIN trial_gate_start_state m ON m.start_key = s.start_key WHERE s.state_directory = ?",
        )
        .all(directory)
        .map((row) =>
          z
            .object({
              start_key: digest,
              slug,
              prompt_digest: z.string(),
              source: z.enum(["import", "live"]),
              ledger_status: z.enum(["pending", "observed"]).nullable(),
            })
            .parse(row),
        );
      const byKey = new Map(recorded.map((row) => [row.start_key, row]));
      const observed = this.#readHistoricalState(directory);
      const observedKeys = new Set<string>();
      const unexpected: PriorTrial[] = [];
      for (const start of observed) {
        const key = canonicalDigest({
          stateDirectory: directory,
          campaignId: start.campaignId,
          snapshotDigest: start.snapshotDigest,
          trialOrdinal: start.trialOrdinal,
        });
        const registered = byKey.get(key);
        if (
          observedKeys.has(key) ||
          registered === undefined ||
          registered.slug !== start.slug ||
          registered.prompt_digest !== start.promptDigest
        )
          unexpected.push(start);
        else if (
          registered.source === "live" &&
          registered.ledger_status !== "observed"
        )
          this.#db
            .prepare(
              "INSERT INTO trial_gate_start_state (start_key, status) VALUES (?, 'observed') ON CONFLICT(start_key) DO UPDATE SET status = 'observed'",
            )
            .run(key);
        observedKeys.add(key);
      }
      if (unexpected.length > 0)
        throw new CoverageSourceUncertain("unregistered-starts", unexpected);
      if (
        recorded.some(
          (row) =>
            !observedKeys.has(row.start_key) &&
            (row.source === "import" || row.ledger_status !== "pending"),
        )
      )
        throw new CoverageSourceUncertain("missing-ledger");
    } catch (error) {
      if (error instanceof CoverageSourceUncertain) throw error;
      throw new CoverageSourceUncertain("unreadable-or-malformed-ledger");
    }
  }

  #recordCoverageInvalidation(
    directory: string,
    failure: CoverageSourceUncertain,
  ): void {
    const evidenceDigest = canonicalDigest({
      stateDirectory: directory,
      reason: failure.code,
      starts: failure.starts,
    });
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO trial_gate_coverage_anomalies (state_directory, reason, evidence_digest) VALUES (?, ?, ?)",
      )
      .run(directory, failure.code, evidenceDigest);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO trial_gate_meta (key, value) VALUES ('coverage-invalidated', ?)",
      )
      .run(evidenceDigest);
    const counts = new Map<string, number>();
    for (const start of failure.starts)
      counts.set(start.slug, (counts.get(start.slug) ?? 0) + 1);
    for (const [candidate, count] of counts)
      this.#db
        .prepare(
          "INSERT INTO trial_gate_unexpected_starts (slug, minimum_started_trials, evidence_digest) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET minimum_started_trials = MAX(minimum_started_trials, excluded.minimum_started_trials)",
        )
        .run(candidate, count, evidenceDigest);
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
    let coverageFailure: CoverageSourceUncertain | undefined;
    try {
      const covered =
        this.#db
          .prepare("SELECT 1 FROM trial_gate_meta WHERE key = 'coverage'")
          .get() !== undefined;
      for (const registeredDirectory of this.#registeredStateDirectories()) {
        try {
          this.#recheckRegisteredState(registeredDirectory);
        } catch (error) {
          if (!(error instanceof CoverageSourceUncertain) || !covered)
            throw error;
          this.#recordCoverageInvalidation(registeredDirectory, error);
          coverageFailure ??= error;
        }
      }
      try {
        if (coverageFailure === undefined) this.#importState(directory);
      } catch (error) {
        if (!(error instanceof CoverageSourceUncertain)) throw error;
        this.#recordCoverageInvalidation(directory, error);
        coverageFailure = error;
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    if (coverageFailure !== undefined) throw coverageFailure;
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

  #hasPriorSlug(candidate: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM trial_gate_starts WHERE slug = ? LIMIT 1")
        .get(candidate) !== undefined ||
      this.#db
        .prepare("SELECT 1 FROM trial_gate_legacy_starts WHERE slug = ?")
        .get(candidate) !== undefined ||
      this.#db
        .prepare("SELECT 1 FROM trial_gate_unexpected_starts WHERE slug = ?")
        .get(candidate) !== undefined
    );
  }

  #assertMayStart(start: RepeatTrialStart): void {
    const existing = this.#db
      .prepare(
        "SELECT s.slug, s.prompt_digest, s.source, m.status AS ledger_status FROM trial_gate_starts s LEFT JOIN trial_gate_start_state m ON m.start_key = s.start_key WHERE s.start_key = ?",
      )
      .get(startKey(start));
    if (existing !== undefined) {
      const recorded = registeredStart.parse(existing);
      if (
        recorded.slug !== start.slug ||
        recorded.prompt_digest !== start.promptDigest
      )
        throw new Error("Reserved Trial identity differs from its prior start");
      if (recorded.source === "live" && recorded.ledger_status !== "observed")
        throw new Error(
          "Pending Trial reservation requires explicit recovery before replay",
        );
      return;
    }
    if (!this.#hasPriorSlug(start.slug)) {
      if (this.#inspectInitialSlug(start.slug).status !== "eligible")
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#assertMayStart(start);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
        if (this.#hasPriorSlug(start.slug)) {
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
        this.#db
          .prepare(
            "INSERT INTO trial_gate_start_state (start_key, status) VALUES (?, 'pending')",
          )
          .run(key);
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

  /** Called after the append-only start event is committed and before provider execution. */
  confirmStarted(value: RepeatTrialStart): void {
    const start = this.#validateStart(value);
    this.ensureReady(start.stateDirectory);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const key = startKey(start);
      const recorded = this.#db
        .prepare(
          "SELECT s.slug, s.prompt_digest, m.status FROM trial_gate_starts s LEFT JOIN trial_gate_start_state m ON m.start_key = s.start_key WHERE s.start_key = ?",
        )
        .get(key);
      const row = z
        .object({
          slug,
          prompt_digest: z.string(),
          status: z.enum(["pending", "observed"]).nullable(),
        })
        .parse(recorded);
      if (
        row.slug !== start.slug ||
        row.prompt_digest !== start.promptDigest ||
        row.status !== "observed"
      )
        throw new Error("Discovery Trial start is not recorded in its ledger");
      this.#db.exec("COMMIT");
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
      if (!this.#hasPriorSlug(start.slug))
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
