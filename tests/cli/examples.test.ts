import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import { allocateTrialArms } from "../../src/discovery/index.js";
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
      promptId: "wp2shell-bounty-v2",
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

describe("TranslatePress 3.2.5 A/B development-set example", () => {
  it("rejects the removed daily run cap setting", async () => {
    const config = (await example(
      "campaign-luna-ab-time-control.json",
      "3.2.5",
    )) as Record<string, unknown>;
    delete config.assignment;
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...wordpressCampaignConfigSchema.parse(config),
        dailyRunCap: 6,
      }).success,
    ).toBe(false);
  });

  it("keeps the archived continuation example for reference and projects a prompt-only comparison", async () => {
    const archived = (await example(
      "campaign-luna-ab.json",
      "3.2.5",
    )) as Record<string, unknown>;
    expect(wordpressCampaignConfigSchema.safeParse(archived).success).toBe(
      false,
    );
    const withoutRemovedModes = { ...archived };
    delete withoutRemovedModes.continuation;
    delete withoutRemovedModes.assignment;
    const config = wordpressCampaignConfigSchema.parse({
      ...withoutRemovedModes,
      ablation: { axes: [(archived.ablation as { axes: unknown[] }).axes[0]] },
    });
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection-luna-40.json", "3.2.5"),
    );
    if (!("candidateSlugs" in policy))
      throw new Error("Expected manual policy");
    expect(policy.pinnedVersions).toEqual({
      "translatepress-multilingual": "3.2.5",
    });
    expect(config.selectionPolicyPath).toBe(
      "examples/translatepress-3.2.5/selection-luna-40.json",
    );
    expect(config.stopRules).toEqual({ maxRuns: 12, noFindingRuns: 12 });
    expect(config.runWallTimeMinutes).toBe(90);
    expect(config.resources.maxConcurrentRuns).toBe(2);
    expect(config.lab.databaseAccess).toBe("read-only");
    expect(config.mode).toBe("ablation");
    if (config.mode !== "ablation") throw new Error("Expected ablation mode");
    expect(config.promptId).toBe("short-objective-v2");
    expect(config.ablation.axes).toEqual([
      {
        axis: "prompt",
        armBFraction: 0.5,
        armBPromptId: "wp2shell-single-http-v2",
      },
    ]);
    const cells = Array.from({ length: 12 }, (_, ordinal) =>
      JSON.stringify(allocateTrialArms(ordinal, config.ablation.axes)),
    );
    expect(new Set(cells).size).toBe(2);
    for (const cell of new Set(cells))
      expect(cells.filter((candidate) => candidate === cell)).toHaveLength(6);
  });

  it("retains the archived 150-minute prompt control as an opt-in ablation", async () => {
    const archived = (await example(
      "campaign-luna-ab-time-control.json",
      "3.2.5",
    )) as Record<string, unknown>;
    expect(wordpressCampaignConfigSchema.safeParse(archived).success).toBe(
      false,
    );
    const promptOnly = { ...archived };
    delete promptOnly.assignment;
    const config = wordpressCampaignConfigSchema.parse(promptOnly);
    expect(config.stopRules).toEqual({ maxRuns: 6, noFindingRuns: 6 });
    expect(config.runWallTimeMinutes).toBe(150);
    expect(config.mode).toBe("ablation");
    if (config.mode !== "ablation") throw new Error("Expected ablation mode");
    expect(config.ablation.axes).toEqual([
      {
        axis: "prompt",
        armBFraction: 0.5,
        armBPromptId: "wp2shell-single-http-v2",
      },
    ]);
    expect(
      Array.from(
        { length: 6 },
        (_, ordinal) => allocateTrialArms(ordinal, config.ablation.axes).prompt,
      ),
    ).toEqual(["a", "b", "a", "b", "a", "b"]);
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
