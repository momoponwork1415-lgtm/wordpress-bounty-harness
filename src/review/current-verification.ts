import type { Ledger } from "../ledger/index.js";
import type { ReviewRef } from "./records.js";

/** A later attempt or latest-version Finding supersedes a review basis. */
export function isCurrentVerification(ledger: Ledger, ref: ReviewRef): boolean {
  const latestAttempt = ledger
    .readAll({
      campaignId: ref.campaignId,
      findingId: ref.findingId,
      type: "verification-finished",
    })
    .at(-1)?.event;
  if (
    latestAttempt?.type !== "verification-finished" ||
    latestAttempt.verificationId !== ref.verificationId ||
    latestAttempt.snapshotDigest !== ref.snapshotDigest
  )
    return false;

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
  return newestLatest === undefined || newestLatest.findingId === ref.findingId;
}
