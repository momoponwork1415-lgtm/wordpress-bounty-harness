import { readFile } from "node:fs/promises";

import {
  parseSkillDefinition,
  type SkillDefinition,
} from "../../../discovery/skill-definition.js";

/**
 * The exploration skills a cooperative Trial may receive (ADR 0043): one
 * `SKILL.md` per id under `skills/<id>/`, staged into the agent CLI's home
 * so the CLI lists it to the Root and its children. A campaign names the ids
 * in `discovery.skills`; absent, no skill is staged and the Trial is the one
 * every earlier decision describes. Each file is pinned by digest like every
 * agent-facing text; a changed body is a new id, and the old one stays
 * `archived` so past Trials can be read back.
 */
interface WordPressDiscoverySkillRecord {
  readonly id: string;
  /** The front matter `name`: what the CLI lists and the agent invokes. */
  readonly name: string;
  readonly digest: `sha256:${string}`;
  /** `current` rows may be named by a new campaign; `archived` rows are read back only. */
  readonly status: "current" | "archived";
}

export const WORDPRESS_DISCOVERY_SKILLS = [
  {
    id: "wbh-recon-v1",
    name: "wbh-recon",
    digest:
      "sha256:ef7658be5403ac69e5ae76c8a41c5d157f65f4b453507e4ed36416856798a52e",
    status: "current",
  },
] as const satisfies readonly WordPressDiscoverySkillRecord[];

export type WordPressDiscoverySkillId =
  (typeof WORDPRESS_DISCOVERY_SKILLS)[number]["id"];

export const WORDPRESS_DISCOVERY_SKILL_IDS = WORDPRESS_DISCOVERY_SKILLS.map(
  (row) => row.id,
);

/** The ids a new campaign may name. */
export const WORDPRESS_LAUNCHABLE_DISCOVERY_SKILL_IDS =
  WORDPRESS_DISCOVERY_SKILLS.flatMap((row: WordPressDiscoverySkillRecord) =>
    row.status === "archived" ? [] : [row.id as WordPressDiscoverySkillId],
  );

export type WordPressDiscoverySkill = SkillDefinition & {
  readonly id: WordPressDiscoverySkillId;
  readonly sourceUrl: URL;
};

export function wordPressDiscoverySkillRecord(
  id: string,
): (typeof WORDPRESS_DISCOVERY_SKILLS)[number] | undefined {
  return WORDPRESS_DISCOVERY_SKILLS.find((row) => row.id === id);
}

/** Reads one skill and checks it against its pinned digest and name. */
export async function loadWordPressDiscoverySkill(
  id: WordPressDiscoverySkillId,
): Promise<WordPressDiscoverySkill> {
  const record = wordPressDiscoverySkillRecord(id);
  if (record === undefined)
    throw new Error("Unknown WordPress discovery skill");
  const sourceUrl = new URL(`./skills/${id}/SKILL.md`, import.meta.url);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(sourceUrl),
  );
  const definition = parseSkillDefinition(text);
  if (definition.digest !== record.digest)
    throw new Error("Skill definition differs from its pinned digest");
  if (definition.frontMatter.name !== record.name)
    throw new Error("Skill definition names another skill");
  return { ...definition, id, sourceUrl };
}
