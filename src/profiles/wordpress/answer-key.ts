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
