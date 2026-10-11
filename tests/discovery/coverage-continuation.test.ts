import { describe, expect, it } from "vitest";

import {
  decideCoverageContinuation,
  renderCoverageContinuation,
} from "../../src/discovery/coverage-continuation.js";

const base = {
  entries: ["entry one", "entry two"],
  examined: "entry one",
  unexamined: "",
  elapsedMs: 60_000,
  remainingMs: 29 * 60_000,
  minimumMs: 30 * 60_000,
  injectionsSoFar: 0,
};

describe("coverage continuation", () => {
  it("returns only identifiers missing from both coverage fields", () => {
    const decision = decideCoverageContinuation(base);
    expect(decision).toMatchObject({
      injected: true,
      mode: "thread-resume",
      reason: "coverage-incomplete",
      remainingMinutes: 29,
      entriesHandedBack: 1,
      remainingEntries: ["entry two"],
    });
    expect(
      renderCoverageContinuation(
        "{remainingMinutes} minutes\n{entriesNotCovered}",
        decision,
      ),
    ).toBe("29 minutes\nentry two");
  });

  it("does not inject after the wall floor, on full coverage, or a second time", () => {
    expect(
      decideCoverageContinuation({ ...base, elapsedMs: 30 * 60_000 }),
    ).toMatchObject({ injected: false, reason: "wall-floor-reached" });
    expect(
      decideCoverageContinuation({
        ...base,
        unexamined: "entry two: no reachable route",
      }),
    ).toMatchObject({ injected: false, reason: "coverage-complete" });
    expect(
      decideCoverageContinuation({
        ...base,
        unexamined: "- entry two",
      }),
    ).toMatchObject({ injected: true, reason: "coverage-incomplete" });
    expect(
      decideCoverageContinuation({ ...base, injectionsSoFar: 1 }),
    ).toMatchObject({ injected: false, reason: "already-injected" });
    expect(
      decideCoverageContinuation({ ...base, remainingMs: 0 }),
    ).toMatchObject({ injected: false, reason: "deadline-reached" });
  });

  it("does not mistake an entry on line 10 for the entry on line 1", () => {
    expect(
      decideCoverageContinuation({
        ...base,
        entries: ["hook handler route.php:1"],
        examined: "hook handler route.php:10",
        unexamined: "",
      }),
    ).toMatchObject({
      injected: true,
      entriesHandedBack: 1,
    });
  });
});
