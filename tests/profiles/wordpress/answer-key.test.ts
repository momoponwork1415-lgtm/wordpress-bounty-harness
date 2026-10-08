import { describe, expect, it } from "vitest";

import {
  parseWordPressAnswerKeys,
  wordpressAnswerKeySchema,
} from "../../../src/profiles/wordpress/answer-key.js";

const example = {
  schemaVersion: 1,
  caseId: "synthetic-case",
  cohort: "first-party",
  entryPoint: { kind: "ajax-action", action: "synthetic_action" },
  violatedProperty: "Synthetic property",
  missingCheck: "Synthetic check",
  attackerPosition: "subscriber",
  impact: "sqli",
  allowedLocations: [{ file: "includes/example.php", function: "example" }],
  publishedAt: "2026-01-02",
  modelCutoff: "2026-01-01",
};

describe("WordPress Answer Key v1", () => {
  it("admits the specified private evaluation fields and WordPress entry points", () => {
    for (const entryPoint of [
      { kind: "hook", hook: "synthetic_hook" },
      { kind: "route", route: "/synthetic/v1/example" },
      { kind: "ajax-action", action: "synthetic_action" },
    ]) {
      expect(
        wordpressAnswerKeySchema.safeParse({ ...example, entryPoint }).success,
      ).toBe(true);
    }
  });

  it("requires every scoring field and rejects extra or unsafe location data", () => {
    for (const field of Object.keys(example)) {
      const candidate: Record<string, unknown> = { ...example };
      delete candidate[field];
      expect(wordpressAnswerKeySchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      wordpressAnswerKeySchema.safeParse({ ...example, advisory: "private" })
        .success,
    ).toBe(false);
    expect(
      wordpressAnswerKeySchema.safeParse({
        ...example,
        allowedLocations: [{ file: "../outside.php" }],
      }).success,
    ).toBe(false);
  });

  it("reads a key file holding one key or several keys", () => {
    expect(parseWordPressAnswerKeys(example).map((key) => key.caseId)).toEqual([
      "synthetic-case",
    ]);
    expect(
      parseWordPressAnswerKeys([example, { ...example, caseId: "second" }]),
    ).toHaveLength(2);
    expect(() => parseWordPressAnswerKeys([])).toThrow();
  });
});
