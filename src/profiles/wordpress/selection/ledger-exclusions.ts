import { z } from "zod";

import {
  countsAsTrialChain,
  recordedTrialActivity,
} from "../../../discovery/counts-as-trial.js";
import type { Ledger, LedgerEventV1 } from "../../../ledger/index.js";
import { compareVersions } from "../plugin-version.js";
import { parseWordPressOrgSelectionId } from "../target-identity.js";

/**
 * Revisit is an explicit policy choice. The default policy re-admits a slug
 * once its stable version exceeds every counted Trial's version and
 * `minimumDaysSinceTrial` days have passed since the latest of those Trials
 * started (ADR 0037, 2026-10-19 addendum; `never` was ADR 0032).
 */
export const wordPressRevisitPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("never") }),
  z.strictObject({
    kind: z.literal("version-increased"),
    /** Absent: the version increase alone re-admits. */
    minimumDaysSinceTrial: z.number().int().nonnegative().max(3650).optional(),
  }),
  z.strictObject({ kind: z.literal("prompt-version-changed") }),
  z.strictObject({ kind: z.literal("version-or-prompt-changed") }),
]);

export type WordPressRevisitPolicy = z.infer<
  typeof wordPressRevisitPolicySchema
>;

export type WordPressLedgerExclusionReason =
  | "previously-selected"
  | "unpublished-finding"
  | "legacy-started"
  | "legacy-ambiguous"
  /** This exact version failed Lab provisioning (e.g. a missing dependency plugin) and never started a Trial. */
  | "lab-provision-failed";

/** Earlier generations' history, exported once outside Git (D2). */
export type WordPressLegacyHistory =
  | {
      readonly started: ReadonlySet<string>;
      readonly ambiguous: ReadonlySet<string>;
      /** Slugs the owner hands back; they ignore legacy and the Trials that started before `exportedAt`. */
      readonly reconsider: ReadonlySet<string>;
      /** When the legacy file was exported; Trials from this instant on count as new. */
      readonly exportedAt: string;
      readonly digest: string;
    }
  | "unavailable";

export interface WordPressLedgerExclusion {
  readonly slug: string;
  readonly version: string;
  readonly reasons: readonly WordPressLedgerExclusionReason[];
}

interface EarlierSelection {
  readonly version: string;
  readonly snapshotKey: string;
  /** `occurredAt` of the counted exploration start. */
  readonly startedAt: string;
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

function promptChanged(
  earlier: readonly EarlierSelection[],
  promptVersions: ReadonlyMap<string, ReadonlySet<string>>,
  currentPromptVariant: string,
): boolean {
  return earlier.every(({ snapshotKey: key }) => {
    const used = promptVersions.get(key);
    return (
      used !== undefined && used.size > 0 && !used.has(currentPromptVariant)
    );
  });
}

/** Inspect the append-only ledger; selections without a counted Trial remain eligible. */
export function inspectWordPressLedgerExclusions(input: {
  readonly ledger: Pick<Ledger, "readAll">;
  readonly candidates: readonly {
    readonly slug: string;
    readonly version: string;
  }[];
  readonly currentPromptVariant: string;
  readonly revisitPolicy: WordPressRevisitPolicy;
  readonly legacyHistory?: WordPressLegacyHistory;
  /** The instant `minimumDaysSinceTrial` is measured to; defaults to the wall clock. */
  readonly now?: Date;
}): readonly WordPressLedgerExclusion[] {
  const revisitPolicy = wordPressRevisitPolicySchema.parse(input.revisitPolicy);
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Selection clock is invalid");
  const promptVersions = new Map<string, Set<string>>();
  const selectedBySlug = new Map<string, EarlierSelection[]>();
  const selectedBySnapshot = new Map<string, string>();
  const versionBySnapshot = new Map<string, string>();
  const recordPrompt = (key: string, promptVariant: string): void => {
    const versions = promptVersions.get(key) ?? new Set<string>();
    versions.add(promptVariant);
    promptVersions.set(key, versions);
  };

  for (const event of ledgerEvents(input.ledger, "target-selected")) {
    if (event.type !== "target-selected") continue;
    const identity = parseWordPressOrgSelectionId(event.selectionId);
    if (identity === null) continue;
    const key = snapshotKey(event);
    selectedBySnapshot.set(key, identity.slug);
    versionBySnapshot.set(key, identity.version);
    if ("promptVariant" in event && typeof event.promptVariant === "string")
      recordPrompt(key, event.promptVariant);
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
    recordPrompt(key, event.configuration.promptVariant);
    // Historical events had no runKind and each represented exploration.
    if ((event.runKind ?? "explore") !== "explore") continue;
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
      earlier.push({ version, snapshotKey: key, startedAt: event.occurredAt });
    selectedBySlug.set(slug, earlier);
  }

  // A submission receipt records a human action, not public disclosure.
  // Until the ledger records publication, every Finding remains private here.
  const unpublishedFindingSlugs = new Set<string>();
  for (const event of ledgerEvents(input.ledger, "finding-recorded")) {
    if (event.type !== "finding-recorded") continue;
    const slug = selectedBySnapshot.get(snapshotKey(event));
    if (slug === undefined)
      throw new Error(
        "Cannot select: a Finding has no matching WordPress target selection",
      );
    unpublishedFindingSlugs.add(slug);
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

  const legacy = input.legacyHistory ?? "unavailable";
  return input.candidates.map(({ slug, version }) => {
    const reasons: WordPressLedgerExclusionReason[] = [];
    if (unpublishedFindingSlugs.has(slug)) reasons.push("unpublished-finding");
    if (labFailedVersions.get(slug)?.has(version))
      reasons.push("lab-provision-failed");
    // A reconsidered slug forgets the Trials that predate the legacy export, not the ones run since.
    const exportedAt =
      legacy !== "unavailable" && legacy.reconsider.has(slug)
        ? Date.parse(legacy.exportedAt)
        : null;
    const reconsidered = exportedAt !== null;
    if (legacy !== "unavailable" && !reconsidered) {
      if (legacy.started.has(slug)) reasons.push("legacy-started");
      else if (legacy.ambiguous.has(slug)) reasons.push("legacy-ambiguous");
    }
    const earlier = (selectedBySlug.get(slug) ?? []).filter(
      (selected) =>
        exportedAt === null || Date.parse(selected.startedAt) >= exportedAt,
    );
    if (earlier.length > 0) {
      const versionIncreased = earlier.every(
        (selected) => compareVersions(version, selected.version) > 0,
      );
      // The gap is measured from the latest counted Trial of this slug.
      const latestStartMs = Math.max(
        ...earlier.map((selected) => Date.parse(selected.startedAt)),
      );
      const daysSinceTrial = (nowMs - latestStartMs) / 86_400_000;
      const waitedLongEnough =
        revisitPolicy.kind !== "version-increased" ||
        revisitPolicy.minimumDaysSinceTrial === undefined ||
        (Number.isFinite(daysSinceTrial) &&
          daysSinceTrial >= revisitPolicy.minimumDaysSinceTrial);
      const changedPrompt = promptChanged(
        earlier,
        promptVersions,
        input.currentPromptVariant,
      );
      const revisit =
        revisitPolicy.kind === "version-increased"
          ? versionIncreased && waitedLongEnough
          : revisitPolicy.kind === "prompt-version-changed"
            ? changedPrompt
            : revisitPolicy.kind === "version-or-prompt-changed"
              ? versionIncreased || changedPrompt
              : false;
      if (!revisit) reasons.push("previously-selected");
    }
    return { slug, version, reasons };
  });
}
