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
    maxChildren: 4,
    minimumActiveMinutes: 0,
    priorResearch: "same-target",
  });
  expect(config.discovery.mode).toBe("wide");
  // Deep was retired on 2026-11-05 (ADR 0039 addendum): v11 and deep no longer parse.
  for (const fields of [
    { discovery: { lab: "attached", mode: "deep" } },
    {
      discovery: { lab: "attached", mode: "deep" },
      promptId: "wp2shell-bounty-v11",
    },
    { discovery: { lab: "attached" }, promptId: "wp2shell-bounty-v11" },
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

it("leaves retired campaign keys to the schema's general refusal", () => {
  const base = {
    schemaVersion: 1,
    programmeBoundary: { version: "v", text: "t" },
    lab: { siteTitle: "s", initialPosts: [], customerRole: false },
  };
  const parse = (fields: object) =>
    wordpressCampaignConfigSchema.safeParse({ ...base, ...fields });
  expect(parse({ discovery: { followUp: "none" } }).success).toBe(true);
  for (const fields of [
    { discovery: { followUp: "leads" } },
    { discovery: { priorLeads: {} } },
    { discovery: { skills: ["wbh-recon-v3"] } },
    { discovery: { mode: "partitioned" } },
    { discovery: { enumerator: {} } },
    {
      resources: { memoryBudgetMiB: 10752, partitionedRoleMemoryProfile: "x" },
    },
    { lab: { ...base.lab, scenarioId: "approved-comment-v1" } },
  ])
    expect(parse(fields).success, JSON.stringify(fields)).toBe(false);
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
      maxChildren: 4,
      minimumActiveMinutes: 0,
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

describe("TranslatePress development set", () => {
  it.each(["3.3.1", "3.2.6"])(
    "pins the %s selection to the one plugin version",
    async (version) => {
      const policy = wordPressSelectionPolicySchema.parse(
        await example("selection.json", version),
      );
      if (!("candidateSlugs" in policy))
        throw new Error("Expected manual policy");
      expect(policy.candidateSlugs).toEqual(["translatepress-multilingual"]);
      expect(policy.pinnedVersions).toEqual({
        "translatepress-multilingual": version,
      });
    },
  );

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
