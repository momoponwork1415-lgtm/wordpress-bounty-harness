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

  it("ships the install queue and rejects retired policy fields", async () => {
    const policy = await loadWordPressSelectionPolicy();
    expect(policy.minimumActiveInstallations).toBe(10_000);
    expect(policy.maximumUpdateAgeDays).toBe(365);
    expect(policy.revisitPolicy).toEqual({ kind: "version-increased" });
    for (const [field, value] of Object.entries({
      cascade: [{ minimumActiveInstallations: 50_000 }],
      maximumActiveInstallations: 1_000_000,
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
      small: observation("small", [], 5_000),
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
