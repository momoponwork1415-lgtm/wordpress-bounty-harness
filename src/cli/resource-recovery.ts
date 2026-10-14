import { stat } from "node:fs/promises";
import { join } from "node:path";

import { DISCOVERY_LEFTOVER_PATTERNS } from "../discovery/provider-credential-egress-broker.js";
import { canonicalJson } from "../infrastructure/canonical-json.js";
import type { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import { PrivateArtifactStore } from "../infrastructure/private-artifact-store.js";
import { Ledger } from "../ledger/index.js";
import {
  listWordPressLeftovers,
  type DockerRunner,
  type Leftovers,
} from "../profiles/wordpress/lab/index.js";

type RecoveryReport = {
  readonly claimId: string;
  readonly targetKey: string;
  readonly ownerKey: string;
  readonly campaignId: string;
  readonly snapshotDigest: string;
  readonly deadlineAt: string;
  readonly checkedAt: string;
  readonly ledgerEvents: number;
  readonly unresolvedRunIds: readonly string[];
  readonly leftovers: Leftovers;
};

const hasAny = (leftovers: Leftovers): boolean =>
  Object.values(leftovers).some((names) => names.length > 0);

/** Inspect the original ledger and every WBH Docker resource before recycling an orphan. */
export async function recoverHostClaim(input: {
  readonly claims: SqliteHostResourceClaims;
  readonly claimId: string;
  readonly docker: DockerRunner;
  readonly clock?: () => Date;
}): Promise<{
  readonly released: boolean;
  readonly reportDigest: string;
  readonly unresolvedRunIds: readonly string[];
  readonly leftovers: Leftovers;
  readonly recoveryEligibleAt: string | null;
}> {
  let report: RecoveryReport | undefined;
  let reportDigest: string | undefined;
  const released = await input.claims.reconcileAbsent(
    input.claimId,
    async (claim) => {
      const ledgerPath = join(claim.stateDirectory, "ledger.sqlite");
      if (!(await stat(ledgerPath)).isFile())
        throw new Error("The claim's original ledger is unavailable");
      const store = new PrivateArtifactStore({
        rootDirectory: join(claim.stateDirectory, "private-evidence"),
        maxEntries: 64,
        maxBytes: 72 * 1024 * 1024,
      });
      const ledger = new Ledger({
        databasePath: ledgerPath,
        artifactStore: store,
      });
      const events = [];
      let afterSequence = 0;
      for (;;) {
        const page = ledger.read({
          campaignId: claim.campaignId,
          afterSequence,
          limit: 1000,
        });
        events.push(
          ...page.filter(
            ({ event }) => event.snapshotDigest === claim.snapshotDigest,
          ),
        );
        if (page.length < 1000) break;
        afterSequence = page.at(-1)!.sequence;
      }
      const starts = new Set(
        events.flatMap(({ event }) =>
          event.type === "discovery-run-started" ? [event.runId] : [],
        ),
      );
      for (const { event } of events)
        if (event.type === "discovery-run-finished") starts.delete(event.runId);
      const leftovers = await listWordPressLeftovers(input.docker, {
        patterns: DISCOVERY_LEFTOVER_PATTERNS,
      });
      report = {
        claimId: input.claimId,
        targetKey: claim.targetKey,
        ownerKey: claim.ownerKey,
        campaignId: claim.campaignId,
        snapshotDigest: claim.snapshotDigest,
        deadlineAt: claim.deadlineAt,
        checkedAt: (input.clock ?? (() => new Date()))().toISOString(),
        ledgerEvents: events.length,
        unresolvedRunIds: [...starts].sort(),
        leftovers,
      };
      reportDigest = await store.putFiles({
        "resource-recovery.json": canonicalJson(report),
      });
      // With the owner dead and no disposable runtime resources, an unfinished
      // start is abandoned, not an active Trial. Its original event remains in
      // the ledger and #215 still counts it against future independent Trials.
      const labHasResources =
        leftovers.containers.some((name) => name.startsWith("wbh-")) ||
        leftovers.networks.some((name) => name.startsWith("wbh-")) ||
        leftovers.volumes.length > 0;
      return {
        ledgerInspected: true as const,
        unresolvedRunIds: report.unresolvedRunIds,
        labHasResources,
        brokerHasResources: hasAny(leftovers) && !labHasResources,
        evidenceDigest: reportDigest,
      };
    },
  );
  if (report === undefined || reportDigest === undefined)
    throw new Error("Resource claim inspection did not complete");
  return {
    released,
    reportDigest,
    unresolvedRunIds: report.unresolvedRunIds,
    leftovers: report.leftovers,
    recoveryEligibleAt:
      input.claims
        .status()
        .claims.find((claim) => claim.claimId === input.claimId)
        ?.recoveryEligibleAt ?? null,
  };
}
