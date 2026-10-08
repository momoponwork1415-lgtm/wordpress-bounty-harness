import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { z } from "zod";

import {
  createHistoryCatalog,
  type CampaignHistory,
} from "../../../discovery/campaign.js";

const propertySchema = z.enum([
  "rce",
  "php-file-write",
  "arbitrary-file-read",
  "delete",
  "download",
  "lfi",
  "rfi",
  "sqli",
  "options-update",
  "privesc-to-admin",
  "auth-bypass-to-admin",
  "account-takeover",
  "privesc-to-contributor+",
  "auth-bypass-non-admin",
  "sensitive-object-access",
  "content-deletion",
  "stored-xss",
  "reflected-xss",
  "csrf-to-write",
  "missing-authz",
  "idor",
  "other",
]);

export const duplicateQuerySchema = z.object({
  plugin: z.string().min(1),
  version: z.string().min(1),
  property: propertySchema,
});

export type DuplicateQuery = z.infer<typeof duplicateQuerySchema>;
export type DuplicateCandidate = {
  id: string;
  title: string;
  published: string | null;
  match: "matching" | "needs-review";
  reasons: ("version-range-unknown" | "property-signal-unknown")[];
};
export type DuplicateLookup = {
  status: "fresh" | "stale" | "unavailable";
  lastSuccessfulAt: string | null;
  candidates: DuplicateCandidate[];
};
export type WordfenceHistoryOptions = {
  databasePath: string;
  statePath: string;
  now?: Date;
  maxAgeMs?: number;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The projection is produced by the legacy refresh_wordfence.py classifier.
// An absent mapping must remain visible for human inspection, not become a negative match.
const propertySignals: Partial<
  Record<DuplicateQuery["property"], readonly string[]>
> = {
  rce: ["remote-code-execution"],
  "php-file-write": ["arbitrary-php-file-upload", "arbitrary-file-upload"],
  "arbitrary-file-read": ["arbitrary-php-file-read", "arbitrary-file-read"],
  delete: ["arbitrary-php-file-deletion", "arbitrary-file-deletion"],
  download: ["arbitrary-file-read"],
  lfi: ["local-file-inclusion"],
  rfi: ["remote-file-inclusion"],
  sqli: ["sql-injection"],
  "options-update": ["arbitrary-options-update"],
  "privesc-to-admin": ["privilege-escalation-to-admin"],
  "auth-bypass-to-admin": ["authentication-bypass-to-admin"],
  "account-takeover": ["account-takeover"],
  "privesc-to-contributor+": ["privilege-escalation"],
  "auth-bypass-non-admin": ["authentication-bypass"],
  "stored-xss": ["stored-xss"],
  "reflected-xss": ["reflected-xss"],
};

const stateSchema = z.object({
  schema_version: z.literal("wordfence-cache/v1"),
  content_sha256: z.string().min(1),
  record_count: z.number().int().nonnegative(),
  last_successful_at: z.iso.datetime({ offset: true }),
  stale_fallback: z.boolean().optional(),
});
const metadataRowSchema = z.object({ value: z.string() });
const vulnerabilityRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  published: z.string().nullable(),
  record_json: z.string(),
});
const signalRowSchema = z.object({ value: z.string() });
const recordSchema = z.object({
  software: z.array(
    z.object({
      slug: z.string(),
      affected_versions: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});
const rangeSchema = z.object({
  from_version: z.string().nullable().optional(),
  from_inclusive: z.boolean().optional(),
  to_version: z.string().nullable().optional(),
  to_inclusive: z.boolean().optional(),
});

function numericVersion(value: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function rangeCovers(
  range: unknown,
  version: readonly number[],
): boolean | null {
  const parsed = rangeSchema.safeParse(range);
  if (!parsed.success) return null;
  const {
    from_version: from,
    from_inclusive: fromInclusive,
    to_version: to,
    to_inclusive: toInclusive,
  } = parsed.data;
  for (const [endpoint, inclusive, lower] of [
    [from, fromInclusive, true],
    [to, toInclusive, false],
  ] as const) {
    if (endpoint === undefined || endpoint === null || endpoint === "*")
      continue;
    const boundary = numericVersion(endpoint);
    if (boundary === null) return null;
    const order = compareVersions(version, boundary);
    if (lower && (order < 0 || (order === 0 && inclusive === false)))
      return false;
    if (!lower && (order > 0 || (order === 0 && inclusive === false)))
      return false;
  }
  return true;
}

function versionMatch(
  recordJson: string,
  plugin: string,
  version: string,
): boolean | null {
  const target = numericVersion(version);
  if (target === null) return null;
  let source: unknown;
  try {
    source = JSON.parse(recordJson);
  } catch {
    return null;
  }
  const record = recordSchema.safeParse(source);
  if (!record.success) return null;
  const software = record.data.software.filter((item) => item.slug === plugin);
  if (software.length === 0) return null;
  let uncertain = false;
  let foundRange = false;
  for (const item of software) {
    if (
      item.affected_versions === undefined ||
      Object.keys(item.affected_versions).length === 0
    ) {
      uncertain = true;
      continue;
    }
    for (const range of Object.values(item.affected_versions)) {
      foundRange = true;
      const covers = rangeCovers(range, target);
      if (covers === true) return true;
      if (covers === null) uncertain = true;
    }
  }
  return uncertain || !foundRange ? null : false;
}

function metadata(db: Database.Database, key: string): string | null {
  const row = metadataRowSchema.safeParse(
    db.prepare("SELECT value FROM metadata WHERE key = ?").get(key),
  );
  return row.success ? row.data.value : null;
}

function isStale(
  state: z.infer<typeof stateSchema>,
  now: Date,
  maxAgeMs: number,
): boolean {
  const fetchedAt = Date.parse(state.last_successful_at);
  return (
    state.stale_fallback === true ||
    fetchedAt > now.getTime() ||
    now.getTime() - fetchedAt > maxAgeMs
  );
}

export type HistoryMirrorStatus =
  | {
      readonly status: "fresh" | "stale";
      readonly lastSuccessfulAt: string;
      readonly ageMs: number;
      readonly maxAgeMs: number;
      readonly recordCount: number;
      readonly staleFallback: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "state-unreadable" | "database-mismatch";
    };

/** Freshness and consistency by the same rules the duplicate lookup applies. */
export function inspectHistoryMirror(
  options: WordfenceHistoryOptions,
): HistoryMirrorStatus {
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let state: z.infer<typeof stateSchema>;
  try {
    state = stateSchema.parse(
      JSON.parse(readFileSync(options.statePath, "utf8")) as unknown,
    );
  } catch {
    return { status: "unavailable", reason: "state-unreadable" };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(options.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    if (
      metadata(db, "projection_schema") !== "wordfence-history/v1" ||
      metadata(db, "content_sha256") !== state.content_sha256 ||
      metadata(db, "record_count") !== String(state.record_count)
    )
      return { status: "unavailable", reason: "database-mismatch" };
  } catch {
    return { status: "unavailable", reason: "database-mismatch" };
  } finally {
    db?.close();
  }
  return {
    status: isStale(state, now, maxAgeMs) ? "stale" : "fresh",
    lastSuccessfulAt: state.last_successful_at,
    ageMs: now.getTime() - Date.parse(state.last_successful_at),
    maxAgeMs,
    recordCount: state.record_count,
    staleFallback: state.stale_fallback === true,
  };
}

/** Read-only review lookup. Candidates are possible duplicates; no automatic duplicate verdict is issued. */
export function findDuplicates(
  input: DuplicateQuery,
  options: WordfenceHistoryOptions,
): DuplicateLookup {
  const query = duplicateQuerySchema.parse(input);
  const unavailable: DuplicateLookup = {
    status: "unavailable",
    lastSuccessfulAt: null,
    candidates: [],
  };
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0
  ) {
    throw new Error("invalid duplicate lookup clock or freshness threshold");
  }
  let stateSource: unknown;
  try {
    stateSource = JSON.parse(readFileSync(options.statePath, "utf8"));
  } catch {
    return unavailable;
  }
  const state = stateSchema.safeParse(stateSource);
  if (!state.success) return unavailable;
  const stale = isStale(state.data, now, maxAgeMs);

  let db: Database.Database | undefined;
  try {
    db = new Database(options.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    if (
      metadata(db, "projection_schema") !== "wordfence-history/v1" ||
      metadata(db, "content_sha256") !== state.data.content_sha256 ||
      metadata(db, "record_count") !== String(state.data.record_count)
    ) {
      return unavailable;
    }
    const rows = db
      .prepare(
        "SELECT v.id, v.title, v.published, v.record_json FROM vulnerabilities v JOIN software s ON s.vulnerability_id = v.id WHERE s.slug = ? AND s.type = 'plugin' ORDER BY v.published DESC, v.id",
      )
      .all(query.plugin);
    const signalQuery = db.prepare(
      "SELECT value FROM signals WHERE vulnerability_id = ? AND slug = ?",
    );
    const candidates: DuplicateCandidate[] = [];
    for (const source of rows) {
      const parsed = vulnerabilityRowSchema.safeParse(source);
      if (!parsed.success) return unavailable;
      const row = parsed.data;
      const version = versionMatch(
        row.record_json,
        query.plugin,
        query.version,
      );
      if (version === false) continue;
      const signalRows = z
        .array(signalRowSchema)
        .safeParse(signalQuery.all(row.id, query.plugin));
      if (!signalRows.success) return unavailable;
      const knownSignals = signalRows.data.map((signal) => signal.value);
      const expectedSignals = propertySignals[query.property];
      const property =
        expectedSignals === undefined || knownSignals.length === 0
          ? null
          : expectedSignals.some((signal) => knownSignals.includes(signal));
      if (property === false) continue;
      const reasons: DuplicateCandidate["reasons"] = [];
      if (version === null) reasons.push("version-range-unknown");
      if (property === null) reasons.push("property-signal-unknown");
      candidates.push({
        id: row.id,
        title: row.title,
        published: row.published,
        match: reasons.length === 0 ? "matching" : "needs-review",
        reasons,
      });
    }
    return {
      status: stale ? "stale" : "fresh",
      lastSuccessfulAt: state.data.last_successful_at,
      candidates,
    };
  } catch {
    return unavailable;
  } finally {
    db?.close();
  }
}

const catalogSoftwareSchema = z.object({
  slug: z.string(),
  affected_versions: z.record(z.string(), z.unknown()).optional(),
  patched_versions: z.array(z.string()).optional(),
});
const catalogSourceSchema = z.object({
  software: z.array(catalogSoftwareSchema),
});

/** Project the local Wordfence mirror into the exact public catalog allowlist. */
export function extractCampaignHistory(
  plugin: string,
  historyCutoff: string,
  options: Pick<WordfenceHistoryOptions, "databasePath" | "statePath">,
):
  | {
      readonly status: "ready";
      readonly history: Extract<CampaignHistory, { mode: "catalog" }>;
    }
  | { readonly status: "unavailable" } {
  if (plugin.length === 0) throw new Error("Plugin slug is required");
  const cutoff = z.iso.datetime({ offset: true }).parse(historyCutoff);
  let db: Database.Database | undefined;
  try {
    const state = stateSchema.parse(
      JSON.parse(readFileSync(options.statePath, "utf8")) as unknown,
    );
    if (state.stale_fallback === true) return { status: "unavailable" };
    db = new Database(options.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    if (
      metadata(db, "projection_schema") !== "wordfence-history/v1" ||
      metadata(db, "content_sha256") !== state.content_sha256 ||
      metadata(db, "record_count") !== String(state.record_count)
    ) {
      return { status: "unavailable" };
    }
    const rows = db
      .prepare(
        "SELECT v.id, v.title, v.published, v.record_json FROM vulnerabilities v JOIN software s ON s.vulnerability_id = v.id WHERE s.slug = ? AND s.type = 'plugin' ORDER BY v.published, v.id",
      )
      .all(plugin);
    const signalQuery = db.prepare(
      "SELECT value FROM signals WHERE vulnerability_id = ? AND slug = ? AND kind = 'primitive' ORDER BY value",
    );
    const records = [];
    for (const source of rows) {
      const row = vulnerabilityRowSchema.parse(source);
      if (row.published === null) continue;
      const published = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
        row.published,
      )
        ? `${row.published.replace(" ", "T")}Z`
        : row.published;
      const instant = Date.parse(published);
      if (!Number.isFinite(instant)) continue;
      if (instant >= Date.parse(cutoff)) continue;
      const sourceRecord = catalogSourceSchema.parse(
        JSON.parse(row.record_json) as unknown,
      );
      const software = sourceRecord.software.filter(
        (item) => item.slug === plugin,
      );
      if (software.length === 0) continue;
      const signals = z
        .array(signalRowSchema)
        .parse(signalQuery.all(row.id, plugin));
      records.push({
        id: row.id,
        kind: signals.map((item) => item.value).join(", ") || "unknown",
        affectedVersions: [
          ...new Set(
            software.flatMap((item) =>
              Object.keys(item.affected_versions ?? {}),
            ),
          ),
        ].sort(),
        fixedVersions: [
          ...new Set(software.flatMap((item) => item.patched_versions ?? [])),
        ].sort(),
        publishedAt: new Date(instant).toISOString(),
        title: row.title,
        changedFiles: [],
      });
    }
    return {
      status: "ready",
      history: createHistoryCatalog(cutoff, records),
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    db?.close();
  }
}
