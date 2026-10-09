import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../infrastructure/canonical-json.js";
import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { verificationResultV1Schema } from "../verification/reproduction-package.js";

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const artifactRef = z.strictObject({ kind: id, digest });
const base = z.strictObject({
  schemaVersion: z.literal(1),
  identity: id,
  campaignId: id,
  snapshotDigest: digest,
  occurredAt: z.iso.datetime({ offset: true }),
  artifacts: z.array(artifactRef).default([]),
});

const tokens = z.union([
  z.number().int().nonnegative(),
  z.literal("unavailable"),
]);

const event = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...base.shape, ...shape });

/** LedgerEvent v1 carries only routing metadata and private artifact digests. */
export const ledgerEventV1Schema = z.discriminatedUnion("type", [
  event({ type: z.literal("target-selected"), selectionId: id }),
  event({ type: z.literal("snapshot-frozen"), sourceDigest: digest }),
  event({
    type: z.literal("lab-provisioned"),
    labId: id,
    status: z.enum(["ready", "failed"]),
    reachability: z
      .strictObject({
        http: z.enum(["ok", "failed"]),
        database: z.enum(["ok", "failed", "not-exposed"]),
      })
      .optional(),
    failureStage: z.enum(["provision", "seed", "probe"]).optional(),
    reason: z.enum(["provision", "reachability"]).optional(),
  }),
  event({
    type: z.literal("discovery-run-started"),
    runId: id,
    labId: id,
    history: z.union([
      z.strictObject({ mode: z.literal("none") }),
      z.strictObject({
        mode: z.literal("catalog"),
        digest,
        recordIds: z.array(id),
      }),
    ]),
    configuration: z.strictObject({
      promptVariant: id,
      assignmentUnit: id,
      axis: z.literal("history").optional(),
      arm: z.enum(["a", "b"]).optional(),
    }),
  }),
  event({
    type: z.literal("discovery-run-finished"),
    runId: id,
    /** `provider-limited`: the subscription refused the run; it does not spend the target's budget. */
    outcome: z.enum([
      "completed",
      "failed",
      "setup-failed",
      "provider-limited",
    ]),
    costUsd: z.union([z.number().nonnegative(), z.literal("unavailable")]),
    wallTimeMs: z.number().int().nonnegative(),
    reason: z
      .enum(["provider", "schema", "sandbox", "policy", "evidence"])
      .optional(),
    reasonDetail: z
      .string()
      .regex(/^[a-z0-9][a-z0-9:_-]{0,127}$/)
      .optional(),
    providerLimit: z.enum(["rate-limit", "quota"]).optional(),
    /** Provider-reported tokens; absent when the transport returned no receipt. */
    usage: z
      .strictObject({
        inputTokens: tokens,
        cachedInputTokens: tokens,
        outputTokens: tokens,
        reasoningOutputTokens: tokens,
      })
      .optional(),
  }),
  event({
    type: z.literal("discovery-concluded"),
    stoppedBy: z.enum(["no-new-finding", "max-runs", "plans-exhausted"]),
  }),
  /** The campaign stopped early; rerunning it with the same id resumes it. */
  event({
    type: z.literal("campaign-stopped"),
    reason: z.enum(["provider-limit", "daily-run-cap"]),
  }),
  /**
   * A target was left behind by an error. Before a snapshot exists, the
   * snapshot digest is the digest of the selection record.
   */
  event({
    type: z.literal("target-skipped"),
    selectionId: id,
    stage: z.enum(["freeze", "discovery", "verification"]),
  }),
  event({
    type: z.literal("finding-recorded"),
    findingId: id,
    runId: id,
    category: id,
    historyRecordId: id.optional(),
  }),
  event({
    type: z.literal("verifier-run-finished"),
    findingId: id,
    runId: id,
    promptDigest: digest,
    receiptDigest: digest,
    terminal: z.enum(["completed", "incomplete"]),
    canaryIssued: z.enum(["execution", "script"]).optional(),
  }),
  event({
    type: z.literal("verification-finished"),
    verificationId: id,
    findingId: id,
    labSetupDigest: digest,
    /** Present when the Finding was re-verified on a newer snapshot of its target. */
    basis: z
      .strictObject({
        kind: z.literal("latest-version"),
        findingSnapshotDigest: digest,
      })
      .optional(),
    result: verificationResultV1Schema,
  }),
  event({
    type: z.literal("review-decided"),
    findingId: id,
    decision: z.enum(["accept", "reject", "defer"]),
  }),
  event({
    type: z.literal("scope-assessed"),
    findingId: id,
    programmeId: id,
    status: z.enum(["in-scope", "out-of-scope", "ambiguous", "incomplete"]),
  }),
  event({
    type: z.literal("draft-saved"),
    findingId: id,
    candidateId: id,
    revisionDigest: digest,
  }),
  event({
    type: z.literal("external-action-authorized"),
    candidateId: id,
    revisionDigest: digest,
    destination: id,
  }),
  // A separate submission receipt lets the funnel distinguish sent from authorized.
  event({
    type: z.literal("submission-recorded"),
    findingId: id,
    candidateId: id,
  }),
  event({
    type: z.literal("submission-outcome"),
    candidateId: id,
    outcome: z.enum([
      "triaged",
      "resolved",
      "duplicate",
      "informative",
      "not-applicable",
      "rejected",
    ]),
    /** Bounty paid in USD, when the programme reported one. */
    rewardUsd: z.number().nonnegative().max(1_000_000).optional(),
  }),
]);

export type LedgerEventV1 = z.infer<typeof ledgerEventV1Schema>;
export type LedgerEventInput = z.input<typeof ledgerEventV1Schema>;
export type LedgerReadQuery = {
  readonly campaignId?: string;
  readonly type?: LedgerEventV1["type"];
  readonly findingId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
};
export type LedgerRecord = {
  readonly sequence: number;
  readonly event: LedgerEventV1;
};
export type FunnelCounts = {
  readonly raw: number;
  readonly verified: number;
  readonly confirmed: number;
  readonly contradicted: number;
  readonly incomplete: number;
  readonly reviewed: number;
  readonly inScope: number;
  readonly submitted: number;
  readonly outcome: number;
};
const usageFields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
export type UsageField = (typeof usageFields)[number];

/** Provider-reported tokens of discovery runs, per target and UTC day of the run's end. */
export type UsageRow = {
  readonly day: string;
  readonly selectionId: string | null;
  readonly runs: number;
  readonly tokens: Readonly<Record<UsageField, number>>;
  /** Runs that did not report the field; their tokens are not in the total. */
  readonly unavailable: Readonly<Record<UsageField, number>>;
};

export type CampaignFunnel = FunnelCounts & {
  readonly campaignId: string;
  readonly discoveryAttempts: number;
  readonly runCount: number;
  readonly knownCostUsd: number;
  readonly unpricedRuns: number;
  readonly wallTimeMs: number;
  /** Reviewed, non-contradicted findings judged in-scope, per assessed programme. */
  readonly inScopeByProgramme: Readonly<Record<string, number>>;
  /** Candidates by their latest recorded outcome. */
  readonly outcomesByKind: Readonly<Record<string, number>>;
  /** Sum of each candidate's latest reported reward. */
  readonly rewardUsd: number;
  readonly byCategory: Readonly<Record<string, FunnelCounts>>;
  /** Runs and their Findings per ablation arm, keyed `<axis>:<arm>`. */
  readonly byArm: Readonly<Record<string, ArmCounts>>;
};
export type ArmCounts = {
  readonly runs: number;
  readonly findings: number;
  readonly confirmed: number;
};

const querySchema = z.strictObject({
  campaignId: id.optional(),
  type: z
    .enum([
      "target-selected",
      "snapshot-frozen",
      "lab-provisioned",
      "discovery-run-started",
      "discovery-run-finished",
      "discovery-concluded",
      "campaign-stopped",
      "target-skipped",
      "finding-recorded",
      "verifier-run-finished",
      "verification-finished",
      "review-decided",
      "scope-assessed",
      "draft-saved",
      "external-action-authorized",
      "submission-recorded",
      "submission-outcome",
    ])
    .optional(),
  findingId: id.optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

const storedRow = z.strictObject({
  sequence: z.number().int().positive(),
  identity: z.string(),
  input_digest: digest,
  event_json: z.string(),
});

type Counts = { -readonly [K in keyof FunnelCounts]: number };

function emptyCounts(): Counts {
  return {
    raw: 0,
    verified: 0,
    confirmed: 0,
    contradicted: 0,
    incomplete: 0,
    reviewed: 0,
    inScope: 0,
    submitted: 0,
    outcome: 0,
  };
}

function findingIdOf(value: LedgerEventV1): string | null {
  return "findingId" in value ? value.findingId : null;
}

/** The only operations on a ledger are append, read and a derived funnel view. */
export class Ledger {
  readonly #db: DatabaseSync;
  readonly #artifacts: PrivateArtifactStore;

  constructor(options: {
    readonly databasePath: string;
    readonly artifactStore: PrivateArtifactStore;
  }) {
    this.#db = new DatabaseSync(options.databasePath);
    this.#artifacts = options.artifactStore;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL UNIQUE,
        campaign_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        finding_id TEXT,
        input_digest TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_campaign_sequence
        ON ledger_events (campaign_id, sequence);
    `);
  }

  async append(
    candidate: LedgerEventInput,
  ): Promise<{ readonly status: "appended" | "existing" | "conflict" }> {
    const parsed = ledgerEventV1Schema.parse(candidate);
    const inputDigest = canonicalDigest(parsed);
    const prior = this.#db
      .prepare(
        "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE identity = ?",
      )
      .get(parsed.identity);
    if (prior !== undefined) {
      return {
        status:
          storedRow.parse(prior).input_digest === inputDigest
            ? "existing"
            : "conflict",
      };
    }
    for (const ref of parsed.artifacts) {
      const resolution = await this.#artifacts.resolve(ref.digest);
      if (
        resolution.status !== "resolved" ||
        resolution.artifact.digest !== ref.digest
      ) {
        throw new Error(`Private artifact is unavailable: ${ref.digest}`);
      }
    }
    let evidenceAvailable = true;
    if (
      parsed.type === "verification-finished" &&
      "evidenceDigest" in parsed.result
    ) {
      const resolution = await this.#artifacts.resolve(
        parsed.result.evidenceDigest,
      );
      evidenceAvailable =
        resolution.status === "resolved" &&
        resolution.artifact.digest === parsed.result.evidenceDigest;
      if (parsed.result.status === "runtime-confirmed") {
        const packageResolution = await this.#artifacts.resolve(
          parsed.result.reproductionPackageDigest,
        );
        evidenceAvailable &&=
          packageResolution.status === "resolved" &&
          packageResolution.artifact.digest ===
            parsed.result.reproductionPackageDigest;
      }
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db
        .prepare(
          "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE identity = ?",
        )
        .get(parsed.identity);
      if (existing !== undefined) {
        const status =
          storedRow.parse(existing).input_digest === inputDigest
            ? "existing"
            : "conflict";
        this.#db.exec("COMMIT");
        return { status };
      }

      if (parsed.type === "discovery-run-started") {
        const previousRuns = this.#db
          .prepare(
            "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'discovery-run-started' ORDER BY sequence",
          )
          .all(parsed.campaignId);
        if (
          previousRuns.some((row) => {
            const previous = ledgerEventV1Schema.parse(
              JSON.parse(
                z.object({ event_json: z.string() }).parse(row).event_json,
              ) as unknown,
            );
            return (
              previous.type === "discovery-run-started" &&
              previous.runId === parsed.runId
            );
          })
        ) {
          this.#db.exec("COMMIT");
          return { status: "conflict" };
        }
      }

      if (parsed.type === "finding-recorded") {
        if (parsed.historyRecordId !== undefined) {
          const runRow = this.#db
            .prepare(
              "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'discovery-run-started' ORDER BY sequence",
            )
            .all(parsed.campaignId)
            .map((row) =>
              ledgerEventV1Schema.parse(
                JSON.parse(
                  z.object({ event_json: z.string() }).parse(row).event_json,
                ) as unknown,
              ),
            )
            .find(
              (event) =>
                event.type === "discovery-run-started" &&
                event.runId === parsed.runId,
            );
          if (
            runRow?.type !== "discovery-run-started" ||
            runRow.snapshotDigest !== parsed.snapshotDigest ||
            runRow.history.mode !== "catalog" ||
            !runRow.history.recordIds.includes(parsed.historyRecordId)
          ) {
            this.#db.exec("COMMIT");
            return { status: "conflict" };
          }
        }
        const previousFinding = this.#db
          .prepare(
            "SELECT sequence FROM ledger_events WHERE campaign_id = ? AND event_type = 'finding-recorded' AND finding_id = ? LIMIT 1",
          )
          .get(parsed.campaignId, parsed.findingId);
        if (previousFinding !== undefined) {
          this.#db.exec("COMMIT");
          return { status: "conflict" };
        }
      }

      let recorded: LedgerEventV1 = parsed;
      if (parsed.type === "verification-finished") {
        const finding = this.#db
          .prepare(
            "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'finding-recorded' AND finding_id = ? ORDER BY sequence LIMIT 1",
          )
          .get(parsed.campaignId, parsed.findingId);
        const findingEvent =
          finding === undefined
            ? null
            : ledgerEventV1Schema.parse(
                JSON.parse(
                  z.object({ event_json: z.string() }).parse(finding)
                    .event_json,
                ) as unknown,
              );
        // A latest-version basis must name the Finding's own snapshot and a snapshot frozen here.
        const latestFrozen =
          parsed.basis === undefined ||
          this.#db
            .prepare(
              "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type = 'snapshot-frozen'",
            )
            .all(parsed.campaignId)
            .some(
              (row) =>
                ledgerEventV1Schema.parse(
                  JSON.parse(
                    z.object({ event_json: z.string() }).parse(row).event_json,
                  ) as unknown,
                ).snapshotDigest === parsed.snapshotDigest,
            );
        if (
          findingEvent?.type !== "finding-recorded" ||
          findingEvent.snapshotDigest !==
            (parsed.basis?.findingSnapshotDigest ?? parsed.snapshotDigest)
        ) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason:
                findingEvent === null ? "precondition" : "digest-mismatch",
              nextStep:
                findingEvent === null
                  ? "Record the finding before verification"
                  : "Repeat verification against the finding snapshot",
            },
          };
        } else if (!latestFrozen) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason: "precondition",
              nextStep:
                "Freeze the latest version in this campaign before re-verifying",
            },
          };
        } else if (!evidenceAvailable) {
          recorded = {
            ...parsed,
            result: {
              status: "incomplete",
              reason: "evidence",
              nextStep: "Restore verification evidence and repeat verification",
            },
          };
        }
      }
      this.#db
        .prepare(
          "INSERT INTO ledger_events (identity, campaign_id, event_type, finding_id, input_digest, event_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          recorded.identity,
          recorded.campaignId,
          recorded.type,
          findingIdOf(recorded),
          inputDigest,
          canonicalJson(recorded),
        );
      this.#db.exec("COMMIT");
      return { status: "appended" };
    } catch (error: unknown) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  read(query: LedgerReadQuery = {}): readonly LedgerRecord[] {
    const parsed = querySchema.parse(query);
    const clauses = ["sequence > ?"];
    const params: (string | number)[] = [parsed.afterSequence ?? 0];
    if (parsed.campaignId !== undefined) {
      clauses.push("campaign_id = ?");
      params.push(parsed.campaignId);
    }
    if (parsed.type !== undefined) {
      clauses.push("event_type = ?");
      params.push(parsed.type);
    }
    if (parsed.findingId !== undefined) {
      clauses.push("finding_id = ?");
      params.push(parsed.findingId);
    }
    const rows = this.#db
      .prepare(
        `SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE ${clauses.join(" AND ")} ORDER BY sequence LIMIT ?`,
      )
      .all(...params, parsed.limit ?? 100);
    return rows.map((row) => {
      const stored = storedRow.parse(row);
      return {
        sequence: stored.sequence,
        event: ledgerEventV1Schema.parse(
          JSON.parse(stored.event_json) as unknown,
        ),
      };
    });
  }

  usage(query: { readonly campaignId?: string } = {}): readonly UsageRow[] {
    const campaign =
      query.campaignId === undefined ? undefined : id.parse(query.campaignId);
    const rows = this.#db
      .prepare(
        campaign === undefined
          ? "SELECT event_json FROM ledger_events WHERE event_type IN ('target-selected', 'discovery-run-finished') ORDER BY sequence"
          : "SELECT event_json FROM ledger_events WHERE campaign_id = ? AND event_type IN ('target-selected', 'discovery-run-finished') ORDER BY sequence",
      )
      .all(...(campaign === undefined ? [] : [campaign]));
    const selections = new Map<string, string>();
    const totals = new Map<
      string,
      {
        day: string;
        selectionId: string | null;
        runs: number;
        tokens: Record<UsageField, number>;
        unavailable: Record<UsageField, number>;
      }
    >();
    for (const row of rows) {
      const event = ledgerEventV1Schema.parse(
        JSON.parse(
          z.object({ event_json: z.string() }).parse(row).event_json,
        ) as unknown,
      );
      const target = `${event.campaignId} ${event.snapshotDigest}`;
      if (event.type === "target-selected") {
        if (!selections.has(target)) selections.set(target, event.selectionId);
        continue;
      }
      // A run that never reached the provider used nothing.
      if (
        event.type !== "discovery-run-finished" ||
        event.outcome === "setup-failed"
      )
        continue;
      const day = new Date(event.occurredAt).toISOString().slice(0, 10);
      const selectionId = selections.get(target) ?? null;
      const key = `${day} ${selectionId ?? event.snapshotDigest}`;
      const zero = () =>
        Object.fromEntries(usageFields.map((field) => [field, 0])) as Record<
          UsageField,
          number
        >;
      const total = totals.get(key) ?? {
        day,
        selectionId,
        runs: 0,
        tokens: zero(),
        unavailable: zero(),
      };
      totals.set(key, total);
      total.runs++;
      for (const field of usageFields) {
        const value = event.usage?.[field] ?? "unavailable";
        if (value === "unavailable") total.unavailable[field]++;
        else total.tokens[field] += value;
      }
    }
    return [...totals.values()].sort(
      (left, right) =>
        left.day.localeCompare(right.day) ||
        (left.selectionId ?? "").localeCompare(right.selectionId ?? ""),
    );
  }

  funnel(campaignId: string): CampaignFunnel {
    const campaign = id.parse(campaignId);
    const rows = this.#db
      .prepare(
        "SELECT sequence, identity, input_digest, event_json FROM ledger_events WHERE campaign_id = ? ORDER BY sequence",
      )
      .all(campaign);
    const events = rows.map((row) =>
      ledgerEventV1Schema.parse(
        JSON.parse(storedRow.parse(row).event_json) as unknown,
      ),
    );
    const readyLabs = new Set<string>();
    const startedRuns = new Map<string, string>();
    const runArms = new Map<string, string>();
    let knownCostUsd = 0;
    let unpricedRuns = 0;
    let wallTimeMs = 0;
    const setupFailedRuns = new Set<string>();
    const findings = new Map<
      string,
      Extract<LedgerEventV1, { type: "finding-recorded" }>
    >();
    const verifications = new Map<
      string,
      Extract<LedgerEventV1, { type: "verification-finished" }>
    >();
    const reviews = new Set<string>();
    const scopes = new Map<string, Map<string, string>>();
    const submissions = new Map<string, string>();
    const outcomes = new Set<string>();
    const latestOutcome = new Map<
      string,
      Extract<LedgerEventV1, { type: "submission-outcome" }>
    >();

    for (const current of events) {
      switch (current.type) {
        case "lab-provisioned":
          if (current.status === "ready") readyLabs.add(current.labId);
          break;
        case "discovery-run-started":
          startedRuns.set(current.runId, current.labId);
          if (
            current.configuration.axis !== undefined &&
            current.configuration.arm !== undefined
          )
            runArms.set(
              current.runId,
              `${current.configuration.axis}:${current.configuration.arm}`,
            );
          break;
        case "discovery-run-finished":
          if (current.costUsd === "unavailable") unpricedRuns++;
          else knownCostUsd += current.costUsd;
          wallTimeMs += current.wallTimeMs;
          if (current.outcome === "setup-failed")
            setupFailedRuns.add(current.runId);
          break;
        case "finding-recorded":
          if (!findings.has(current.findingId))
            findings.set(current.findingId, current);
          break;
        case "verification-finished":
          verifications.set(current.findingId, current);
          break;
        case "review-decided":
          reviews.add(current.findingId);
          break;
        case "scope-assessed": {
          const byProgramme =
            scopes.get(current.findingId) ?? new Map<string, string>();
          byProgramme.set(current.programmeId, current.status);
          scopes.set(current.findingId, byProgramme);
          break;
        }
        case "submission-recorded":
          submissions.set(current.findingId, current.candidateId);
          break;
        case "submission-outcome":
          outcomes.add(current.candidateId);
          latestOutcome.set(current.candidateId, current);
          break;
      }
    }

    const inScopeByProgramme: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    for (const finding of findings.values()) {
      const status = verifications.get(finding.findingId)?.result.status;
      if (
        status === undefined ||
        status === "contradicted" ||
        !reviews.has(finding.findingId)
      )
        continue;
      for (const [programmeId, scope] of scopes.get(finding.findingId) ?? [])
        inScopeByProgramme[programmeId] =
          (inScopeByProgramme[programmeId] ?? 0) +
          (scope === "in-scope" ? 1 : 0);
    }
    const totals = emptyCounts();
    const byCategory: Record<string, Counts> = Object.create(null) as Record<
      string,
      Counts
    >;
    for (const finding of findings.values()) {
      const category = (byCategory[finding.category] ??= emptyCounts());
      for (const count of [totals, category]) {
        count.raw++;
        const verification = verifications.get(finding.findingId);
        if (verification === undefined) continue;
        count.verified++;
        const status = verification.result.status;
        if (status === "runtime-confirmed") count.confirmed++;
        else if (status === "contradicted") count.contradicted++;
        else count.incomplete++;
        if (status === "contradicted" || !reviews.has(finding.findingId))
          continue;
        count.reviewed++;
        const inScope = [
          ...(scopes.get(finding.findingId)?.values() ?? []),
        ].includes("in-scope");
        if (!inScope) continue;
        count.inScope++;
        const candidateId = submissions.get(finding.findingId);
        if (candidateId === undefined) continue;
        count.submitted++;
        if (outcomes.has(candidateId)) count.outcome++;
      }
    }
    const outcomesByKind: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    let rewardUsd = 0;
    for (const latest of latestOutcome.values()) {
      outcomesByKind[latest.outcome] =
        (outcomesByKind[latest.outcome] ?? 0) + 1;
      rewardUsd += latest.rewardUsd ?? 0;
    }
    const byArm: Record<
      string,
      { runs: number; findings: number; confirmed: number }
    > = Object.create(null) as Record<
      string,
      { runs: number; findings: number; confirmed: number }
    >;
    for (const arm of runArms.values())
      (byArm[arm] ??= { runs: 0, findings: 0, confirmed: 0 }).runs++;
    for (const finding of findings.values()) {
      const arm = runArms.get(finding.runId);
      if (arm === undefined) continue;
      const counts = byArm[arm]!;
      counts.findings++;
      if (
        verifications.get(finding.findingId)?.result.status ===
        "runtime-confirmed"
      )
        counts.confirmed++;
    }
    const discoveryAttempts = [...startedRuns.entries()].filter(
      ([runId, labId]) => readyLabs.has(labId) && !setupFailedRuns.has(runId),
    ).length;
    return {
      campaignId: campaign,
      discoveryAttempts,
      runCount: startedRuns.size,
      knownCostUsd,
      unpricedRuns,
      wallTimeMs,
      ...totals,
      inScopeByProgramme: { ...inScopeByProgramme },
      outcomesByKind,
      rewardUsd,
      byCategory,
      byArm: { ...byArm },
    };
  }
}
