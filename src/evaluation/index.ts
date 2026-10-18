import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger, LedgerEventV1 } from "../ledger/index.js";

const id = z.string().min(1).max(128);

/** A source location as both the key and a Finding trace express it. */
export interface SourceLocation {
  readonly file: string;
  readonly function?: string | undefined;
}

/** The profile-neutral part of an advisory key that location-overlap needs. */
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

/** Reads ledger references and private records only; nothing flows back to discovery. */
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
