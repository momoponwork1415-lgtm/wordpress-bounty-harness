import type { Ledger } from "../../../ledger/index.js";
import type {
  DuplicateLookup,
  DuplicateLookupResult,
} from "../../../review/index.js";
import { duplicateQuerySchema, findDuplicates } from "./index.js";

/**
 * Review's duplicate seam backed by the local Wordfence history mirror. It
 * lists possible matches only; a stale or unreadable mirror never yields no-match.
 */
export function createWordfenceDuplicateLookup(options: {
  readonly ledger: Ledger;
  readonly history: {
    readonly databasePath: string;
    readonly statePath: string;
  };
  readonly clock?: () => Date;
}): DuplicateLookup {
  return {
    async inspect({ campaignId, findingId }): Promise<DuplicateLookupResult> {
      const finding = options.ledger
        .read({ campaignId, findingId, type: "finding-recorded", limit: 1 })
        .at(0)?.event;
      if (finding?.type !== "finding-recorded")
        return { status: "unavailable" };
      const selected = options.ledger
        .read({ campaignId, type: "target-selected", limit: 1000 })
        .map(({ event }) => event)
        .find((event) => event.snapshotDigest === finding.snapshotDigest);
      const match =
        selected?.type === "target-selected"
          ? /^wporg:([a-z0-9][a-z0-9-]*)@(.+)$/.exec(selected.selectionId)
          : null;
      const query = duplicateQuerySchema.safeParse({
        plugin: match?.[1],
        version: match?.[2],
        property: finding.category,
      });
      if (!query.success) return { status: "unavailable" };
      const result = findDuplicates(query.data, {
        ...options.history,
        now: (options.clock ?? (() => new Date()))(),
      });
      if (result.candidates.length > 0)
        return {
          status: "possible-match",
          reference: result.candidates
            .map((candidate) => candidate.id)
            .join(","),
        };
      return result.status === "fresh"
        ? { status: "no-match" }
        : { status: "unavailable" };
    },
  };
}
