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

describe("TranslatePress 3.3.1 development-set example", () => {
  it("keeps the two Root + 3 prompt arms identical except for the prompt", async () => {
    const previous = wordpressCampaignConfigSchema.parse(
      await example("campaign-short-managed-v3.json"),
    );
    const current = wordpressCampaignConfigSchema.parse(
      await example("campaign-wp2shell-bounty.json"),
    );
    expect(current.promptId).toBe("wp2shell-bounty-v1");
    expect(previous.promptId).toBe("short-objective-managed-v3");
    expect({ ...current, promptId: previous.promptId }).toEqual(previous);
  });

  it("pins the development target and bounds the trial to one discovery run", async () => {
    const config = wordpressCampaignConfigSchema.parse(
      await example("campaign.json"),
    );
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection.json"),
    );
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
    const config = await example("campaign-luna-ab.json", "3.2.5");
    expect(
      wordpressCampaignConfigSchema.safeParse({
        ...wordpressCampaignConfigSchema.parse(config),
        dailyRunCap: 6,
      }).success,
    ).toBe(false);
  });

  it("pins one source and balances prompt and continuation across twelve Trials", async () => {
    const config = wordpressCampaignConfigSchema.parse(
      await example("campaign-luna-ab.json", "3.2.5"),
    );
    const policy = wordPressSelectionPolicySchema.parse(
      await example("selection-luna-40.json", "3.2.5"),
    );
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
    expect(config.assignment).toEqual({
      unit: "entry-point",
      entriesPerRun: 8,
    });
    expect(config.continuation).toEqual({
      maxRunsPerTrial: 2,
      runWallTimeMinutes: 30,
    });
    expect(config.promptId).toBe("short-objective-v2");
    expect(
      wordpressCampaignConfigSchema.parse({
        ...config,
        promptId: undefined,
      }).promptId,
    ).toBe("short-objective-managed-v3");
    expect(config.ablation?.axes).toEqual([
      {
        axis: "prompt",
        armBFraction: 0.5,
        armBPromptId: "wp2shell-single-http-v2",
      },
      { axis: "continuation", armBFraction: 0.5 },
    ]);
    const cells = Array.from({ length: 12 }, (_, ordinal) =>
      JSON.stringify(allocateTrialArms(ordinal, config.ablation?.axes ?? [])),
    );
    expect(new Set(cells).size).toBe(4);
    for (const cell of new Set(cells))
      expect(cells.filter((candidate) => candidate === cell)).toHaveLength(3);
  });

  it("sets a separate 150-minute no-continuation control with three Trials per prompt", async () => {
    const config = wordpressCampaignConfigSchema.parse(
      await example("campaign-luna-ab-time-control.json", "3.2.5"),
    );
    expect(config.stopRules).toEqual({ maxRuns: 6, noFindingRuns: 6 });
    expect(config.runWallTimeMinutes).toBe(150);
    expect(config.continuation).toBeUndefined();
    expect(config.ablation?.axes).toEqual([
      {
        axis: "prompt",
        armBFraction: 0.5,
        armBPromptId: "wp2shell-single-http-v2",
      },
    ]);
    expect(
      Array.from(
        { length: 6 },
        (_, ordinal) =>
          allocateTrialArms(ordinal, config.ablation?.axes ?? []).prompt,
      ),
    ).toEqual(["a", "b", "a", "b", "a", "b"]);
  });
});

describe("TranslatePress 3.2.6 Stored XSS prompt comparison", () => {
  it("pairs both prompts on a secondary-language Lab with identical inputs", async () => {
    const short = wordpressCampaignConfigSchema.parse(
      await example("campaign-short-managed-v3.json", "3.2.6"),
    );
    const wp2shell = wordpressCampaignConfigSchema.parse(
      await example("campaign-wp2shell-bounty.json", "3.2.6"),
    );
    expect(short.promptId).toBe("short-objective-managed-v3");
    expect(wp2shell.promptId).toBe("wp2shell-bounty-v1");
    expect(short.lab.translatePress?.administratorSecondaryLocale).toBe(
      "fr_FR",
    );
    expect({ ...wp2shell, promptId: short.promptId }).toEqual(short);
  });
});
