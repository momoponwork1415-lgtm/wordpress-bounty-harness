import { describe, expect, it, vi } from "vitest";

import {
  createWordPressSelection,
  loadWordPressSelectionPolicy,
  wordPressSelectionPolicySchema,
} from "../../../src/profiles/wordpress/selection/index.js";
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
  it("changes order when the policy changes and records the score breakdown", async () => {
    const selection = harness({});
    const first = await selection.select(basePolicy);
    expect(first.map((item) => item.slug)).toEqual(["popular", "exposed"]);
    expect(first[0]?.scoreBreakdown.installations).toBeGreaterThan(
      first[1]?.scoreBreakdown.installations ?? 0,
    );

    const second = await selection.select({
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
    const plain = await selection.select({
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
    const plain = await selection.select(policy);
    expect(plain.map((item) => item.slug)).toEqual(["popular", "files"]);
    expect(plain.find((item) => item.slug === "files")).toMatchObject({
      highThreatSurface: true,
      runBudget: 30,
      scoreBreakdown: { highThreat: 0 },
    });
    expect(plain.find((item) => item.slug === "popular")?.runBudget).toBe(10);

    const weighted = await selection.select({
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

  it("does not rank candidates by historical advisory counts", async () => {
    const selection = harness({});
    const ranked = await selection.select({
      ...basePolicy,
      historySignals: { popular: 1, exposed: 12 },
      historySource: { digest: digest("d"), refreshedAt: now },
      scoreWeights: {
        ...basePolicy.scoreWeights,
        installations: 0,
        history: 10,
      },
    });
    expect(ranked.map((item) => item.slug)).toEqual(["exposed", "popular"]);
    expect(ranked.every((item) => item.scoreBreakdown.history === 0)).toBe(
      true,
    );
  });

  it("does not let stale legacy history change current selection", async () => {
    const selection = harness({});
    const inspected = await selection.inspect({
      ...basePolicy,
      historySignals: { popular: 2 },
      historySource: {
        digest: digest("d"),
        refreshedAt: "2026-10-06T00:00:00Z",
      },
    });
    expect(inspected.find((item) => item.slug === "popular")).toMatchObject({
      status: "eligible",
      reasons: [],
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
    expect((await selection.select(policy)).map((item) => item.slug)).toEqual([
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
    expect((await selection.select(policy)).map((item) => item.slug)).toEqual([
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

    const historical = await selection.select({
      ...stablePolicy,
      pinnedVersions: { legacy: "1.0.0" },
    });
    expect(historical).toMatchObject([{ slug: "legacy", version: "1.0.0" }]);
  });

  it("never makes stale programme or target observations eligible", async () => {
    const staleProgramme = harness({ programmeStatus: "stale" });
    expect(await staleProgramme.select(basePolicy)).toEqual([]);
    expect((await staleProgramme.inspect(basePolicy))[0]?.reasons).toContain(
      "programme-stale",
    );

    const staleTarget = harness({ clock: "2026-10-12T00:00:00.000Z" });
    expect(await staleTarget.select(basePolicy)).toEqual([]);
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
    expect(await selection.select(basePolicy)).toHaveLength(2);
  });

  it("dates the stable version by its last update and leaves a pinned version undated", async () => {
    const selection = harness({});
    const [stable] = await selection.select({
      ...basePolicy,
      candidateSlugs: ["exposed"],
    });
    expect(stable?.versionPublishedAt).toBe("2026-09-01T00:00:00.000Z");
    const [pinned] = await selection.select({
      ...basePolicy,
      candidateSlugs: ["exposed"],
      pinnedVersions: { exposed: "1.0.0" },
    });
    expect(pinned).not.toHaveProperty("versionPublishedAt");
  });

  it("selects a manually pinned version and binds the pin into the policy digest", async () => {
    const selection = harness({});
    const unpinned = await selection.select(basePolicy);
    const pinnedPolicy = {
      ...basePolicy,
      candidateSlugs: ["exposed"],
      pinnedVersions: { exposed: "1.0.0" },
    };
    const [pinned] = await selection.select(pinnedPolicy);
    expect(pinned).toMatchObject({ slug: "exposed", version: "1.0.0" });
    expect(pinned?.policy.digest).not.toBe(unpinned[0]?.policy.digest);
    await expect(
      selection.select({ ...basePolicy, pinnedVersions: { absent: "1.0.0" } }),
    ).rejects.toThrow();
  });
});
