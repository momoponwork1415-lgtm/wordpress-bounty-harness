// Builds the Git-outside legacy history JSON (final design D2). Reads only;
// never touches the production ledger. JSON goes to stdout, counts to stderr.
//
// node scripts/export-legacy-slugs.mjs \
//   [--db <old research.sqlite> --db-started-sql "<SELECT slug ...>" \
//    [--db-ambiguous-sql "<SELECT slug ...>"]] \
//   [--state <old state dir>]... [--report <selection-report.json>]... \
//   [--reconsider <slug>]... > /abs/legacy-slugs.json
//
// The old research DB has no fixed schema here, so its two slug queries are
// written once against the real file. Each must return one `slug` column.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const FLOORS = [100_000, 50_000, 30_000];
const slugPattern = /^[a-z0-9][a-z0-9-]{0,199}$/;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    "db-started-sql": { type: "string" },
    "db-ambiguous-sql": { type: "string" },
    state: { type: "string", multiple: true, default: [] },
    report: { type: "string", multiple: true, default: [] },
    reconsider: { type: "string", multiple: true, default: [] },
  },
});
const fail = (message) => {
  process.stderr.write(`export-legacy-slugs: ${message}\n`);
  process.exit(2);
};
for (const path of [values.db, ...values.state, ...values.report])
  if (path !== undefined && !isAbsolute(path))
    fail(`paths must be absolute: ${path}`);
if ((values.db === undefined) !== (values["db-started-sql"] === undefined))
  fail("--db and --db-started-sql go together");
if (values.db === undefined && values.state.length === 0)
  fail("give --db or at least one --state");

const started = new Set();
const ambiguous = new Set();
const sourceDigests = [];
const sha256 = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const slug = (value, origin) => {
  if (typeof value !== "string" || !slugPattern.test(value))
    fail(`not a slug from ${origin}: ${JSON.stringify(value)}`);
  return value;
};

const readOnly = async (path) => {
  sourceDigests.push(sha256(await readFile(path)));
  return new DatabaseSync(path, { readOnly: true });
};

if (values.db !== undefined) {
  const db = await readOnly(values.db);
  for (const [sql, into] of [
    [values["db-started-sql"], started],
    [values["db-ambiguous-sql"], ambiguous],
  ])
    if (sql !== undefined)
      for (const row of db.prepare(sql).all()) into.add(slug(row.slug, "--db"));
  db.close();
}

// Old Harness ledgers: an exploration start (or a legacy start without
// runKind) marks its selected slug as started.
for (const directory of values.state) {
  const db = await readOnly(join(directory, "ledger.sqlite"));
  const slugBySnapshot = new Map();
  const rows = db
    .prepare(
      "SELECT event_type, event_json FROM ledger_events WHERE event_type IN ('target-selected', 'discovery-run-started') ORDER BY sequence",
    )
    .all();
  for (const row of rows) {
    const event = JSON.parse(row.event_json);
    const key = `${event.campaignId}\0${event.snapshotDigest}`;
    if (row.event_type === "target-selected") {
      const matched = /^wporg:([a-z0-9][a-z0-9-]*)@/.exec(event.selectionId);
      if (matched !== null) slugBySnapshot.set(key, matched[1]);
    } else if ((event.runKind ?? "explore") === "explore") {
      const known = slugBySnapshot.get(key);
      if (known !== undefined) started.add(known);
    }
  }
  db.close();
}
for (const item of started) ambiguous.delete(item);

const reconsider = new Set(
  values.reconsider.map((item) => slug(item, "--reconsider")),
);
const sorted = (set) => [...set].sort();
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceDigest: sha256(sourceDigests.join("\n")),
      exportedAt: new Date().toISOString(),
      sources: [values.db, ...values.state].filter(Boolean),
      started: sorted(started),
      ambiguous: sorted(ambiguous),
      reconsider: sorted(reconsider),
    },
    null,
    2,
  )}\n`,
);
process.stderr.write(
  `started ${started.size}  ambiguous ${ambiguous.size}  reconsider ${reconsider.size}\n`,
);

// Remaining candidates per floor: eligible slugs in `select` reports (run the
// lowest-floor policy on a scratch state) minus started and ambiguous,
// with owner reconsider overrides.
if (values.report.length > 0) {
  const installs = new Map();
  for (const path of values.report) {
    const report = JSON.parse(await readFile(path, "utf8"));
    for (const item of report.inspections ?? [])
      if (item.selection !== undefined)
        installs.set(item.slug, item.selection.activeInstallations);
  }
  for (const floor of FLOORS) {
    const eligible = [...installs].filter(([, count]) => count >= floor);
    const remaining = eligible.filter(
      ([item]) =>
        reconsider.has(item) || !(started.has(item) || ambiguous.has(item)),
    );
    process.stderr.write(
      `floor ${floor}  enumerable ${eligible.length}  legacy ${eligible.length - remaining.length}  remaining ${remaining.length}\n`,
    );
  }
}
