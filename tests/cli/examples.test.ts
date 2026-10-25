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

it("starts the checked-in v10 campaign with one concurrent target on WordPress 7.1.3", async () => {
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
    promptId: "wp2shell-bounty-v10",
    runWallTimeMinutes: 120,
  });
  expect(config.resources.maxConcurrentTargets).toBe(1);
  expect(config.wordpressVersion).toBe("7.1.3");
  expect(config.discovery.lab).toBe("none");
  expect(
    wordpressCampaignConfigSchema.safeParse({
      ...(source as object),
      discovery: { lab: "attached" },
    }).success,
  ).toBe(false);
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

it("retains the v6 measurement example as an unrunnable historical fixture", async () => {
  const measure = JSON.parse(
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
  ) as Record<string, unknown>;
  expect(measure.promptId).toBe("wp2shell-bounty-v6");
  expect(wordpressCampaignConfigSchema.safeParse(measure).success).toBe(false);
});

it.each(["3.3.1", "3.2.6"])(
  "runs the pinned %s production example as one source-first 120-minute v10 Trial",
  async (version) => {
    const source = (await example(
      "campaign-production-v1.json",
      version,
    )) as Record<string, unknown>;
    expect(source).not.toHaveProperty("promptId");
    expect(wordpressCampaignConfigSchema.parse(source)).toMatchObject({
      promptId: "wp2shell-bounty-v10",
      runWallTimeMinutes: 120,
      discovery: { lab: "none" },
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
