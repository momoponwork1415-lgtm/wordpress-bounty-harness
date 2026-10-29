import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  admittedStagedSkills,
  MAX_STAGED_SKILL_BYTES,
  MAX_STAGED_SKILL_FILE_BYTES,
  MAX_STAGED_SKILL_FILES,
  parseSkillDefinition,
  stageSkills,
} from "../../src/discovery/skill-definition.js";

// ADR 0043: a skill definition is front matter plus a body of whole
// paragraphs; the digest covers the whole file, so a changed body is a new
// version. The sandbox stages it where the agent CLI reads user skills.

const valid = [
  "---",
  "name: wbh-example",
  "description: Use when the example applies.",
  "---",
  "",
  "# wbh-example v1",
  "",
  "First paragraph.",
  "",
].join("\n");

describe("parseSkillDefinition", () => {
  it("parses the front matter, keeps the body and digests the whole file", () => {
    const definition = parseSkillDefinition(valid);
    expect(definition.frontMatter).toEqual({
      name: "wbh-example",
      description: "Use when the example applies.",
    });
    expect(definition.body).toBe("# wbh-example v1\n\nFirst paragraph.\n");
    expect(definition.text).toBe(valid);
    expect(definition.digest).toBe(
      `sha256:${createHash("sha256").update(valid).digest("hex")}`,
    );
  });

  it.each([
    ["no front matter", "First paragraph.\n"],
    [
      "a line without `key: value`",
      valid.replace("name: wbh-example", "name wbh-example"),
    ],
    [
      "a repeated key",
      valid.replace("name: wbh-example", "name: a\nname: wbh-example"),
    ],
    ["an unknown key", valid.replace("name: wbh-example", "name: a\nextra: y")],
    [
      "a missing description",
      valid.replace("description: Use when the example applies.\n", ""),
    ],
    ["a name with capitals", valid.replace("name: wbh-example", "name: Wbh")],
    ["a body that ends in a blank line", `${valid}\n`],
    ["an empty body", valid.split("---\n\n")[0] + "---\n\n"],
  ])("refuses %s", (_, text) => {
    expect(() => parseSkillDefinition(text)).toThrow();
  });
});

describe("staged skills", () => {
  it("admits a bounded list of uniquely named, non-empty files", () => {
    expect(admittedStagedSkills([])).toBe(true);
    expect(admittedStagedSkills([{ name: "wbh-recon", content: valid }])).toBe(
      true,
    );
    expect(
      admittedStagedSkills([
        { name: "wbh-recon", content: valid },
        { name: "wbh-recon", content: valid },
      ]),
    ).toBe(false);
    expect(admittedStagedSkills([{ name: "Recon", content: valid }])).toBe(
      false,
    );
    expect(admittedStagedSkills([{ name: "../x", content: valid }])).toBe(
      false,
    );
    expect(admittedStagedSkills([{ name: "wbh-recon", content: "" }])).toBe(
      false,
    );
    expect(
      admittedStagedSkills([
        { name: "wbh-recon", content: "x".repeat(MAX_STAGED_SKILL_BYTES + 1) },
      ]),
    ).toBe(false);
    expect(
      admittedStagedSkills(
        Array.from({ length: 9 }, (_, index) => ({
          name: `s${index}`,
          content: valid,
        })),
      ),
    ).toBe(false);
  });

  it("admits bounded, uniquely named supporting files beside SKILL.md (#687)", () => {
    const one = (files: { name: string; content: string | Uint8Array }[]) =>
      admittedStagedSkills([{ name: "wbh-tools", content: valid, files }]);
    expect(one([])).toBe(true);
    expect(
      one([
        { name: "list-v1.sh", content: "#!/bin/sh\n" },
        { name: "reference-v1.md", content: new Uint8Array([35, 10]) },
      ]),
    ).toBe(true);
    expect(one([{ name: "SKILL.md", content: "x" }])).toBe(false);
    expect(one([{ name: "../x", content: "x" }])).toBe(false);
    expect(one([{ name: "Upper.sh", content: "x" }])).toBe(false);
    expect(one([{ name: "a.sh", content: "" }])).toBe(false);
    expect(
      one([
        { name: "a.sh", content: "x" },
        { name: "a.sh", content: "y" },
      ]),
    ).toBe(false);
    expect(
      one(
        Array.from({ length: MAX_STAGED_SKILL_FILES + 1 }, (_, index) => ({
          name: `f${index}.md`,
          content: "x",
        })),
      ),
    ).toBe(false);
    expect(
      one([
        { name: "a.md", content: "x".repeat(MAX_STAGED_SKILL_FILE_BYTES) },
        { name: "b.md", content: "x" },
      ]),
    ).toBe(false);
  });

  it("writes each skill read-only at skills/<name>/SKILL.md under the home, scripts executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "skill-home-"));
    try {
      await stageSkills(home, [
        {
          name: "wbh-recon",
          content: valid,
          files: [
            { name: "list-v1.sh", content: "#!/bin/sh\necho\n" },
            { name: "reference-v1.md", content: "# ref\n" },
          ],
        },
      ]);
      const path = join(home, "skills", "wbh-recon", "SKILL.md");
      expect(await readFile(path, "utf8")).toBe(valid);
      expect((await stat(path)).mode & 0o777).toBe(0o400);
      const script = join(home, "skills", "wbh-recon", "list-v1.sh");
      expect((await stat(script)).mode & 0o777).toBe(0o500);
      expect(
        (await stat(join(home, "skills", "wbh-recon", "reference-v1.md")))
          .mode & 0o777,
      ).toBe(0o400);
      await expect(
        stageSkills(home, [{ name: "wbh-recon", content: valid }]),
      ).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
