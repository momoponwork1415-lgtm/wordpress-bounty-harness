import { describe, expect, it } from "vitest";

import {
  assessWordpressScope,
  createWordpressScopeEvaluator,
  loadWordpressScopePolicy,
} from "../../../src/profiles/wordpress/scope-policy.js";

const policy = await loadWordpressScopePolicy();
const base = {
  category: "sqli" as const,
  attacker: "subscriber" as const,
  activeInstalls: 1_000,
  wordpressOrgListed: true,
  premium: false,
  latestVersionVerified: true,
  defaultOrCommonSettings: true,
  observations: ["canary-row-access"],
};

describe("WordPress programme scope policy", () => {
  it("evaluates Wordfence and Patchstack exactly once from the dated policy", () => {
    const result = assessWordpressScope(policy, base);
    expect(result.map(({ programme, status }) => [programme, status])).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "in-scope"],
    ]);
    expect(policy.observedAt).toBe("2026-10-08");
  });

  it("provides the review module's programme evaluator", async () => {
    const evaluator = createWordpressScopeEvaluator(policy);
    expect(
      (
        await evaluator.assess({
          ref: {
            campaignId: "c",
            findingId: "f",
            verificationId: "v",
            snapshotDigest: `sha256:${"a".repeat(64)}`,
          },
          facts: base,
        })
      ).map(({ programmeId, status }) => [programmeId, status]),
    ).toEqual([
      ["wordfence", "in-scope"],
      ["patchstack", "in-scope"],
    ]);
  });

  it("keeps programme differences and proof conditions separate", () => {
    expect(
      assessWordpressScope(policy, {
        ...base,
        category: "reflected-xss",
        observations: ["javascript-executed", "nonce-free"],
      }).map(({ status }) => status),
    ).toEqual(["out-of-scope", "in-scope"]);
    expect(
      assessWordpressScope(policy, {
        ...base,
        category: "lfi",
      })[1]?.status,
    ).toBe("ambiguous");
  });

  it("applies installation and CVSS gates without promoting unknown facts", () => {
    expect(
      assessWordpressScope(policy, {
        ...base,
        activeInstalls: 500,
        cvssScore: 8.4,
      }).map(({ status }) => status),
    ).toEqual(["in-scope", "out-of-scope"]);
    expect(
      assessWordpressScope(policy, {
        ...base,
        activeInstalls: 500,
      })[1]?.status,
    ).toBe("ambiguous");
    expect(
      assessWordpressScope(policy, {
        ...base,
        activeInstalls: 99,
        cvssScore: 10,
      })[1]?.status,
    ).toBe("out-of-scope");
  });

  it("classifies a consequential authorization flaw by its reached impact", () => {
    expect(
      assessWordpressScope(policy, {
        ...base,
        category: "missing-authz",
      }).map(({ status }) => status),
    ).toEqual(["out-of-scope", "out-of-scope"]);
    expect(
      assessWordpressScope(policy, {
        ...base,
        category: "options-update",
        activeInstalls: 50,
        observations: ["option-canary-changed", "significant-option-changed"],
        cvssScore: 9,
      }).map(({ status }) => status),
    ).toEqual(["in-scope", "out-of-scope"]);
  });
});
