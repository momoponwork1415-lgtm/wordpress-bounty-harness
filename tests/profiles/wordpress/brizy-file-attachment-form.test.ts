import { describe, expect, it, vi } from "vitest";

import type { Resources } from "../../../src/profiles/wordpress/lab/index.js";
import {
  assertBrizyFileAttachmentFormTarget,
  seedBrizyFileAttachmentForm,
} from "../../../src/profiles/wordpress/lab/brizy-file-attachment-form.js";

const resource = {} as Resources;

describe("ordinary public file-attachment form Lab adapter", () => {
  it("does not seed a form when the scenario is absent", async () => {
    const wp = vi.fn();
    await seedBrizyFileAttachmentForm({
      fileAttachmentForm: false,
      targetSlug: "another-plugin",
      resource,
      wp,
    });
    expect(wp).not.toHaveBeenCalled();
  });

  it("fails closed for a target without a form adapter", async () => {
    const wp = vi.fn();
    expect(() =>
      assertBrizyFileAttachmentFormTarget(true, "another-plugin"),
    ).toThrow("No file-attachment-form Lab adapter for this target");
    await expect(
      seedBrizyFileAttachmentForm({
        fileAttachmentForm: true,
        targetSlug: "another-plugin",
        resource,
        wp,
      }),
    ).rejects.toThrow("No file-attachment-form Lab adapter for this target");
    expect(wp).not.toHaveBeenCalled();
  });

  it("seeds an ordinary public form with harmless email and attachment fields", async () => {
    const wp = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await seedBrizyFileAttachmentForm({
      fileAttachmentForm: true,
      targetSlug: "brizy",
      resource,
      wp,
    });
    expect(wp).toHaveBeenCalledTimes(1);
    const args = wp.mock.calls[0]?.[1] as readonly string[];
    expect(args[0]).toBe("eval");
    expect(args[1]).toContain("Brizy_Editor_Forms_FormManager");
    expect(args[1]).toContain("Brizy_Editor_Forms_WordpressIntegration");
    expect(args[1]).toContain("setCompleted(false)");
    expect(args[1]).toContain('type="email"');
    expect(args[1]).toContain('type="file"');
    expect(args[1]).toContain("FileUpload");
    expect(args[1]).toContain(
      "$editor->setCompiledSections($manager->asJson())",
    );
    expect(args[1]).toContain("Public attachment form was not saved");
    expect(args[1]).not.toContain("wp_set_password");
  });
});
