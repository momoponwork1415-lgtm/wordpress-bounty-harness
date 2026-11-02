import { z } from "zod";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";

/**
 * The store table (ADR 0049 D): a pure transformation of the `lookupLog` an
 * exploration Lab sealed (`exploration-lab.json`). For every answered `find`
 * it keeps the marker and where the site stored it (table and column, the
 * key values dropped; file paths); for every answered `trace` the request's
 * method and path, the HTTP status, the entry count and the distinct plugin
 * files the trace entered. `sql` answers, refusals, failures, cookies and
 * every other field are left out. Nothing here interprets an answer.
 */

export const RESEARCH_STORES_FILE = "stores.json";
const MAX_FINDS = 300;
const MAX_TRACES = 300;
const MAX_FILES_PER_ENTRY = 200;

const findAnswer = z.looseObject({
  marker: z.string().regex(/^[1-9][0-9]{9,14}$/),
  database: z
    .array(z.looseObject({ table: z.string(), column: z.string() }))
    .default([]),
  files: z.array(z.string()).default([]),
});
const traceRequest = z.looseObject({
  method: z.enum(["GET", "POST"]),
  path: z.string(),
});
const traceAnswer = z.looseObject({
  httpStatus: z.number().int(),
  entryCount: z.number().int().nonnegative(),
  entries: z.array(z.looseObject({ file: z.string() })).default([]),
});
const lookupEntry = z.looseObject({
  command: z.string(),
  status: z.string(),
  request: z.unknown().optional(),
  answer: z.unknown().optional(),
});
const explorationLabRecord = z.looseObject({
  lookupLog: z.array(lookupEntry).default([]),
});

export const researchStoresSchema = z.strictObject({
  kind: z.literal("research-stores"),
  schemaVersion: z.literal(1),
  finds: z.array(
    z.strictObject({
      marker: z.string(),
      database: z.array(
        z.strictObject({ table: z.string(), column: z.string() }),
      ),
      files: z.array(z.string()),
    }),
  ),
  traces: z.array(
    z.strictObject({
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      httpStatus: z.number().int(),
      entryCount: z.number().int().nonnegative(),
      files: z.array(z.string()),
    }),
  ),
});
export type ResearchStores = z.infer<typeof researchStoresSchema>;

/**
 * The store table of one sealed exploration Lab record, or undefined when
 * the record is not one or no `find` / `trace` was answered.
 */
export function buildResearchStores(
  record: unknown,
): ResearchStores | undefined {
  const parsed = explorationLabRecord.safeParse(record);
  if (!parsed.success) return undefined;
  const finds: ResearchStores["finds"] = [];
  const traces: ResearchStores["traces"] = [];
  for (const entry of parsed.data.lookupLog) {
    if (entry.status !== "answered") continue;
    if (entry.command === "find" && finds.length < MAX_FINDS) {
      const answer = findAnswer.safeParse(entry.answer);
      if (!answer.success) continue;
      const seen = new Set<string>();
      const database: { table: string; column: string }[] = [];
      for (const { table, column } of answer.data.database) {
        const key = `${table}\n${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        database.push({ table, column });
      }
      finds.push({
        marker: answer.data.marker,
        database,
        files: [...new Set(answer.data.files)].slice(0, MAX_FILES_PER_ENTRY),
      });
    } else if (entry.command === "trace" && traces.length < MAX_TRACES) {
      const request = traceRequest.safeParse(entry.request);
      const answer = traceAnswer.safeParse(entry.answer);
      if (!request.success || !answer.success) continue;
      traces.push({
        method: request.data.method,
        path: request.data.path,
        httpStatus: answer.data.httpStatus,
        entryCount: answer.data.entryCount,
        files: [...new Set(answer.data.entries.map(({ file }) => file))].slice(
          0,
          MAX_FILES_PER_ENTRY,
        ),
      });
    }
  }
  if (finds.length === 0 && traces.length === 0) return undefined;
  return { kind: "research-stores", schemaVersion: 1, finds, traces };
}

/** The bytes of `stores.json`: canonical JSON, so the same record gives the same digest. */
export function researchStoresBytes(stores: ResearchStores): Buffer {
  return Buffer.from(canonicalJson(researchStoresSchema.parse(stores)), "utf8");
}
