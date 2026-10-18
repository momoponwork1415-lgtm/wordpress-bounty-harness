// Prints the WordPress source index summary with its unresolved counts (Issue #328 1a-0).
// Usage: pnpm build && node scripts/report-index-unresolved.mjs <source-dir> <plugin-prefix> [--list]
// Read-only text scan; it executes nothing from the source and is never shown to an agent.
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { list: { type: "boolean", default: false } },
});
if (positionals.length !== 2)
  throw new Error(
    "usage: report-index-unresolved.mjs <source-dir> <plugin-prefix> [--list]",
  );
const { buildWordPressSourceIndex } =
  await import("../dist/profiles/wordpress/discovery/storage-index.js");
const { describeWordPressUnresolved } =
  await import("../dist/profiles/wordpress/discovery/unresolved.js");
const index = await buildWordPressSourceIndex(
  resolve(positionals[0]),
  positionals[1],
);
console.log(`Index digest: ${index.digest}`);
console.log(`Entries: ${index.entries.length}`);
console.log(`Incomplete: ${index.incomplete}`);
console.log(describeWordPressUnresolved(index.unresolvedCounts));
if (values.list)
  for (const item of index.unresolved)
    console.log(`- ${item.kind} ${item.file}:${item.line}`);
