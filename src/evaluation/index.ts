import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";
import { clopperPearson, type Interval } from "./interval.js";

export type { Interval } from "./interval.js";

const id = z.string().min(1).max(128);

/** A source location as both the key and a Finding trace express it. */
export interface SourceLocation {
  readonly file: string;
  readonly function?: string | undefined;
}

/** The profile-neutral part of an Answer Key that location-overlap needs. */
export interface LocationAnswerKey {
  readonly caseId: string;
  readonly allowedLocations: readonly SourceLocation[];
}

/** A later public advisory in key form; the profile decides which targets it affects. */
export interface ProspectiveAdvisory extends LocationAnswerKey {
  readonly publishedAt: string;
  matches(selectionId: string): boolean;
}

export type ProspectiveStatus =
  "found" | "missed" | "unscorable" | "predates-run" | "not-searched";

export type ProspectiveScore = {
  readonly metric: "location-overlap";
  readonly advisories: readonly {
    readonly caseId: string;
    readonly status: ProspectiveStatus;
    readonly snapshots: readonly string[];
    readonly overlapping: readonly string[];
    readonly unreadable: readonly string[];
  }[];
  readonly counts: Readonly<Record<ProspectiveStatus, number>>;
  /** Pairs for the human blind rubric; no arm, configuration or verification result. */
  readonly rubric: readonly {
    readonly caseId: string;
    readonly findingId: string;
  }[];
};

export type LocationOverlapScore = {
  readonly metric: "location-overlap";
  readonly campaignId: string;
  readonly caseId: string;
  readonly findings: number;
  readonly overlapping: readonly string[];
  /** Findings whose private record could not be read; a scoring failure, not a miss. */
  readonly unreadable: readonly string[];
  readonly hit: boolean;
};

export type ArmTally = {
  readonly runs: number;
  /** Runs that produced at least one runtime-confirmed Finding. */
  readonly hits: number;
  readonly findings: number;
  readonly knownCostUsd: number;
  readonly unpricedRuns: number;
};

export type ArmComparison = {
  readonly axis: "history" | "prompt" | "continuation";
  /** One row per searched snapshot; only paired rows enter the pooled numbers. */
  readonly targets: readonly {
    readonly snapshotDigest: string;
    readonly selectionId: string | null;
    readonly paired: boolean;
    readonly arms: { readonly a: ArmTally; readonly b: ArmTally };
  }[];
  readonly pooled: {
    readonly a: ArmTally & { readonly interval: Interval };
    readonly b: ArmTally & { readonly interval: Interval };
  };
  /** Overlapping intervals are inconclusive, never "no difference". */
  readonly verdict: "inconclusive" | "a-higher" | "b-higher";
};

type MutableTally = { -readonly [K in keyof ArmTally]: ArmTally[K] };
const emptyTally = (): MutableTally => ({
  runs: 0,
  hits: 0,
  findings: 0,
  knownCostUsd: 0,
  unpricedRuns: 0,
});

function overlaps(
  trace: readonly SourceLocation[],
  allowed: readonly SourceLocation[],
): boolean {
  return trace.some((location) =>
    allowed.some(
      (key) =>
        key.file === location.file &&
        (key.function === undefined || key.function === location.function),
    ),
  );
}

/** Reads the ledger and private Finding records only; nothing flows back to discovery. */
export class Evaluation {
  readonly #ledger: Ledger;
  readonly #store: PrivateArtifactStore;
  readonly #locationsOf: (finding: unknown) => readonly SourceLocation[];

  constructor(options: {
    readonly ledger: Ledger;
    readonly store: PrivateArtifactStore;
    /** Profile reader for the trace inside a private Finding record. */
    readonly locationsOf: (finding: unknown) => readonly SourceLocation[];
  }) {
    this.#ledger = options.ledger;
    this.#store = options.store;
    this.#locationsOf = options.locationsOf;
  }

  async score(input: {
    readonly campaignId: string;
    readonly answerKey: LocationAnswerKey;
  }): Promise<LocationOverlapScore> {
    const campaignId = id.parse(input.campaignId);
    const caseId = id.parse(input.answerKey.caseId);
    if (input.answerKey.allowedLocations.length === 0)
      throw new Error("Answer Key has no allowed locations");
    const overlapping: string[] = [];
    const unreadable: string[] = [];
    let findings = 0;
    let afterSequence = 0;
    for (;;) {
      const page = this.#ledger.read({
        campaignId,
        type: "finding-recorded",
        afterSequence,
        limit: 1000,
      });
      for (const { event } of page) {
        if (event.type !== "finding-recorded") continue;
        findings++;
        const trace = await this.#trace(event.artifacts);
        if (trace === null) unreadable.push(event.findingId);
        else if (overlaps(trace, input.answerKey.allowedLocations))
          overlapping.push(event.findingId);
      }
      if (page.length < 1000) break;
      afterSequence = page[page.length - 1]!.sequence;
    }
    return {
      metric: "location-overlap",
      campaignId,
      caseId,
      findings,
      overlapping,
      unreadable,
      hit: overlapping.length > 0,
    };
  }

  /** Pairs arms within each target, then pools the paired targets across campaigns. */
  compare(input: {
    readonly axis: "history" | "prompt" | "continuation";
    readonly campaignId?: string;
  }): ArmComparison {
    const campaignId =
      input.campaignId === undefined ? undefined : id.parse(input.campaignId);
    const events = (type: LedgerEventV1["type"]) =>
      this.#events(type, campaignId);
    const finished = new Map<
      string,
      Extract<LedgerEventV1, { type: "discovery-run-finished" }>
    >();
    for (const event of events("discovery-run-finished"))
      if (event.type === "discovery-run-finished")
        finished.set(event.runId, event);
    const confirmed = new Map<string, boolean>();
    for (const event of events("verification-finished"))
      if (event.type === "verification-finished")
        confirmed.set(
          event.findingId,
          event.result.status === "runtime-confirmed",
        );
    const findingsByRun = new Map<string, string[]>();
    for (const event of events("finding-recorded"))
      if (event.type === "finding-recorded")
        findingsByRun.set(event.runId, [
          ...(findingsByRun.get(event.runId) ?? []),
          event.findingId,
        ]);
    const selections = new Map<string, string>();
    for (const event of events("target-selected"))
      if (
        event.type === "target-selected" &&
        !selections.has(event.snapshotDigest)
      )
        selections.set(event.snapshotDigest, event.selectionId);

    const targets = new Map<string, { a: MutableTally; b: MutableTally }>();
    for (const event of events("discovery-run-started")) {
      if (
        event.type !== "discovery-run-started" ||
        (event.runKind ?? "explore") !== "explore" ||
        (event.configuration.arms?.[input.axis] ??
          (event.configuration.axis === input.axis
            ? event.configuration.arm
            : undefined)) === undefined
      )
        continue;
      const end = finished.get(event.runId);
      // Unfinished, setup-failed and provider-refused runs were never discovery attempts.
      if (
        end === undefined ||
        end.outcome === "setup-failed" ||
        end.outcome === "provider-limited"
      )
        continue;
      const target = targets.get(event.snapshotDigest) ?? {
        a: emptyTally(),
        b: emptyTally(),
      };
      targets.set(event.snapshotDigest, target);
      const arm =
        event.configuration.arms?.[input.axis] ?? event.configuration.arm;
      if (arm === undefined) continue;
      const tally = target[arm];
      const findings = findingsByRun.get(event.runId) ?? [];
      tally.runs++;
      tally.findings += findings.length;
      if (findings.some((findingId) => confirmed.get(findingId) === true))
        tally.hits++;
      if (end.costUsd === "unavailable") tally.unpricedRuns++;
      else tally.knownCostUsd += end.costUsd;
    }

    const pooled = { a: emptyTally(), b: emptyTally() };
    const rows = [...targets.entries()].map(([snapshotDigest, arms]) => {
      const paired = arms.a.runs > 0 && arms.b.runs > 0;
      if (paired)
        for (const arm of ["a", "b"] as const)
          for (const key of Object.keys(pooled[arm]) as (keyof ArmTally)[])
            pooled[arm][key] += arms[arm][key];
      return {
        snapshotDigest,
        selectionId: selections.get(snapshotDigest) ?? null,
        paired,
        arms,
      };
    });
    const a = {
      ...pooled.a,
      interval: clopperPearson(pooled.a.hits, pooled.a.runs),
    };
    const b = {
      ...pooled.b,
      interval: clopperPearson(pooled.b.hits, pooled.b.runs),
    };
    const verdict =
      a.runs === 0 || b.runs === 0
        ? "inconclusive"
        : a.interval.lower > b.interval.upper
          ? "a-higher"
          : b.interval.lower > a.interval.upper
            ? "b-higher"
            : "inconclusive";
    return { axis: input.axis, targets: rows, pooled: { a, b }, verdict };
  }

  /** Scores searched snapshots against advisories published after their selection. */
  async prospective(input: {
    readonly advisories: readonly ProspectiveAdvisory[];
    readonly campaignId?: string;
  }): Promise<ProspectiveScore> {
    const campaignId =
      input.campaignId === undefined ? undefined : id.parse(input.campaignId);
    const searched = new Set(
      this.#events("discovery-run-started", campaignId).map(
        (event) => `${event.campaignId} ${event.snapshotDigest}`,
      ),
    );
    const selections = this.#events("target-selected", campaignId).flatMap(
      (event) =>
        event.type === "target-selected" &&
        searched.has(`${event.campaignId} ${event.snapshotDigest}`)
          ? [event]
          : [],
    );
    const findings = this.#events("finding-recorded", campaignId);
    const traces = new Map<string, readonly SourceLocation[] | null>();
    const advisories = [];
    for (const advisory of input.advisories) {
      const caseId = id.parse(advisory.caseId);
      if (advisory.allowedLocations.length === 0)
        throw new Error("Advisory has no allowed locations");
      const published = Date.parse(advisory.publishedAt);
      if (!Number.isFinite(published))
        throw new Error("Advisory publication date is invalid");
      const matching = selections.filter((event) =>
        advisory.matches(event.selectionId),
      );
      // Only an advisory published after the selection measures what discovery missed.
      const later = matching.filter(
        (event) => Date.parse(event.occurredAt) < published,
      );
      const keys = new Set(
        later.map((event) => `${event.campaignId} ${event.snapshotDigest}`),
      );
      const overlapping: string[] = [];
      const unreadable: string[] = [];
      for (const event of findings) {
        if (
          event.type !== "finding-recorded" ||
          !keys.has(`${event.campaignId} ${event.snapshotDigest}`)
        )
          continue;
        if (!traces.has(event.findingId))
          traces.set(event.findingId, await this.#trace(event.artifacts));
        const trace = traces.get(event.findingId) ?? null;
        if (trace === null) unreadable.push(event.findingId);
        else if (overlaps(trace, advisory.allowedLocations))
          overlapping.push(event.findingId);
      }
      const status: ProspectiveStatus =
        matching.length === 0
          ? "not-searched"
          : later.length === 0
            ? "predates-run"
            : overlapping.length > 0
              ? "found"
              : unreadable.length > 0
                ? "unscorable"
                : "missed";
      advisories.push({
        caseId,
        status,
        snapshots: [...new Set(later.map((event) => event.snapshotDigest))],
        overlapping,
        unreadable,
      });
    }
    const counts: Record<ProspectiveStatus, number> = {
      found: 0,
      missed: 0,
      unscorable: 0,
      "predates-run": 0,
      "not-searched": 0,
    };
    for (const advisory of advisories) counts[advisory.status]++;
    return {
      metric: "location-overlap",
      advisories,
      counts,
      rubric: advisories.flatMap((advisory) =>
        advisory.overlapping.map((findingId) => ({
          caseId: advisory.caseId,
          findingId,
        })),
      ),
    };
  }

  #events(
    type: LedgerEventV1["type"],
    campaignId: string | undefined,
  ): LedgerEventV1[] {
    const events: LedgerEventV1[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.#ledger.read({
        ...(campaignId === undefined ? {} : { campaignId }),
        type,
        afterSequence,
        limit: 1000,
      });
      events.push(...page.map(({ event }) => event));
      if (page.length < 1000) return events;
      afterSequence = page[page.length - 1]!.sequence;
    }
  }

  async #trace(
    artifacts: readonly { readonly kind: string; readonly digest: string }[],
  ): Promise<readonly SourceLocation[] | null> {
    const reference = artifacts.find((artifact) => artifact.kind === "finding");
    if (reference === undefined) return null;
    const file = await this.#store.readFile(
      reference.digest,
      "finding.json",
      1024 * 1024,
    );
    if (file.status !== "resolved") return null;
    try {
      return this.#locationsOf(
        JSON.parse(file.bytes.toString("utf8")) as unknown,
      );
    } catch {
      return null;
    }
  }
}
