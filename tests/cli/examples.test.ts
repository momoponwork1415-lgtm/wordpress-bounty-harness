import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import { readWordPressCampaignPolicy } from "../../src/cli/wordpress-session.js";
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

it("starts the checked-in wide v26 campaign with one concurrent target on the Lab image's WordPress (owner decision 2026-11-05; #741 unpinned)", async () => {
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
    promptId: "wp2shell-bounty-v26-wide",
    runWallTimeMinutes: 120,
  });
  expect((await readWordPressCampaignPolicy(config)).promptVariant).toBe(
    config.promptId,
  );
  expect(config.resources.maxConcurrentTargets).toBe(1);
  // #741: no pin; select takes the Lab image's version and checks it against the latest stable.
  expect(config.wordpressVersion).toBeUndefined();
  expect(config.discovery.lab).toEqual({
    mode: "attached",
    maxResets: 2,
    maxObservations: 20,
    maxLookups: 60,
  });
  expect(config.discovery).toMatchObject({
    maxChildren: 3,
    minimumActiveMinutes: 60,
    priorResearch: "same-target",
  });
  expect(config.discovery.mode).toBe("wide");
  // Deep was retired on 2026-11-05 (ADR 0039 addendum): v11 and deep no longer parse.
  for (const fields of [
    { discovery: { lab: "none", mode: "deep" } },
    {
      discovery: { lab: "none", mode: "deep" },
      promptId: "wp2shell-bounty-v11",
    },
    { discovery: { lab: "none" }, promptId: "wp2shell-bounty-v11" },
  ])
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...(source as object),
        ...fields,
      }).success,
    ).toBe(false);
  expect(
    wordpressCampaignConfigSchema.parse({
      ...(source as object),
      discovery: { lab: "attached", mode: "wide" },
    }).discovery.lab,
  ).toEqual({
    mode: "attached",
    maxResets: 2,
    maxObservations: 20,
    maxLookups: 60,
  });
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

it("rejects every removed partitioned campaign setting at parse time", () => {
  const base = {
    schemaVersion: 1,
    programmeBoundary: { version: "v", text: "t" },
    wordpressVersion: "6.8",
    lab: { siteTitle: "s", initialPosts: [], customerRole: false },
  };
  const cases = [
    ["discovery.mode", { discovery: { mode: "partitioned" } }],
    ["discovery.enumerator", { discovery: { enumerator: {} } }],
    ["discovery.partition", { discovery: { partition: {} } }],
    ["discovery.tracer", { discovery: { tracer: {} } }],
    [
      "resources.partitionedRoleMemoryProfile",
      {
        resources: {
          memoryBudgetMiB: 10752,
          partitionedRoleMemoryProfile: "compact-768-256",
        },
      },
    ],
  ] as const;
  for (const [path, fields] of cases) {
    const result = wordpressCampaignConfigSchema.safeParse({
      ...base,
      ...fields,
    });
    expect(result.success, path).toBe(false);
    expect(
      result.error?.issues.find((issue) => issue.path.join(".") === path)
        ?.message ?? "",
      path,
    ).toContain("Partitioned mode was removed in #685");
  }
});

it("rejects discovery.skills at parse time", () => {
  const result = wordpressCampaignConfigSchema.safeParse({
    schemaVersion: 1,
    programmeBoundary: { version: "v", text: "t" },
    wordpressVersion: "6.8",
    lab: { siteTitle: "s", initialPosts: [], customerRole: false },
    discovery: { skills: ["wbh-recon-v3"] },
  });
  expect(result.success).toBe(false);
  expect(
    result.error?.issues.find(
      (issue) => issue.path.join(".") === "discovery.skills",
    )?.message,
  ).toBe("Exploration skills were removed in the v26 cleanup");
});

it("parses the historical 20-minute v22-wide example with the current selection policy (ADR 0039)", async () => {
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
    promptId: "wp2shell-bounty-v22-wide",
    runWallTimeMinutes: 20,
  });
});

it("runs the v26 wide example with an attached Lab for at least 60 active minutes", async () => {
  const source = JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "examples",
        "campaign-wide-v26-120.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const config = wordpressCampaignConfigSchema.parse(source);
  expect(config).toMatchObject({
    promptId: "wp2shell-bounty-v26-wide",
    runWallTimeMinutes: 120,
    discovery: {
      mode: "wide",
      lab: { mode: "attached" },
      maxChildren: 3,
      minimumActiveMinutes: 60,
      priorResearch: "same-target",
    },
  });
  expect(config.wordpressVersion).toBeUndefined();
  expect(config.resources.maxConcurrentTargets).toBe(1);
});

it.each(["3.3.1", "3.2.6"])(
  "runs the pinned %s production example as one source-first 120-minute wide Trial",
  async (version) => {
    const source = (await example(
      "campaign-production-v1.json",
      version,
    )) as Record<string, unknown>;
    expect(source).not.toHaveProperty("promptId");
    // ADR 0049: an example that names no Lab mode now gets the default, attached.
    expect(wordpressCampaignConfigSchema.parse(source)).toMatchObject({
      promptId: "wp2shell-bounty-v26-wide",
      runWallTimeMinutes: 120,
      discovery: { lab: { mode: "attached" } },
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
