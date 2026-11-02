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
      "wbh-tools-v1",
      "wbh-setup-v1",
      "wbh-recon-v3",
      "wbh-falsify-v2",
      "wbh-lab-v1",
    ]);
    expect(wordPressDiscoverySkillRecord("wbh-falsify-v1")?.status).toBe(
      "archived",
    );
    expect(wordPressDiscoverySkillRecord("wbh-recon-v1")?.status).toBe(
      "archived",
    );
    expect(wordPressDiscoverySkillRecord("wbh-recon-v2")?.status).toBe(
      "archived",
    );
    const tools = wordPressDiscoverySkillRecord("wbh-tools-v1") as
      { files?: readonly unknown[] } | undefined;
    expect(tools?.files?.length).toBe(3);
    expect(wordPressDiscoverySkillRecord("wbh-recon-v1")?.name).toBe(
      "wbh-recon",
    );
    expect(wordPressDiscoverySkillRecord("wbh-setup-v1")?.name).toBe(
      "wbh-setup",
    );
    expect(wordPressDiscoverySkillRecord("wbh-falsify-v1")?.name).toBe(
      "wbh-falsify",
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
      if (row.id === "wbh-recon-v2" || row.id === "wbh-recon-v3") {
        // #752: children start from the files, not from the parent's history.
        expect(body).toContain("without the parent's conversation");
      }
      if (row.id === "wbh-recon-v3") {
        // #714 / #686: the Trial closes on the research files, not on row counts.
        expect(body).toContain("## Step 9: closing");
        expect(body).toContain(
          "read a second time by an agent other than the one that wrote it",
        );
      }
      if (row.id === "wbh-falsify-v1" || row.id === "wbh-falsify-v2") {
        // #786: one assumptions table per unit, every "not found" row read
        // both ways, and prior leads taken first when the Trial states them.
        expect(body).toContain("/workspace/research/assumptions");
        expect(body).toContain("/workspace/research/traces");
        expect(body).toContain("Backward to every producer");
        expect(body).toContain("`## Prior leads` section");
        expect(frontMatter.description).toMatch(/^Use after the map exists/);
      }
      if (row.id === "wbh-falsify-v1") {
        expect(body).toContain("## Step 3: read the rows not found");
      }
      if (row.id === "wbh-falsify-v2") {
        // #791: every unit is walked entry by entry first, by another agent,
        // and the table starts from the walk file.
        expect(body).toContain("## Step 2: the walk");
        expect(body).toContain("/workspace/research/walks");
        expect(body).toContain("## Step 4: read the rows not found");
        expect(body).toContain(
          "The agent that writes the table is not the agent that walked the unit",
        );
      }
      if (row.id === "wbh-lab-v1") {
        // #793 E: a marked request through the site's ordinary use, Find for
        // the store, Trace for the functions, Observe for the read-back, one
        // record per use, and every open row the Lab can answer taken before
        // the final report.
        expect(body).toContain("/workspace/research/lab-facts.md");
        expect(body).toContain("/workspace/research/lab-traces/");
        expect(body).toContain("## Step 9: before the final report");
        expect(body).toContain("`## Lab` section");
        expect(body).toContain("an observation, not a confirmation");
        expect(frontMatter.description).toMatch(
          /^Use when the Trial has a Lab/,
        );
      }
      if (row.id === "wbh-setup-v1") {
        // #749: the setup record is the hand-over surface, and the skill
        // applies only to Trials whose `## Lab` section names a site.
        expect(body).toContain("/workspace/research/lab-setup.md");
        expect(body).toContain("`## Lab` section");
        expect(frontMatter.description).toMatch(
          /^Use when the Trial has a Lab/,
        );
      }
    }
  });
});
