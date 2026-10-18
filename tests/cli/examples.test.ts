import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
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

it("starts the checked-in campaign with two targets on WordPress 7.1.3", async () => {
  const config = wordpressCampaignConfigSchema.parse(
    JSON.parse(
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
    ) as unknown,
  );
  expect(config.resources.maxConcurrentTargets).toBe(2);
  expect(config.wordpressVersion).toBe("7.1.3");
});

it("loads the opt-in v6 measurement example with a 120-minute wall", async () => {
  const measure = wordpressCampaignConfigSchema.parse(
    JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "..",
          "..",
          "examples",
          "campaign-v6-measure.json",
        ),
        "utf8",
      ),
    ) as unknown,
  );
  expect(measure).toMatchObject({
    mode: "wp2shell",
    promptId: "wp2shell-bounty-v6",
    runWallTimeMinutes: 120,
    entryIndex: true,
  });
  expect(
    wordpressCampaignConfigSchema.safeParse({
      ...measure,
      promptId: "wp2shell-bounty-v5",
    }).success,
  ).toBe(false);
});

it.each(["3.3.1", "3.2.6"])(
  "runs the pinned %s production example as one indexed 60-minute WP2Shell Trial",
  async (version) => {
    const source = (await example(
      "campaign-production-v1.json",
      version,
    )) as Record<string, unknown>;
    expect(source).not.toHaveProperty("promptId");
    const config = wordpressCampaignConfigSchema.parse(source);
    expect(config).toMatchObject({
      mode: "wp2shell",
      promptId: "wp2shell-bounty-v5",
      entryIndex: true,
      runWallTimeMinutes: 60,
      stopRules: { maxRuns: 1, noFindingRuns: 1 },
    });
  },
);

describe("TranslatePress 3.3.1 development-set example", () => {
  it("keeps the short prompt comparison arm and bounds the cooperative default at 60 minutes", async () => {
    const previous = wordpressCampaignConfigSchema.parse(
      await example("campaign-short-managed-v4.json"),
    );
    const archivedCurrent = (await example(
      "campaign-wp2shell-bounty-v2.json",
    )) as Record<string, unknown>;
    expect(
      wordpressCampaignConfigSchema.safeParse(archivedCurrent).success,
    ).toBe(false);
    const current = wordpressCampaignConfigSchema.parse({
      ...archivedCurrent,
      runWallTimeMinutes: 60,
    });
    expect(current.mode).toBe("wp2shell");
    expect(previous.mode).toBe("comparison");
    expect(current.promptId).toBe("wp2shell-bounty-v2");
    expect(previous.promptId).toBe("short-objective-managed-v4");
    expect(current.stopRules).toEqual(previous.stopRules);
    expect(current.programmeBoundary).toEqual(previous.programmeBoundary);
    expect(current.lab).toEqual(previous.lab);
  });

  it("keeps the whitebox v1.7 arm identical to the archived WP2Shell arm except for promptId", async () => {
    const archived = (await example(
      "campaign-wp2shell-bounty-v2.json",
    )) as Record<string, unknown>;
    const whitebox = (await example("campaign-whitebox-v1.7.json")) as Record<
      string,
      unknown
    >;
    expect(whitebox).toEqual({
      ...archived,
      promptId: "wp2shell-whitebox-v1.7",
    });
    expect(wordpressCampaignConfigSchema.safeParse(whitebox).success).toBe(
      false,
    );
    expect(
      wordpressCampaignConfigSchema.parse({
        ...whitebox,
        runWallTimeMinutes: 60,
      }),
    ).toMatchObject({
      mode: "wp2shell",
      promptId: "wp2shell-whitebox-v1.7",
      entryIndex: true,
    });
  });

  it("pins the development target and bounds the trial to one discovery run", async () => {
    const config = wordpressCampaignConfigSchema.parse(
      await example("campaign.json"),
    );
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection.json"),
    );
    if (!("candidateSlugs" in policy))
      throw new Error("Expected manual policy");
    expect(config.stopRules.maxRuns).toBe(1);
    expect(config.resources.maxConcurrentRuns).toBe(1);
    expect(config.selectionPolicyPath).toBe(
      "examples/translatepress-3.3.1/selection.json",
    );
    expect(policy.candidateSlugs).toEqual(["translatepress-multilingual"]);
    expect(policy.pinnedVersions).toEqual({
      "translatepress-multilingual": "3.3.1",
    });
  });

  it("runs the 40-run luna trial on the same pinned target with four concurrent runs", async () => {
    const config = wordpressCampaignConfigSchema.parse(
      await example("campaign-luna-40.json"),
    );
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection-luna-40.json"),
    );
    if (!("candidateSlugs" in policy))
      throw new Error("Expected manual policy");
    expect(config.stopRules).toEqual({ maxRuns: 40, noFindingRuns: 4 });
    expect(config.resources).toEqual({
      maxConcurrentRuns: 4,
      maxConcurrentTargets: 1,
      memoryBudgetMiB: 10240,
    });
    expect(config.selectionPolicyPath).toBe(
      "examples/translatepress-3.3.1/selection-luna-40.json",
    );
    expect(policy.runBudget).toEqual({ default: 40, highThreat: 40 });
    expect(policy.pinnedVersions).toEqual({
      "translatepress-multilingual": "3.3.1",
    });
  });

  it("keeps the programme transcription unusable until a human adds the pending submission cap", async () => {
    const transcription = wordfenceProgrammeTranscriptionSchema.parse(
      await example("wordfence-programme.example.json"),
    );
    expect(
      transcription.pages.find((page) => page.sourceKind === "programme")
        ?.assertions.eligibility?.limits,
    ).toBeUndefined();
  });
});

describe("TranslatePress 3.2.6 Stored XSS prompt comparison", () => {
  it("pairs both prompts on a secondary-language Lab with identical inputs", async () => {
    const short = wordpressCampaignConfigSchema.parse(
      await example("campaign-short-managed-v4.json", "3.2.6"),
    );
    const archived = (await example(
      "campaign-wp2shell-bounty-v2.json",
      "3.2.6",
    )) as Record<string, unknown>;
    expect(wordpressCampaignConfigSchema.safeParse(archived).success).toBe(
      false,
    );
    const wp2shell = wordpressCampaignConfigSchema.parse({
      ...archived,
      runWallTimeMinutes: 60,
    });
    expect(short.promptId).toBe("short-objective-managed-v4");
    expect(wp2shell.promptId).toBe("wp2shell-bounty-v2");
    expect(short.lab.translatePress?.administratorSecondaryLocale).toBe(
      "fr_FR",
    );
    expect(wp2shell.mode).toBe("wp2shell");
    expect(short.mode).toBe("comparison");
    expect(wp2shell.lab).toEqual(short.lab);
    expect(wp2shell.programmeBoundary).toEqual(short.programmeBoundary);
  });

  it("pairs both prompts with the same approved-comment Lab fixture", async () => {
    const short = wordpressCampaignConfigSchema.parse(
      await example("campaign-short-managed-v4-comment-fixture.json", "3.2.6"),
    );
    const archived = (await example(
      "campaign-wp2shell-bounty-v2-comment-fixture.json",
      "3.2.6",
    )) as Record<string, unknown>;
    expect(wordpressCampaignConfigSchema.safeParse(archived).success).toBe(
      false,
    );
    const wp2shell = wordpressCampaignConfigSchema.parse({
      ...archived,
      runWallTimeMinutes: 60,
    });
    expect(short.lab.initialApprovedComment).toBe(true);
    expect(wp2shell.lab).toEqual(short.lab);
    expect(wp2shell.programmeBoundary).toEqual(short.programmeBoundary);
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...short,
        lab: { ...short.lab, initialPosts: [] },
      }).success,
    ).toBe(false);
  });
});
