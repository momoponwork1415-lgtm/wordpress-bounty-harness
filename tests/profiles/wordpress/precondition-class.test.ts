import { describe, expect, it } from "vitest";

import { classifyWordPressPrecondition } from "../../../src/profiles/wordpress/verification/precondition-class.js";

describe("Harness-owned WordPress precondition classification", () => {
  it("parks a password-protected block and a slider with a chosen placeholder", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "An administrator sets the block's Password protected visibility setting to password-protected.",
      }).preconditionClass,
    ).toBe("admin-configuration");
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "An administrator configures a published slider with button Link {author_name}.",
      }).preconditionClass,
    ).toBe("admin-configuration");
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "A public page contains a block and a trusted editor then restricts the synced pattern.",
      }).preconditionClass,
    ).toBe("admin-configuration");
  });

  it("keeps ordinary block placement distinct from a chosen setting", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "A public post contains a block.",
      }),
    ).toEqual({ preconditionClass: "common-usage" });
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "A public slider is published.",
      }).preconditionClass,
    ).toBe("common-usage");
  });

  it("does not treat a product name or a negated visibility requirement as an enabled setting", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "An administrator opens Password-Protected Showcase > Dashboard. Public content does not require password protection.",
      }).preconditionClass,
    ).toBe("unknown");
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "No password-protected post is required.",
      }).preconditionClass,
    ).toBe("unknown");
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "The post is not password-protected.",
      }).preconditionClass,
    ).toBe("unknown");
  });

  it("does not park negated or unnecessary password protection", () => {
    for (const configurationPrecondition of [
      "A non-password-protected post is published.",
      "A password-protected post is not required.",
      "Do not create a password-protected post.",
      "No password-protected page is needed.",
    ])
      expect(
        classifyWordPressPrecondition({ configurationPrecondition })
          .preconditionClass,
      ).not.toBe("admin-configuration");
  });

  it("does not park an absent placeholder or inactive visibility setting", () => {
    for (const configurationPrecondition of [
      "No placeholder value is needed for the public form.",
      "The password-protected visibility setting remains off.",
      "A block with no password-protected visibility setting is published.",
      "パスワード保護は不要。",
      "プレースホルダー値は不要。",
      "No non-default setting is required.",
      "The option is not explicitly enabled.",
      "No setting is enabled to expose the form.",
    ])
      expect(
        classifyWordPressPrecondition({ configurationPrecondition })
          .preconditionClass,
      ).not.toBe("admin-configuration");
  });

  it("still parks explicitly password-protected content", () => {
    for (const configurationPrecondition of [
      "An administrator publishes a password-protected post.",
      "A password-protected page is published.",
      "The post is password-protected.",
      "The page must be password-protected.",
      "A password-protected post must be published.",
    ])
      expect(
        classifyWordPressPrecondition({ configurationPrecondition })
          .preconditionClass,
      ).toBe("admin-configuration");
  });

  it("still identifies an administrator's explicit checkbox choice", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "An admin has ticked the Legacy Mode setting. A public page remains visible.",
      }).preconditionClass,
    ).toBe("admin-configuration");
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "The placeholder value is set to {visitor_name}.",
      }).preconditionClass,
    ).toBe("admin-configuration");
  });

  it("names no Lab scenario for ordinary content now that scenarios are removed (#353)", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "A private post is missing.",
      }),
    ).toEqual({ preconditionClass: "unknown" });
  });

  it("preserves the TranslatePress default Finding and uses the attachment as an input", () => {
    expect(
      classifyWordPressPrecondition({ configurationPrecondition: "default" }),
    ).toEqual({ preconditionClass: "default" });
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "default",
        attachmentPrecondition:
          "The administrator selects Password protected visibility for the block.",
      }).preconditionClass,
    ).toBe("admin-configuration");
  });

  it("keeps undecidable claims for review", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "An external dependency must be available.",
      }).preconditionClass,
    ).toBe("unknown");
  });
});
