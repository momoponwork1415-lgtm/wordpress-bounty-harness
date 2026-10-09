import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import { wordPressSelectionPolicySchema } from "../../src/profiles/wordpress/selection/index.js";
import { wordfenceProgrammeTranscriptionSchema } from "../../src/profiles/wordpress/wordfence-programme/index.js";

const example = async (file: string): Promise<unknown> =>
  JSON.parse(
    await readFile(
      join(
        import.meta.dirname,
        "..",
        "..",
        "examples",
        "translatepress-3.3.1",
        file,
      ),
      "utf8",
    ),
  ) as unknown;

describe("TranslatePress 3.3.1 development-set example", () => {
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
    expect(config.dailyRunCap).toBe(40);
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
