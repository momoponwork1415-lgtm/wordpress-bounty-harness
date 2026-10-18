import { readFile } from "node:fs/promises";

import { canonicalDigestPreservingProperties } from "../../../infrastructure/canonical-json.js";
import type { Ledger } from "../../../ledger/index.js";
import type {
  WordPressOrgTargetSource,
  WordPressOrgTargetObservation,
} from "../acquisition/index.js";
import type {
  ProgrammeEligibilitySnapshotRef,
  ProgrammeIntelligence,
} from "../programme-intelligence/index.js";
import { compareVersions } from "../plugin-version.js";
import {
  enumerateWordPressOrgCandidates,
  type EnumerateWordPressOrgCandidatesOptions,
  type WordPressOrgCandidateEnumeration,
} from "./wordpress-org-candidate-enumerator.js";
import {
  wordPressSelectionPolicySchema,
  type WordPressSelectionPolicy,
  type WordPressTargetSelection,
  type WordPressSelectionInspection,
  type SelectionReason,
} from "./contracts.js";
import {
  inspectWordPressLedgerExclusions,
  type WordPressLedgerExclusionReason,
} from "./ledger-exclusions.js";
import {
  loadWordPressLegacyHistory,
  type WordPressLegacyHistoryReport,
} from "./legacy-history.js";

const dayMs = 86_400_000;

export interface CreateWordPressSelectionOptions {
  readonly targetSource: Pick<WordPressOrgTargetSource, "observe">;
  readonly programme: Pick<ProgrammeIntelligence, "inspect">;
  readonly programmeRef: ProgrammeEligibilitySnapshotRef;
  readonly clock?: () => Date;
  readonly fetch?: typeof fetch;
  readonly enumerateCandidates?: (
    options: EnumerateWordPressOrgCandidatesOptions,
  ) => Promise<WordPressOrgCandidateEnumeration>;
}

export interface WordPressSelectionBatchInspection {
  readonly inspections: readonly WordPressSelectionInspection[];
  readonly sourceStatus: "manual" | WordPressOrgCandidateEnumeration["status"];
  readonly sourceListings: WordPressOrgCandidateEnumeration["listings"];
}

/**
 * The boundary toward WordPress.org and the Programme: observes each
 * candidate, applies the policy's eligibility rules and scores it. It reads
 * no Ledger; `openWordPressSelection` adds that.
 */
export interface WordPressCandidateInspection {
  inspectBatch(
    policy: WordPressSelectionPolicy,
  ): Promise<WordPressSelectionBatchInspection>;
  inspect(
    policy: WordPressSelectionPolicy,
  ): Promise<readonly WordPressSelectionInspection[]>;
  /**
   * Eligible targets by score, cut at `maximumTargets`, without Ledger
   * exclusions: manual pins for a campaign run and re-verification of a
   * Finding's own target, which the Ledger would otherwise exclude.
   */
  rank(
    policy: WordPressSelectionPolicy,
  ): Promise<readonly WordPressTargetSelection[]>;
}

export type WordPressSelectionExclusionReason =
  SelectionReason | WordPressLedgerExclusionReason;

export interface WordPressSelectionDecision {
  /** Every candidate with its policy, Ledger and legacy-history reasons merged. */
  readonly inspections: readonly (Omit<
    WordPressSelectionInspection,
    "reasons"
  > & {
    readonly reasons: readonly WordPressSelectionExclusionReason[];
  })[];
  /** Candidates left without a reason, best first; one order for every caller. */
  readonly ranked: readonly WordPressTargetSelection[];
  /** `ranked` cut at `maximumTargets`. */
  readonly selected: readonly WordPressTargetSelection[];
  readonly sourceStatus: WordPressSelectionBatchInspection["sourceStatus"];
  readonly sourceListings: WordPressSelectionBatchInspection["sourceListings"];
  readonly legacyHistory: WordPressLegacyHistoryReport;
}

/** The selection `policy/selection.md` describes: policy, Ledger and legacy history. */
export interface WordPressSelection {
  decide(policy: WordPressSelectionPolicy): Promise<WordPressSelectionDecision>;
  /** `decide(policy).selected`: the next batch, Ledger exclusions applied. */
  select(
    policy: WordPressSelectionPolicy,
  ): Promise<readonly WordPressTargetSelection[]>;
}

const byScore = (
  left: WordPressTargetSelection,
  right: WordPressTargetSelection,
): number => right.score - left.score || left.slug.localeCompare(right.slug);

const eligibleTargets = (
  inspections: readonly { readonly selection?: WordPressTargetSelection }[],
): WordPressTargetSelection[] =>
  inspections.flatMap((item) =>
    item.selection === undefined ? [] : [item.selection],
  );

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
    (total, tag) =>
      total + (policy.surfaceTagWeights?.[normalizeName(tag)] ?? 0),
    0,
  );
  const surface = surfacePoints * (policy.scoreWeights.surface ?? 0);
  const highThreat =
    (highThreatSurface(observation, policy) ? 1 : 0) *
    (policy.scoreWeights.highThreat ?? 0);
  // 公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030）。
  const history = 0;
  return { installations, recency, surface, highThreat, history };
}

function highThreatSurface(
  observation: WordPressOrgTargetObservation,
  policy: WordPressSelectionPolicy,
): boolean {
  const tags = new Set((policy.highThreatTags ?? []).map(normalizeName));
  return (observation.tags ?? []).some((tag) => tags.has(normalizeName(tag)));
}

export function createWordPressSelection(
  options: CreateWordPressSelectionOptions,
): WordPressCandidateInspection {
  const clock = options.clock ?? (() => new Date());

  async function inspectBatch(
    policyInput: WordPressSelectionPolicy,
  ): Promise<WordPressSelectionBatchInspection> {
    const policy = wordPressSelectionPolicySchema.parse(policyInput);
    const nowDate = clock();
    const now = nowDate.getTime();
    if (!Number.isFinite(now)) throw new Error("Selection clock is invalid");
    const policyDigest = canonicalDigestPreservingProperties(policy);
    const pinnedVersions =
      "pinnedVersions" in policy ? policy.pinnedVersions : undefined;
    const enumeration =
      "candidateSource" in policy
        ? await (
            options.enumerateCandidates ?? enumerateWordPressOrgCandidates
          )({
            ...policy.candidateSource,
            clock,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          })
        : undefined;
    const candidateSlugs =
      "candidateSlugs" in policy
        ? policy.candidateSlugs
        : (enumeration?.candidates.map((candidate) => candidate.slug) ?? []);
    const candidateProvenance = new Map(
      enumeration?.candidates.map((candidate) => [candidate.slug, candidate]) ??
        [],
    );
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
    for (const slug of [...new Set(candidateSlugs)]) {
      const enumeration = candidateProvenance.get(slug);
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
        results.push({
          slug,
          status: "ineligible",
          reasons,
          ...(enumeration === undefined ? {} : { enumeration }),
        });
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
        policy.maximumActiveInstallations !== undefined &&
        observation.activeInstallations >= policy.maximumActiveInstallations
      ) {
        reasons.push("above-installation-ceiling");
      }
      const pinnedVersion = pinnedVersions?.[slug];
      // Directory `requires` describes the observed stable release, not a historical pin.
      if (
        policy.wordpressVersion !== undefined &&
        (pinnedVersion ?? observation.stableVersion) ===
          observation.stableVersion
      ) {
        if (observation.minimumWordPressVersion === undefined)
          reasons.push("core-requirement-unavailable");
        else if (
          compareVersions(
            observation.minimumWordPressVersion,
            policy.wordpressVersion,
          ) > 0
        )
          reasons.push("core-version-incompatible");
      }
      if (
        reasons.length > 0 ||
        updateAge === undefined ||
        programmeResult?.status !== "current"
      ) {
        results.push({
          slug,
          status: "ineligible",
          reasons,
          observedAt: observation.observedAt,
          ...(enumeration === undefined ? {} : { enumeration }),
        });
        continue;
      }
      const scoreBreakdown = score(observation, policy, updateAge);
      const lastUpdated = parseObservedDate(observation.lastUpdated);
      const selection: WordPressTargetSelection = {
        targetId: observation.pluginIdentity,
        slug,
        version: pinnedVersion ?? observation.stableVersion,
        ...(!("pluginDependencyPins" in policy) ||
        policy.pluginDependencyPins?.[slug] === undefined
          ? {}
          : { pluginDependencyPins: policy.pluginDependencyPins[slug] }),
        ...(!("targetSourcePins" in policy) ||
        policy.targetSourcePins?.[slug] === undefined
          ? {}
          : { targetSourcePin: policy.targetSourcePins[slug] }),
        ...(!("pluginDependencySlugs" in policy) ||
        policy.pluginDependencySlugs?.[slug] === undefined
          ? {}
          : { pluginDependencySlugs: policy.pluginDependencySlugs[slug] }),
        dependencyVersionPolicy:
          "candidateSlugs" in policy ? "pinned-only" : "stable-observed",
        // Only the stable version is dated; a pin may name any older release.
        ...(pinnedVersion === undefined && lastUpdated !== undefined
          ? { versionPublishedAt: new Date(lastUpdated).toISOString() }
          : {}),
        activeInstallations: observation.activeInstallations,
        highThreatSurface: highThreatSurface(observation, policy),
        ...(policy.runBudget === undefined
          ? {}
          : {
              runBudget: highThreatSurface(observation, policy)
                ? policy.runBudget.highThreat
                : policy.runBudget.default,
            }),
        ...(enumeration?.sourceTag === undefined
          ? {}
          : { candidateTag: enumeration.sourceTag }),
        scoreBreakdown,
        score:
          scoreBreakdown.installations +
          scoreBreakdown.recency +
          scoreBreakdown.surface +
          scoreBreakdown.highThreat +
          scoreBreakdown.history,
        selectedAt: nowDate.toISOString(),
        policy: { id: policy.id, digest: policyDigest },
        observationRef: result.observationRef,
        programmeRef: programmeResult.snapshotRef,
      };
      results.push({
        slug,
        status: "eligible",
        reasons,
        selection,
        observedAt: observation.observedAt,
        ...(enumeration === undefined ? {} : { enumeration }),
      });
    }
    return {
      inspections: results,
      sourceStatus: enumeration?.status ?? "manual",
      sourceListings: enumeration?.listings ?? [],
    };
  }

  return {
    inspectBatch,
    inspect: async (policyInput) =>
      (await inspectBatch(policyInput)).inspections,
    async rank(policyInput) {
      const policy = wordPressSelectionPolicySchema.parse(policyInput);
      const { inspections } = await inspectBatch(policy);
      return eligibleTargets(inspections)
        .sort(byScore)
        .slice(0, policy.maximumTargets);
    },
  };
}

export function openWordPressSelection(input: {
  readonly candidates: WordPressCandidateInspection;
  readonly ledger: Pick<Ledger, "readAll">;
  /** Git-outside legacy history JSON, read on every decision (D2). */
  readonly legacyHistoryFile?: string;
  /** The prompt a policy without `promptVariant` is selected for. */
  readonly promptVariant: string;
}): WordPressSelection {
  async function decide(
    policyInput: WordPressSelectionPolicy,
  ): Promise<WordPressSelectionDecision> {
    const policy = wordPressSelectionPolicySchema.parse(policyInput);
    const batch = await input.candidates.inspectBatch(policy);
    const eligible = eligibleTargets(batch.inspections);
    const legacy = await loadWordPressLegacyHistory(input.legacyHistoryFile);
    const ledgerReasons = new Map(
      inspectWordPressLedgerExclusions({
        ledger: input.ledger,
        legacyHistory: legacy.history,
        candidates: eligible.map(({ slug, version }) => ({ slug, version })),
        currentPromptVariant: policy.promptVariant ?? input.promptVariant,
        revisitPolicy: policy.revisitPolicy ?? { kind: "never" },
      }).map(({ slug, reasons }) => [slug, reasons]),
    );
    const inspections = batch.inspections.map((item) => ({
      ...item,
      reasons: [...item.reasons, ...(ledgerReasons.get(item.slug) ?? [])],
    }));
    const excluded = new Set(
      inspections
        .filter((item) => item.reasons.length > 0)
        .map((item) => item.slug),
    );
    const ranked = eligible
      .filter((target) => !excluded.has(target.slug))
      .sort(byScore);
    return {
      inspections,
      ranked,
      selected: ranked.slice(0, policy.maximumTargets),
      sourceStatus: batch.sourceStatus,
      sourceListings: batch.sourceListings,
      legacyHistory: legacy.report,
    };
  }
  return {
    decide,
    select: async (policy) => (await decide(policy)).selected,
  };
}

export async function loadWordPressSelectionPolicy(
  url: URL = new URL("../policy/selection.json", import.meta.url),
): Promise<WordPressSelectionPolicy> {
  return wordPressSelectionPolicySchema.parse(
    JSON.parse(await readFile(url, "utf8")),
  );
}
