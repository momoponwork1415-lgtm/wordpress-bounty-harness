import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ledgerEventV1Schema,
  type Ledger,
  type LedgerReadAllQuery,
  type LedgerRecord,
} from "../../../src/ledger/index.js";
import {
  createWordPressSelection,
  loadWordPressSelectionPolicy,
  openWordPressSelection,
  wordPressSelectionPolicySchema,
  wordPressTargetSelectionSchema,
} from "../../../src/profiles/wordpress/selection/index.js";
import type { CreateWordPressSelectionOptions } from "../../../src/profiles/wordpress/selection/wordpress-selection.js";
import type { WordPressOrgTargetSource } from "../../../src/profiles/wordpress/acquisition/index.js";
import type { ProgrammeIntelligence } from "../../../src/profiles/wordpress/programme-intelligence/index.js";

const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;
const now = "2026-10-08T00:00:00.000Z";
const programmeRef = {
  kind: "programme-eligibility-snapshot-ref" as const,
  schemaVersion: 1 as const,
  id: "wordfence-policy",
  digest: digest("a"),
};

function observation(
  slug: string,
  tags: string[],
  installations = 5000,
  minimumWordPressVersion: string | null = "6.0",
) {
  return {
    status: "observed" as const,
    observation: {
      kind: "wordpress-org-target-observation" as const,
      schemaVersion: 1 as const,
      pluginIdentity: `wporg:${slug}`,
      officialSlug: slug,
      displayName: slug,
      stableVersion: "1.2.3",
      ...(minimumWordPressVersion === null ? {} : { minimumWordPressVersion }),
      activeInstallations: installations,
      lastUpdated: "2026-09-01 12:00am GMT",
      observedAt: now,
      author: "Independent Author",
      tags,
      intelligenceSource: {
        kind: "wordpress-org-plugin-directory" as const,
        sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
        retrievedAt: now,
        contentDigest: digest("b"),
        parserVersion: "wordpress-org-plugin-information-v1" as const,
      },
      downloadProvenance: {
        sourceUrl: `https://downloads.wordpress.org/plugin/${slug}.1.2.3.zip`,
      },
    },
    observationRef: {
      kind: "wordpress-org-target-observation-ref" as const,
      schemaVersion: 1 as const,
      id: `observation-${slug}`,
      digest: digest("c"),
    },
  };
}

const basePolicy = {
  kind: "wordpress-selection-policy" as const,
  schemaVersion: 1 as const,
  id: "selection-v1",
  candidateSlugs: ["popular", "exposed"],
  minimumActiveInstallations: 500,
  maximumActiveInstallations: 1_000_000,
  maximumObservationAgeDays: 2,
  maximumUpdateAgeDays: 365,
  maximumTargets: 2,
  excludedAuthors: ["Automattic", "Facebook", "Google", "SiteGround", "Yoast"],
  excludedSlugs: [],
  surfaceTagWeights: { form: 5 },
  highThreatTags: ["file manager"],
  scoreWeights: { installations: 10, recency: 0, surface: 1, highThreat: 0 },
  runBudget: { default: 10, highThreat: 30 },
};

const failed = (slug: string, reason: "closed" | "not-found") => ({
  status: "failed" as const,
  operation: "observe" as const,
  reason,
  pluginIdentity: `wporg:${slug}`,
});

function harness(options: {
  observations?: Record<
    string,
    ReturnType<typeof observation> | ReturnType<typeof failed>
  >;
  programmeStatus?: "current" | "stale";
  clock?: string;
  /** The clock moves on by this much each time it is read, as a real one does. */
  advanceMsPerRead?: number;
  enumerateCandidates?: NonNullable<
    CreateWordPressSelectionOptions["enumerateCandidates"]
  >;
}) {
  const observations = options.observations ?? {
    popular: observation("popular", [], 100_000),
    exposed: observation("exposed", ["form"], 1_000),
  };
  const targetSource = {
    observe: vi.fn(
      async ({ slug }: { slug: string }) =>
        observations[slug] ?? {
          status: "failed",
          operation: "observe",
          reason: "not-found",
          pluginIdentity: `wporg:${slug}`,
        },
    ),
  } as unknown as WordPressOrgTargetSource;
  const programme = {
    inspect: vi.fn(async () =>
      options.programmeStatus === "stale"
        ? { status: "stale", reason: "snapshot-expired" }
        : {
            status: "current",
            snapshotRef: programmeRef,
            snapshot: {
              programmeIdentity: "programme:wordfence",
              policy: {
                programmeOpportunityBand: "high-impact-only",
                eligibility: {
                  assets: [
                    { kind: "wordpress-plugin", scope: "publicly-distributed" },
                  ],
                },
              },
            },
          },
    ),
  } as unknown as ProgrammeIntelligence;
  return createWordPressSelection({
    targetSource,
    programme,
    programmeRef,
    ...(options.enumerateCandidates === undefined
      ? {}
      : { enumerateCandidates: options.enumerateCandidates }),
    clock: (() => {
      let reads = 0;
      return () =>
        new Date(
          Date.parse(options.clock ?? now) +
            (options.advanceMsPerRead ?? 0) * reads++,
        );
    })(),
  });
}

describe("WordPress selection public interface", () => {
  it("carries explicit plugin dependency version pins into the frozen selection", async () => {
    const selection = harness({});
    const policy = {
      ...basePolicy,
      pluginDependencyPins: { exposed: { elementor: "3.32.0" } },
    };
    const selected = await selection.rank(policy);
    expect(selected.find((item) => item.slug === "exposed")).toMatchObject({
      pluginDependencyPins: { elementor: "3.32.0" },
      dependencyVersionPolicy: "pinned-only",
    });
    expect(
      selected.find((item) => item.slug === "popular")?.pluginDependencyPins,
    ).toBeUndefined();
    expect(
      selected.find((item) => item.slug === "exposed")?.policy.digest,
    ).not.toBe((await selection.rank(basePolicy))[1]?.policy.digest);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        pluginDependencyPins: { misspelled: { elementor: "3.32.0" } },
      }).success,
    ).toBe(false);
  });

  it("pins a captured SVN target only for a manually pinned version", async () => {
    const sourcePin = {
      kind: "captured-wordpress-org-svn-export" as const,
      storageDirectory: "/private/svn-intake",
      packetDigest: digest("1"),
      sourceTreeDigest: digest("2"),
      revision: 3628543,
    };
    const policy = {
      ...basePolicy,
      pinnedVersions: { exposed: "2.0.16" },
      targetSourcePins: { exposed: sourcePin },
    };
    const selected = await harness({}).rank(policy);
    expect(selected.find((item) => item.slug === "exposed")).toMatchObject({
      version: "2.0.16",
      targetSourcePin: sourcePin,
    });
    expect(
      wordPressTargetSelectionSchema.parse(
        selected.find((item) => item.slug === "exposed"),
      ).targetSourcePin,
    ).toEqual(sourcePin);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        targetSourcePins: { exposed: sourcePin },
      }).success,
    ).toBe(false);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        targetSourcePins: { other: sourcePin },
      }).success,
    ).toBe(false);
  });

  it("carries slug-only dependencies only from the current automatic policy", async () => {
    const selection = harness({
      observations: {
        exposed: observation("exposed", ["form"], 100_000),
      },
      enumerateCandidates: async () => ({
        status: "available",
        candidates: [
          {
            slug: "exposed",
            sourceKind: "popular",
            sourcePage: 1,
            sourceUrl: "https://api.wordpress.org/plugins/info/1.2/",
            observedAt: now,
            contentDigest: digest("d"),
          },
        ],
        listings: [],
      }),
    });
    const currentPolicy = await loadWordPressSelectionPolicy();
    const selected = await selection.rank({
      ...currentPolicy,
      // This harness has no mirror; the shipped history weights would stop it (ADR 0037).
      scoreWeights: {
        ...currentPolicy.scoreWeights,
        history: 0,
        historyPayingClass: 0,
        recordRecency: 0,
      },
      pluginDependencySlugs: { exposed: ["elementor"] },
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      pluginDependencySlugs: ["elementor"],
      dependencyVersionPolicy: "stable-observed",
    });
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        pluginDependencySlugs: { exposed: ["elementor"] },
      }).success,
    ).toBe(false);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...currentPolicy,
        pluginDependencyPins: { exposed: { elementor: "3.32.0" } },
      }).success,
    ).toBe(false);
  });

  it("changes order when the policy changes and records the score breakdown", async () => {
    const selection = harness({});
    const first = await selection.rank(basePolicy);
    expect(first.map((item) => item.slug)).toEqual(["popular", "exposed"]);
    expect(first[0]?.scoreBreakdown.installations).toBeGreaterThan(
      first[1]?.scoreBreakdown.installations ?? 0,
    );

    const second = await selection.rank({
      ...basePolicy,
      scoreWeights: {
        installations: 0,
        recency: 0,
        surface: 10,
        highThreat: 0,
      },
    });
    expect(second.map((item) => item.slug)).toEqual(["exposed", "popular"]);
    expect(second[0]?.scoreBreakdown.surface).toBeGreaterThan(0);
    expect(second[0]?.policy.digest).not.toBe(first[0]?.policy.digest);
  });

  it("rejects a ceiling that does not exceed the floor", async () => {
    const policy = await loadWordPressSelectionPolicy();
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        maximumActiveInstallations: policy.minimumActiveInstallations,
      }).success,
    ).toBe(false);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        maximumActiveInstallations: policy.minimumActiveInstallations + 1,
      }).success,
    ).toBe(true);
  });

  it("ships an automatic policy with the 100000-install floor, data-derived tags and no tag weights (ADR 0032)", async () => {
    const policy = await loadWordPressSelectionPolicy();
    expect(policy.minimumActiveInstallations).toBe(100_000);
    expect(policy.maximumActiveInstallations).toBe(1_000_000);
    expect("candidateSource" in policy && policy.candidateSource.kind).toBe(
      "wordpress-org",
    );
    expect(policy.excludedAuthors).toEqual(
      expect.arrayContaining([
        "Automattic",
        "Facebook",
        "Google",
        "MailPoet",
        "SiteGround",
        "WooCommerce",
        "Yoast",
      ]),
    );
    expect(policy.scoreWeights.highThreat).toBeUndefined();
    expect(policy.scoreWeights.surface).toBeUndefined();
    expect(policy.highThreatTags).toBeUndefined();
    expect(policy.surfaceTagWeights).toBeUndefined();
    expect(policy.runBudget).toBeUndefined();
    if (!("candidateSource" in policy))
      throw new Error("Expected automatic policy");
    expect(policy.candidateSource.tags.length).toBeGreaterThanOrEqual(6);
    expect(policy.wordpressVersion).toBe("7.1.3");
    for (const maximumTargets of [2, 6])
      expect(
        wordPressSelectionPolicySchema.safeParse({
          ...policy,
          maximumTargets,
        }).success,
      ).toBe(false);
  });

  it("ships the statistics-derived weights (ADR 0037, 2026-10-19 addendum) in the default policy and the two floor siblings, which differ only in id and floor", async () => {
    const policy = await loadWordPressSelectionPolicy();
    expect(policy.id).toBe("wordpress-selection-2026-10-22");
    // docs/reviews/2026-10-19-selection-statistics.md §5.1: paying class decides,
    // record recency splits ties, installs come last; WordPress.org recency is a leak.
    expect(policy.scoreWeights).toEqual({
      installations: 0.5,
      recency: 0,
      history: 0,
      historyPayingClass: 1,
      recordRecency: 1,
    });
    expect(policy.historyWindowDays).toBe(365);
    expect(policy.historyCountCap).toBe(10);
    expect(policy.historyPayingClassCap).toBe(3);
    expect(policy.maximumHistoryAgeDays).toBe(2);
    expect(policy.maximumTargets).toBe(5);
    expect(policy.maximumUpdateAgeDays).toBe(365);
    expect(policy.revisitPolicy).toEqual({
      kind: "version-increased",
      minimumDaysSinceTrial: 90,
    });
    expect(policy.historyPayingClasses).toEqual([
      "stored-xss",
      "sql-injection",
      "privilege-escalation",
      "authentication-bypass",
      "arbitrary-file-upload",
      "remote-code-execution",
    ]);
    for (const [file, floor] of [
      ["selection.50000.json", 50_000],
      ["selection.30000.json", 30_000],
    ] as const) {
      const sibling = await loadWordPressSelectionPolicy(
        new URL(
          `../../../src/profiles/wordpress/policy/${file}`,
          import.meta.url,
        ),
      );
      expect(sibling).toEqual({
        ...policy,
        id: `${policy.id}-${floor}`,
        minimumActiveInstallations: floor,
      });
    }
    // The historical manual signals are gone; a policy still carrying them is rejected.
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        historySignals: { popular: 1 },
        historySource: { digest: digest("d"), refreshedAt: now },
      }).success,
    ).toBe(false);
  });

  it("omits run budgets and treats every surface alike when a policy carries no legacy weights", async () => {
    const selection = harness({
      observations: {
        popular: observation("popular", [], 100_000),
        files: observation("files", ["File Manager"], 1_000),
      },
    });
    const { surfaceTagWeights, highThreatTags, runBudget, ...rest } =
      basePolicy;
    void surfaceTagWeights;
    void highThreatTags;
    void runBudget;
    const plain = await selection.rank({
      ...rest,
      candidateSlugs: ["popular", "files"],
      scoreWeights: { installations: 10, recency: 0 },
    });
    expect(plain.map((item) => item.slug)).toEqual(["popular", "files"]);
    for (const item of plain) {
      expect(item.runBudget).toBeUndefined();
      expect(item.highThreatSurface).toBe(false);
      expect(item.scoreBreakdown.surface).toBe(0);
      expect(item.scoreBreakdown.highThreat).toBe(0);
    }
  });

  it("still honours legacy High Threat weights and run budgets for old policies", async () => {
    const selection = harness({
      observations: {
        popular: observation("popular", [], 100_000),
        files: observation("files", ["File Manager"], 1_000),
      },
    });
    const policy = { ...basePolicy, candidateSlugs: ["popular", "files"] };
    const plain = await selection.rank(policy);
    expect(plain.map((item) => item.slug)).toEqual(["popular", "files"]);
    expect(plain.find((item) => item.slug === "files")).toMatchObject({
      highThreatSurface: true,
      runBudget: 30,
      scoreBreakdown: { highThreat: 0 },
    });
    expect(plain.find((item) => item.slug === "popular")?.runBudget).toBe(10);

    const weighted = await selection.rank({
      ...policy,
      scoreWeights: { ...policy.scoreWeights, highThreat: 100 },
    });
    expect(weighted.map((item) => item.slug)).toEqual(["files", "popular"]);
    expect(weighted[0]?.scoreBreakdown.highThreat).toBe(100);
    expect(weighted[1]).toMatchObject({
      highThreatSurface: false,
      scoreBreakdown: { highThreat: 0 },
    });
  });

  describe("advisory history from the local mirror (ADR 0037)", () => {
    const mirrorAsOf = "2026-10-07T00:00:00.000Z";
    const mirrorDigest = digest("f");
    const counts: Record<
      string,
      { count: number; payingClassCount: number; latestPublished?: string }
    > = {
      popular: { count: 1, payingClassCount: 0 },
      exposed: {
        count: 12,
        payingClassCount: 3,
        latestPublished: "2026-10-07T00:00:00.000Z",
      },
    };
    /** A fake source; `opened` counts how often selection reached for the mirror. */
    function fakeHistory(status: "open" | "stale" | "unavailable" = "open"): {
      source: NonNullable<CreateWordPressSelectionOptions["advisoryHistory"]>;
      opened: () => number;
      closed: () => number;
      windows: () => { fromMs: number; toMs: number }[];
    } {
      let opened = 0;
      let closed = 0;
      const windows: { fromMs: number; toMs: number }[] = [];
      return {
        opened: () => opened,
        closed: () => closed,
        windows: () => windows,
        source: {
          open() {
            opened++;
            if (status === "stale")
              return {
                status: "stale",
                lastSuccessfulAt: "2026-10-01T00:00:00Z",
                ageMs: 7 * 86_400_000,
              };
            if (status === "unavailable")
              return { status: "unavailable", reason: "state is unreadable" };
            return {
              status: "open",
              mirror: {
                asOf: mirrorAsOf,
                digest: mirrorDigest,
                recordCount: 42,
                lastRefreshFailed: false,
                count(slug, window) {
                  windows.push({ fromMs: window.fromMs, toMs: window.toMs });
                  return (
                    counts[slug] ?? {
                      count: 0,
                      payingClassCount: 0,
                      title: "never read",
                    }
                  );
                },
                close: () => {
                  closed++;
                },
              },
            };
          },
        },
      };
    }
    const withHistory = (
      fake: ReturnType<typeof fakeHistory>,
      options: Parameters<typeof harness>[0] = {},
    ) =>
      createWordPressSelection({
        targetSource: {
          observe: async ({ slug }: { slug: string }) =>
            (options.observations ?? {
              popular: observation("popular", [], 100_000),
              exposed: observation("exposed", ["form"], 1_000),
            })[slug] ?? failed(slug, "not-found"),
        } as unknown as WordPressOrgTargetSource,
        programme: {
          inspect: async () => ({
            status: "current",
            snapshotRef: programmeRef,
            snapshot: {
              programmeIdentity: "programme:wordfence",
              policy: {
                programmeOpportunityBand: "high-impact-only",
                eligibility: {
                  assets: [
                    { kind: "wordpress-plugin", scope: "publicly-distributed" },
                  ],
                },
              },
            },
          }),
        } as unknown as ProgrammeIntelligence,
        programmeRef,
        clock: () => new Date(options.clock ?? now),
        advisoryHistory: fake.source,
      });

    it("weight 0 reproduces the ranking without history and never opens the mirror", async () => {
      const fake = fakeHistory();
      const baseline = await harness({}).rank(basePolicy);
      const zeroWeight = await withHistory(fake).rank({
        ...basePolicy,
        scoreWeights: { ...basePolicy.scoreWeights, history: 0 },
      });
      const absent = await withHistory(fake).rank(basePolicy);
      for (const ranked of [zeroWeight, absent]) {
        expect(ranked.map((item) => [item.slug, item.score])).toEqual(
          baseline.map((item) => [item.slug, item.score]),
        );
        expect(
          ranked.every(
            (item) =>
              item.scoreBreakdown.history === 0 &&
              item.scoreBreakdown.historyPayingClass === 0 &&
              item.scoreBreakdown.recordRecency === 0 &&
              item.advisoryHistory === undefined,
          ),
        ).toBe(true);
      }
      expect(fake.opened()).toBe(0);
      // The same holds when only the newer weights are written as 0.
      const zeroNew = await withHistory(fake).rank({
        ...basePolicy,
        scoreWeights: {
          ...basePolicy.scoreWeights,
          history: 0,
          historyPayingClass: 0,
          recordRecency: 0,
        },
      });
      expect(zeroNew.map((item) => [item.slug, item.score])).toEqual(
        baseline.map((item) => [item.slug, item.score]),
      );
      expect(fake.opened()).toBe(0);
    });

    it("scores min(count, cap) / cap for the history member, relative to the mirror's asOf and without a freshness share", async () => {
      const fake = fakeHistory();
      const policy = {
        ...basePolicy,
        historyWindowDays: 100,
        historyCountCap: 10,
        scoreWeights: {
          ...basePolicy.scoreWeights,
          installations: 0,
          surface: 0,
          history: 5,
        },
      };
      const ranked = await withHistory(fake).rank(policy);
      const exposed = ranked.find((item) => item.slug === "exposed");
      const popular = ranked.find((item) => item.slug === "popular");
      // 12 records cap at 10 → full weight; the latest record's date moves `recordRecency`, not `history`.
      expect(exposed?.scoreBreakdown.history).toBeCloseTo(5, 10);
      // 1 record → 5 × 1/10.
      expect(popular?.scoreBreakdown.history).toBeCloseTo(0.5, 10);
      expect(ranked.map((item) => item.slug)).toEqual(["exposed", "popular"]);
      // The other members stay 0 until their own weights are set.
      expect(exposed?.scoreBreakdown.historyPayingClass).toBe(0);
      expect(exposed?.scoreBreakdown.recordRecency).toBe(0);
      // The window is anchored on the mirror, not on the selection clock.
      const asOfMs = Date.parse(mirrorAsOf);
      expect(fake.windows()).toEqual(
        expect.arrayContaining([
          { fromMs: asOfMs - 100 * 86_400_000, toMs: asOfMs },
        ]),
      );
      expect(fake.opened()).toBe(1);
      expect(fake.closed()).toBe(1);
      // A history-only ranking is independent of when `select` runs.
      const later = await withHistory(fake, {
        clock: "2026-10-08T12:00:00.000Z",
      }).rank(policy);
      expect(later.map((item) => item.scoreBreakdown.history)).toEqual(
        ranked.map((item) => item.scoreBreakdown.history),
      );
    });

    it("scores one point per paying-class record up to historyPayingClassCap, and weight 0 leaves the decided score unchanged", async () => {
      const fake = fakeHistory();
      const policy = {
        ...basePolicy,
        scoreWeights: {
          ...basePolicy.scoreWeights,
          installations: 0,
          surface: 0,
          history: 5,
        },
      };
      const decided = await withHistory(fake).rank(policy);
      const paying = await withHistory(fake).rank({
        ...policy,
        historyCountCap: 10,
        scoreWeights: { ...policy.scoreWeights, historyPayingClass: 4 },
      });
      const exposedPaying = paying.find((item) => item.slug === "exposed");
      // 3 paying records, default cap 3 → 4 × min(3, 3); not divided by the cap.
      expect(exposedPaying?.scoreBreakdown.historyPayingClass).toBeCloseTo(
        4 * 3,
        10,
      );
      expect(exposedPaying?.advisoryHistory?.payingClassCount).toBe(3);
      expect(
        paying.find((item) => item.slug === "popular")?.scoreBreakdown
          .historyPayingClass,
      ).toBe(0);
      expect(
        decided.every((item) => item.scoreBreakdown.historyPayingClass === 0),
      ).toBe(true);
      expect(exposedPaying?.score).toBeCloseTo(
        (decided.find((item) => item.slug === "exposed")?.score ?? NaN) + 4 * 3,
        10,
      );
      // A lower cap clips the count; a higher one does not inflate it.
      for (const [cap, expected] of [
        [2, 2],
        [5, 3],
      ] as const) {
        const capped = await withHistory(fake).rank({
          ...policy,
          historyPayingClassCap: cap,
          scoreWeights: { ...policy.scoreWeights, historyPayingClass: 1 },
        });
        expect(
          capped.find((item) => item.slug === "exposed")?.scoreBreakdown
            .historyPayingClass,
        ).toBe(expected);
      }
    });

    it("scores recordRecency as 1 − days since the newest record / window, anchored on the mirror's asOf", async () => {
      const fake = fakeHistory();
      const policy = {
        ...basePolicy,
        historyWindowDays: 100,
        scoreWeights: {
          ...basePolicy.scoreWeights,
          installations: 0,
          surface: 0,
          recordRecency: 2,
        },
      };
      const ranked = await withHistory(fake).rank(policy);
      // exposed's latest record is at asOf → full weight; popular has no dated record → 0.
      expect(
        ranked.find((item) => item.slug === "exposed")?.scoreBreakdown
          .recordRecency,
      ).toBeCloseTo(2, 10);
      expect(
        ranked.find((item) => item.slug === "popular")?.scoreBreakdown
          .recordRecency,
      ).toBe(0);
      expect(ranked.map((item) => item.slug)).toEqual(["exposed", "popular"]);
      // The mirror was opened for this weight alone.
      expect(fake.opened()).toBe(1);
      // The clock does not move the value; only the mirror's asOf does.
      const later = await withHistory(fake, {
        clock: "2026-10-09T12:00:00.000Z",
      }).rank(policy);
      expect(later).toHaveLength(2);
      expect(later.map((item) => item.scoreBreakdown.recordRecency)).toEqual(
        ranked.map((item) => item.scoreBreakdown.recordRecency),
      );
    });

    it("ranks the report's way: paying count decides, record recency splits ties, installs come last (§5.1)", async () => {
      // Six candidates in the 100k–1M band with the shipped weights.
      const day = 86_400_000;
      const daysAgo = (days: number) =>
        new Date(Date.parse(mirrorAsOf) - days * day).toISOString();
      const band: Record<
        string,
        { installs: number; paying: number; latestDaysAgo?: number }
      > = {
        "three-fresh-small": {
          installs: 100_000,
          paying: 3,
          latestDaysAgo: 10,
        },
        "three-old-large": { installs: 900_000, paying: 3, latestDaysAgo: 300 },
        "five-fresh-small": { installs: 100_000, paying: 5, latestDaysAgo: 5 },
        "one-fresh-large": { installs: 900_000, paying: 1, latestDaysAgo: 1 },
        "zero-fresh-large": { installs: 900_000, paying: 0, latestDaysAgo: 1 },
        "zero-none-huge": { installs: 999_999, paying: 0 },
      };
      const fake = fakeHistory();
      const open = fake.source.open;
      fake.source.open = (options) => {
        const opened = open(options);
        if (opened.status !== "open") return opened;
        return {
          ...opened,
          mirror: {
            ...opened.mirror,
            count(slug) {
              const row = band[slug];
              if (row === undefined) throw new Error(`unexpected ${slug}`);
              return {
                count: row.paying + 1,
                payingClassCount: row.paying,
                ...(row.latestDaysAgo === undefined
                  ? {}
                  : { latestPublished: daysAgo(row.latestDaysAgo) }),
              };
            },
          },
        };
      };
      const shipped = await loadWordPressSelectionPolicy();
      const ranked = await withHistory(fake, {
        observations: Object.fromEntries(
          Object.entries(band).map(([slug, row]) => [
            slug,
            observation(slug, [], row.installs),
          ]),
        ),
      }).rank({
        ...basePolicy,
        candidateSlugs: Object.keys(band),
        maximumTargets: 6,
        minimumActiveInstallations: 100_000,
        scoreWeights: shipped.scoreWeights,
        historyWindowDays: shipped.historyWindowDays,
        historyCountCap: shipped.historyCountCap,
        historyPayingClassCap: shipped.historyPayingClassCap,
        historyPayingClasses: shipped.historyPayingClasses,
      });
      expect(ranked.map((item) => item.slug)).toEqual([
        // 5 paying records cap at 3; the freshest record of the capped group wins.
        "five-fresh-small",
        "three-fresh-small",
        // Same cap, 300-day-old record: recency 0.18 loses to 0.97 despite 9× installs.
        "three-old-large",
        // One paying record beats none, whatever the installs.
        "one-fresh-large",
        // No paying record: recency then installs decide.
        "zero-fresh-large",
        "zero-none-huge",
      ]);
      const five = ranked[0]!;
      expect(five.scoreBreakdown.historyPayingClass).toBe(3);
      expect(five.scoreBreakdown.recordRecency).toBeCloseTo(1 - 5 / 365, 10);
      expect(five.scoreBreakdown.installations).toBeCloseTo(
        0.5 * Math.log10(100_001),
        10,
      );
      expect(five.scoreBreakdown.recency).toBe(0);
      expect(five.scoreBreakdown.history).toBe(0);
      // Band values stay in the report's ranges: 0–3 + 0–1 + 2.5–3.0.
      for (const item of ranked) {
        expect(item.scoreBreakdown.installations).toBeGreaterThanOrEqual(2.5);
        expect(item.scoreBreakdown.installations).toBeLessThanOrEqual(3.0);
        expect(item.score).toBeCloseTo(
          item.scoreBreakdown.historyPayingClass! +
            item.scoreBreakdown.recordRecency! +
            item.scoreBreakdown.installations,
          10,
        );
      }
    });

    it("keeps 200,000 installs at 53.01 points under the former weight 10 (log10(1 + installs))", async () => {
      const ranked = await harness({
        observations: { popular: observation("popular", [], 200_000) },
      }).rank({
        ...basePolicy,
        candidateSlugs: ["popular"],
        scoreWeights: { installations: 10, recency: 0 },
      });
      expect(ranked[0]?.scoreBreakdown.installations).toBeCloseTo(53.01, 2);
    });

    it("records only counts, dates and the mirror's timestamp and digest on the target", async () => {
      const fake = fakeHistory();
      const ranked = await withHistory(fake).rank({
        ...basePolicy,
        scoreWeights: { ...basePolicy.scoreWeights, history: 5 },
      });
      expect(
        ranked.find((item) => item.slug === "exposed")?.advisoryHistory,
      ).toEqual({
        count: 12,
        payingClassCount: 3,
        latestPublished: "2026-10-07T00:00:00.000Z",
        mirrorAsOf,
        mirrorDigest,
      });
      expect(
        ranked.find((item) => item.slug === "popular")?.advisoryHistory,
      ).toEqual({
        count: 1,
        payingClassCount: 0,
        mirrorAsOf,
        mirrorDigest,
      });
      // Anything beyond the contract (a title the fake sneaks in) never reaches the record.
      expect(JSON.stringify(ranked)).not.toContain("never read");
      for (const item of ranked)
        expect(wordPressTargetSelectionSchema.safeParse(item).success).toBe(
          true,
        );
    });

    it("stops before observing anything when the mirror is stale, unavailable or not configured", async () => {
      const policy = {
        ...basePolicy,
        maximumHistoryAgeDays: 2,
        scoreWeights: { ...basePolicy.scoreWeights, history: 5 },
      };
      await expect(
        withHistory(fakeHistory("stale")).inspectBatch(policy),
      ).rejects.toThrow(
        "Wordfence history mirror is stale: last success 2026-10-01T00:00:00Z is 7.0 days old, policy maximumHistoryAgeDays is 2",
      );
      await expect(
        withHistory(fakeHistory("unavailable")).rank(policy),
      ).rejects.toThrow(
        "Wordfence history mirror is unavailable (state is unreadable)",
      );
      await expect(harness({}).rank(policy)).rejects.toThrow(
        "no wordfenceHistory mirror configured",
      );
      // A batch inspection that stops observed no candidate.
      const observe = vi.fn();
      await expect(
        createWordPressSelection({
          targetSource: { observe } as unknown as WordPressOrgTargetSource,
          programme: { inspect: vi.fn() } as unknown as ProgrammeIntelligence,
          programmeRef,
          advisoryHistory: fakeHistory("stale").source,
        }).inspect(policy),
      ).rejects.toThrow("stale");
      expect(observe).not.toHaveBeenCalled();
      // The maximum age reaches the source as milliseconds.
      const open = vi.fn(() => ({
        status: "unavailable" as const,
        reason: "database and state disagree",
      }));
      await expect(
        createWordPressSelection({
          targetSource: { observe } as unknown as WordPressOrgTargetSource,
          programme: { inspect: vi.fn() } as unknown as ProgrammeIntelligence,
          programmeRef,
          clock: () => new Date(now),
          advisoryHistory: { open },
        }).inspect({ ...policy, maximumHistoryAgeDays: 3 }),
      ).rejects.toThrow("database and state disagree");
      expect(open).toHaveBeenCalledWith({
        now: new Date(now),
        maximumAgeMs: 3 * 86_400_000,
      });
    });

    it("reports the mirror's timestamp, digest and window through decide()", async () => {
      const decision = await openWordPressSelection({
        candidates: withHistory(fakeHistory()),
        ledger: { readAll: () => [] },
        promptVariant: "wp2shell-bounty-v8",
      }).decide({
        ...basePolicy,
        scoreWeights: { ...basePolicy.scoreWeights, history: 5 },
      });
      expect(decision.advisoryHistory).toEqual({
        status: "used",
        asOf: mirrorAsOf,
        digest: mirrorDigest,
        recordCount: 42,
        lastRefreshFailed: false,
        windowDays: 365,
        countCap: 10,
        payingClassCap: 3,
        maximumAgeDays: 2,
      });
      expect(
        (
          await openWordPressSelection({
            candidates: harness({}),
            ledger: { readAll: () => [] },
            promptVariant: "wp2shell-bounty-v8",
          }).decide(basePolicy)
        ).advisoryHistory,
      ).toEqual({ status: "not-used" });
    });
  });

  it("keeps unavailable, stale, excluded and under-threshold observations in inspect but out of select", async () => {
    const excluded = observation("excluded", ["form"]);
    excluded.observation.author = "Automattic";
    const selection = harness({
      clock: "2026-10-10T00:00:00.000Z",
      observations: {
        recent: observation("recent", []),
        excluded,
        tiny: observation("tiny", [], 499),
        huge: observation("huge", [], 1_000_000),
        closed: failed("closed", "closed"),
      },
    });
    const policy = {
      ...basePolicy,
      candidateSlugs: [
        "recent",
        "excluded",
        "tiny",
        "huge",
        "missing",
        "closed",
      ],
    };
    const inspected = await selection.inspect(policy);
    expect(
      inspected.map((item) => [item.slug, item.status, item.reasons]),
    ).toEqual([
      ["recent", "eligible", []],
      ["excluded", "ineligible", ["excluded-author"]],
      ["tiny", "ineligible", ["below-installation-threshold"]],
      ["huge", "ineligible", ["above-installation-ceiling"]],
      ["missing", "ineligible", ["observation-unavailable"]],
      ["closed", "ineligible", ["distribution-closed"]],
    ]);
    expect((await selection.rank(policy)).map((item) => item.slug)).toEqual([
      "recent",
    ]);
  });

  it("excludes plugins whose minimum core exceeds the pinned version or is unknown", async () => {
    const selection = harness({
      observations: {
        equal: observation("equal", [], 5000, "6.8.3"),
        older: observation("older", [], 5000, "6.8"),
        newer: observation("newer", [], 5000, "7.1"),
        unknown: observation("unknown", [], 5000, null),
      },
    });
    const policy = {
      ...basePolicy,
      candidateSlugs: ["equal", "older", "newer", "unknown"],
      wordpressVersion: "6.8.3",
    };
    expect(
      (await selection.inspect(policy)).map((item) => [
        item.slug,
        item.status,
        item.reasons,
      ]),
    ).toEqual([
      ["equal", "eligible", []],
      ["older", "eligible", []],
      ["newer", "ineligible", ["core-version-incompatible"]],
      ["unknown", "ineligible", ["core-requirement-unavailable"]],
    ]);
    expect((await selection.rank(policy)).map((item) => item.slug)).toEqual([
      "equal",
      "older",
    ]);
  });

  it("does not apply the stable release's core requirement to a historical pin", async () => {
    const selection = harness({
      observations: {
        legacy: observation("legacy", [], 5000, "7.1"),
      },
    });
    const stablePolicy = {
      ...basePolicy,
      candidateSlugs: ["legacy"],
      wordpressVersion: "6.8.3",
    };
    expect((await selection.inspect(stablePolicy))[0]).toMatchObject({
      status: "ineligible",
      reasons: ["core-version-incompatible"],
    });

    const historical = await selection.rank({
      ...stablePolicy,
      pinnedVersions: { legacy: "1.0.0" },
    });
    expect(historical).toMatchObject([{ slug: "legacy", version: "1.0.0" }]);
  });

  it("never makes stale programme or target observations eligible", async () => {
    const staleProgramme = harness({ programmeStatus: "stale" });
    expect(await staleProgramme.rank(basePolicy)).toEqual([]);
    expect((await staleProgramme.inspect(basePolicy))[0]?.reasons).toContain(
      "programme-stale",
    );

    const staleTarget = harness({ clock: "2026-10-12T00:00:00.000Z" });
    expect(await staleTarget.rank(basePolicy)).toEqual([]);
    expect((await staleTarget.inspect(basePolicy))[0]?.reasons).toContain(
      "observation-stale",
    );
  });

  it("keeps a target observed during the selection itself fresh", async () => {
    // A live fetch finishes after selection reads the clock, so the
    // observation is stamped a moment later than "now".
    const fetchedJustNow = (
      slug: string,
      tags: string[],
      installations: number,
    ) => {
      const observed = observation(slug, tags, installations);
      return {
        ...observed,
        observation: {
          ...observed.observation,
          observedAt: "2026-10-08T00:00:02.000Z",
        },
      };
    };
    const selection = harness({
      observations: {
        popular: fetchedJustNow("popular", [], 100_000),
        exposed: fetchedJustNow("exposed", ["form"], 1_000),
      },
      advanceMsPerRead: 3_000,
    });
    expect((await selection.inspect(basePolicy))[0]?.reasons).toEqual([]);
    expect(await selection.rank(basePolicy)).toHaveLength(2);
  });

  it("dates the stable version by its last update and leaves a pinned version undated", async () => {
    const selection = harness({});
    const [stable] = await selection.rank({
      ...basePolicy,
      candidateSlugs: ["exposed"],
    });
    expect(stable?.versionPublishedAt).toBe("2026-09-01T00:00:00.000Z");
    const [pinned] = await selection.rank({
      ...basePolicy,
      candidateSlugs: ["exposed"],
      pinnedVersions: { exposed: "1.0.0" },
    });
    expect(pinned).not.toHaveProperty("versionPublishedAt");
  });

  it("selects a manually pinned version and binds the pin into the policy digest", async () => {
    const selection = harness({});
    const unpinned = await selection.rank(basePolicy);
    const pinnedPolicy = {
      ...basePolicy,
      candidateSlugs: ["exposed"],
      pinnedVersions: { exposed: "1.0.0" },
    };
    const [pinned] = await selection.rank(pinnedPolicy);
    expect(pinned).toMatchObject({ slug: "exposed", version: "1.0.0" });
    expect(pinned?.policy.digest).not.toBe(unpinned[0]?.policy.digest);
    await expect(
      selection.rank({ ...basePolicy, pinnedVersions: { absent: "1.0.0" } }),
    ).rejects.toThrow();
  });
});

/** An append-only Ledger read back from memory, in sequence order. */
function ledgerOf(events: readonly unknown[]): Pick<Ledger, "readAll"> {
  const records: readonly LedgerRecord[] = events.map((event, index) => ({
    sequence: index + 1,
    event: ledgerEventV1Schema.parse(event),
  }));
  return {
    readAll(query: LedgerReadAllQuery = {}) {
      return records.filter(
        ({ event }) =>
          (query.type === undefined || event.type === query.type) &&
          (query.campaignId === undefined ||
            event.campaignId === query.campaignId),
      );
    },
  };
}

const occurredAt = "2026-10-01T00:00:00.000Z";
const recorded = (
  campaignId: string,
  snapshotDigest: string,
  identity: string,
  event: Record<string, unknown>,
): Record<string, unknown> => ({
  schemaVersion: 1,
  campaignId,
  snapshotDigest,
  identity,
  occurredAt,
  artifacts: [],
  ...event,
});
/** `exposed@1.2.3` was selected, explored with one completed Trial and yielded a Finding. */
const exposedTrialWithFinding = (promptVariant = "wp2shell-bounty-v8") => [
  recorded("campaign-1", digest("d"), "selected-exposed", {
    type: "target-selected",
    selectionId: "wporg:exposed@1.2.3",
    promptVariant,
  }),
  recorded("campaign-1", digest("d"), "run-exposed", {
    type: "discovery-run-started",
    runId: "run-exposed",
    labId: "lab-1",
    history: { mode: "none" },
    configuration: { promptVariant, assignmentUnit: "target" },
  }),
  recorded("campaign-1", digest("d"), "finished-exposed", {
    type: "discovery-run-finished",
    runId: "run-exposed",
    outcome: "completed",
    costUsd: "unavailable",
    wallTimeMs: 1000,
  }),
  recorded("campaign-1", digest("d"), "finding-exposed", {
    type: "finding-recorded",
    findingId: "finding-1",
    runId: "run-exposed",
    category: "stored-xss",
  }),
];

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("WordPress selection over the Ledger (policy/selection.md)", () => {
  const open = (ledger: Pick<Ledger, "readAll">, legacyHistoryFile?: string) =>
    openWordPressSelection({
      candidates: harness({}),
      ledger,
      ...(legacyHistoryFile === undefined ? {} : { legacyHistoryFile }),
      promptVariant: "wp2shell-bounty-v8",
    });

  it("select() excludes a slug with a recorded Finding and keeps the others in score order", async () => {
    const selection = open(ledgerOf(exposedTrialWithFinding()));
    expect(
      (await selection.select(basePolicy)).map((item) => item.slug),
    ).toEqual(["popular"]);
    // The same candidates rank in full when the Ledger is empty.
    expect(
      (await open(ledgerOf([])).select(basePolicy)).map((item) => item.slug),
    ).toEqual(["popular", "exposed"]);
    // The pure ranking below the Ledger still returns the Finding's own target.
    expect(
      (await harness({}).rank(basePolicy)).map((item) => item.slug),
    ).toEqual(["popular", "exposed"]);
  });

  it("decide() merges Ledger reasons into the inspection report and cuts the ranking at maximumTargets", async () => {
    const decision = await open(ledgerOf(exposedTrialWithFinding())).decide({
      ...basePolicy,
      maximumTargets: 1,
    });
    expect(
      decision.inspections.map((item) => [item.slug, item.reasons]),
    ).toEqual([
      ["popular", []],
      ["exposed", ["unpublished-finding", "previously-selected"]],
    ]);
    expect(decision.ranked.map((item) => item.slug)).toEqual(["popular"]);
    expect(decision.selected).toEqual(decision.ranked.slice(0, 1));
    expect(decision.sourceStatus).toBe("manual");
    expect(decision.legacyHistory).toEqual({ status: "unavailable" });
  });

  it("excludes a slug an earlier generation already started, and reports the legacy digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-selection-"));
    temporaryDirectories.push(root);
    const legacyHistoryFile = join(root, "legacy-history.json");
    await writeFile(
      legacyHistoryFile,
      JSON.stringify({
        schemaVersion: 1,
        sourceDigest: digest("e"),
        exportedAt: occurredAt,
        sources: ["synthetic"],
        started: ["popular"],
        ambiguous: [],
        reconsider: [],
      }),
    );
    const decision = await open(ledgerOf([]), legacyHistoryFile).decide(
      basePolicy,
    );
    expect(
      decision.inspections.find((item) => item.slug === "popular")?.reasons,
    ).toEqual(["legacy-started"]);
    expect(decision.selected.map((item) => item.slug)).toEqual(["exposed"]);
    expect(decision.legacyHistory).toMatchObject({
      status: "available",
      started: 1,
      ambiguous: 0,
      reconsider: 0,
    });
  });

  it("reads the policy's own prompt variant before the campaign's when judging a revisit", async () => {
    const ledger = ledgerOf([
      ...exposedTrialWithFinding("wp2shell-bounty-v7").filter(
        (event) => event.type !== "finding-recorded",
      ),
    ]);
    const revisit = {
      ...basePolicy,
      revisitPolicy: { kind: "prompt-version-changed" as const },
    };
    // Explored with v7; a v8 selection is a revisit under this policy.
    expect(
      (await open(ledger).select(revisit)).map((item) => item.slug),
    ).toEqual(["popular", "exposed"]);
    // The policy pins v7 itself: the same prompt again is not a revisit.
    expect(
      (
        await open(ledger).select({
          ...revisit,
          promptVariant: "wp2shell-bounty-v7",
        })
      ).map((item) => item.slug),
    ).toEqual(["popular"]);
  });
});
