import { describe, expect, it } from "vitest";

import { assertInitialContinuousInventory } from "../../src/cli/continuous-preflight.js";

describe("continuous parent admission", () => {
  const firstPage = {
    source: {
      status: "available" as const,
      requestedListingCoverage: "all-observed" as const,
    },
    sourcePoolSealed: true,
    sourceCoverageVerified: false,
  };

  it("accepts a sealed first page without requiring the final page", () => {
    expect(() => assertInitialContinuousInventory(firstPage)).not.toThrow();
  });

  it("rejects unavailable, partial-listing, or unsealed source data", () => {
    expect(() =>
      assertInitialContinuousInventory({
        ...firstPage,
        source: { ...firstPage.source, status: "unavailable" },
      }),
    ).toThrow("unverified");
    expect(() =>
      assertInitialContinuousInventory({
        ...firstPage,
        source: {
          ...firstPage.source,
          requestedListingCoverage: "partial",
        },
      }),
    ).toThrow("unverified");
    expect(() =>
      assertInitialContinuousInventory({
        ...firstPage,
        sourcePoolSealed: false,
      }),
    ).toThrow("unverified");
  });
});
