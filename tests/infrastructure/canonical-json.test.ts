import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  canonicalDigest,
  canonicalDigestPreservingProperties,
  canonicalJson,
  canonicalJsonPreservingProperties,
} from "../../src/infrastructure/canonical-json.js";

describe("Canonical JSON", () => {
  it("preserves persisted bytes and identity regardless of object insertion order", () => {
    const values = [
      { z: [null, false, 0, "日本語"], a: { "2": 2, "10": 10 } },
      { a: { "10": 10, "2": 2 }, z: [null, false, 0, "日本語"] },
    ];

    for (const value of values) {
      expect(canonicalJson(value)).toBe(
        '{"a":{"10":10,"2":2},"z":[null,false,0,"日本語"]}',
      );
      expect(canonicalDigest(value)).toBe(
        "sha256:e980b8fee6642191c65505e1b03737cf3b428fd5b4ef48b01fc74429a04aaeb4",
      );
    }
  });

  it("keeps array order significant to the stored identity", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalDigest([2, 1])).not.toBe(canonicalDigest([1, 2]));
  });

  it("preserves JSON scalar encoding", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson('日本語\n"quoted"')).toBe('"日本語\\n\\"quoted\\""');
    expect(canonicalJson(-0)).toBe("0");
  });

  it("retains distinct persisted formats for keys affected by schema parsing", () => {
    const value: unknown = JSON.parse('{"__proto__":{"label":"value"},"a":1}');

    expect(canonicalJson(value)).toBe('{"a":1}');
    expect(canonicalJsonPreservingProperties(value)).toBe(
      '{"__proto__":{"label":"value"},"a":1}',
    );
    expect(canonicalDigestPreservingProperties(value)).not.toBe(
      canonicalDigest(value),
    );
  });

  it("preserves the acquisition input contract without broadening the parsed format", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(canonicalJsonPreservingProperties(date)).toBe("{}");
    expect(() => canonicalJson(date)).toThrow(ZodError);
    expect(() =>
      canonicalJsonPreservingProperties({ member: undefined }),
    ).toThrow(TypeError);
    expect(() => canonicalDigestPreservingProperties(Infinity)).toThrow(
      TypeError,
    );
  });

  it.each([
    { name: "undefined", value: undefined },
    { name: "undefined member", value: { member: undefined } },
    { name: "undefined array entry", value: [undefined] },
    { name: "non-finite number", value: { member: Infinity } },
    { name: "NaN", value: NaN },
    { name: "bigint", value: 1n },
    { name: "Date", value: new Date("2026-01-01T00:00:00Z") },
  ])("rejects $name before encoding or hashing", ({ value }) => {
    expect(() => canonicalJson(value)).toThrow(ZodError);
    expect(() => canonicalDigest(value)).toThrow(ZodError);
  });
});
