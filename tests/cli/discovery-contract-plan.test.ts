import { describe, expect, it } from "vitest";

import { wordPressDiscoveryContractPlan } from "../../src/cli/wordpress.js";
import { WORDPRESS_DISCOVERY_PROMPTS } from "../../src/profiles/wordpress/prompts/index.js";

type Plan = ReturnType<typeof wordPressDiscoveryContractPlan>;

/**
 * The v26-wide objective is objective-only and receives the v4 contract
 * (ADR 0038 addendum 15). The other rows moved to `history/prompts/` on
 * 2026-11-05.
 */
const inline = (contract: Plan["contract"]): Plan => ({
  objectiveOnly: contract !== null,
  contract,
});
const MAIN_PLANS: Record<string, Plan> = {
  "wp2shell-bounty-v26-wide": inline("v4"),
};

describe("wordPressDiscoveryContractPlan", () => {
  it("gives every table row its contract selection", () => {
    expect(Object.keys(MAIN_PLANS).sort()).toEqual(
      WORDPRESS_DISCOVERY_PROMPTS.map((row) => row.id).sort(),
    );
    for (const row of WORDPRESS_DISCOVERY_PROMPTS)
      expect(wordPressDiscoveryContractPlan(row.id)).toEqual(
        MAIN_PLANS[row.id]!,
      );
  });

  it("rejects ids that are not in the table", () => {
    expect(() =>
      wordPressDiscoveryContractPlan("wp2shell-bounty-v22-wide"),
    ).toThrow("Unknown WordPress discovery prompt");
    expect(() => wordPressDiscoveryContractPlan("wp2shell-bounty-v9")).toThrow(
      "Unknown WordPress discovery prompt",
    );
    expect(() => wordPressDiscoveryContractPlan("trust-boundary-v1")).toThrow(
      "Unknown WordPress discovery prompt",
    );
    expect(() => wordPressDiscoveryContractPlan("trust-boundary-v2")).toThrow(
      "Unknown WordPress discovery prompt",
    );
  });
});
