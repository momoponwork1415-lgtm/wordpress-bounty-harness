import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const relativeFile = nonEmpty.refine(
  (file) =>
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !file
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === ".."),
  "Expected a relative source file",
);

const entryPoint = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hook"), hook: nonEmpty }),
  z.strictObject({ kind: z.literal("route"), route: nonEmpty }),
  z.strictObject({ kind: z.literal("ajax-action"), action: nonEmpty }),
]);

/** Private evaluation data. Never pass an instance to discovery or Lab. */
export const wordpressAnswerKeySchema = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: nonEmpty,
  cohort: z.enum(["first-party", "auxiliary"]),
  entryPoint,
  violatedProperty: nonEmpty,
  missingCheck: nonEmpty,
  attackerPosition: z.enum(["unauthenticated", "subscriber", "customer"]),
  impact: z.enum([
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
  allowedLocations: z
    .array(
      z.strictObject({ file: relativeFile, function: nonEmpty.optional() }),
    )
    .min(1),
  publishedAt: z.iso.date(),
  modelCutoff: z.iso.date(),
});

export type WordPressAnswerKey = z.infer<typeof wordpressAnswerKeySchema>;

const findingTraceSchema = z.looseObject({
  sourceTrace: z
    .array(z.looseObject({ file: relativeFile, function: nonEmpty.optional() }))
    .min(1),
});

/** The trace locations of a private WordPress Finding record, for location-overlap. */
export function wordpressFindingLocations(
  finding: unknown,
): readonly { readonly file: string; readonly function?: string }[] {
  return findingTraceSchema
    .parse(finding)
    .sourceTrace.map((location) =>
      location.function === undefined
        ? { file: location.file }
        : { file: location.file, function: location.function },
    );
}

/** Answer keys live outside Git; a file holds one key or an array of keys. */
export function parseWordPressAnswerKeys(
  value: unknown,
): readonly WordPressAnswerKey[] {
  return z
    .union([
      wordpressAnswerKeySchema.transform((key) => [key]),
      z.array(wordpressAnswerKeySchema).min(1),
    ])
    .parse(value);
}
