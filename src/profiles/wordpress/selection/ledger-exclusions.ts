import { z } from "zod";

import {
  countsAsTrialChain,
  recordedTrialActivity,
} from "../../../discovery/counts-as-trial.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { compareVersions } from "../plugin-version.js";
import { parseWordPressOrgSelectionId } from "../target-identity.js";

/** New queues revisit only when the stable version increases (#533). */
export const wordPressRevisitPolicySchema = z.strictObject({
  kind: z.literal("version-increased"),
});

export type WordPressLedgerExclusionReason =
  | "previously-selected"
  /** This exact version failed Lab provisioning (e.g. a missing dependency plugin) and never started a Trial. */
  | "lab-provision-failed"
  /** This exact version's source freeze was deferred (e.g. an unreadable plugin header) while the same attempt froze another target, or its archive was rejected (#623). */
  | "freeze-deferred"
  /** A batch another runner of the state holds selected this slug and has not finished (#604). */
  | "reserved-by-runner";

export interface WordPressLedgerExclusion {
  readonly slug: string;
  readonly version: string;
  readonly reasons: readonly WordPressLedgerExclusionReason[];
  readonly reason: "initial" | "version-increased";
}

interface EarlierSelection {
  readonly version: string;
  readonly snapshotKey: string;
}

function ledgerEvents(
  ledger: Pick<Ledger, "readAll">,
  type: LedgerEventV1["type"],
): readonly LedgerEventV1[] {
  return ledger.readAll({ type }).map(({ event }) => event);
}

function snapshotKey(
  event: Pick<LedgerEventV1, "campaignId" | "snapshotDigest">,
): string {
  return `${event.campaignId}\0${event.snapshotDigest}`;
}

/** Inspect the append-only ledger; selections without a counted Trial remain eligible. */
export function inspectWordPressLedgerExclusions(input: {
  readonly ledger: Pick<Ledger, "readAll">;
  readonly candidates: readonly {
    readonly slug: string;
    readonly version: string;
  }[];
  /** Batches another runner holds; any slug they selected is excluded (#604). */
  readonly reservedBatches?: ReadonlySet<string>;
}): readonly WordPressLedgerExclusion[] {
  const selectedBySlug = new Map<string, EarlierSelection[]>();
  const selectedBySnapshot = new Map<string, string>();
  const versionBySnapshot = new Map<string, string>();
  // An attempt that froze any target shows the host could freeze; its deferrals belong to the target.
  const attemptsThatFroze = new Set<string>();
  const reservedSlugs = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "target-selected")) {
    if (event.type !== "target-selected") continue;
    attemptsThatFroze.add(event.campaignId);
    const identity = parseWordPressOrgSelectionId(event.selectionId);
    if (identity === null) continue;
    if (input.reservedBatches?.has(event.campaignId))
      reservedSlugs.add(identity.slug);
    const key = snapshotKey(event);
    selectedBySnapshot.set(key, identity.slug);
    versionBySnapshot.set(key, identity.version);
  }

  // A discovery Lab that failed to provision for a snapshot that never explored marks that slug@version.
  const labFailedSnapshots = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "lab-provisioned"))
    if (
      event.type === "lab-provisioned" &&
      event.status === "failed" &&
      event.purpose !== "verification"
    )
      labFailedSnapshots.add(snapshotKey(event));
  const exploredSnapshots = new Set<string>();

  const finishedRuns = new Map<
    string,
    Extract<LedgerEventV1, { type: "discovery-run-finished" }>
  >();
  for (const event of ledgerEvents(input.ledger, "discovery-run-finished"))
    if (event.type === "discovery-run-finished")
      finishedRuns.set(`${event.campaignId}\0${event.runId}`, event);
  // A provider-limited run alone is retried after backoff. The runner's
  // reasoned resume refusal/cap writes this terminal skip with its diagnostic;
  // that incomplete Trial must not be selected again in a later campaign.
  const terminalLimitedSnapshots = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "target-skipped"))
    if (
      event.type === "target-skipped" &&
      event.stage === "discovery" &&
      event.reason === "run-failed" &&
      event.artifacts.some(
        (artifact) => artifact.kind === "target-skip-diagnostic",
      )
    )
      terminalLimitedSnapshots.add(snapshotKey(event));
  const activeRuns = recordedTrialActivity(input.ledger);
  const starts = ledgerEvents(input.ledger, "discovery-run-started");
  const startsById = new Map(
    starts.flatMap((event) =>
      event.type === "discovery-run-started"
        ? [[`${event.campaignId}\0${event.runId}`, event] as const]
        : [],
    ),
  );
  for (const event of starts) {
    if (event.type !== "discovery-run-started") continue;
    const key = snapshotKey(event);
    // Historical events had no runKind and each represented exploration.
    if (!["explore", "enumerate"].includes(event.runKind ?? "explore"))
      continue;
    exploredSnapshots.add(key);
    const runKey = `${event.campaignId}\0${event.runId}`;
    const finished = finishedRuns.get(runKey);
    const segment = (runId: string) => ({
      finished: finishedRuns.get(`${event.campaignId}\0${runId}`),
      hasRecordedActivity: activeRuns.has(`${event.campaignId}\0${runId}`),
      resumesRun: startsById.get(`${event.campaignId}\0${runId}`)?.resumesRun,
    });
    if (
      !countsAsTrialChain(event.runId, segment) &&
      !(
        finished?.outcome === "provider-limited" &&
        terminalLimitedSnapshots.has(key)
      )
    )
      continue;
    const slug = selectedBySnapshot.get(key);
    const version = versionBySnapshot.get(key);
    if (slug === undefined || version === undefined) continue;
    const earlier = selectedBySlug.get(slug) ?? [];
    if (!earlier.some((item) => item.snapshotKey === key))
      earlier.push({ version, snapshotKey: key });
    selectedBySlug.set(slug, earlier);
  }

  const labFailedVersions = new Map<string, Set<string>>();
  for (const key of labFailedSnapshots) {
    if (exploredSnapshots.has(key)) continue;
    const slug = selectedBySnapshot.get(key);
    const version = versionBySnapshot.get(key);
    if (slug === undefined || version === undefined) continue;
    const versions = labFailedVersions.get(slug) ?? new Set<string>();
    versions.add(version);
    labFailedVersions.set(slug, versions);
  }

  const exploredVersions = new Set<string>();
  for (const key of exploredSnapshots) {
    const slug = selectedBySnapshot.get(key);
    const version = versionBySnapshot.get(key);
    if (slug !== undefined && version !== undefined)
      exploredVersions.add(`${slug}@${version}`);
  }
  const deferredVersions = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "target-skipped")) {
    if (event.type !== "target-skipped" || event.stage !== "freeze") continue;
    // A deferral is the target's own when the same attempt froze another
    // target. A rejected archive is the version's own whatever else the
    // attempt froze: the sole candidate of a band must not be retried every
    // batch (#623).
    const ownFailure =
      (event.reason === "deferred" &&
        attemptsThatFroze.has(event.campaignId)) ||
      event.reason === "invalid-archive";
    if (!ownFailure) continue;
    const identity = parseWordPressOrgSelectionId(event.selectionId);
    if (identity === null) continue;
    const key = `${identity.slug}@${identity.version}`;
    if (!exploredVersions.has(key)) deferredVersions.add(key);
  }

  return input.candidates.map(({ slug, version }) => {
    const reasons: WordPressLedgerExclusionReason[] = [];
    if (labFailedVersions.get(slug)?.has(version))
      reasons.push("lab-provision-failed");
    if (deferredVersions.has(`${slug}@${version}`))
      reasons.push("freeze-deferred");
    if (reservedSlugs.has(slug)) reasons.push("reserved-by-runner");
    const earlier = selectedBySlug.get(slug) ?? [];
    if (
      earlier.some(
        (selected) => compareVersions(version, selected.version) <= 0,
      )
    )
      reasons.push("previously-selected");
    return {
      slug,
      version,
      reasons,
      reason: earlier.length > 0 ? "version-increased" : "initial",
    };
  });
}
