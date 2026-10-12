import { randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { verifyCanonicalSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import { snapshotSchema, type Snapshot } from "../../../snapshot/index.js";
import type {
  Resources,
  WordPressLabHandle,
  WordPressSource,
  WordPressSourceResolver,
} from "./index.js";
import { wordPressScenario, type WordPressScenario } from "./scenarios.js";
import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
} from "./wordpress-initialization.js";

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
type Account = { readonly username: string; readonly password: string };
export interface PreparedWordPressLab {
  readonly snapshot: Snapshot;
  readonly setup: ParsedWordPressLabSetup;
  readonly scenario: WordPressScenario | undefined;
  readonly target: PluginDirectory;
  readonly dependencies: readonly PluginDirectory[];
  readonly coreVersion: string | undefined;
}

function validateScenario(
  setup: ParsedWordPressLabSetup,
): WordPressScenario | undefined {
  const scenario =
    setup.scenario === undefined
      ? undefined
      : wordPressScenario(setup.scenario.id);
  if (
    setup.scenario !== undefined &&
    (scenario === undefined || scenario.digest !== setup.scenario.digest)
  )
    throw new Error("Unknown or changed Lab scenario");
  if (scenario?.approvedComment && setup.initialPosts.length === 0)
    throw new Error("Scenario requires an initial post");
  if (
    scenario?.translation !== null &&
    scenario?.translation !== undefined &&
    !setup.initialPosts.includes(scenario.translation.original)
  )
    throw new Error("Scenario translation requires its published post");
  if (
    scenario?.secondaryLocale !== null &&
    scenario?.secondaryLocale !== undefined &&
    setup.translatePress !== undefined &&
    setup.translatePress.administratorSecondaryLocale !==
      scenario.secondaryLocale
  )
    throw new Error("Scenario secondary locale conflicts with setup");
  return scenario;
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
}> {
  const dependencies: PluginDirectory[] = [];
  let coreVersion: string | undefined;
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
    } else {
      dependencies.push({ slug: item.pluginSlug, directory });
    }
  }
  return { dependencies, coreVersion };
}

/** Validate immutable source and scenario before starting any container. */
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
  const scenario = validateScenario(setup);
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
    scenario?.pluginSlug !== null &&
    scenario?.pluginSlug !== undefined &&
    resolved.target.pluginSlug !== scenario.pluginSlug
  )
    throw new Error("Lab scenario requires its plugin");
  if (
    setup.translatePress !== undefined &&
    resolved.target.pluginSlug !== "translatepress-multilingual"
  )
    throw new Error("TranslatePress Lab setup requires its plugin");
  const directory = await verifySource(
    resolved.target,
    snapshot.target.sourceDigest,
  );
  const { dependencies, coreVersion } = await prepareDependencies(
    resolved,
    snapshot,
  );
  return {
    snapshot,
    setup,
    scenario,
    target: { slug: resolved.target.pluginSlug, directory },
    dependencies,
    coreVersion,
  };
}

export function createLabResource(
  prepared: PreparedWordPressLab,
  forVerification: boolean,
): {
  readonly resource: Resources;
  readonly subscriber: Account;
  readonly customer: Account | undefined;
  readonly victimSubscriber: Account | undefined;
  readonly victimCustomer: Account | undefined;
} {
  const id = randomUUID();
  const prefix = `wbh-${id}`;
  const subscriber = {
    username: `wbh-subscriber-${id.slice(0, 8)}`,
    password: randomUUID(),
  };
  const customer = prepared.setup.customerRole
    ? {
        username: `wbh-customer-${id.slice(0, 8)}`,
        password: randomUUID(),
      }
    : undefined;
  const victimSubscriber = forVerification
    ? {
        username: `wbh-victim-subscriber-${id.slice(0, 8)}`,
        password: randomUUID(),
      }
    : undefined;
  const victimCustomer =
    forVerification && prepared.setup.customerRole
      ? {
          username: `wbh-victim-customer-${id.slice(0, 8)}`,
          password: randomUUID(),
        }
      : undefined;
  const secondaryLocale =
    prepared.setup.translatePress?.administratorSecondaryLocale ??
    prepared.scenario?.secondaryLocale ??
    undefined;
  const resource: Resources = {
    id,
    network: `${prefix}-net`,
    volume: `${prefix}-site`,
    database: `${prefix}-db`,
    wordpress: `${prefix}-wp`,
    recorder: `${prefix}-proxy`,
    receiver: `${prefix}-canary`,
    databasePassword: randomUUID(),
    readerPassword: randomBytes(32).toString("hex"),
    adminPassword: randomUUID(),
    victimAccounts: {
      ...(victimSubscriber === undefined
        ? {}
        : { subscriber: victimSubscriber }),
      ...(victimCustomer === undefined ? {} : { customer: victimCustomer }),
    },
    ...(secondaryLocale === undefined
      ? {}
      : {
          administratorSecondaryLocale: secondaryLocale,
        }),
    executionSalt: randomBytes(16).toString("hex"),
    executionNonces: new Set(),
    scriptNonces: new Set(),
    sensitiveCanaries: [],
    receiverCreated: false,
    networkCreated: false,
    volumeCreated: false,
    databaseCreated: false,
    wordpressCreated: false,
    recorderCreated: false,
  };
  return { resource, subscriber, customer, victimSubscriber, victimCustomer };
}

export function databaseIp(resource: Resources): string {
  if (resource.databaseIp === undefined)
    throw new Error("Lab database address is unavailable");
  return resource.databaseIp;
}

export function createLabHandle(input: {
  readonly prepared: PreparedWordPressLab;
  readonly resource: Resources;
  readonly images: Readonly<Record<string, string>>;
  readonly internalIp: string;
  readonly recorderIp: string;
  readonly subscriber: Account;
  readonly customer: Account | undefined;
}): WordPressLabHandle {
  const {
    prepared,
    resource,
    images,
    internalIp,
    recorderIp,
    subscriber,
    customer,
  } = input;
  const { setup, snapshot } = prepared;
  return {
    id: resource.id,
    snapshotDigest: snapshot.digest,
    setupDigest: canonicalDigest({ setup, images }),
    ...(setup.scenario === undefined ? {} : { scenario: setup.scenario }),
    ...(resource.administratorSecondaryLocale === undefined
      ? {}
      : { secondaryLocale: resource.administratorSecondaryLocale }),
    endpoint: "http://wordpress",
    networkName: resource.network,
    internalIp,
    recorderIp,
    attackerAccounts: {
      subscriber,
      ...(customer === undefined ? {} : { customer }),
    },
    ...(setup.databaseAccess === "read-only"
      ? {
          database: {
            host: "database" as const,
            ipv4: databaseIp(resource),
            port: 3306 as const,
            name: DATABASE_NAME,
            readOnlyAccount: {
              username: READ_ONLY_DATABASE_USER,
              password: resource.readerPassword,
            },
          },
        }
      : {}),
  };
}
