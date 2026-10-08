import { readFile } from "node:fs/promises";

import { canonicalDigestPreservingProperties } from "../../../infrastructure/canonical-json.js";
import type { Selection } from "../../../selection/index.js";
import type {
  WordPressOrgTargetSource,
  WordPressOrgTargetObservation,
} from "../acquisition/index.js";
import type {
  ProgrammeEligibilitySnapshotRef,
  ProgrammeIntelligence,
} from "../programme-intelligence/index.js";
import {
  wordPressSelectionPolicySchema,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
  type WordPressSelectionInspection,
  type SelectionReason,
} from "./contracts.js";

const dayMs = 86_400_000;

export interface CreateWordPressSelectionOptions {
  readonly targetSource: Pick<WordPressOrgTargetSource, "observe">;
  readonly programme: Pick<ProgrammeIntelligence, "inspect">;
  readonly programmeRef: ProgrammeEligibilitySnapshotRef;
  readonly clock?: () => Date;
}

/** WordPress.org dates look like `2026-09-01 12:00am GMT`; ISO strings also parse. */
function parseObservedDate(date: string): number | undefined {
  const wpTimestamp =
    /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(am|pm) GMT$/i.exec(date);
  let parsed: number;
  if (wpTimestamp) {
    const [, day, hourText, minuteText, meridiem] = wpTimestamp;
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (
      !day ||
      !hourText ||
      !minuteText ||
      !meridiem ||
      hour < 1 ||
      hour > 12 ||
      minute > 59
    )
      return undefined;
    const hour24 = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
    parsed = Date.parse(
      `${day}T${String(hour24).padStart(2, "0")}:${minuteText}:00Z`,
    );
  } else {
    parsed = Date.parse(date);
  }
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ageDays(date: string, now: number): number | undefined {
  const parsed = parseObservedDate(date);
  if (parsed === undefined || parsed > now) return undefined;
  return (now - parsed) / dayMs;
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function score(
  observation: WordPressOrgTargetObservation,
  policy: WordPressSelectionPolicy,
  updateAgeDays: number,
): WordPressTargetSelection["scoreBreakdown"] {
  const installations =
    Math.log10(1 + observation.activeInstallations) *
    policy.scoreWeights.installations;
  const recency =
    Math.max(0, 1 - updateAgeDays / policy.maximumUpdateAgeDays) *
    policy.scoreWeights.recency;
  const surfacePoints = (observation.tags ?? []).reduce(
    (total, tag) => total + (policy.surfaceTagWeights[normalizeName(tag)] ?? 0),
    0,
  );
  const surface = surfacePoints * policy.scoreWeights.surface;
  const highThreat =
    (highThreatSurface(observation, policy) ? 1 : 0) *
    policy.scoreWeights.highThreat;
  return { installations, recency, surface, highThreat };
}

function highThreatSurface(
  observation: WordPressOrgTargetObservation,
  policy: WordPressSelectionPolicy,
): boolean {
  const tags = new Set(policy.highThreatTags.map(normalizeName));
  return (observation.tags ?? []).some((tag) => tags.has(normalizeName(tag)));
}

export function createWordPressSelection(
  options: CreateWordPressSelectionOptions,
): Selection<
  WordPressSelectionPolicy,
  WordPressTargetSelection,
  WordPressSelectionInspection
> {
  const clock = options.clock ?? (() => new Date());

  async function inspect(
    policyInput: WordPressSelectionPolicy,
  ): Promise<readonly WordPressSelectionInspection[]> {
    const policy = wordPressSelectionPolicySchema.parse(policyInput);
    const nowDate = clock();
    const now = nowDate.getTime();
    if (!Number.isFinite(now)) throw new Error("Selection clock is invalid");
    const policyDigest = canonicalDigestPreservingProperties(policy);
    const programmeResult = await options.programme
      .inspect({
        kind: "programme-eligibility-inspection",
        schemaVersion: 1,
        snapshotRef: options.programmeRef,
        requiredFor: "target-selection-batch",
      })
      .catch(() => undefined);
    const programmeCurrent =
      programmeResult?.status === "current" &&
      programmeResult.snapshot.programmeIdentity === "programme:wordfence" &&
      programmeResult.snapshotRef.digest === options.programmeRef.digest;
    const programmeAcceptsAsset =
      programmeResult?.status === "current" &&
      programmeResult.snapshot.policy.programmeOpportunityBand !==
        "research-only" &&
      programmeResult.snapshot.policy.eligibility.assets.some(
        (asset) =>
          asset.kind === "wordpress-plugin" &&
          asset.scope === "publicly-distributed",
      );

    const results: WordPressSelectionInspection[] = [];
    for (const slug of [...new Set(policy.candidateSlugs)]) {
      const reasons: SelectionReason[] = [];
      if (!programmeCurrent) reasons.push("programme-stale");
      else if (!programmeAcceptsAsset)
        reasons.push("programme-asset-out-of-scope");
      if (policy.excludedSlugs.includes(slug)) reasons.push("excluded-slug");
      const result = await options.targetSource
        .observe({
          kind: "wordpress-org-target-observe",
          schemaVersion: 1,
          slug,
        })
        .catch(() => undefined);
      if (result?.status !== "observed") {
        reasons.push(
          result?.status === "failed" && result.reason === "closed"
            ? "distribution-closed"
            : "observation-unavailable",
        );
        results.push({ slug, status: "ineligible", reasons });
        continue;
      }
      const observation = result.observation;
      // A live fetch stamps the observation after `now` was read.
      const observedAge = ageDays(
        observation.observedAt,
        Math.max(now, clock().getTime()),
      );
      if (
        observedAge === undefined ||
        observedAge > policy.maximumObservationAgeDays
      ) {
        reasons.push("observation-stale");
      }
      const updateAge = ageDays(observation.lastUpdated, now);
      if (updateAge === undefined) reasons.push("update-date-unavailable");
      else if (updateAge > policy.maximumUpdateAgeDays)
        reasons.push("update-stale");
      if (!observation.author) reasons.push("author-unavailable");
      else if (
        policy.excludedAuthors.some(
          (author) =>
            normalizeName(author) === normalizeName(observation.author ?? ""),
        )
      ) {
        reasons.push("excluded-author");
      }
      if (observation.activeInstallations < policy.minimumActiveInstallations) {
        reasons.push("below-installation-threshold");
      }
      if (
        reasons.length > 0 ||
        updateAge === undefined ||
        programmeResult?.status !== "current"
      ) {
        results.push({ slug, status: "ineligible", reasons });
        continue;
      }
      const scoreBreakdown = score(observation, policy, updateAge);
      const pinnedVersion = policy.pinnedVersions?.[slug];
      const lastUpdated = parseObservedDate(observation.lastUpdated);
      const selection: WordPressTargetSelection = {
        targetId: observation.pluginIdentity,
        slug,
        version: pinnedVersion ?? observation.stableVersion,
        // Only the stable version is dated; a pin may name any older release.
        ...(pinnedVersion === undefined && lastUpdated !== undefined
          ? { versionPublishedAt: new Date(lastUpdated).toISOString() }
          : {}),
        activeInstallations: observation.activeInstallations,
        highThreatSurface: highThreatSurface(observation, policy),
        runBudget: highThreatSurface(observation, policy)
          ? policy.runBudget.highThreat
          : policy.runBudget.default,
        scoreBreakdown,
        score:
          scoreBreakdown.installations +
          scoreBreakdown.recency +
          scoreBreakdown.surface +
          scoreBreakdown.highThreat,
        selectedAt: nowDate.toISOString(),
        policy: { id: policy.id, digest: policyDigest },
        observationRef: result.observationRef,
        programmeRef: programmeResult.snapshotRef,
      };
      results.push({ slug, status: "eligible", reasons, selection });
    }
    return results;
  }

  return {
    inspect,
    async select(policyInput) {
      const policy = wordPressSelectionPolicySchema.parse(policyInput);
      const inspected = await inspect(policy);
      return inspected
        .flatMap((item) =>
          item.selection === undefined ? [] : [item.selection],
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.slug.localeCompare(right.slug),
        )
        .slice(0, policy.maximumTargets);
    },
  };
}

export async function loadWordPressSelectionPolicy(
  url: URL = new URL("../policy/selection.json", import.meta.url),
): Promise<WordPressSelectionPolicy> {
  return wordPressSelectionPolicySchema.parse(
    JSON.parse(await readFile(url, "utf8")),
  );
}
