import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import { WORDPRESS_DEPENDENCY_SOURCE_ROOTS } from "../sandbox-layout.js";
import { normalizeWordPressSourcePath } from "./source-path.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const relativeFile = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
  );
// Keep the target relative and identify each read-only dependency tree.
const sourceFile = z
  .string()
  .transform(normalizeWordPressSourcePath)
  .pipe(relativeFile);

/**
 * #613 (ADR 0038 追記 13): the agent's own judgment of the configuration a
 * route needs, of how the attacker's input reaches the sink and of when the
 * attacker can trigger it. The Harness parks on the declared value alone and
 * never derives it from wording. All three fields are optional: an omitted
 * declaration neither holds nor parks.
 */
export const configurationClassSchema = z
  .union([
    z
      .literal("default")
      .describe(
        "The route works on the plugin as installed, with no setting changed.",
      ),
    z
      .literal("ordinary-feature-use")
      .describe(
        "An administrator uses a feature as intended, in a way a typical site may plausibly use it.",
      ),
    z
      .literal("admin-authored-unsafe-content")
      .describe(
        "An administrator must author the unsafe thing themselves: markup, script, a field or column definition, a query condition, a template or snippet that no typical site would create.",
      ),
    z
      .literal("admin-setting-change")
      .describe(
        "An administrator must set an option to a value that creates the vulnerability or disables a safeguard (for example turning sanitisation off), which a typical site would not choose.",
      ),
    z
      .literal("developer-mode")
      .describe(
        "A debug, development or test mode must be on; a production site would not run it.",
      ),
  ])
  .describe("The site configuration the route needs.");
export type ConfigurationClass = z.infer<typeof configurationClassSchema>;

export const attackerInputPathSchema = z
  .union([
    z
      .literal("direct-request")
      .describe("The attacker sends an HTTP request to the target site."),
    z
      .literal("own-account-data")
      .describe(
        "The attacker writes a field of their own account on the site, e.g. a profile field, a comment, a form submission.",
      ),
    z
      .literal("public-third-party-content")
      .describe(
        "Anyone can write it, e.g. a comment on a public social-media page, or the attacker's own blocked request kept in a WAF log.",
      ),
    z
      .literal("vendor-controlled-data")
      .describe(
        "Only the service's vendor, the site itself or an administrator writes it, e.g. scanner results, a vulnerability database, a fixed vendor feed or notice, an official translation pack, an API response body, an administrator-run check's output.",
      ),
  ])
  .describe("How the attacker's input reaches the sink.");
export type AttackerInputPath = z.infer<typeof attackerInputPathSchema>;

export const exploitTimingSchema = z
  .union([
    z
      .literal("any-time")
      .describe("The attacker can trigger it whenever they choose."),
    z
      .literal("time-window")
      .describe(
        "It works only inside a window another actor opens, e.g. a transient's lifetime or a few minutes after an administrator acts.",
      ),
    z.literal("race").describe("It depends on two requests interleaving."),
  ])
  .describe("When the attacker can trigger the route.");
export type ExploitTiming = z.infer<typeof exploitTimingSchema>;

/** The declared fields; a park records each one the Finding declared. */
export type WordPressDeclaredPrecondition = {
  readonly configurationClass?: ConfigurationClass;
  readonly attackerInputPath?: AttackerInputPath;
  readonly exploitTiming?: ExploitTiming;
};

/** The declared values that park a Finding at the exit (owner, 2026-10-26). */
const PARKED_DECLARATIONS: {
  readonly [
    Field in keyof WordPressDeclaredPrecondition
  ]-?: readonly NonNullable<WordPressDeclaredPrecondition[Field]>[];
} = {
  configurationClass: [
    "admin-authored-unsafe-content",
    "admin-setting-change",
    "developer-mode",
  ],
  attackerInputPath: ["vendor-controlled-data"],
  exploitTiming: ["time-window", "race"],
};

/**
 * The declaration a park records, when one of its values parks the Finding.
 * Only enum values leave the Finding; an undeclared field never parks.
 */
export function wordPressDeclaredPreconditionPark(
  finding: Pick<
    WordPressFinding,
    "configurationClass" | "attackerInputPath" | "exploitTiming"
  >,
): WordPressDeclaredPrecondition | undefined {
  const { configurationClass, attackerInputPath, exploitTiming } = finding;
  const declared = {
    ...(configurationClass === undefined ? {} : { configurationClass }),
    ...(attackerInputPath === undefined ? {} : { attackerInputPath }),
    ...(exploitTiming === undefined ? {} : { exploitTiming }),
  };
  const parks =
    (configurationClass !== undefined &&
      PARKED_DECLARATIONS.configurationClass.includes(configurationClass)) ||
    (attackerInputPath !== undefined &&
      PARKED_DECLARATIONS.attackerInputPath.includes(attackerInputPath)) ||
    (exploitTiming !== undefined &&
      PARKED_DECLARATIONS.exploitTiming.includes(exploitTiming));
  return parks ? declared : undefined;
}

export const wordpressFindingClaimSchema = z.strictObject({
  claim: z.string().min(1).max(4000),
  attackerPosition: z.enum(["unauthenticated", "subscriber", "customer"]),
  impact: z.preprocess(
    (value) =>
      value === "account-takeover-to-admin" ? "account-takeover" : value,
    z.enum([
      "rce",
      "php-file-write",
      "arbitrary-file-read",
      "arbitrary-file-delete",
      "arbitrary-file-download",
      "lfi",
      "rfi",
      "sqli",
      "options-update",
      "privesc-to-admin",
      "auth-bypass-to-admin",
      "account-takeover",
      "privesc-to-contributor+",
      "auth-bypass-non-admin",
      "sensitive-object-access",
      "content-deletion",
      "stored-xss",
      "reflected-xss",
      "csrf-to-write",
      "missing-authz",
      "idor",
      "other",
    ]),
  ),
  configurationPrecondition: z.string().min(1).max(1000),
  configurationClass: configurationClassSchema.optional(),
  attackerInputPath: attackerInputPathSchema.optional(),
  exploitTiming: exploitTimingSchema.optional(),
  brokenProperty: z.string().min(1).max(1000),
  sourceTrace: z
    .array(
      z.strictObject({
        file: sourceFile,
        function: z.string().min(1).max(256),
        line: z.number().int().positive(),
      }),
    )
    .min(1),
  existingControls: z.string().min(1).max(4000),
  labObservations: z.string().min(1).max(4000),
  /** The agent's note stays private; the authoritative recipe is the pinned report. */
  privateRecipeReference: z.string().min(1).max(4000).optional(),
  historyRecordId: id.optional(),
});

const contextSchema = z.strictObject({
  runId: id,
  snapshotDigest: digest,
  reportArtifactDigest: digest,
});

export type WordPressFinding = z.infer<typeof wordpressFindingClaimSchema> & {
  readonly findingId: string;
  readonly discoveryRunId: string;
  readonly snapshotDigest: string;
  readonly recipeRef: {
    readonly kind: "provider-report";
    readonly digest: string;
  };
};

/**
 * #424: the plugin-side `file:function` places of a Finding, its keys for the
 * overlap groups. Frames in WordPress core, PHP or a dependency plugin are
 * shared by unrelated Findings, so they are not keys.
 */
export function wordPressFindingGroupKeys(
  finding: Pick<WordPressFinding, "sourceTrace">,
): string[] {
  return finding.sourceTrace
    .filter(
      (frame) =>
        !WORDPRESS_DEPENDENCY_SOURCE_ROOTS.some((root) =>
          frame.file.startsWith(`${root.label}/`),
        ),
    )
    .map((frame) => canonicalJson([frame.file, frame.function]));
}

/** Agent claims remain unconfirmed; only a person confirms them in a Lab (#525). */
export function admitWordPressFinding(
  candidate: unknown,
  context: unknown,
): WordPressFinding {
  const claim = wordpressFindingClaimSchema.parse(candidate);
  const bound = contextSchema.parse(context);
  const body = {
    ...claim,
    discoveryRunId: bound.runId,
    snapshotDigest: bound.snapshotDigest,
    recipeRef: {
      kind: "provider-report" as const,
      digest: bound.reportArtifactDigest,
    },
  };
  return { ...body, findingId: canonicalDigest(body) };
}

const storedFindingSchema = wordpressFindingClaimSchema.extend({
  findingId: digest,
  discoveryRunId: id,
  snapshotDigest: digest,
  recipeRef: z.strictObject({
    kind: z.literal("provider-report"),
    digest,
  }),
});

/** Reads a private Finding record back and rejects one whose identity no longer matches. */
export function readWordPressFinding(value: unknown): WordPressFinding {
  const { findingId, ...body } = storedFindingSchema.parse(value);
  if (canonicalDigest(body) !== findingId)
    throw new Error("Finding identity does not match its content");
  return { ...body, findingId };
}
