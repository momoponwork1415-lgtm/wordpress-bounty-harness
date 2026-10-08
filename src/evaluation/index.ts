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
  readonly axis: "history";
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
    readonly axis: "history";
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
        event.configuration.axis !== input.axis ||
        event.configuration.arm === undefined
      )
        continue;
      const end = finished.get(event.runId);
      // An unfinished or setup-failed run was never a discovery attempt.
      if (end === undefined || end.outcome === "setup-failed") continue;
      const target = targets.get(event.snapshotDigest) ?? {
        a: emptyTally(),
        b: emptyTally(),
      };
      targets.set(event.snapshotDigest, target);
      const tally = target[event.configuration.arm];
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
