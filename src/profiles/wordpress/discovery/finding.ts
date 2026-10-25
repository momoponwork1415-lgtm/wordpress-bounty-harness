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
