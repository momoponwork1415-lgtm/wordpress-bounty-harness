/**
 * #424/#653: Findings of one Snapshot whose profile keys overlap form
 * one group, the connected component of "shares at least one key". The group
 * labels and orders review and verification; judging and submission stay per
 * Finding, because one place can hold two different weaknesses. The rule is
 * set overlap and needs no judgement; the ledger keeps only key digests.
 */
import { canonicalDigest } from "../infrastructure/canonical-json.js";
import type { Ledger, LedgerEventV1 } from "./index.js";

type FindingRecorded = Extract<LedgerEventV1, { type: "finding-recorded" }>;
type FindingRef = {
  readonly campaignId: string;
  readonly findingId?: string | undefined;
};

/** One Finding's place in its group, derived from the ledger when read. */
export type FindingGroup = {
  /** A digest of the first-recorded Finding's campaignId and findingId. */
  readonly id: string;
  readonly size: number;
  readonly representative: boolean;
};

/**
 * Connected components over items in admission order: items sharing a key in
 * the same scope join. Returns, per item, the index of its component's first
 * item. An item without keys stands alone.
 */
export function overlapComponents(
  items: readonly {
    readonly scope: string;
    readonly keys: readonly string[];
  }[],
): number[] {
  const parent = items.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index]!;
    return index;
  };
  const owner = new Map<string, number>();
  for (const [index, item] of items.entries())
    for (const key of item.keys) {
      const scoped = `${item.scope}\u0000${key}`;
      const earlier = owner.get(scoped);
      if (earlier === undefined) owner.set(scoped, index);
      else {
        const [left, right] = [root(earlier), root(index)];
        // The smaller index stays the root, so the root is the first item.
        parent[Math.max(left, right)] = Math.min(left, right);
      }
    }
  return items.map((_, index) => root(index));
}

const refOf = ({ campaignId, findingId }: FindingRef) =>
  `${campaignId}\u0000${findingId}`;

/** Public read-time reference; a findingId can recur in another campaign. */
const publicGroupId = (ref: {
  readonly campaignId: string;
  readonly findingId: string;
}) => canonicalDigest([ref.campaignId, ref.findingId]);

/** Findings outside the review and verification queues join no group. */
function groupedFindings(ledger: Ledger, campaignId?: string) {
  const scope = campaignId === undefined ? {} : { campaignId };
  const parked = new Set(
    ledger.activeParked(scope).map((event) => refOf(event)),
  );
  return ledger
    .readAll({ ...scope, type: "finding-recorded" })
    .map(({ event }) => event)
    .filter(
      (event): event is FindingRecorded =>
        event.type === "finding-recorded" &&
        event.derivationKind !== "fixed-version-control" &&
        !parked.has(refOf(event)),
    );
}

/**
 * The group a newly admitted Finding records: its component among the
 * Findings recorded before it in the same Snapshot. A later
 * Finding can join two groups; the ledger view then reads them as one.
 */
export function admitFindingGroup(
  ledger: Ledger,
  finding: {
    readonly campaignId: string;
    readonly snapshotDigest: string;
    readonly findingId: string;
    /** The profile's keys; only their digests reach the ledger. */
    readonly keys: readonly string[];
  },
): { readonly id: string; readonly keys: string[] } {
  const keys = [
    ...new Set(finding.keys.map((key) => canonicalDigest(key))),
  ].sort();
  const recorded = groupedFindings(ledger).filter(
    (event) => event.snapshotDigest === finding.snapshotDigest,
  );
  // Recording the same Finding again sees the same earlier Findings, so the event is identical.
  const own = recorded.findIndex(
    (event) =>
      event.campaignId === finding.campaignId &&
      event.findingId === finding.findingId,
  );
  const earlier = own === -1 ? recorded : recorded.slice(0, own);
  // A legacy cache projects old events for reading only; it cannot change a
  // new event's admission identity when a cache is added or removed later.
  const root = overlapComponents(
    [...earlier.map((event) => event.group?.keys ?? []), keys].map(
      (itemKeys) => ({ scope: "", keys: itemKeys }),
    ),
  ).at(-1)!;
  return { id: earlier[root]?.findingId ?? finding.findingId, keys };
}

/** Groups of the recorded Findings, recomputed from the key digests each event kept. */
export function readFindingGroups(
  ledger: Ledger,
  input: { readonly campaignId?: string } = {},
) {
  // A campaign view still needs the earlier Findings in other campaigns to
  // derive the same group id and size for a shared Snapshot.
  const findings = groupedFindings(ledger);
  const roots = overlapComponents(
    findings.map((event) => ({
      scope: event.snapshotDigest,
      keys: ledger.findingGroupKeyDigests(event),
    })),
  );
  const sizes = new Map<number, number>();
  for (const root of roots) sizes.set(root, (sizes.get(root) ?? 0) + 1);
  const placed = new Map(findings.map((event, index) => [refOf(event), index]));
  const indexOf = (ref: FindingRef) =>
    ref.findingId === undefined ? undefined : placed.get(refOf(ref));
  return {
    /** The groups sharing a digest-only profile key with a Lead on this Snapshot. */
    matchingKeyDigests(
      snapshotDigest: string,
      keys: readonly string[],
    ): string[] {
      const sought = new Set(keys);
      const matched = new Set<number>();
      for (const [index, event] of findings.entries()) {
        if (event.snapshotDigest !== snapshotDigest) continue;
        if (ledger.findingGroupKeyDigests(event).some((key) => sought.has(key)))
          matched.add(roots[index]!);
      }
      return [...matched]
        .sort((left, right) => left - right)
        .map((root) => publicGroupId(findings[root]!));
    },
    /** A Finding outside every group (parked, a fixed-version control, unknown) is its own group. */
    of(campaignId: string, findingId: string): FindingGroup {
      if (input.campaignId !== undefined && campaignId !== input.campaignId)
        return {
          id: publicGroupId({ campaignId, findingId }),
          size: 1,
          representative: true,
        };
      const index = indexOf({ campaignId, findingId });
      if (index === undefined)
        return {
          id: publicGroupId({ campaignId, findingId }),
          size: 1,
          representative: true,
        };
      const root = roots[index]!;
      const id = publicGroupId(findings[root]!);
      return { id, size: sizes.get(root)!, representative: root === index };
    },
    /** Representatives first in recorded order, then each group's other Findings, group by group. */
    order<T>(items: readonly T[], ref: (item: T) => FindingRef): T[] {
      const rank = (item: T) => {
        const itemRef = ref(item);
        const index =
          input.campaignId !== undefined &&
          itemRef.campaignId !== input.campaignId
            ? undefined
            : indexOf(itemRef);
        return index === undefined || roots[index] === index
          ? -1
          : roots[index]!;
      };
      // Array sort is stable: equal ranks keep the order they came in.
      return items
        .map((item) => ({ item, rank: rank(item) }))
        .sort((left, right) => left.rank - right.rank)
        .map(({ item }) => item);
    },
  };
}
