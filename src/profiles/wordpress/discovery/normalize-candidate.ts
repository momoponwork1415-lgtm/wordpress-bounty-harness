import { wordpressFindingClaimSchema } from "./finding.js";
import { wordpressLeadClaimSchema } from "./lead.js";

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
        item.file = file.startsWith("/workspace/main/")
          ? file.slice("/workspace/main/".length)
          : file.startsWith("/workspace/wordpress/")
            ? `@wordpress/${file.slice("/workspace/wordpress/".length)}`
            : file.startsWith("../wordpress/")
              ? `@wordpress/${file.slice("../wordpress/".length)}`
              : file.startsWith("WordPress ")
                ? `@wordpress/${file.slice("WordPress ".length)}`
                : file;
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
