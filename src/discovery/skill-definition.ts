import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

/**
 * A skill definition is a `SKILL.md` the Harness stages into the agent CLI's
 * own home before a Trial starts (ADR 0043): a front matter of `name` and
 * `description`, which both Codex and Claude Code list to the model, then
 * the procedure the agent reads when it invokes the skill. The Harness pins
 * each definition by the digest of the whole file, as it does every other
 * agent-facing text, and records which definitions a Trial received.
 *
 * The front matter is `key: value` lines between two `---` lines, like a
 * role definition; the body is whole paragraphs.
 */
export const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export const skillDefinitionFrontMatterSchema = z.strictObject({
  /** The name the CLI lists and the agent invokes; also the staged directory. */
  name: z.string().regex(SKILL_NAME),
  /** One line the CLI shows beside the name, so the agent knows when to use it. */
  description: z.string().min(1).max(1024),
});
export type SkillDefinitionFrontMatter = z.infer<
  typeof skillDefinitionFrontMatterSchema
>;

export type SkillDefinition = {
  readonly frontMatter: SkillDefinitionFrontMatter;
  /** The Markdown after the front matter. */
  readonly body: string;
  /** The whole file, as staged. */
  readonly text: string;
  /** sha256 of the whole file, front matter included. */
  readonly digest: `sha256:${string}`;
};

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n\n([\s\S]+)$/;

/** Parses one skill definition file; any deviation from the shape is an error. */
export function parseSkillDefinition(text: string): SkillDefinition {
  const match = FRONT_MATTER.exec(text);
  if (match === null)
    throw new Error("A skill definition starts with front matter");
  const [, head, body] = match;
  const raw: Record<string, string> = {};
  for (const line of head!.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new Error("A front matter line is `key: value`");
    const key = line.slice(0, separator);
    if (key in raw) throw new Error("A front matter key appears once");
    raw[key] = line.slice(separator + 2);
  }
  const frontMatter = skillDefinitionFrontMatterSchema.parse(raw);
  if (!/^\S[\s\S]*\S\n$/.test(body!) || body!.endsWith("\n\n"))
    throw new Error("A skill definition body holds whole paragraphs");
  return {
    frontMatter,
    body: body!,
    text,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}

/**
 * A supporting file staged beside `SKILL.md` (#687): a script or a reference
 * the procedure names. It lives in the skill directory only; the Harness
 * neither runs it nor reads its output.
 */
export type StagedSkillFile = {
  readonly name: string;
  readonly content: string | Uint8Array;
};

/** A skill as the sandbox receives it: the staged directory name and the files. */
export type StagedSkill = {
  readonly name: string;
  readonly content: string;
  readonly files?: readonly StagedSkillFile[];
};

/** The most skills one Trial may receive. */
export const MAX_STAGED_SKILLS = 8;
/** The largest skill file the sandbox stages. */
export const MAX_STAGED_SKILL_BYTES = 32 * 1024;
/** The most supporting files one skill may carry. */
export const MAX_STAGED_SKILL_FILES = 16;
/** The largest total of one skill's supporting files. */
export const MAX_STAGED_SKILL_FILE_BYTES = 1024 * 1024;
/** A supporting file name: one path segment, no leading dot, never `SKILL.md`. */
export const SKILL_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function byteLength(content: string | Uint8Array): number {
  return typeof content === "string"
    ? Buffer.byteLength(content)
    : content.byteLength;
}

/** Whether one skill's supporting files are bounded, uniquely named, non-empty. */
export function admittedSkillFiles(files: readonly StagedSkillFile[]): boolean {
  if (files.length > MAX_STAGED_SKILL_FILES) return false;
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (
      !SKILL_FILE_NAME.test(file.name) ||
      file.name === "SKILL.md" ||
      names.has(file.name)
    )
      return false;
    names.add(file.name);
    const size = byteLength(file.content);
    if (size <= 0) return false;
    total += size;
    if (total > MAX_STAGED_SKILL_FILE_BYTES) return false;
  }
  return true;
}

/** Whether a sandbox may stage these skills: bounded, uniquely named, non-empty. */
export function admittedStagedSkills(skills: readonly StagedSkill[]): boolean {
  if (skills.length > MAX_STAGED_SKILLS) return false;
  const names = new Set<string>();
  for (const skill of skills) {
    if (!SKILL_NAME.test(skill.name) || names.has(skill.name)) return false;
    names.add(skill.name);
    const size =
      typeof skill.content === "string" ? Buffer.byteLength(skill.content) : -1;
    if (size <= 0 || size > MAX_STAGED_SKILL_BYTES) return false;
    if (skill.files !== undefined && !admittedSkillFiles(skill.files))
      return false;
  }
  return true;
}

/**
 * Writes each skill at `<home>/skills/<name>/SKILL.md`, the layout both Codex
 * (`CODEX_HOME`) and Claude Code (`CLAUDE_CONFIG_DIR`) read user skills from.
 * Supporting files go beside it; a `.sh` file is executable, everything else
 * is read-only.
 */
export async function stageSkills(
  home: string,
  skills: readonly StagedSkill[],
): Promise<void> {
  for (const skill of skills) {
    const directory = join(home, "skills", skill.name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "SKILL.md"), skill.content, {
      flag: "wx",
      mode: 0o400,
    });
    for (const file of skill.files ?? []) {
      await writeFile(join(directory, file.name), file.content, {
        flag: "wx",
        mode: file.name.endsWith(".sh") ? 0o500 : 0o400,
      });
    }
  }
}
