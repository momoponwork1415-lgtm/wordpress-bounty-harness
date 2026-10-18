import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { normalizeWordPressSourcePath } from "./source-path.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const relativeFile = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !file.startsWith("/") &&
      !file.includes("\\") &&
      file
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
const sourceFile = z
  .string()
  .transform(normalizeWordPressSourcePath)
  .pipe(relativeFile);

export const wordpressLeadClaimSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  attackerPosition: z.enum(["unauthenticated", "subscriber", "customer"]),
  primitive: z.enum([
    "read",
    "write",
    "delete",
    "auth-material",
    "partial-execution",
  ]),
  storage: z
    .strictObject({
      kind: z.enum([
        "option",
        "post-meta",
        "user-meta",
        "transient",
        "db-table",
        "file",
      ]),
      key: z.string().min(1).max(200),
    })
    .nullable(),
  missingEdge: z.enum([
    "producer",
    "consumer",
    "auth-use",
    "reachability",
    "precondition",
  ]),
  sourceTrace: z
    .array(
      z.strictObject({
        file: sourceFile,
        function: z.string().min(1).max(256),
        line: z.number().int().positive(),
      }),
    )
    .min(1),
  labObservations: z.string().min(1).max(4000),
});

const contextSchema = z.strictObject({
  runId: id,
  trialId: id,
  snapshotDigest: digest,
  reportArtifactDigest: digest,
});

export type WordPressLead = z.infer<typeof wordpressLeadClaimSchema> & {
  readonly leadId: string;
  readonly discoveryRunId: string;
  readonly trialId: string;
  readonly snapshotDigest: string;
  readonly recipeRef: {
    readonly kind: "provider-report";
    readonly digest: string;
  };
};

export function admitWordPressLead(
  candidate: unknown,
  context: unknown,
): WordPressLead {
  const claim = wordpressLeadClaimSchema.parse(candidate);
  const bound = contextSchema.parse(context);
  const body = {
    ...claim,
    discoveryRunId: bound.runId,
    trialId: bound.trialId,
    snapshotDigest: bound.snapshotDigest,
    recipeRef: {
      kind: "provider-report" as const,
      digest: bound.reportArtifactDigest,
    },
  };
  return { ...body, leadId: canonicalDigest(body) };
}

export function wordPressLeadSignature(lead: WordPressLead): string {
  return canonicalDigest({
    primitive: lead.primitive,
    storage: lead.storage,
    missingEdge: lead.missingEdge,
    sourceTrace: [
      ...new Set(lead.sourceTrace.map((location) => location.file)),
    ].sort(),
  });
}

const storedLeadSchema = wordpressLeadClaimSchema.extend({
  leadId: digest,
  discoveryRunId: id,
  trialId: id,
  snapshotDigest: digest,
  recipeRef: z.strictObject({ kind: z.literal("provider-report"), digest }),
});

export function readWordPressLead(value: unknown): WordPressLead {
  const { leadId, ...body } = storedLeadSchema.parse(value);
  if (canonicalDigest(body) !== leadId)
    throw new Error("Lead identity does not match its content");
  return { ...body, leadId };
}
