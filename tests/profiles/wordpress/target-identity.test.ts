import { describe, expect, it } from "vitest";

import { targetSelectionId } from "../../../src/selection/index.js";
import {
  parseWordPressOrgPluginIdentity,
  parseWordPressOrgSelectionId,
  wordPressOrgPluginIdentity,
  wordPressOrgPluginIdentitySchema,
} from "../../../src/profiles/wordpress/target-identity.js";

describe("WordPress.org Target identity", () => {
  it("builds the byte-identical strings the ledger already carries", () => {
    expect(wordPressOrgPluginIdentity("translatepress-multilingual")).toBe(
      "wporg:translatepress-multilingual",
    );
    expect(
      targetSelectionId({
        targetId: wordPressOrgPluginIdentity("akismet"),
        version: "5.3.1",
      }),
    ).toBe("wporg:akismet@5.3.1");
  });

  it("reads the slug and version back and rejects anything else", () => {
    expect(parseWordPressOrgPluginIdentity("wporg:akismet")).toBe("akismet");
    expect(parseWordPressOrgPluginIdentity("wporg:akismet@5.3.1")).toBeNull();
    expect(parseWordPressOrgPluginIdentity("wordpress-core")).toBeNull();
    expect(parseWordPressOrgPluginIdentity("wporg:-bad")).toBeNull();
    expect(parseWordPressOrgSelectionId("wporg:akismet@5.3.1-beta.1")).toEqual({
      slug: "akismet",
      version: "5.3.1-beta.1",
    });
    expect(parseWordPressOrgSelectionId("wporg:akismet")).toBeNull();
    expect(parseWordPressOrgSelectionId("wporg:akismet@")).toBeNull();
    expect(parseWordPressOrgSelectionId("premium:v/p@1")).toBeNull();
  });

  it("validates the identity with one schema", () => {
    expect(
      wordPressOrgPluginIdentitySchema.safeParse("wporg:a1-b").success,
    ).toBe(true);
    expect(wordPressOrgPluginIdentitySchema.safeParse("wporg:A").success).toBe(
      false,
    );
    expect(
      wordPressOrgPluginIdentitySchema.safeParse("wporg:a@1").success,
    ).toBe(false);
  });
});
