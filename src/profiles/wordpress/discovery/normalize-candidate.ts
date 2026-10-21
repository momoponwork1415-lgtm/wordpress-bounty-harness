import { z } from "zod";

import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";
import { normalizeWordPressSourcePath } from "./source-path.js";

// Limits and labels come from the claim schemas, so the repair cannot drift from them (ADR 0019).
const propertiesSchema = z.object({
  properties: z.record(
    z.string(),
    z.object({
      maxLength: z.number().optional(),
      enum: z.array(z.string()).optional(),
    }),
  ),
});
const [findingProperties, leadProperties] = [
  wordpressFindingClaimSchema,
  wordpressLeadClaimSchema,
].map(
  (schema) =>
    propertiesSchema.parse(z.toJSONSchema(schema, { io: "output" })).properties,
);
const claimProperties = { ...leadProperties, ...findingProperties };
const ATTACKER_POSITIONS = claimProperties.attackerPosition?.enum ?? [];
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The label leads the text; case, spaces and underscores may differ from the enum spelling.
const IMPACT_LABELS = (claimProperties.impact?.enum ?? []).map((label) => ({
  label,
  pattern: new RegExp(
    `^\\s*${label.split("-").map(escapeRegExp).join("[\\s_-]+")}(?![a-z0-9+])`,
    "i",
  ),
}));

function truncate(text: string, maximum: number): string {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(maximum - 1))
    ? maximum - 1
    : maximum;
  return text.slice(0, end);
}

function isImpactLabel(value: unknown): boolean {
  return wordpressFindingClaimSchema.shape.impact.safeParse(value).success;
}

/** Syntax repair only. The claim schemas still decide whether a candidate is admissible. */
export function normalizeWordPressCandidate(candidate: unknown): {
  value: unknown;
  changes: { path: string; operation: string }[];
} {
  const changes: { path: string; operation: string }[] = [];
  let value = candidate;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
      changes.push({ path: "", operation: "json-decoded" });
    } catch {
      return { value, changes };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { value, changes };
  const result: Record<string, unknown> = { ...value };
  for (const field of [
    "claim",
    "summary",
    "configurationPrecondition",
    "brokenProperty",
    "existingControls",
    "labObservations",
    "privateRecipeReference",
  ]) {
    const text = result[field];
    if (Array.isArray(text) && text.every((part) => typeof part === "string")) {
      result[field] = text.join("\n");
      changes.push({ path: field, operation: "text-array-joined" });
    }
    const maximum = claimProperties[field]?.maxLength;
    const joined = result[field];
    if (
      maximum !== undefined &&
      typeof joined === "string" &&
      joined.length > maximum
    ) {
      result[field] = truncate(joined, maximum);
      changes.push({ path: field, operation: "text-truncated" });
    }
  }
  const position = result.attackerPosition;
  if (typeof position === "string" && !ATTACKER_POSITIONS.includes(position)) {
    const named = ATTACKER_POSITIONS.filter((word) =>
      position.toLowerCase().includes(word),
    );
    if (named.length === 1) {
      result.attackerPosition = named[0];
      changes.push({
        path: "attackerPosition",
        operation: "attacker-position-coerced",
      });
    }
  }
  const impact = result.impact;
  if (typeof impact === "object" && impact !== null && !Array.isArray(impact)) {
    const fields = impact as Record<string, unknown>;
    const strings = Object.values(fields).filter(
      (part) => typeof part === "string",
    );
    const lifted =
      strings.length === 1
        ? strings[0]
        : ["impact", "kind", "type", "category"]
            .map((key) => fields[key])
            .find((part) => typeof part === "string");
    if (lifted !== undefined) {
      result.impact = lifted;
      changes.push({ path: "impact", operation: "impact-lifted" });
    }
  }
  const label = result.impact;
  if (typeof label === "string" && !isImpactLabel(label)) {
    const named = IMPACT_LABELS.filter(({ pattern }) => pattern.test(label));
    if (named.length === 1) {
      result.impact = named[0]!.label;
      changes.push({ path: "impact", operation: "impact-label-coerced" });
    }
  }
  if (Array.isArray(result.sourceTrace)) {
    result.sourceTrace = result.sourceTrace.map((entry, index) => {
      const path = `sourceTrace.${index}`;
      let trace: unknown = entry;
      if (typeof trace === "string") {
        const parts = trace.split(/\s+\/\s+/);
        const line =
          parts.length === 3
            ? /^(\d+)(?:-\d+)?(?:\s+.*)?$/.exec(parts[2]!)
            : null;
        if (line !== null) {
          trace = {
            file: parts[0],
            function: parts[1],
            line: Number(line[1]),
          };
          changes.push({ path, operation: "source-trace-parsed" });
        }
      }
      if (typeof trace !== "object" || trace === null || Array.isArray(trace))
        return trace;
      const item: Record<string, unknown> = { ...trace };
      if (typeof item.file === "string") {
        const file = item.file;
        item.file = normalizeWordPressSourcePath(file);
        if (item.file !== file)
          changes.push({
            path: `${path}.file`,
            operation: "source-path-normalized",
          });
      }
      return item;
    });
  }
  return { value: result, changes };
}
export function classifyWordPressCandidate(
  candidate: unknown,
  kind: "finding" | "lead",
) {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    return kind === "finding"
      ? { impact: "unclassified" }
      : { primitive: "unclassified", missingEdge: "unclassified" };
  const fields = candidate as Record<string, unknown>;
  if (kind === "finding") {
    const impact = wordpressFindingClaimSchema.shape.impact.safeParse(
      fields.impact,
    );
    return { impact: impact.success ? impact.data : "unclassified" };
  }
  const primitive = wordpressLeadClaimSchema.shape.primitive.safeParse(
    fields.primitive,
  );
  const missingEdge = wordpressLeadClaimSchema.shape.missingEdge.safeParse(
    fields.missingEdge,
  );
  return {
    primitive: primitive.success ? primitive.data : "unclassified",
    missingEdge: missingEdge.success ? missingEdge.data : "unclassified",
  };
}
