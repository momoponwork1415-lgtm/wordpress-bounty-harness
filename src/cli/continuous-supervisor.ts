import {
  continuousChildCampaignId,
  type ContinuousRunRecord,
} from "../infrastructure/continuous-run-journal.js";
import type { ContinuousRunOwnerObservation } from "../infrastructure/continuous-run-owner.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";

export type ContinuousSupervisorDecision =
  | { readonly action: "wake"; readonly expectedRevision: number }
  | {
      readonly action: "hold";
      readonly reason:
        | "parent-not-running"
        | "stop-requested"
        | "owner-live"
        | "owner-uncertain"
        | "claims-unavailable"
        | "resource-claim-present";
    };

/**
 * A scheduler may use this point-in-time, read-only gate before invoking the
 * normal parent runner. The runner must still acquire its owner capability and
 * reconcile the journal, ledger, and host claims. This decision alone never
 * authorizes a child Trial or clears an operator hold.
 */
export function assessContinuousSupervisorWake(input: {
  readonly run: ContinuousRunRecord;
  readonly owner: ContinuousRunOwnerObservation;
  readonly claims: Pick<SqliteHostResourceClaims, "status">;
}): ContinuousSupervisorDecision {
  const { run, owner, claims } = input;
  if (run.stopRequested) return { action: "hold", reason: "stop-requested" };
  if (run.state !== "RUNNING")
    return { action: "hold", reason: "parent-not-running" };
  if (owner.pidLiveness === "alive")
    return { action: "hold", reason: "owner-live" };
  if (owner.pidLiveness === "unknown")
    return { action: "hold", reason: "owner-uncertain" };
  let activeClaims: ReturnType<SqliteHostResourceClaims["status"]>["claims"];
  try {
    activeClaims = claims.status().claims;
  } catch {
    return { action: "hold", reason: "claims-unavailable" };
  }
  const campaignIds = new Set([
    ...run.children.map((child) => child.campaignId),
    continuousChildCampaignId(run.parentRunId, run.children.length),
  ]);
  if (activeClaims.some((claim) => campaignIds.has(claim.campaignId)))
    return { action: "hold", reason: "resource-claim-present" };
  return { action: "wake", expectedRevision: run.revision };
}
