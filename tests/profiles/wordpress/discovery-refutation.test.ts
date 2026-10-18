import { describe, expect, it } from "vitest";

import {
  wordPressRefutationOutputContract,
  wordPressRefutationSchema,
} from "../../../src/profiles/wordpress/discovery/refutation.js";

describe("source-only refutation contract", () => {
  const report = {
    verdict: "undecided",
    reasonCode: "unknown",
    sourceTrace: [{ file: "plugin.php", function: "entry", line: 4 }],
    note: "Source cannot settle this claim",
  };

  it("accepts only the bounded three-way opinion", () => {
    expect(wordPressRefutationSchema.safeParse(report).success).toBe(true);
    expect(
      wordPressRefutationSchema.safeParse({
        ...report,
        verdict: "runtime-confirmed",
      }).success,
    ).toBe(false);
    expect(
      wordPressRefutationSchema.safeParse({
        ...report,
        note: "x".repeat(1001),
      }).success,
    ).toBe(false);
    expect(
      wordPressRefutationSchema.safeParse({
        ...report,
        findings: [],
      }).success,
    ).toBe(false);
  });

  it("derives a stable contract from the admitted schema", () => {
    const contract = wordPressRefutationOutputContract();
    expect(contract.digest).toMatch(/^sha256:/);
    expect(contract.text).toContain("guard-effective");
    expect(contract.text).toContain("undecided");
  });
});
