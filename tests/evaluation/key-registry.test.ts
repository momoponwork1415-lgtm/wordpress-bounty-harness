import { describe, expect, it } from "vitest";

import { keyDigestManifestSchema } from "../../src/evaluation/key-registry.js";

const one = {
  caseId: "synthetic-case",
  digest: `sha256:${"a".repeat(64)}`,
};

describe("Answer Key digest manifest", () => {
  it("contains only case identities and private-key digest references", () => {
    expect(
      keyDigestManifestSchema.parse({ schemaVersion: 1, keys: [one] }),
    ).toMatchObject({ keys: [one] });
    expect(
      keyDigestManifestSchema.safeParse({
        schemaVersion: 1,
        keys: [{ ...one, cause: "private" }],
      }).success,
    ).toBe(false);
  });

  it("rejects repeated cases and invalid digests", () => {
    expect(
      keyDigestManifestSchema.safeParse({
        schemaVersion: 1,
        keys: [one, one],
      }).success,
    ).toBe(false);
    expect(
      keyDigestManifestSchema.safeParse({
        schemaVersion: 1,
        keys: [{ ...one, digest: "sha256:wrong" }],
      }).success,
    ).toBe(false);
  });
});
