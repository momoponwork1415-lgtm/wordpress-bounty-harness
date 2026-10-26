import type { Ledger } from "../ledger/index.js";
import type { ReviewRef } from "./records.js";

/** A newer latest-version Finding of the same original replaces this one. */
export function supersededByLatestVersion(
  ledger: Ledger,
  ref: Pick<ReviewRef, "campaignId" | "findingId">,
): boolean {
  const findings = ledger
    .readAll({ campaignId: ref.campaignId, type: "finding-recorded" })
    .map(({ event }) => event)
    .filter((event) => event.type === "finding-recorded");
  const byId = new Map(findings.map((event) => [event.findingId, event]));
  const rootOf = (findingId: string): string => {
    let current = findingId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = byId.get(current)?.derivedFromFindingId;
      if (parent === undefined) break;
      current = parent;
    }
    return current;
  };
  const root = rootOf(ref.findingId);
  const newestLatest = findings
    .filter(
      (event) =>
        event.derivationKind === "latest-version" &&
        rootOf(event.findingId) === root,
    )
    .at(-1);
  return newestLatest !== undefined && newestLatest.findingId !== ref.findingId;
}

/** A later attempt or latest-version Finding supersedes a review basis. */
export function isCurrentVerification(ledger: Ledger, ref: ReviewRef): boolean {
  const latestAttempt = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })
    .at(-1)?.event;
  return (
    latestAttempt?.type === "verification-finished" &&
    latestAttempt.verificationId === ref.verificationId &&
    latestAttempt.snapshotDigest === ref.snapshotDigest &&
    !supersededByLatestVersion(ledger, ref)
  );
}
