import { describe, expect, it } from "vitest";

import { classifyWordPressPrecondition } from "../../../src/profiles/wordpress/verification/precondition-class.js";

describe("Harness-owned WordPress precondition classification", () => {
  it("parks a password-protected block and a slider with a chosen placeholder", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition:
          "An administrator publishes a block with the editor's Password protected visibility setting.",
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
    ).toEqual({
      preconditionClass: "common-usage",
      reasonCode: "common-usage-scenario-missing",
    });
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "A public slider is published.",
      }).preconditionClass,
    ).toBe("common-usage");
  });

  it("selects an existing generic scenario for ordinary content", () => {
    expect(
      classifyWordPressPrecondition({
        configurationPrecondition: "A private post is missing.",
      }),
    ).toMatchObject({
      preconditionClass: "common-usage",
      nextScenarioId: "private-post-v1",
    });
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
