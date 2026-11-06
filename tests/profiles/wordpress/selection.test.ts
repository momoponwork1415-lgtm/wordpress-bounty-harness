import { describe, expect, it, vi } from "vitest";

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
  maximumObservationAgeDays: 2,
  maximumUpdateAgeDays: 365,
  maximumTargets: 2,
  excludedAuthors: ["Automattic", "Facebook", "Google", "SiteGround", "Yoast"],
  excludedSlugs: [],
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
  programmeAcceptsAsset?: boolean;
  clock?: string;
  /** The clock moves on by this much each time it is read, as a real one does. */
  advanceMsPerRead?: number;
  enumerateCandidates?: NonNullable<
    CreateWordPressSelectionOptions["enumerateCandidates"]
  >;
  /** Drives the real enumerator against fake WordPress.org listings. */
  fetch?: typeof fetch;
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
                  assets:
                    options.programmeAcceptsAsset === false
                      ? []
                      : [
                          {
                            kind: "wordpress-plugin",
                            scope: "publicly-distributed",
                          },
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
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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

  it("accepts one target per selection and still caps a batch at ten", async () => {
    const policy = await loadWordPressSelectionPolicy();
    for (const [maximumTargets, success] of [
      [0, false],
      [1, true],
      [10, true],
      [11, false],
    ] as const)
      expect(
        wordPressSelectionPolicySchema.safeParse({ ...policy, maximumTargets })
          .success,
      ).toBe(success);
  });

  it("ships the install queue and rejects retired policy fields", async () => {
    const policy = await loadWordPressSelectionPolicy();
    expect(policy.minimumActiveInstallations).toBe(5_000);
    expect(policy.maximumTargets).toBe(10);
    expect(
      "candidateSource" in policy ? policy.candidateSource.tags : null,
    ).toEqual([]);
    expect(policy.maximumUpdateAgeDays).toBe(180);
    expect(policy.revisitPolicy).toEqual({ kind: "version-increased" });
    for (const [field, value] of Object.entries({
      cascade: [{ minimumActiveInstallations: 50_000 }],
      scoreWeights: { installations: 0.5, recency: 0, historyPayingClass: 1 },
      historyWindowDays: 365,
      historyCountCap: 10,
      historyPayingClassCap: 3,
      historyPayingClasses: ["stored-xss"],
      maximumHistoryAgeDays: 2,
    }))
      expect(
        wordPressSelectionPolicySchema.safeParse({ ...policy, [field]: value })
          .success,
      ).toBe(false);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        revisitPolicy: { kind: "version-increased", minimumDaysSinceTrial: 90 },
      }).success,
    ).toBe(false);
    // The upper install bound is optional and must exceed the floor (ADR 0037, 2026-11-02).
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        maximumActiveInstallations: 1_000_000,
      }).success,
    ).toBe(true);
    for (const value of [5_000, 4_999, 0, -1, 1.5, "1000000"]) {
      const result = wordPressSelectionPolicySchema.safeParse({
        ...policy,
        maximumActiveInstallations: value,
      });
      expect(result.success).toBe(false);
      if (typeof value === "number" && Number.isInteger(value) && value > 0)
        expect(JSON.stringify(result.error?.issues)).toContain(
          "maximumActiveInstallations must be greater than minimumActiveInstallations",
        );
    }
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        maximumActiveInstallations: basePolicy.minimumActiveInstallations,
      }).success,
    ).toBe(false);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...basePolicy,
        maximumActiveInstallations: basePolicy.minimumActiveInstallations + 1,
      }).success,
    ).toBe(true);
    // The method-change cutoff is an ISO instant (ADR 0037 addendum 6).
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        revisitPolicy: {
          kind: "version-increased",
          countTrialsFrom: "2026-11-01T12:40:00Z",
        },
      }).success,
    ).toBe(true);
    expect(
      wordPressSelectionPolicySchema.safeParse({
        ...policy,
        revisitPolicy: {
          kind: "version-increased",
          countTrialsFrom: "2026-11-01",
        },
      }).success,
    ).toBe(false);
  });

  it("writes no legacy surface fields and rejects a policy that still carries them", async () => {
    const selection = harness({
      observations: {
        popular: observation("popular", [], 100_000),
        files: observation("files", ["File Manager"], 1_000),
      },
    });
    const plain = await selection.rank({
      ...basePolicy,
      candidateSlugs: ["popular", "files"],
    });
    expect(plain.map((item) => item.slug)).toEqual(["popular", "files"]);
    for (const item of plain) {
      expect(item).not.toHaveProperty("runBudget");
      expect(item).not.toHaveProperty("highThreatSurface");
      expect(item).not.toHaveProperty("scoreBreakdown");
    }
    for (const legacy of [
      { surfaceTagWeights: { form: 5 } },
      { highThreatTags: ["file manager"] },
      { runBudget: { default: 10, highThreat: 30 } },
      { scoreWeights: { surface: 1 } },
      { scoreWeights: { highThreat: 1 } },
    ])
      expect(
        wordPressSelectionPolicySchema.safeParse({ ...basePolicy, ...legacy })
          .success,
      ).toBe(false);
  });

  it("still reads a stored selection written with the legacy surface fields", async () => {
    const [current] = await harness({}).rank(basePolicy);
    if (current === undefined) throw new Error("Expected a selection");
    const { reason: _reason, ...historical } = current;
    const old = {
      ...historical,
      cascadeStep: 2,
      advisoryHistory: {
        count: 3,
        payingClassCount: 2,
        mirrorAsOf: now,
        mirrorDigest: digest("f"),
      },
      highThreatSurface: true,
      runBudget: 30,
      scoreBreakdown: {
        installations: 10,
        recency: 2,
        history: 0,
        surface: 5,
        highThreat: 15,
      },
    };
    expect(wordPressTargetSelectionSchema.parse(old)).toEqual(old);
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
      ["huge", "eligible", []],
      ["missing", "ineligible", ["observation-unavailable"]],
      ["closed", "ineligible", ["distribution-closed"]],
    ]);
    expect((await selection.rank(policy)).map((item) => item.slug)).toEqual([
      "huge",
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

describe("install queue (#533)", () => {
  it("orders installs then updates without a mirror, admits a newer version immediately despite a Finding, and excludes the same version", async () => {
    const policy = basePolicy;
    const popular = observation("popular", [], 1_000_000);
    const exposed = observation("exposed", [], 1_000_000);
    exposed.observation.stableVersion = "1.2.4";
    exposed.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const small = observation("small", [], 10_000);
    const candidates = harness({ observations: { popular, exposed, small } });
    const selection = openWordPressSelection({
      candidates,
      ledger: ledgerOf(exposedTrialWithFinding()),
    });
    const queuePolicy = {
      ...policy,
      candidateSlugs: ["popular", "exposed", "small"],
      minimumActiveInstallations: 10_000,
      maximumTargets: 3,
    };
    const decision = await selection.decide(queuePolicy);
    expect(
      decision.selected.map(({ slug, reason }) => ({ slug, reason })),
    ).toEqual([
      { slug: "exposed", reason: "version-increased" },
      { slug: "popular", reason: "initial" },
      { slug: "small", reason: "initial" },
    ]);
    exposed.observation.stableVersion = "1.2.3";
    expect(
      (await selection.select(queuePolicy)).map(({ slug }) => slug),
    ).toEqual(["popular", "small"]);
  });
});

describe("queue ordering (ADR 0037 追記 3)", () => {
  it("keeps installs first by default and puts the newest publication first with version-published", async () => {
    const big = observation("big", [], 1_000_000);
    big.observation.lastUpdated = "2026-08-01T00:00:00Z";
    const fresh = observation("fresh", [], 10_000);
    fresh.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const mid = observation("mid", [], 100_000);
    mid.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const candidates = harness({ observations: { big, fresh, mid } });
    const selection = openWordPressSelection({
      candidates,
      ledger: ledgerOf([]),
    });
    const policy = {
      ...basePolicy,
      candidateSlugs: ["big", "fresh", "mid"],
      minimumActiveInstallations: 10_000,
      maximumTargets: 3,
    };
    expect((await selection.select(policy)).map(({ slug }) => slug)).toEqual([
      "big",
      "mid",
      "fresh",
    ]);
    expect(
      (
        await selection.select({ ...policy, ordering: "installs" as const })
      ).map(({ slug }) => slug),
    ).toEqual(["big", "mid", "fresh"]);
    expect(
      (
        await selection.select({
          ...policy,
          ordering: "version-published" as const,
        })
      ).map(({ slug }) => slug),
    ).toEqual(["mid", "fresh", "big"]);
    expect(
      (
        await candidates.rank({
          ...policy,
          ordering: "version-published" as const,
        })
      ).map(({ slug }) => slug),
    ).toEqual(["mid", "fresh", "big"]);
  });

  it("puts the higher install band first and the newest publication first inside a band (ADR 0037 追記 4)", async () => {
    const giantOld = observation("giant-old", [], 2_000_000);
    giantOld.observation.lastUpdated = "2026-06-01T00:00:00Z";
    const giantNew = observation("giant-new", [], 1_200_000);
    giantNew.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const midNew = observation("mid-new", [], 300_000);
    midNew.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const smallNew = observation("small-new", [], 20_000);
    smallNew.observation.lastUpdated = "2026-10-07T00:00:00Z";
    const candidates = harness({
      observations: {
        "giant-old": giantOld,
        "giant-new": giantNew,
        "mid-new": midNew,
        "small-new": smallNew,
      },
    });
    const selection = openWordPressSelection({
      candidates,
      ledger: ledgerOf([]),
    });
    const policy = {
      ...basePolicy,
      candidateSlugs: ["giant-old", "giant-new", "mid-new", "small-new"],
      minimumActiveInstallations: 10_000,
      maximumTargets: 4,
      ordering: "install-band-then-published" as const,
    };
    expect((await selection.select(policy)).map(({ slug }) => slug)).toEqual([
      "giant-new",
      "giant-old",
      "mid-new",
      "small-new",
    ]);
    // A single bound makes two bands; order inside the lower band is by date.
    expect(
      (await selection.select({ ...policy, orderingBands: [1_500_000] })).map(
        ({ slug }) => slug,
      ),
    ).toEqual(["giant-old", "giant-new", "mid-new", "small-new"]);
  });

  it("ships install-band-then-published as the production order", async () => {
    const shipped = await loadWordPressSelectionPolicy();
    expect(shipped.ordering).toBe("install-band-then-published");
    expect(shipped.orderingBands).toEqual([1_000_000, 100_000, 10_000]);
    expect(shipped.id).toBe("wordpress-selection-2026-11-01-install-band");
  });
});

describe("freshness 180 days (#742)", () => {
  it("excludes an update 181 days old and keeps one 179 days old with the shipped policy", async () => {
    const stale = observation("stale", [], 100_000);
    stale.observation.lastUpdated = "2026-04-10T00:00:00Z";
    const fresh = observation("fresh", [], 50_000);
    fresh.observation.lastUpdated = "2026-04-12T00:00:00Z";
    const candidates = harness({ observations: { stale, fresh } });
    const selection = openWordPressSelection({
      candidates,
      ledger: ledgerOf([]),
    });
    const shipped = await loadWordPressSelectionPolicy();
    const policy = {
      ...basePolicy,
      maximumUpdateAgeDays: shipped.maximumUpdateAgeDays,
      candidateSlugs: ["stale", "fresh"],
    };
    const decision = await selection.decide(policy);
    expect(
      decision.inspections.map(({ slug, reasons }) => ({ slug, reasons })),
    ).toEqual([
      { slug: "stale", reasons: ["update-stale"] },
      { slug: "fresh", reasons: [] },
    ]);
    expect(decision.selected.map(({ slug }) => slug)).toEqual(["fresh"]);
  });
});

describe("operator candidate list (#520)", () => {
  it("excludes a nominated version that differs from stable instead of silently changing it", async () => {
    const selection = openWordPressSelection({
      candidates: harness({
        observations: { nominated: observation("nominated", [], 100_000) },
        enumerateCandidates: async () => ({
          status: "available",
          candidates: [],
          listings: [],
        }),
      }),
      ledger: ledgerOf([]),
    });
    const policy = {
      ...(await loadWordPressSelectionPolicy()),
      operatorCandidates: [
        { slug: "nominated", version: "1.2.2", evidenceDigest: digest("f") },
      ],
    };
    const decision = await selection.decide(policy);
    expect(decision.selected).toEqual([]);
    expect(decision.inspections).toMatchObject([
      {
        slug: "nominated",
        status: "ineligible",
        reasons: ["operator-candidate-version-mismatch"],
        operatorCandidate: policy.operatorCandidates[0],
      },
    ]);
  });

  it("adds nominated versions to the normal install queue with the same eligibility and Trial exclusions", async () => {
    const observations = {
      popular: observation("popular", [], 1_000_000),
      nominated: observation("nominated", [], 500_000),
      exposed: observation("exposed", [], 2_000_000),
      small: observation("small", [], 4_000),
    };
    const candidates = harness({
      observations,
      enumerateCandidates: async () => ({
        status: "available",
        candidates: [
          {
            slug: "popular",
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
    const selection = openWordPressSelection({
      candidates,
      ledger: ledgerOf(exposedTrialWithFinding()),
    });
    const policy = {
      ...(await loadWordPressSelectionPolicy()),
      operatorCandidates: ["popular", "nominated", "exposed", "small"].map(
        (slug) => ({
          slug,
          version: "1.2.3",
          evidenceDigest: digest("f"),
        }),
      ),
    };
    const decision = await selection.decide(policy);
    expect(decision.selected.map(({ slug }) => slug)).toEqual([
      "popular",
      "nominated",
    ]);
    expect(
      decision.inspections.find(({ slug }) => slug === "exposed")?.reasons,
    ).toEqual(["previously-selected"]);
    expect(
      decision.inspections.find(({ slug }) => slug === "small")?.reasons,
    ).toEqual(["below-installation-threshold"]);
    expect(
      decision.inspections.find(({ slug }) => slug === "nominated"),
    ).toMatchObject({
      operatorCandidate: {
        slug: "nominated",
        version: "1.2.3",
        evidenceDigest: digest("f"),
      },
    });
    expect(JSON.stringify(decision.selected)).not.toContain(digest("f"));
    observations.exposed.observation.stableVersion = "1.2.4";
    const revisited = await selection.decide({
      ...policy,
      operatorCandidates: policy.operatorCandidates.map((candidate) =>
        candidate.slug === "exposed"
          ? { ...candidate, version: "1.2.4" }
          : candidate,
      ),
    });
    expect(revisited.selected.map(({ slug }) => slug)).toEqual([
      "exposed",
      "popular",
      "nominated",
    ]);
    expect(revisited.selected[0]?.reason).toBe("version-increased");
  });

  it("applies current freshness, author, slug and Programme rules to nominated candidates", async () => {
    const oldUpdate = observation("old-update", [], 100_000);
    oldUpdate.observation.lastUpdated = "2025-01-01T00:00:00Z";
    const oldObservation = observation("old-observation", [], 100_000);
    oldObservation.observation.observedAt = "2026-10-01T00:00:00Z";
    const excludedAuthor = observation("excluded-author", [], 100_000);
    excludedAuthor.observation.author = "Automattic";
    const observations = {
      safe: observation("safe", [], 100_000),
      blocked: observation("blocked", [], 100_000),
      "excluded-author": excludedAuthor,
      "old-update": oldUpdate,
      "old-observation": oldObservation,
      closed: failed("closed", "closed"),
    };
    const policy = {
      ...(await loadWordPressSelectionPolicy()),
      excludedSlugs: ["blocked"],
      operatorCandidates: Object.keys(observations).map((slug) => ({
        slug,
        version: "1.2.3",
        evidenceDigest: digest("f"),
      })),
    };
    const source = {
      observations,
      enumerateCandidates: async () => ({
        status: "available" as const,
        candidates: [],
        listings: [],
      }),
    };
    const decision = await openWordPressSelection({
      candidates: harness(source),
      ledger: ledgerOf([]),
    }).decide(policy);
    expect(decision.selected.map(({ slug }) => slug)).toEqual(["safe"]);
    expect(
      decision.inspections.map(({ slug, reasons }) => [slug, reasons]),
    ).toEqual([
      ["safe", []],
      ["blocked", ["excluded-slug"]],
      ["excluded-author", ["excluded-author"]],
      ["old-update", ["update-stale"]],
      ["old-observation", ["observation-stale"]],
      ["closed", ["distribution-closed"]],
    ]);
    for (const [settings, expected] of [
      [{ programmeStatus: "stale" as const }, "programme-stale"],
      [{ programmeAcceptsAsset: false }, "programme-asset-out-of-scope"],
    ] as const) {
      const blocked = await openWordPressSelection({
        candidates: harness({ ...source, ...settings }),
        ledger: ledgerOf([]),
      }).decide(policy);
      expect(blocked.selected).toEqual([]);
      expect(
        blocked.inspections.every(({ reasons }) => reasons.includes(expected)),
      ).toBe(true);
    }
  });

  it("binds references to the policy and refuses body fields, duplicate slugs and invalid references at the public boundary", async () => {
    const selection = openWordPressSelection({
      candidates: harness({
        observations: { nominated: observation("nominated", [], 100_000) },
        enumerateCandidates: async () => ({
          status: "available",
          candidates: [],
          listings: [],
        }),
      }),
      ledger: ledgerOf([]),
    });
    const candidate = {
      slug: "nominated",
      version: "1.2.3",
      evidenceDigest: digest("f"),
    };
    const policy = {
      ...(await loadWordPressSelectionPolicy()),
      operatorCandidates: [candidate],
    };
    const selected = (await selection.decide(policy)).selected;
    const changed = await selection.decide({
      ...policy,
      operatorCandidates: [{ ...candidate, evidenceDigest: digest("e") }],
    });
    expect(changed.selected[0]?.policy.digest).not.toBe(
      selected[0]?.policy.digest,
    );
    for (const field of ["mechanism", "patch", "poc", "reproduction"]) {
      await expect(
        selection.decide({
          ...policy,
          operatorCandidates: [
            { ...candidate, [field]: "synthetic forbidden body" },
          ],
        }),
      ).rejects.toThrow();
    }
    for (const operatorCandidates of [
      [candidate, candidate],
      [{ ...candidate, evidenceDigest: "/private/evidence" }],
      [{ ...candidate, version: "../old" }],
      [{ ...candidate, slug: "../outside" }],
    ])
      await expect(
        selection.decide({ ...policy, operatorCandidates }),
      ).rejects.toThrow();
    await expect(
      selection.decide({ ...basePolicy, operatorCandidates: [candidate] }),
    ).rejects.toThrow();
  });

  it("does not bypass a failed directory enumeration with operator candidates", async () => {
    const selection = openWordPressSelection({
      candidates: harness({
        observations: { nominated: observation("nominated", [], 100_000) },
        enumerateCandidates: async () => ({
          status: "unavailable",
          candidates: [],
          listings: [],
        }),
      }),
      ledger: ledgerOf([]),
    });
    const decision = await selection.decide({
      ...(await loadWordPressSelectionPolicy()),
      operatorCandidates: [
        { slug: "nominated", version: "1.2.3", evidenceDigest: digest("f") },
      ],
    });
    expect(decision.sourceStatus).toBe("unavailable");
    expect(decision.selected).toEqual([]);
  });
});

describe("installation upper bound (ADR 0037, 2026-11-02)", () => {
  /** Popular pages of one plugin each: 5M, 900k, 50k, then 8k below the floor. */
  const pages = [
    ["giant", 5_000_000],
    ["large", 900_000],
    ["mid", 50_000],
    ["small", 8_000],
  ] as const;
  const requested: number[] = [];
  const popularPages: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("request[page]"));
    requested.push(page);
    const entry = pages[page - 1];
    return new Response(
      JSON.stringify({
        info: { page, pages: pages.length, results: pages.length },
        plugins:
          entry === undefined
            ? []
            : [{ slug: entry[0], active_installs: entry[1] }],
      }),
    );
  };
  const observations = Object.fromEntries(
    pages.map(([slug, installs]) => [slug, observation(slug, [], installs)]),
  );

  async function decideWith(maximum: number | undefined) {
    requested.length = 0;
    const selection = openWordPressSelection({
      candidates: harness({ observations, fetch: popularPages }),
      ledger: ledgerOf([]),
    });
    const shipped = await loadWordPressSelectionPolicy();
    if (!("candidateSource" in shipped))
      throw new Error("Expected the automatic policy");
    return selection.decide({
      ...shipped,
      candidateSource: { ...shipped.candidateSource, perPage: 1 },
      minimumActiveInstallations: 10_000,
      ...(maximum === undefined ? {} : { maximumActiveInstallations: maximum }),
    });
  }

  it("skips a plugin at or above the maximum with a recorded reason and still stops at the floor", async () => {
    const decision = await decideWith(1_000_000);
    expect(decision.sourceStatus).toBe("available");
    // Pages are read past the ≥1M plugins and stop where installs fall below the floor.
    expect(requested).toEqual([1, 2, 3, 4]);
    expect(decision.sourceListings.at(-1)).toMatchObject({
      page: 4,
      status: "available",
      end: "installation-floor",
    });
    expect(decision.selected.map(({ slug }) => slug)).toEqual(["large", "mid"]);
    expect(
      decision.inspections.map(({ slug, status, reasons }) => [
        slug,
        status,
        reasons,
      ]),
    ).toEqual([
      ["giant", "ineligible", ["above-maximum-installations"]],
      ["large", "eligible", []],
      ["mid", "eligible", []],
    ]);
    expect(
      decision.inspections.find(({ slug }) => slug === "giant"),
    ).toMatchObject({
      observedAt: now,
      enumeration: { sourceKind: "popular", sourcePage: 1 },
    });
  });

  it("selects exactly as before when the maximum is absent", async () => {
    const decision = await decideWith(undefined);
    expect(requested).toEqual([1, 2, 3, 4]);
    expect(decision.selected.map(({ slug }) => slug)).toEqual([
      "giant",
      "large",
      "mid",
    ]);
    expect(
      decision.inspections.every(({ reasons }) => reasons.length === 0),
    ).toBe(true);
  });

  it("treats the bound as exclusive: a plugin exactly at the maximum is skipped, one below stays", async () => {
    const decision = await decideWith(900_000);
    expect(decision.selected.map(({ slug }) => slug)).toEqual(["mid"]);
    expect(
      decision.inspections.map(({ slug, reasons }) => [slug, reasons]),
    ).toEqual([
      ["giant", ["above-maximum-installations"]],
      ["large", ["above-maximum-installations"]],
      ["mid", []],
    ]);
    expect(
      (await decideWith(900_001)).selected.map(({ slug }) => slug),
    ).toEqual(["large", "mid"]);
  });
});
