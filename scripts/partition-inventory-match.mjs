#!/usr/bin/env node
// Acceptance count for a partitioned Trial's inventory (ADR 0042, measurement.md 5a):
// how many human-kept records (file + line pairs) land on an inventory row.
//
//   node scripts/partition-inventory-match.mjs --inventory <inventory.json> --records <records.json>
//
// `inventory.json` is the enumerator's output as sealed in Private Evidence
// (`{"rows": [{"id", "origin", "kind", "file", "line", "text"}]}`). The
// records file is kept outside Git; it is a JSON array of `{"file", "line"}`
// objects, or an object with a `records` array of them. A record matches a
// row when the files are equal and either line is absent or the lines are
// equal. Only counts are printed: never a row, a file name or a line.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const USAGE =
  "usage: node scripts/partition-inventory-match.mjs --inventory <inventory.json> --records <records.json>";

/** Pure: the count of records that match at least one row, and the total. */
export function matchRecords(rows, records) {
  const byFile = new Map();
  for (const row of rows) {
    if (typeof row?.file !== "string") continue;
    const lines = byFile.get(row.file) ?? new Set();
    lines.add(Number.isInteger(row.line) ? row.line : null);
    byFile.set(row.file, lines);
  }
  let matched = 0;
  for (const record of records) {
    if (typeof record?.file !== "string") continue;
    const lines = byFile.get(record.file);
    if (lines === undefined) continue;
    if (
      !Number.isInteger(record.line) ||
      lines.has(record.line) ||
      lines.has(null)
    )
      matched += 1;
  }
  return { matched, total: records.length };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function recordsOf(value) {
  const list = Array.isArray(value) ? value : value?.records;
  if (!Array.isArray(list)) throw new Error("records file holds no array");
  return list;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))
) {
  const { values } = parseArgs({
    options: {
      inventory: { type: "string" },
      records: { type: "string" },
    },
  });
  if (values.inventory === undefined || values.records === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const rows = readJson(values.inventory)?.rows;
  if (!Array.isArray(rows)) {
    console.error("inventory file holds no rows array");
    process.exit(1);
  }
  const { matched, total } = matchRecords(
    rows,
    recordsOf(readJson(values.records)),
  );
  console.log(`records matched: ${matched} / ${total}`);
}
