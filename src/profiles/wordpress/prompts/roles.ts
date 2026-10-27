import { readFile } from "node:fs/promises";

import {
  parseRoleDefinition,
  type RoleDefinition,
} from "../../../discovery/role-definition.js";

/**
 * The role definitions of a partitioned Trial (ADR 0042): one Markdown file
 * per role under `agents/`, pinned by digest like every agent-facing text.
 * The enumerator receives the tool files of `discovery/tools.ts` and returns
 * an inventory and a partition proposal; a tracer receives one partition and
 * the partition objective, and returns the contract's report.
 */
export const WORDPRESS_ROLES = ["enumerator", "tracer"] as const;
export type WordPressRole = (typeof WORDPRESS_ROLES)[number];

interface WordPressRoleDefinitionRecord {
  readonly id: string;
  readonly role: WordPressRole;
  readonly digest: `sha256:${string}`;
  /** Exactly one row per role is `current`. */
  readonly status: "current" | "archived";
}

export const WORDPRESS_ROLE_DEFINITIONS = [
  {
    id: "enumerator-v1",
    role: "enumerator",
    digest:
      "sha256:e51bc576cdfaea0bacb2ce5cf2af31f24cca6cf7fe34f39070248cedb419da54",
    status: "current",
  },
  {
    id: "tracer-v1",
    role: "tracer",
    digest:
      "sha256:139fcf12a971eef2d22644b2138e1611c04115931f4b572a13984132a5c4b392",
    status: "current",
  },
] as const satisfies readonly WordPressRoleDefinitionRecord[];

export type WordPressRoleDefinitionId =
  (typeof WORDPRESS_ROLE_DEFINITIONS)[number]["id"];

/** The current definition of each role. */
export const WORDPRESS_CURRENT_ROLE_DEFINITION_IDS = Object.fromEntries(
  WORDPRESS_ROLES.map((role) => {
    const current = WORDPRESS_ROLE_DEFINITIONS.filter(
      (row) => row.role === role && row.status === "current",
    );
    if (current.length !== 1)
      throw new Error("Exactly one role definition must be current");
    return [role, current[0]!.id];
  }),
) as Record<WordPressRole, WordPressRoleDefinitionId>;

export type WordPressRoleDefinition = RoleDefinition & {
  readonly id: WordPressRoleDefinitionId;
  readonly role: WordPressRole;
  readonly sourceUrl: URL;
};

/** Reads one role definition and checks it against its pinned digest and role. */
export async function loadWordPressRoleDefinition(
  id: WordPressRoleDefinitionId,
): Promise<WordPressRoleDefinition> {
  const record = WORDPRESS_ROLE_DEFINITIONS.find((row) => row.id === id);
  if (record === undefined)
    throw new Error("Unknown WordPress role definition");
  const sourceUrl = new URL(`./agents/${id}.md`, import.meta.url);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(sourceUrl),
  );
  const definition = parseRoleDefinition(text);
  if (definition.digest !== record.digest)
    throw new Error("Role definition differs from its pinned digest");
  if (definition.frontMatter.role !== record.role)
    throw new Error("Role definition names another role");
  return { ...definition, id, role: record.role, sourceUrl };
}
