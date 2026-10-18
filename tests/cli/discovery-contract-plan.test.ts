import { describe, expect, it } from "vitest";

import { wordPressDiscoveryContractPlan } from "../../src/cli/wordpress.js";
import { WORDPRESS_DISCOVERY_PROMPTS } from "../../src/profiles/wordpress/prompts/index.js";

type Plan = ReturnType<typeof wordPressDiscoveryContractPlan>;

/**
 * What main@d9c840d produced per prompt id from its `coverageFor`,
 * `outputContractFor` and `objectiveOnly` id comparisons, with the entry
 * index off and on. The table must reproduce this exactly.
 */
const inline = (contract: Plan["contract"]): Record<"off" | "on", Plan> => ({
  off: { objectiveOnly: contract !== null, contract, coverage: false },
  on: { objectiveOnly: contract !== null, contract, coverage: false },
});
const coverageCapable = (
  contract: Plan["contract"],
): Record<"off" | "on", Plan> => ({
  off: { objectiveOnly: true, contract, coverage: false },
  on: { objectiveOnly: true, contract: "v3", coverage: true },
});
const MAIN_PLANS: Record<string, Record<"off" | "on", Plan>> = {
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
  "wp2shell-bounty-v5": coverageCapable("v2"),
  "wp2shell-bounty-v6": coverageCapable("v2"),
  "wp2shell-bounty-v7": inline("v2"),
  "wp2shell-bounty-v8": inline("v4"),
  "wp2shell-whitebox-v1.7": inline("v2"),
};

describe("wordPressDiscoveryContractPlan", () => {
  it("reproduces main's per-id contract selection for every table row", () => {
    expect(Object.keys(MAIN_PLANS).sort()).toEqual(
      WORDPRESS_DISCOVERY_PROMPTS.map((row) => row.id).sort(),
    );
    for (const row of WORDPRESS_DISCOVERY_PROMPTS) {
      expect(wordPressDiscoveryContractPlan(row.id, false)).toEqual(
        MAIN_PLANS[row.id]!.off,
      );
      expect(wordPressDiscoveryContractPlan(row.id, true)).toEqual(
        MAIN_PLANS[row.id]!.on,
      );
    }
  });

  it("rejects ids that are not in the table", () => {
    expect(() =>
      wordPressDiscoveryContractPlan("wp2shell-bounty-v9", false),
    ).toThrow("Unknown WordPress discovery prompt");
    expect(() =>
      wordPressDiscoveryContractPlan("trust-boundary-v1", false),
    ).toThrow("Unknown WordPress discovery prompt");
  });
});
