import { describe, expect, it, vi } from "vitest";

import type { Resources } from "../../../src/profiles/wordpress/lab/index.js";
import {
  assertBrizyBuilderPageTarget,
  seedBrizyBuilderPage,
} from "../../../src/profiles/wordpress/lab/brizy-builder-page.js";

const resource = {} as Resources;

describe("ordinary builder-page Lab adapter", () => {
  it("does not seed a page when the scenario is absent", async () => {
    const wp = vi.fn();
    await seedBrizyBuilderPage({
      builderPage: false,
      targetSlug: "another-plugin",
      resource,
      wp,
    });
    expect(wp).not.toHaveBeenCalled();
  });

  it("fails closed for a target without a builder adapter", async () => {
    const wp = vi.fn();
    expect(() => assertBrizyBuilderPageTarget(true, "another-plugin")).toThrow(
      "No builder-page Lab adapter for this target",
    );
    await expect(
      seedBrizyBuilderPage({
        builderPage: true,
        targetSlug: "another-plugin",
        resource,
        wp,
      }),
    ).rejects.toThrow("No builder-page Lab adapter for this target");
    expect(wp).not.toHaveBeenCalled();
  });

  it("uses the plugin's normal editor enable flow for a published page", async () => {
    const wp = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await seedBrizyBuilderPage({
      builderPage: true,
      targetSlug: "brizy",
      resource,
      wp,
    });
    expect(wp).toHaveBeenCalledTimes(1);
    const args = wp.mock.calls[0]?.[1] as readonly string[];
    expect(args[0]).toBe("eval");
    expect(args[1]).toContain('"post_status"=>"publish"');
    expect(args[1]).toContain('"post_type"=>"page"');
    expect(args[1]).toContain("$editor->enable_editor()");
    expect(args[1]).toContain(
      "$editor->set_template(Brizy_Config::BRIZY_BLANK_TEMPLATE_FILE_NAME)",
    );
    expect(args[1]).toContain("$editor->getCompiledSectionManager()");
    expect(args[1]).toContain(
      "$editor->setCompiledSections($manager->asJson())",
    );
    expect(args[1]).toContain("An ordinary page created for the Lab.");
    expect(args[1]).toContain("$editor->set_needs_compile(false)");
    expect(args[1]).toContain("$editor->saveStorage()");
    expect(args[1]).toContain("Brizy_Editor_Entity::isBrizyEnabled($id)");
  });
});
