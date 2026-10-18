import { z } from "zod";

/**
 * The one place that builds and reads the WordPress.org Target identity
 * (`wporg:<slug>`) and reads the selection id the ledger carries
 * (`<targetId>@<version>`, built by the generic `targetSelectionId`).
 */
const PLUGIN_IDENTITY = /^wporg:([a-z0-9][a-z0-9-]*)$/;
const SELECTION_ID = /^wporg:([a-z0-9][a-z0-9-]*)@(.+)$/;

/** `wporg:<slug>` as a schema: the Target identity of a WordPress.org plugin. */
export const wordPressOrgPluginIdentitySchema = z
  .string()
  .regex(/^wporg:[a-z0-9][a-z0-9-]*$/);

export function wordPressOrgPluginIdentity(slug: string): string {
  return `wporg:${slug}`;
}

/** The plugin slug of a `wporg:` identity, or null for any other identity. */
export function parseWordPressOrgPluginIdentity(
  identity: string,
): string | null {
  return PLUGIN_IDENTITY.exec(identity)?.[1] ?? null;
}

/** The plugin slug and version of a selection id, or null when it is not one. */
export function parseWordPressOrgSelectionId(selectionId: string): {
  readonly slug: string;
  readonly version: string;
} | null {
  const matched = SELECTION_ID.exec(selectionId);
  return matched?.[1] && matched[2]
    ? { slug: matched[1], version: matched[2] }
    : null;
}
