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
import type {
  WordPressAdvisoryHistoryCount,
  WordPressAdvisoryHistoryMirror,
  WordPressAdvisoryHistorySource,
} from "./advisory-history.js";
import {
  advisoryHistoryDefaults,
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
  /** The public advisory mirror; required only when the policy weights history (ADR 0037). */
  readonly advisoryHistory?: WordPressAdvisoryHistorySource;
}

/** What the selection report records about the mirror: timestamp, digest and the policy's window, never record content. */
export type WordPressSelectionAdvisoryHistoryReport =
  | { readonly status: "not-used" }
  | {
      readonly status: "used";
      readonly asOf: string;
      readonly digest: string;
      readonly recordCount: number;
      /** A refresh attempt after `asOf` failed; the data is still inside the policy's age. */
      readonly lastRefreshFailed: boolean;
      readonly windowDays: number;
      readonly countCap: number;
      readonly payingClassCap: number;
      readonly maximumAgeDays: number;
    };

export interface WordPressSelectionBatchInspection {
  /** The primary band's view of every candidate. */
  readonly inspections: readonly WordPressSelectionInspection[];
  /** The same candidates under each `cascade` step, in policy order (empty without a cascade). */
  readonly cascade: readonly {
    readonly step: number;
    readonly inspections: readonly WordPressSelectionInspection[];
  }[];
  readonly sourceStatus: "manual" | WordPressOrgCandidateEnumeration["status"];
  readonly sourceListings: WordPressOrgCandidateEnumeration["listings"];
  readonly advisoryHistory: WordPressSelectionAdvisoryHistoryReport;
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
  /** The cascade step whose band `ranked` comes from; absent for the primary band. */
  readonly cascadeStep?: number | undefined;
  /** Eligible counts of the bands tried, step 0 being the primary band, in the order tried. */
  readonly cascade: readonly {
    readonly step: number;
    readonly eligible: number;
  }[];
  /**
   * Every band's merged inspections and ranking, step 0 first, so a caller
   * whose freezes leave it below `minimum` can go on to the next band (#623).
   */
  readonly bands: readonly {
    readonly step: number;
    readonly inspections: WordPressSelectionDecision["inspections"];
    readonly ranked: readonly WordPressTargetSelection[];
  }[];
  readonly sourceStatus: WordPressSelectionBatchInspection["sourceStatus"];
  readonly sourceListings: WordPressSelectionBatchInspection["sourceListings"];
  readonly legacyHistory: WordPressLegacyHistoryReport;
  readonly advisoryHistory: WordPressSelectionAdvisoryHistoryReport;
}

export interface WordPressSelectionDecideOptions {
  /**
   * Fewest eligible candidates that make the primary band sufficient; below it
   * the policy's `cascade` steps are tried in order (default 1).
   */
  readonly minimum?: number;
  /** Selection batches another runner holds unfinished; their slugs are excluded (#604). */
  readonly reservedBatches?: readonly string[];
}

/** The selection `policy/selection.md` describes: policy, Ledger and legacy history. */
export interface WordPressSelection {
  decide(
    policy: WordPressSelectionPolicy,
    options?: WordPressSelectionDecideOptions,
  ): Promise<WordPressSelectionDecision>;
  /** `decide(policy).selected`: the next batch, Ledger exclusions applied. */
  select(
    policy: WordPressSelectionPolicy,
    options?: WordPressSelectionDecideOptions,
  ): Promise<readonly WordPressTargetSelection[]>;
}

interface SelectionBand {
  /** 0 for the primary band, otherwise the 1-based cascade step. */
  readonly step: number;
  readonly minimumActiveInstallations: number;
  readonly maximumActiveInstallations: number | undefined;
  readonly minimumPayingClassCount: number | undefined;
}

/** The primary band followed by the policy's cascade steps, each the primary with its fields overridden. */
function selectionBands(policy: WordPressSelectionPolicy): SelectionBand[] {
  const primary: SelectionBand = {
    step: 0,
    minimumActiveInstallations: policy.minimumActiveInstallations,
    maximumActiveInstallations: policy.maximumActiveInstallations,
    minimumPayingClassCount: undefined,
  };
  const steps = "cascade" in policy ? (policy.cascade ?? []) : [];
  return [
    primary,
    ...steps.map((step, index) => ({
      step: index + 1,
      minimumActiveInstallations: step.minimumActiveInstallations,
      maximumActiveInstallations:
        step.maximumActiveInstallations === undefined
          ? policy.maximumActiveInstallations
          : (step.maximumActiveInstallations ?? undefined),
      minimumPayingClassCount: step.minimumPayingClassCount,
    })),
  ];
}

function bandSelectionReasons(
  band: SelectionBand,
  activeInstallations: number,
  counted: WordPressAdvisoryHistoryCount | undefined,
): SelectionReason[] {
  const reasons: SelectionReason[] = [];
  if (activeInstallations < band.minimumActiveInstallations)
    reasons.push("below-installation-threshold");
  if (
    band.maximumActiveInstallations !== undefined &&
    activeInstallations >= band.maximumActiveInstallations
  )
    reasons.push("above-installation-ceiling");
  // The count is read only for candidates the band-independent rules admit;
  // an unread count is not a failed floor.
  if (
    band.minimumPayingClassCount !== undefined &&
    counted !== undefined &&
    counted.payingClassCount < band.minimumPayingClassCount
  )
    reasons.push("below-paying-class-minimum");
  return reasons;
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

/** The policy's advisory-history settings with ADR 0037 defaults filled in. */
export function advisoryHistorySettings(policy: WordPressSelectionPolicy): {
  readonly weight: number;
  readonly payingClassWeight: number;
  readonly recordRecencyWeight: number;
  readonly windowDays: number;
  readonly countCap: number;
  readonly payingClassCap: number;
  readonly maximumAgeDays: number;
  readonly payingClasses: readonly string[];
  /** The mirror is opened only when a history weight is positive. */
  readonly used: boolean;
} {
  const weight = policy.scoreWeights.history ?? 0;
  const payingClassWeight = policy.scoreWeights.historyPayingClass ?? 0;
  const recordRecencyWeight = policy.scoreWeights.recordRecency ?? 0;
  return {
    weight,
    payingClassWeight,
    recordRecencyWeight,
    windowDays: policy.historyWindowDays ?? advisoryHistoryDefaults.windowDays,
    countCap: policy.historyCountCap ?? advisoryHistoryDefaults.countCap,
    payingClassCap:
      policy.historyPayingClassCap ?? advisoryHistoryDefaults.payingClassCap,
    maximumAgeDays:
      policy.maximumHistoryAgeDays ?? advisoryHistoryDefaults.maximumAgeDays,
    payingClasses:
      policy.historyPayingClasses ?? advisoryHistoryDefaults.payingClasses,
    // A cascade step's paying-class floor also needs the counts.
    used:
      weight > 0 ||
      payingClassWeight > 0 ||
      recordRecencyWeight > 0 ||
      ("cascade" in policy &&
        (policy.cascade ?? []).some(
          (step) => step.minimumPayingClassCount !== undefined,
        )),
  };
}

/** Where the newest counted record falls in the window: 1 at the mirror's `asOf`, 0 at the window's edge or with no record. */
export function recordRecency(
  latestPublished: string | undefined,
  asOfMs: number,
  windowDays: number,
): number {
  const latestMs =
    latestPublished === undefined ? undefined : Date.parse(latestPublished);
  if (latestMs === undefined || !Number.isFinite(latestMs)) return 0;
  return Math.max(
    0,
    Math.min(1, 1 - (asOfMs - latestMs) / (windowDays * dayMs)),
  );
}

/**
 * Three members, all relative to the mirror's `asOf` rather than the wall
 * clock, so one mirror gives one score (policy/selection.md, ADR 0037 and its
 * 2026-10-19 addendum):
 * - `history = w × min(count, historyCountCap) / historyCountCap`
 * - `historyPayingClass = w × min(payingClassCount, historyPayingClassCap)`
 *   (one point per record, not normalised)
 * - `recordRecency = w × max(0, 1 − daysSinceLatestRecord / historyWindowDays)`
 */
function historyScore(
  counted: WordPressAdvisoryHistoryCount,
  settings: ReturnType<typeof advisoryHistorySettings>,
  asOfMs: number,
): {
  readonly history: number;
  readonly historyPayingClass: number;
  readonly recordRecency: number;
} {
  const volume = Math.min(counted.count, settings.countCap) / settings.countCap;
  return {
    history: settings.weight * volume,
    historyPayingClass:
      settings.payingClassWeight *
      Math.min(counted.payingClassCount, settings.payingClassCap),
    recordRecency:
      settings.recordRecencyWeight *
      recordRecency(counted.latestPublished, asOfMs, settings.windowDays),
  };
}

const NO_HISTORY = { history: 0, historyPayingClass: 0, recordRecency: 0 };

/** Stops `select` before any candidate is observed when the mirror cannot be trusted (ADR 0037). */
function openAdvisoryHistory(
  source: WordPressAdvisoryHistorySource | undefined,
  settings: ReturnType<typeof advisoryHistorySettings>,
  now: Date,
): WordPressAdvisoryHistoryMirror {
  if (source === undefined)
    throw new Error(
      "Selection policy weights advisory history but the host has no wordfenceHistory mirror configured",
    );
  const opened = source.open({
    now,
    maximumAgeMs: settings.maximumAgeDays * dayMs,
  });
  if (opened.status === "unavailable")
    throw new Error(
      `Wordfence history mirror is unavailable (${opened.reason}); selection stops until it is repaired`,
    );
  if (opened.status === "stale")
    throw new Error(
      `Wordfence history mirror is stale: last success ${opened.lastSuccessfulAt} is ${(opened.ageMs / dayMs).toFixed(1)} days old, policy maximumHistoryAgeDays is ${settings.maximumAgeDays}; refresh the mirror, then select again`,
    );
  return opened.mirror;
}

function score(
  observation: WordPressOrgTargetObservation,
  policy: WordPressSelectionPolicy,
  updateAgeDays: number,
  history: typeof NO_HISTORY,
): WordPressTargetSelection["scoreBreakdown"] {
  const installations =
    Math.log10(1 + observation.activeInstallations) *
    policy.scoreWeights.installations;
  const recency =
    Math.max(0, 1 - updateAgeDays / policy.maximumUpdateAgeDays) *
    policy.scoreWeights.recency;
  // 公開履歴は mirror の件数と公開日だけを採点に使う（ADR 0037）。記録の内容は読まない。
  return {
    installations,
    recency,
    history: history.history,
    historyPayingClass: history.historyPayingClass,
    recordRecency: history.recordRecency,
  };
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
    const historySettings = advisoryHistorySettings(policy);
    // A stale or inconsistent mirror stops here, before any WordPress.org request.
    const mirror = historySettings.used
      ? openAdvisoryHistory(options.advisoryHistory, historySettings, nowDate)
      : undefined;
    try {
      const advisoryHistory: WordPressSelectionAdvisoryHistoryReport =
        mirror === undefined
          ? { status: "not-used" }
          : {
              status: "used",
              asOf: mirror.asOf,
              digest: mirror.digest,
              recordCount: mirror.recordCount,
              lastRefreshFailed: mirror.lastRefreshFailed,
              windowDays: historySettings.windowDays,
              countCap: historySettings.countCap,
              payingClassCap: historySettings.payingClassCap,
              maximumAgeDays: historySettings.maximumAgeDays,
            };
      const asOfMs = mirror === undefined ? now : Date.parse(mirror.asOf);
      if (!Number.isFinite(asOfMs))
        throw new Error("Wordfence history mirror has an unreadable timestamp");
      const historyWindow = {
        fromMs: asOfMs - historySettings.windowDays * dayMs,
        toMs: asOfMs,
        payingClasses: historySettings.payingClasses,
      };
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
        enumeration?.candidates.map((candidate) => [
          candidate.slug,
          candidate,
        ]) ?? [],
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

      // One observation per candidate serves the primary band and every
      // cascade step; only the install band and paying-class floor differ.
      const bands = selectionBands(policy);
      const results = bands.map((): WordPressSelectionInspection[] => []);
      const pushToEveryBand = (item: WordPressSelectionInspection): void => {
        for (const band of results) band.push(item);
      };
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
          pushToEveryBand({
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
        const pinnedVersion = pinnedVersions?.[slug];
        // Directory `requires` describes the observed stable release, not a historical pin.
        const coreReasons: SelectionReason[] = [];
        if (
          policy.wordpressVersion !== undefined &&
          (pinnedVersion ?? observation.stableVersion) ===
            observation.stableVersion
        ) {
          if (observation.minimumWordPressVersion === undefined)
            coreReasons.push("core-requirement-unavailable");
          else if (
            compareVersions(
              observation.minimumWordPressVersion,
              policy.wordpressVersion,
            ) > 0
          )
            coreReasons.push("core-version-incompatible");
        }
        const ineligibleEverywhere =
          reasons.length > 0 ||
          coreReasons.length > 0 ||
          updateAge === undefined ||
          programmeResult?.status !== "current";
        // The mirror is read once the band-independent rules pass; a step's
        // paying-class floor needs the count even where the primary band fails.
        const counted = ineligibleEverywhere
          ? undefined
          : mirror?.count(slug, historyWindow);
        const bandReasons = bands.map((band) =>
          bandSelectionReasons(band, observation.activeInstallations, counted),
        );
        if (
          ineligibleEverywhere ||
          bandReasons.every((perBand) => perBand.length > 0)
        ) {
          bands.forEach((_band, index) =>
            results[index]!.push({
              slug,
              status: "ineligible",
              reasons: [...reasons, ...bandReasons[index]!, ...coreReasons],
              observedAt: observation.observedAt,
              ...(enumeration === undefined ? {} : { enumeration }),
            }),
          );
          continue;
        }
        if (updateAge === undefined || programmeResult?.status !== "current")
          throw new Error("unreachable: eligibility checked above");
        const scoreBreakdown = score(
          observation,
          policy,
          updateAge,
          counted === undefined
            ? NO_HISTORY
            : historyScore(counted, historySettings, asOfMs),
        );
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
          ...(enumeration?.sourceTag === undefined
            ? {}
            : { candidateTag: enumeration.sourceTag }),
          scoreBreakdown,
          score:
            scoreBreakdown.installations +
            scoreBreakdown.recency +
            scoreBreakdown.history +
            (scoreBreakdown.historyPayingClass ?? 0) +
            (scoreBreakdown.recordRecency ?? 0),
          ...(mirror === undefined || counted === undefined
            ? {}
            : {
                advisoryHistory: {
                  count: counted.count,
                  payingClassCount: counted.payingClassCount,
                  ...(counted.latestPublished === undefined
                    ? {}
                    : { latestPublished: counted.latestPublished }),
                  mirrorAsOf: mirror.asOf,
                  mirrorDigest: mirror.digest,
                },
              }),
          selectedAt: nowDate.toISOString(),
          policy: { id: policy.id, digest: policyDigest },
          observationRef: result.observationRef,
          programmeRef: programmeResult.snapshotRef,
        };
        bands.forEach((band, index) => {
          const perBand = bandReasons[index]!;
          results[index]!.push(
            perBand.length > 0
              ? {
                  slug,
                  status: "ineligible",
                  reasons: perBand,
                  observedAt: observation.observedAt,
                  ...(enumeration === undefined ? {} : { enumeration }),
                }
              : {
                  slug,
                  status: "eligible",
                  reasons: [],
                  selection:
                    band.step === 0
                      ? selection
                      : { ...selection, cascadeStep: band.step },
                  observedAt: observation.observedAt,
                  ...(enumeration === undefined ? {} : { enumeration }),
                },
          );
        });
      }
      return {
        inspections: results[0]!,
        cascade: bands.slice(1).map((band, index) => ({
          step: band.step,
          inspections: results[index + 1]!,
        })),
        sourceStatus: enumeration?.status ?? "manual",
        sourceListings: enumeration?.listings ?? [],
        advisoryHistory,
      };
    } finally {
      mirror?.close();
    }
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
  /** Measures the revisit rule's days since the last Trial; defaults to the wall clock. */
  readonly clock?: () => Date;
}): WordPressSelection {
  async function decide(
    policyInput: WordPressSelectionPolicy,
    options: WordPressSelectionDecideOptions = {},
  ): Promise<WordPressSelectionDecision> {
    const policy = wordPressSelectionPolicySchema.parse(policyInput);
    const minimum = options.minimum ?? 1;
    const batch = await input.candidates.inspectBatch(policy);
    const legacy = await loadWordPressLegacyHistory(input.legacyHistoryFile);
    const now = (input.clock ?? (() => new Date()))();
    // Ledger exclusions are the same rule for every band; only the eligible set differs.
    const evaluate = (
      bandInspections: readonly WordPressSelectionInspection[],
    ): Pick<WordPressSelectionDecision, "inspections" | "ranked"> => {
      const eligible = eligibleTargets(bandInspections);
      const ledgerReasons = new Map(
        inspectWordPressLedgerExclusions({
          ledger: input.ledger,
          legacyHistory: legacy.history,
          candidates: eligible.map(({ slug, version }) => ({ slug, version })),
          currentPromptVariant: policy.promptVariant ?? input.promptVariant,
          revisitPolicy: policy.revisitPolicy ?? { kind: "never" },
          now,
          reservedBatches: new Set(options.reservedBatches ?? []),
        }).map(({ slug, reasons }) => [slug, reasons]),
      );
      const inspections = bandInspections.map((item) => ({
        ...item,
        reasons: [...item.reasons, ...(ledgerReasons.get(item.slug) ?? [])],
      }));
      const excluded = new Set(
        inspections
          .filter((item) => item.reasons.length > 0)
          .map((item) => item.slug),
      );
      return {
        inspections,
        ranked: eligible
          .filter((target) => !excluded.has(target.slug))
          .sort(byScore),
      };
    };
    // The primary band stands whenever it reaches the minimum; the cascade
    // steps are tried in policy order only below it (ADR 0037 addendum).
    const primary = evaluate(batch.inspections);
    const steps = batch.cascade.map((step) => ({
      step: step.step,
      ...evaluate(step.inspections),
    }));
    const tried = [{ step: 0, eligible: primary.ranked.length }];
    let chosen: Pick<WordPressSelectionDecision, "inspections" | "ranked"> & {
      readonly cascadeStep?: number;
    } = primary;
    if (primary.ranked.length < minimum)
      for (const evaluated of steps) {
        tried.push({ step: evaluated.step, eligible: evaluated.ranked.length });
        if (evaluated.ranked.length >= minimum) {
          chosen = { ...evaluated, cascadeStep: evaluated.step };
          break;
        }
      }
    return {
      bands: [{ step: 0, ...primary }, ...steps],
      inspections: chosen.inspections,
      ranked: chosen.ranked,
      selected: chosen.ranked.slice(0, policy.maximumTargets),
      ...(chosen.cascadeStep === undefined
        ? {}
        : { cascadeStep: chosen.cascadeStep }),
      cascade: tried,
      sourceStatus: batch.sourceStatus,
      sourceListings: batch.sourceListings,
      legacyHistory: legacy.report,
      advisoryHistory: batch.advisoryHistory,
    };
  }
  return {
    decide,
    select: async (policy, options) => (await decide(policy, options)).selected,
  };
}

export async function loadWordPressSelectionPolicy(
  url: URL = new URL("../policy/selection.json", import.meta.url),
): Promise<WordPressSelectionPolicy> {
  return wordPressSelectionPolicySchema.parse(
    JSON.parse(await readFile(url, "utf8")),
  );
}
