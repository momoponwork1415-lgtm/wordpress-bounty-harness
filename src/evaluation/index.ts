import { z } from "zod";

import type { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import type { Ledger } from "../ledger/index.js";

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
