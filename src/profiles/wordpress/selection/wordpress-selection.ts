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
import { compareVersions } from "../plugin-version.js";
import {
  enumerateWordPressOrgCandidates,
  type EnumerateWordPressOrgCandidatesOptions,
  type WordPressOrgCandidateCursor,
  type WordPressOrgCandidateEnumeration,
  type WordPressOrgCandidateSourcePool,
  type WordPressOrgCandidate,
} from "./wordpress-org-candidate-enumerator.js";
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
  readonly fetch?: typeof fetch;
  readonly enumerateCandidates?: (
    options: EnumerateWordPressOrgCandidatesOptions,
  ) => Promise<WordPressOrgCandidateEnumeration>;
}

export interface WordPressSelectionBatchInspection {
  readonly inspections: readonly WordPressSelectionInspection[];
  readonly sourceStatus: "manual" | WordPressOrgCandidateEnumeration["status"];
  readonly sourceListings: WordPressOrgCandidateEnumeration["listings"];
  readonly sourceTraversal?: WordPressOrgCandidateEnumeration["traversal"];
  readonly sourcePool?: WordPressOrgCandidateSourcePool;
}

export type WordPressSelectionWithBatchInspection = Selection<
  WordPressSelectionPolicy,
  WordPressTargetSelection,
  WordPressSelectionInspection
> & {
  /** Older injected Selection adapters may only implement inspect. */
  readonly inspectBatch?: (
    policy: WordPressSelectionPolicy,
    cursor?: WordPressOrgCandidateCursor,
    sourcePool?: WordPressOrgCandidateSourcePool,
  ) => Promise<WordPressSelectionBatchInspection>;
  /** Re-observe nominated slugs from a fresh sealed automatic source pool. */
  readonly inspectNominated?: (
    policy: WordPressSelectionPolicy,
    sourcePool: WordPressOrgCandidateSourcePool,
    slugs: readonly string[],
  ) => Promise<readonly WordPressSelectionInspection[]>;
  /** Re-observe one slug and Programme at admission without replaying a listing pool. */
  readonly inspectCurrent?: (
    policy: WordPressSelectionPolicy,
    slug: string,
  ) => Promise<WordPressSelectionInspection>;
};

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
): WordPressSelectionWithBatchInspection {
  const clock = options.clock ?? (() => new Date());

  async function inspectBatch(
    policyInput: WordPressSelectionPolicy,
    cursor?: WordPressOrgCandidateCursor,
    sourcePool?: WordPressOrgCandidateSourcePool,
    nominatedCandidates?: readonly WordPressOrgCandidate[],
    nominatedSlugs?: readonly string[],
  ): Promise<WordPressSelectionBatchInspection> {
    const policy = wordPressSelectionPolicySchema.parse(policyInput);
    const nowDate = clock();
    const now = nowDate.getTime();
    if (!Number.isFinite(now)) throw new Error("Selection clock is invalid");
    const policyDigest = canonicalDigestPreservingProperties(policy);
    const pinnedVersions =
      "pinnedVersions" in policy ? policy.pinnedVersions : undefined;
    const enumeration =
      "candidateSource" in policy &&
      nominatedCandidates === undefined &&
      nominatedSlugs === undefined
        ? await (
            options.enumerateCandidates ?? enumerateWordPressOrgCandidates
          )({
            ...policy.candidateSource,
            ...(cursor === undefined ? {} : { cursor }),
            ...(sourcePool === undefined ? {} : { sourcePool }),
            clock,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          })
        : undefined;
    const candidateSlugs =
      nominatedSlugs !== undefined
        ? nominatedSlugs
        : nominatedCandidates !== undefined
          ? nominatedCandidates.map((candidate) => candidate.slug)
          : "candidateSlugs" in policy
            ? policy.candidateSlugs
            : (enumeration?.candidates.map((candidate) => candidate.slug) ??
              []);
    const candidateProvenance = new Map(
      (nominatedCandidates ?? enumeration?.candidates ?? []).map(
        (candidate) => [candidate.slug, candidate],
      ),
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
      sourceStatus:
        nominatedCandidates === undefined && nominatedSlugs === undefined
          ? (enumeration?.status ?? "manual")
          : "available",
      sourceListings: enumeration?.listings ?? [],
      ...(enumeration === undefined
        ? {}
        : {
            sourceTraversal: enumeration.traversal,
            ...(enumeration.sourcePool === undefined
              ? {}
              : { sourcePool: enumeration.sourcePool }),
          }),
    };
  }

  return {
    inspectBatch,
    async inspectCurrent(policyInput, slug) {
      const policy = wordPressSelectionPolicySchema.parse(policyInput);
      if (!("candidateSource" in policy))
        throw new Error("Current-slug inspection requires automatic policy");
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(slug))
        throw new Error("Invalid current-slug inspection target");
      const result = await inspectBatch(
        policy,
        undefined,
        undefined,
        undefined,
        [slug],
      );
      if (
        result.inspections.length !== 1 ||
        result.inspections[0]?.slug !== slug
      )
        throw new Error("Current-slug inspection returned another target");
      return result.inspections[0];
    },
    async inspectNominated(policyInput, sourcePool, slugs) {
      const policy = wordPressSelectionPolicySchema.parse(policyInput);
      if (!("candidateSource" in policy))
        throw new Error("Nominated inspection requires automatic policy");
      if (new Set(slugs).size !== slugs.length || slugs.length === 0)
        throw new Error("Nominated slugs must be unique and nonempty");
      const verified = await enumerateWordPressOrgCandidates({
        ...policy.candidateSource,
        sourcePool,
        cursor: {
          kind: "wordpress-org-candidate-cursor",
          schemaVersion: 1,
          listingSetDigest: sourcePool.listingSetDigest,
          nextIndex: 0,
        },
        clock,
      });
      const candidates = new Map(
        sourcePool.candidates.map((candidate) => [candidate.slug, candidate]),
      );
      if (
        verified.status !== "available" ||
        slugs.some((slug) => !candidates.has(slug))
      )
        throw new Error("Nominated slug is outside the fresh source pool");
      return (
        await inspectBatch(
          policy,
          undefined,
          undefined,
          slugs.map((slug) => candidates.get(slug)!),
        )
      ).inspections;
    },
    inspect: async (policyInput) =>
      (await inspectBatch(policyInput)).inspections,
    async select(policyInput) {
      const policy = wordPressSelectionPolicySchema.parse(policyInput);
      const { inspections: inspected } = await inspectBatch(policy);
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
