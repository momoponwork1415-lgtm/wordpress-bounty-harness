import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import { runParametersSection } from "../../src/discovery/run-parameters.js";

describe("Run parameters section (redesign 2026-10-25 §5.1)", () => {
  it("states each enforced value, including a zero floor", () => {
    const runtime = {
      transportKind: "claude-code/v1",
      model: "claude-opus-5-5",
      effort: "high",
    };
    expect(
      runParametersSection({
        wallMinutes: 120,
        minimumActiveMinutes: 60,
        maxChildren: 4,
        lab: { mode: "attached", maxResets: 3 },
        runtime,
      }),
    ).toBe(
      [
        "## Run parameters",
        "",
        "The Harness sets and enforces these values for this Trial.",
        "- Runtime: claude-code/v1, model claude-opus-5-5, effort high.",
        "- Wall time: 120 minutes.",
        "- Minimum active exploration time: 60 minutes.",
        "- Maximum concurrent child agents: 4.",
        "- Lab: attached, at most 3 resets.",
      ].join("\n"),
    );
    expect(
      runParametersSection({
        wallMinutes: 120,
        minimumActiveMinutes: 0,
        maxChildren: 4,
        lab: { mode: "none", maxResets: 2 },
        runtime,
      }),
    ).toContain("- Minimum active exploration time: 0 minutes (no minimum).");
  });

  it("normalises both discovery.lab forms to one object with a reset budget", () => {
    const base = {
      schemaVersion: 1 as const,
      programmeBoundary: { version: "v1", text: "Synthetic" },
      wordpressVersion: "6.8",
      lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
    };
    for (const [lab, expected] of [
      ["none", { mode: "none", maxResets: 2, maxObservations: 20 }],
      [{ mode: "none" }, { mode: "none", maxResets: 2, maxObservations: 20 }],
      [
        { mode: "none", maxResets: 5 },
        { mode: "none", maxResets: 5, maxObservations: 20 },
      ],
      [
        { mode: "attached", maxObservations: 0 },
        { mode: "attached", maxResets: 2, maxObservations: 0 },
      ],
    ] as const)
      expect(
        wordpressCampaignConfigSchema.parse({ ...base, discovery: { lab } })
          .discovery.lab,
      ).toEqual(expected);
  });
});
