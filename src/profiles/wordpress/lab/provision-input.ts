import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { verifyCanonicalSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import { snapshotSchema, type Snapshot } from "../../../snapshot/index.js";
import type { WordPressSource, WordPressSourceResolver } from "./contract.js";
import { PHP_RUNTIME_SOURCE_IDENTITY } from "../acquisition/php-runtime-source.js";
import { wordPressOrgPluginIdentity } from "../target-identity.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(100);
const snapshotWithDigestSchema = snapshotSchema.safeExtend({ digest });
export const setupSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotDigest: digest,
    siteTitle: z.string().min(1).max(120),
    initialPosts: z.array(z.string().min(1).max(120)).max(20),
    initialApprovedComment: z.boolean().optional(),
    customerRole: z.boolean(),
    databaseAccess: z.enum(["read-only", "none"]).default("none"),
    translatePress: z
      .strictObject({
        administratorSecondaryLocale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
      })
      .optional(),
    /** Read only: past setups name a scenario removed in #353; no Lab is built from one. */
    scenario: z.strictObject({ id: z.string(), digest }).optional(),
  })
  .refine(
    (setup) =>
      setup.initialApprovedComment !== true || setup.initialPosts.length > 0,
    {
      path: ["initialApprovedComment"],
      message: "An approved comment requires an initial post",
    },
  );
export type WordPressLabSetup = z.input<typeof setupSchema>;
export type ParsedWordPressLabSetup = z.output<typeof setupSchema>;
export const WORDPRESS_CORE_IDENTITY = "wordpress-core";

type PluginDirectory = { readonly slug: string; readonly directory: string };
export interface PreparedWordPressLab {
  readonly snapshot: Snapshot;
  readonly setup: ParsedWordPressLabSetup;
  readonly target: PluginDirectory;
  readonly dependencies: readonly PluginDirectory[];
  readonly coreVersion: string | undefined;
  readonly phpVersion: string | undefined;
}

async function verifySource(
  source: WordPressSource,
  expected: string,
): Promise<string> {
  if (source.kind === "plugin") slug.parse(source.pluginSlug);
  if (
    !isAbsolute(source.sourceDirectory) ||
    source.sourceDirectory.includes("\0") ||
    source.sourceTree.digest !== expected
  )
    throw new Error("Source digest mismatch");
  const directory = await realpath(source.sourceDirectory);
  if (
    !(await stat(directory)).isDirectory() ||
    !(await verifyCanonicalSourceTree(directory, source.sourceTree)).matches
  )
    throw new Error("Source tree mismatch");
  return directory;
}

async function prepareDependencies(
  resolved: Awaited<ReturnType<WordPressSourceResolver["resolve"]>>,
  snapshot: Snapshot,
): Promise<{
  readonly dependencies: readonly PluginDirectory[];
  readonly coreVersion: string | undefined;
  readonly phpVersion: string | undefined;
}> {
  const dependencies: PluginDirectory[] = [];
  let coreVersion: string | undefined;
  let phpVersion: string | undefined;
  for (let index = 0; index < resolved.dependencies.length; index++) {
    const item = resolved.dependencies[index];
    const expected = snapshot.dependencies[index];
    if (item === undefined || expected === undefined)
      throw new Error("Dependency missing");
    const directory = await verifySource(item, expected.sourceDigest);
    if (item.kind === "wordpress-core") {
      if (
        expected.identity !== WORDPRESS_CORE_IDENTITY ||
        expected.version !== item.version ||
        coreVersion !== undefined
      )
        throw new Error("WordPress core dependency mismatch");
      coreVersion = item.version;
    } else if (item.kind === "php-source") {
      if (
        expected.identity !== PHP_RUNTIME_SOURCE_IDENTITY ||
        expected.version !== item.version ||
        phpVersion !== undefined
      )
        throw new Error("PHP source dependency mismatch");
      phpVersion = item.version;
    } else {
      if (expected.identity !== wordPressOrgPluginIdentity(item.pluginSlug))
        throw new Error("Plugin dependency identity mismatch");
      dependencies.push({ slug: item.pluginSlug, directory });
    }
  }
  return { dependencies, coreVersion, phpVersion };
}

/** Validate immutable source and setup before starting any container. */
export async function prepareWordPressLab(
  candidateSnapshot: unknown,
  candidateSetup: WordPressLabSetup,
  sourceResolver: WordPressSourceResolver,
): Promise<PreparedWordPressLab> {
  const snapshot = snapshotWithDigestSchema.parse(candidateSnapshot);
  const { digest: snapshotDigest, ...record } = snapshot;
  if (canonicalDigest(record) !== snapshotDigest)
    throw new Error("Snapshot digest mismatch");
  const setup = setupSchema.parse(candidateSetup);
  if (setup.snapshotDigest !== snapshot.digest)
    throw new Error("Lab setup snapshot mismatch");
  // Lab scenarios were removed in #353; wbh-verify prepares preconditions (ADR 0035).
  if (setup.scenario !== undefined)
    throw new Error(
      "Lab scenarios were removed in #353; restore them from archive/pre-353-deletion",
    );
  const resolved = await sourceResolver.resolve(snapshot);
  if (resolved.dependencies.length !== snapshot.dependencies.length)
    throw new Error("Dependency count mismatch");
  if (
    setup.customerRole &&
    ![resolved.target, ...resolved.dependencies].some(
      (item) => item.kind === "plugin" && item.pluginSlug === "woocommerce",
    )
  )
    throw new Error("Customer role needs WooCommerce");
  if (resolved.target.kind !== "plugin")
    throw new Error("The target must be a plugin");
  if (
    setup.translatePress !== undefined &&
    resolved.target.pluginSlug !== "translatepress-multilingual"
  )
    throw new Error("TranslatePress Lab setup requires its plugin");
  const directory = await verifySource(
    resolved.target,
    snapshot.target.sourceDigest,
  );
  const { dependencies, coreVersion, phpVersion } = await prepareDependencies(
    resolved,
    snapshot,
  );
  return {
    snapshot,
    setup,
    target: { slug: resolved.target.pluginSlug, directory },
    dependencies,
    coreVersion,
    phpVersion,
  };
}
