import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import {
  readWordPressCampaignConfig,
  readWordPressCampaignPolicy,
} from "../../src/cli/wordpress-session.js";
import { wordPressSelectionPolicySchema } from "../../src/profiles/wordpress/selection/index.js";
import { wordfenceProgrammeTranscriptionSchema } from "../../src/profiles/wordpress/wordfence-programme/index.js";

const example = async (file: string, version = "3.3.1"): Promise<unknown> =>
  JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "examples",
        `translatepress-${version}`,
        file,
      ),
      "utf8",
    ),
  ) as unknown;

it("starts the checked-in wide v14 campaign with one concurrent target on WordPress 7.1.3 (owner decision 2026-10-26)", async () => {
  const source = JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "profiles",
        "wordpress",
        "policy",
        "campaign.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const config = wordpressCampaignConfigSchema.parse(source);
  expect(config).toMatchObject({
    promptId: "wp2shell-bounty-v14-wide",
    runWallTimeMinutes: 120,
  });
  expect(config.resources.maxConcurrentTargets).toBe(1);
  expect(config.wordpressVersion).toBe("7.1.3");
  expect(config.discovery.lab).toEqual({
    mode: "none",
    maxResets: 2,
    maxObservations: 20,
  });
  expect(config.discovery).toMatchObject({
    maxChildren: 4,
    minimumActiveMinutes: 0,
  });
  expect(config.discovery.mode).toBe("wide");
  // deep v11 stays available for named Trials: the same file in deep mode still parses.
  expect(
    wordpressCampaignConfigSchema.parse({
      ...(source as object),
      discovery: { lab: "none", mode: "deep" },
      promptId: "wp2shell-bounty-v11",
    }),
  ).toMatchObject({
    promptId: "wp2shell-bounty-v11",
    discovery: { mode: "deep", minimumActiveMinutes: 60 },
  });
  expect(
    wordpressCampaignConfigSchema.parse({
      ...(source as object),
      discovery: { lab: "attached", mode: "wide" },
    }).discovery.lab,
  ).toEqual({ mode: "attached", maxResets: 2, maxObservations: 20 });
  for (const [maxConcurrentTargets, accepted] of [
    [10, true],
    [11, false],
  ] as const)
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...(source as object),
        resources: { ...config.resources, maxConcurrentTargets },
      }).success,
    ).toBe(accepted);
});

it("runs the wide example as a 20-minute v14-wide Trial on the production selection policy (ADR 0039)", async () => {
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "..",
          "examples",
          "campaign-wide-20.json",
        ),
        "utf8",
      ),
    ) as unknown,
  );
  // The example keeps its explicit 20-minute wall; without it, wide gets 120 (ADR 0039 addendum 3).
  expect(config).toMatchObject({
    discovery: {
      lab: { mode: "none" },
      mode: "wide",
      minimumActiveMinutes: 0,
    },
    promptId: "wp2shell-bounty-v14-wide",
    runWallTimeMinutes: 20,
  });
  // The production selection policy names the deep objective; both modes select from it.
  expect((await readWordPressCampaignPolicy(config)).promptVariant).toBe(
    "wp2shell-bounty-v11",
  );
});

it.each(["3.3.1", "3.2.6"])(
  "runs the pinned %s production example as one source-first 120-minute v11 Trial",
  async (version) => {
    const source = (await example(
      "campaign-production-v1.json",
      version,
    )) as Record<string, unknown>;
    expect(source).not.toHaveProperty("promptId");
    expect(wordpressCampaignConfigSchema.parse(source)).toMatchObject({
      promptId: "wp2shell-bounty-v11",
      runWallTimeMinutes: 120,
      discovery: { lab: { mode: "none" } },
    });
  },
);

describe("historical TranslatePress development fixtures", () => {
  it("keeps old prompt examples readable but rejects them as new campaigns", async () => {
    for (const [version, files] of [
      [
        "3.3.1",
        [
          "campaign.json",
          "campaign-luna-40.json",
          "campaign-short-managed-v4.json",
          "campaign-wp2shell-bounty-v2.json",
          "campaign-whitebox-v1.7.json",
        ],
      ],
      [
        "3.2.6",
        [
          "campaign-short-managed-v4.json",
          "campaign-wp2shell-bounty-v2.json",
          "campaign-short-managed-v4-comment-fixture.json",
          "campaign-wp2shell-bounty-v2-comment-fixture.json",
        ],
      ],
    ] as const)
      for (const file of files) {
        const source = await example(file, version);
        expect(wordpressCampaignConfigSchema.safeParse(source).success).toBe(
          false,
        );
      }
  });

  it("preserves the archived whitebox comparison and pinned target metadata", async () => {
    const old = (await example("campaign-wp2shell-bounty-v2.json")) as Record<
      string,
      unknown
    >;
    const whitebox = (await example("campaign-whitebox-v1.7.json")) as Record<
      string,
      unknown
    >;
    expect(whitebox).toEqual({ ...old, promptId: "wp2shell-whitebox-v1.7" });
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection.json"),
    );
    if (!("candidateSlugs" in policy))
      throw new Error("Expected manual policy");
    expect(policy.candidateSlugs).toEqual(["translatepress-multilingual"]);
    expect(policy.pinnedVersions).toEqual({
      "translatepress-multilingual": "3.3.1",
    });
  });

  it("preserves both old Stored XSS comparison inputs and validates the comment setup", async () => {
    for (const suffix of ["", "-comment-fixture"]) {
      const short = (await example(
        `campaign-short-managed-v4${suffix}.json`,
        "3.2.6",
      )) as Record<string, unknown>;
      const wp2shell = (await example(
        `campaign-wp2shell-bounty-v2${suffix}.json`,
        "3.2.6",
      )) as Record<string, unknown>;
      expect(short.lab).toEqual(wp2shell.lab);
      expect(short.programmeBoundary).toEqual(wp2shell.programmeBoundary);
    }
    const production = (await example(
      "campaign-production-v1.json",
      "3.2.6",
    )) as Record<string, unknown>;
    const comment = (await example(
      "campaign-short-managed-v4-comment-fixture.json",
      "3.2.6",
    )) as { lab: Record<string, unknown> };
    expect(comment.lab.initialApprovedComment).toBe(true);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...production,
        lab: { ...comment.lab, initialPosts: [] },
      }).success,
    ).toBe(false);
  });

  it("keeps the programme transcription pending its submission cap", async () => {
    const transcription = wordfenceProgrammeTranscriptionSchema.parse(
      await example("wordfence-programme.example.json"),
    );
    expect(
      transcription.pages.find((page) => page.sourceKind === "programme")
        ?.assertions.eligibility?.limits,
    ).toBeUndefined();
  });
});

describe("partitioned example (ADR 0042 stage 1, shape only)", () => {
  const partitioned = async () =>
    JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "..",
          "examples",
          "campaign-partitioned.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;

  it("parses the example with its roles, limits and the partition objective", async () => {
    const config = wordpressCampaignConfigSchema.parse(await partitioned());
    expect(config).toMatchObject({
      promptId: "objective-partition-v1",
      runWallTimeMinutes: 120,
      discovery: {
        mode: "partitioned",
        minimumActiveMinutes: 0,
        enumerator: {
          runtime: "claude",
          model: "claude-opus-5-5",
          effort: "high",
          wallMinutes: 20,
          tools: [
            "enumerate-hooks-v1",
            "enumerate-sinks-v1",
            "core-fixed-list-v1",
          ],
          rowSource: "agent",
        },
        partition: {
          maxEntriesPerPartition: 60,
          maxPartitions: 8,
          maxResubmits: 2,
        },
        tracer: { runtime: "claude", wallMinutes: 45, maxParallel: 2 },
      },
    });
  });

  it("fills the roles with defaults in the partitioned mode and refuses them in the others", async () => {
    const source = await partitioned();
    const bare = wordpressCampaignConfigSchema.parse({
      ...source,
      discovery: { lab: "none", mode: "partitioned" },
      promptId: undefined,
    });
    expect(bare.promptId).toBe("objective-partition-v1");
    expect(bare.discovery).toMatchObject({
      enumerator: { runtime: "claude", wallMinutes: 20, rowSource: "agent" },
      partition: {
        maxEntriesPerPartition: 60,
        maxPartitions: 8,
        maxResubmits: 2,
      },
      tracer: { runtime: "claude", wallMinutes: 45, maxParallel: 2 },
    });
    const wide = wordpressCampaignConfigSchema.safeParse({
      ...source,
      discovery: { lab: "none", mode: "wide", tracer: { maxParallel: 1 } },
      promptId: "wp2shell-bounty-v14-wide",
    });
    expect(wide.success).toBe(false);
    expect(wide.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "discovery.tracer",
    ]);
    // The partition objective belongs to the partitioned mode only.
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...source,
        discovery: { lab: "none", mode: "wide" },
      }).success,
    ).toBe(false);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...source,
        promptId: "wp2shell-bounty-v14-wide",
      }).success,
    ).toBe(false);
  });

  it("bounds one target to the sandbox ceiling and the parallel tracers to the memory budget", async () => {
    const source = await partitioned();
    const discovery = source.discovery as Record<string, unknown>;
    const paths = (candidate: unknown) =>
      wordpressCampaignConfigSchema
        .safeParse(candidate)
        .error?.issues.map((issue) => issue.path.join("."));
    // 20 × 3 + 8 × 25 = 260 > 240.
    expect(
      paths({
        ...source,
        discovery: {
          ...discovery,
          tracer: { wallMinutes: 25, maxParallel: 1 },
        },
      }),
    ).toEqual(["discovery.tracer.wallMinutes"]);
    // A tracer run is 4,096 + 512 MiB; the 10,752 MiB budget holds two, not
    // three, per target and across the one target.
    expect(
      paths({
        ...source,
        discovery: {
          ...discovery,
          tracer: { wallMinutes: 20, maxParallel: 3 },
        },
      }),
    ).toEqual([
      "discovery.tracer.maxParallel",
      "resources.maxConcurrentTargets",
    ]);
    // Two targets side by side double the tracers in flight.
    expect(
      paths({
        ...source,
        resources: {
          ...(source.resources as object),
          maxConcurrentTargets: 2,
        },
      }),
    ).toEqual(["resources.maxConcurrentTargets"]);
    expect(
      paths({
        ...source,
        resources: {
          ...(source.resources as object),
          maxConcurrentTargets: 2,
          memoryBudgetMiB: 4 * (4096 + 512),
        },
      }),
    ).toBeUndefined();
    expect(
      paths({
        ...source,
        discovery: {
          ...discovery,
          tracer: { wallMinutes: 20, maxParallel: 3 },
        },
        resources: {
          ...(source.resources as object),
          memoryBudgetMiB: 3 * (4096 + 512),
        },
      }),
    ).toBeUndefined();
    expect(
      paths({
        ...source,
        discovery: { ...discovery, enumerator: { runtime: "codex" } },
      }),
    ).toEqual(["discovery.enumerator.runtime"]);
  });

  it("is read by a session now that the role runtime exists (ADR 0042, PR 2)", async () => {
    const config = await readWordPressCampaignConfig(
      join(
        import.meta.dirname,
        "..",
        "..",
        "examples",
        "campaign-partitioned.json",
      ),
    );
    expect(config.discovery.mode).toBe("partitioned");
    expect(config.promptId).toBe("objective-partition-v1");
  });
});
