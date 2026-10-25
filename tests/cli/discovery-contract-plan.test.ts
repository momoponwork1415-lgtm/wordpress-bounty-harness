import { describe, expect, it } from "vitest";

import { wordPressDiscoveryContractPlan } from "../../src/cli/wordpress.js";
import { WORDPRESS_DISCOVERY_PROMPTS } from "../../src/profiles/wordpress/prompts/index.js";

type Plan = ReturnType<typeof wordPressDiscoveryContractPlan>;

/**
 * What main@d9c840d produced per prompt id from its `outputContractFor` and
 * `objectiveOnly` id comparisons with the entry index off. The index and its
 * coverage contract (v3) were deleted (ADR 0034), so the "index on" column is
 * gone; v5 / v6 keep the v2 contract they received without the index.
 */
const inline = (contract: Plan["contract"]): Plan => ({
  objectiveOnly: contract !== null,
  contract,
});
const MAIN_PLANS: Record<string, Plan> = {
  "wp2shell-derived-v1": inline(null),
  "short-objective-v1": inline(null),
  "wp2shell-derived-v2": inline(null),
  "short-objective-v2": inline(null),
  "short-objective-managed-v1": inline(null),
  "short-objective-managed-v2": inline(null),
  "short-objective-managed-v3": inline(null),
  "short-objective-managed-v4": inline(null),
  "short-objective-managed-v5": inline("v1"),
  "screening-v1": inline("v1"),
  "wp2shell-single-http-v2": inline(null),
  "wp2shell-bounty-v1": inline(null),
  "wp2shell-bounty-v2": inline(null),
  "wp2shell-bounty-v3": inline("v2"),
  "wp2shell-bounty-v4": inline("v2"),
  "wp2shell-bounty-v5": inline("v2"),
  "wp2shell-bounty-v6": inline("v2"),
  "wp2shell-bounty-v7": inline("v2"),
  "wp2shell-bounty-v8": inline("v4"),
  "wp2shell-bounty-v10": inline("v4"),
  "wp2shell-bounty-v10-wide": inline("v4"),
  "wp2shell-bounty-v11-wide": inline("v4"),
  "wp2shell-whitebox-v1.7": inline("v2"),
};

describe("wordPressDiscoveryContractPlan", () => {
  it("reproduces main's per-id contract selection for every table row", () => {
    expect(Object.keys(MAIN_PLANS).sort()).toEqual(
      WORDPRESS_DISCOVERY_PROMPTS.map((row) => row.id).sort(),
    );
    for (const row of WORDPRESS_DISCOVERY_PROMPTS)
      expect(wordPressDiscoveryContractPlan(row.id)).toEqual(
        MAIN_PLANS[row.id]!,
      );
  });

  it("rejects ids that are not in the table", () => {
    expect(() => wordPressDiscoveryContractPlan("wp2shell-bounty-v9")).toThrow(
      "Unknown WordPress discovery prompt",
    );
    expect(() => wordPressDiscoveryContractPlan("trust-boundary-v1")).toThrow(
      "Unknown WordPress discovery prompt",
    );
  });
});
