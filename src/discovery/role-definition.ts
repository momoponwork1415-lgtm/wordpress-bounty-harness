import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * A role definition is the Markdown a partitioned Trial hands to one agent
 * (design 2026-10-27 §3): a short front matter that names the role and the
 * shape of its output, then the body the agent reads. The Harness keeps the
 * definition's digest apart from the per-Trial assignment it also records,
 * so a changed body is a new version, as with every agent-facing text.
 *
 * The front matter is `key: value` lines between two `---` lines; no YAML
 * parser, so there is nothing to mis-parse. The body is whole paragraphs.
 */
export const roleDefinitionFrontMatterSchema = z.strictObject({
  /** The role the body defines, as the profile names it. */
  role: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  version: z.number().int().positive(),
  /** The output shape the Harness validates the agent's report against. */
  output: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
});
export type RoleDefinitionFrontMatter = z.infer<
  typeof roleDefinitionFrontMatterSchema
>;

export type RoleDefinition = {
  readonly frontMatter: RoleDefinitionFrontMatter;
  /** The Markdown after the front matter, as the agent receives it. */
  readonly body: string;
  /** sha256 of the whole file, front matter included. */
  readonly digest: `sha256:${string}`;
};

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n\n([\s\S]+)$/;

/** Parses one role definition file; any deviation from the shape is an error. */
export function parseRoleDefinition(text: string): RoleDefinition {
  const match = FRONT_MATTER.exec(text);
  if (match === null)
    throw new Error("A role definition starts with front matter");
  const [, head, body] = match;
  const raw: Record<string, string | number> = {};
  for (const line of head!.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new Error("A front matter line is `key: value`");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (key in raw) throw new Error("A front matter key appears once");
    raw[key] = /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  }
  const frontMatter = roleDefinitionFrontMatterSchema.parse(raw);
  if (!/^\S[\s\S]*\S\n$/.test(body!) || body!.endsWith("\n\n"))
    throw new Error("A role definition body holds whole paragraphs");
  return {
    frontMatter,
    body: body!,
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
}
