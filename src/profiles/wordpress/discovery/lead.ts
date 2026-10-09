import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { entryKey } from "./entry-points.js";
import type { WordPressSourceIndex } from "./storage-index.js";

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
        file: relativeFile,
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

/** Source-index facts around one Lead; no earlier report or other claim is included. */
export function renderWordPressLeadNeighbourhood(
  lead: WordPressLead,
  index: WordPressSourceIndex,
): string {
  const traceFiles = new Set(lead.sourceTrace.map((location) => location.file));
  const matchingKeys = new Set(
    lead.storage === null
      ? index.components
          .filter((component) =>
            component.files.some((file) => traceFiles.has(file)),
          )
          .flatMap((component) => component.entries)
      : index.entries
          .filter((entry) =>
            entry.storage.some(
              (ref) =>
                ref.kind === lead.storage?.kind &&
                ref.key === lead.storage?.key,
            ),
          )
          .map(entryKey),
  );
  const entries = index.entries.filter((entry) =>
    matchingKeys.has(entryKey(entry)),
  );
  return [
    `Index: ${index.incomplete ? "partial" : "complete"}`,
    ...(lead.storage === null
      ? []
      : [`Storage: ${lead.storage.kind}:${lead.storage.key}`]),
    ...(entries.length === 0
      ? ["No adjacent indexed entry found."]
      : entries.flatMap((entry) => [
          `- ${entry.kind} ${entry.name} — ${entry.file}:${entry.line}`,
          `  Files: ${entry.reach.join(", ")}`,
          ...entry.crossings.map(
            (crossing) =>
              `  ${crossing.kind}: ${crossing.name} (${crossing.file}:${crossing.line})`,
          ),
        ])),
  ].join("\n");
}
