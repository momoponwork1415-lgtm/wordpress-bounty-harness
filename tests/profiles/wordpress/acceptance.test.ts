import { expect, it } from "vitest";

import {
  loadWordPressAcceptanceCriteria,
  loadWordPressReproductionTemplate,
} from "../../../src/profiles/wordpress/acceptance/index.js";

it("loads three versioned and digest-pinned criteria from the WordPress profile", async () => {
  for (const [category, expected] of [
    ["stored-xss", ["JavaScript", "サイト全体"]],
    ["sqli", ["canary", "wp_magic_quotes"]],
    ["account-takeover", ["管理者", "認証状態"]],
  ] as const) {
    const asset = await loadWordPressAcceptanceCriteria(category);
    expect(asset).not.toBeNull();
    if (asset === null) continue;
    expect(asset.id).toBe(`${category}-v1`);
    expect(asset.version).toBe(1);
    expect(asset.category).toBe(category);
    expect(asset.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(asset.judgeSuccessCriterion).toContain(expected[0]);
    expect(asset.programmeCriteria.wordfence.length).toBeGreaterThan(0);
    expect(asset.programmeCriteria.patchstack.length).toBeGreaterThan(0);
    expect(asset.text).toContain(expected[1]);
    expect(asset.text).toContain("docs/SPEC.md");
  }
});

it("keeps unsupported categories outside the initial acceptance registry", async () => {
  expect(await loadWordPressAcceptanceCriteria("rce")).toBeNull();
  expect(await loadWordPressAcceptanceCriteria("reflected-xss")).toBeNull();
});

it("loads one digest-pinned template with the fixed human reading order", async () => {
  const template = await loadWordPressReproductionTemplate();
  expect(template.id).toBe("reproduction-package-v1");
  expect(template.version).toBe(1);
  expect(template.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(template.sections.map((section) => section.id)).toEqual([
    "acceptance",
    "observation",
    "negative-control",
    "steps",
  ]);
  expect(template.text).toContain("harness-captured");
  expect(template.text).toContain("agent-authored");
});
