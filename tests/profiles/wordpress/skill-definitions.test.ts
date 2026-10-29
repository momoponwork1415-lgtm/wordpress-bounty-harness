import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  loadWordPressDiscoverySkill,
  WORDPRESS_DISCOVERY_SKILL_IDS,
  WORDPRESS_DISCOVERY_SKILLS,
  WORDPRESS_LAUNCHABLE_DISCOVERY_SKILL_IDS,
  wordPressDiscoverySkillRecord,
} from "../../../src/profiles/wordpress/prompts/skills.js";

const skillsUrl = new URL(
  "../../../src/profiles/wordpress/prompts/skills/",
  import.meta.url,
);
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Agent-facing text (ADR 0043): pinned by digest, a procedure only, free of
// answer clues, target names, bug-type lists and judgment criteria.
const ANSWER_CLUES =
  /\bCVE(?:-\d+)?\b|\badvisor(?:y|ies)\b|\bPoC\b|\bpayload\b|<script\b|\bcurl\s+-|(?:past|previous)\s+(?:fix|patch)|TranslatePress|The Events Calendar|Smash Balloon|ThemePunch|revslider|wpforms|woocommerce|Tourfic|Groundhogg|rtMedia|Relevanssi|Brizy|Elementor/i;

describe("WordPress discovery skills", () => {
  it("pins every skill to its digest and names it in the front matter", async () => {
    for (const row of WORDPRESS_DISCOVERY_SKILLS) {
      const skill = await loadWordPressDiscoverySkill(row.id);
      const bytes = await readFile(new URL(`${row.id}/SKILL.md`, skillsUrl));
      expect(skill.digest).toBe(sha256(bytes));
      expect(skill.digest).toBe(row.digest);
      expect(skill.frontMatter.name).toBe(row.name);
      expect(row.id.startsWith(`${row.name}-v`)).toBe(true);
      expect(skill.body.startsWith(`# ${row.name} v`)).toBe(true);
      expect(skill.body.length).toBeGreaterThan(500);
      expect(Buffer.byteLength(skill.text, "utf8")).toBeLessThan(16_000);
      // Supporting files (#687): every file in the directory is pinned, by name and digest.
      const pinnedFiles =
        (row as { files?: readonly { name: string; digest: string }[] })
          .files ?? [];
      const inDirectory = (
        await readdir(new URL(`${row.id}/`, skillsUrl))
      ).sort();
      expect(inDirectory).toEqual(
        ["SKILL.md", ...pinnedFiles.map((file) => file.name)].sort(),
      );
      expect(skill.files.map((file) => file.name)).toEqual(
        pinnedFiles.map((file) => file.name),
      );
      for (const file of skill.files)
        expect(sha256(file.content)).toBe(
          pinnedFiles.find((pinned) => pinned.name === file.name)?.digest,
        );
    }
    const onDisk = (await readdir(skillsUrl, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(onDisk.sort()).toEqual([...WORDPRESS_DISCOVERY_SKILL_IDS].sort());
    expect(WORDPRESS_LAUNCHABLE_DISCOVERY_SKILL_IDS).toEqual([
      "wbh-recon-v1",
      "wbh-tools-v1",
    ]);
    const tools = wordPressDiscoverySkillRecord("wbh-tools-v1") as
      { files?: readonly unknown[] } | undefined;
    expect(tools?.files?.length).toBe(3);
    expect(wordPressDiscoverySkillRecord("wbh-recon-v1")?.name).toBe(
      "wbh-recon",
    );
    expect(wordPressDiscoverySkillRecord("wbh-other-v1")).toBeUndefined();
  });

  it("keeps every body a procedure: no answer clues, bug-type lists, criteria or Harness-fixed numbers", async () => {
    for (const row of WORDPRESS_DISCOVERY_SKILLS) {
      const { body, frontMatter } = await loadWordPressDiscoverySkill(row.id);
      expect(body).not.toMatch(ANSWER_CLUES);
      expect(body).not.toMatch(
        /\b(?:XSS|SQLi|SQL injection|RCE|LFI|SSRF|CSRF|IDOR)\b/,
      );
      expect(body).not.toMatch(/\bvulnerab/i);
      expect(body).not.toMatch(/\bexploit/i);
      expect(body).not.toMatch(/at least\s+\d+\s+(?:minutes?|hours?)/i);
      expect(body).not.toMatch(/\bREGISTRY\b/);
      expect(frontMatter.description).toMatch(/^Use /);
      // The map lives where every agent of the Trial can read it.
      expect(body).toContain("/workspace/research/recon-map.md");
    }
  });
});
