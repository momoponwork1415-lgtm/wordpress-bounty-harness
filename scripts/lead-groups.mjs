#!/usr/bin/env node
// Groups of Leads and Findings of one Snapshot that share a sourceTrace
// endpoint (#715 acceptance 1). The #424 review groups do this for Findings
// only; this reader extends the same overlap rule to Leads.
//
//   node scripts/lead-groups.mjs [--state <dir>] (--campaign <id>... | --campaign-like <pattern> | --snapshot <digest>) [--rule overlap|pair] [--json]
//
// --state defaults to $WBH_STATE_DIRECTORY. --campaign may repeat;
// --campaign-like is an SQL LIKE pattern (e.g. prod-v18-20261031-%).
//
// Endpoints: a member's entry is its first sourceTrace row and its effect is
// its last, after dropping rows in WordPress core, PHP or a dependency plugin
// (the frames #424 does not key on either). When every row is such a frame,
// the first and last rows are used as they are. Each endpoint is a
// file + function pair; the line is ignored.
//
// Rules:
//   overlap (default)  members sharing their entry or their effect join, and
//                      groups are the connected components, as in #424.
//   pair               members join only when entry and effect both match.
// Groups never cross Snapshots. Entry keys and effect keys are kept apart, so
// a member whose effect is another member's entry does not join it.
//
// Representative: the first-recorded Lead of the group, or its first-recorded
// Finding when the group has no Lead.
//
// Read-only: the ledger is opened read-only and Private Evidence is only read.
// Output goes to stdout and holds ids, digests, counts and enum values only:
// no summary, claim, file or function name, URL or payload (SPEC section 2,
// invariant 8). Do not redirect it into Git-tracked files.
//
// Sources:
//   ledger     <state>/ledger.sqlite, events lead-recorded and finding-recorded
//   bodies     <state>/private-evidence/<digest>/content/lead.json | finding.json
// Findings parked at admission have no finding-recorded event and are not read.
// fixed-version-control derivations are left out, as in #424.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const USAGE =
  "usage: node scripts/lead-groups.mjs [--state <dir>] (--campaign <id>... | --campaign-like <pattern> | --snapshot <digest>) [--rule overlap|pair] [--json]";

// node:sqlite prints an ExperimentalWarning on stderr; drop only that one.
const emit = process.emit;
process.emit = function (name, ...args) {
  if (name === "warning" && args[0]?.name === "ExperimentalWarning")
    return false;
  return emit.call(this, name, ...args);
};
const { DatabaseSync } = await import("node:sqlite");
process.on("uncaughtException", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const { values } = parseArgs({
  options: {
    state: { type: "string" },
    campaign: { type: "string", multiple: true },
    "campaign-like": { type: "string" },
    snapshot: { type: "string" },
    rule: { type: "string", default: "overlap" },
    json: { type: "boolean", default: false },
  },
  strict: true,
});
const stateValue = values.state ?? process.env.WBH_STATE_DIRECTORY;
if (stateValue === undefined || stateValue === "")
  throw new Error(`--state or WBH_STATE_DIRECTORY is required. ${USAGE}`);
const scopes = [
  values.campaign !== undefined,
  values["campaign-like"] !== undefined,
  values.snapshot !== undefined,
].filter(Boolean).length;
if (scopes !== 1)
  throw new Error(
    `Give exactly one of --campaign, --campaign-like, --snapshot. ${USAGE}`,
  );
if (values.rule !== "overlap" && values.rule !== "pair")
  throw new Error(`--rule is overlap or pair. ${USAGE}`);

const digestPattern = /^sha256:[a-f0-9]{64}$/;
if (values.snapshot !== undefined && !digestPattern.test(values.snapshot))
  throw new Error("--snapshot is a sha256: digest");

const stateDirectory = resolve(stateValue);
const ledgerPath = join(stateDirectory, "ledger.sqlite");
if (!existsSync(ledgerPath)) throw new Error(`No ledger at ${ledgerPath}`);

// ---------------------------------------------------------------- helpers

const sha256 = (text) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const short = (digest) =>
  typeof digest === "string" && digest.startsWith("sha256:")
    ? digest.slice(7, 19)
    : String(digest);
// Only enum-like tokens are printed; anything else is dropped.
const token = (text) =>
  typeof text === "string" && /^[a-z][a-z0-9+-]{0,63}$/.test(text)
    ? text
    : undefined;
// The sandbox labels of the frames #424 does not key on
// (src/profiles/wordpress/sandbox-layout.ts, WORDPRESS_DEPENDENCY_SOURCE_ROOTS).
const DEPENDENCY_LABELS = ["@wordpress/", "@php/", "@dependencies/"];

/** A Lead or Finding body from Private Evidence, or undefined when unreadable. */
function body(digest, name) {
  if (typeof digest !== "string" || !digestPattern.test(digest))
    return undefined;
  const path = join(stateDirectory, "private-evidence", digest, "content");
  try {
    for (const part of [
      join(stateDirectory, "private-evidence"),
      join(stateDirectory, "private-evidence", digest),
      path,
    ]) {
      const stat = lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    }
    const file = join(path, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Entry and effect of a sourceTrace, or undefined when it has no row. */
function endpoints(sourceTrace) {
  if (!Array.isArray(sourceTrace)) return undefined;
  const rows = sourceTrace.filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      typeof row.file === "string" &&
      typeof row.function === "string",
  );
  if (rows.length === 0) return undefined;
  const target = rows.filter(
    (row) => !DEPENDENCY_LABELS.some((label) => row.file.startsWith(label)),
  );
  const frames = target.length === 0 ? rows : target;
  const place = (row) => JSON.stringify([row.file, row.function]);
  return { entry: place(frames[0]), effect: place(frames.at(-1)) };
}

function keysOf(ends) {
  if (ends === undefined) return [];
  return values.rule === "pair"
    ? [`pair\u0000${ends.entry}\u0000${ends.effect}`]
    : [`entry\u0000${ends.entry}`, `effect\u0000${ends.effect}`];
}

// ----------------------------------------------------------------- ledger

const database = new DatabaseSync(ledgerPath, { readOnly: true });
const where =
  values.campaign !== undefined
    ? `campaign_id in (${values.campaign.map(() => "?").join(", ")})`
    : values["campaign-like"] !== undefined
      ? "campaign_id like ?"
      : "1 = 1";
const parameters =
  values.campaign ??
  (values["campaign-like"] !== undefined ? [values["campaign-like"]] : []);
const rows = database
  .prepare(
    `select sequence, campaign_id, event_type, event_json from ledger_events where ${where} and event_type in ('lead-recorded', 'finding-recorded') order by sequence`,
  )
  .all(...parameters);
database.close();

const members = [];
const seen = new Set();
let unreadable = 0;
for (const row of rows) {
  let event;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    continue;
  }
  if (values.snapshot !== undefined && event.snapshotDigest !== values.snapshot)
    continue;
  const isLead = row.event_type === "lead-recorded";
  if (!isLead && event.derivationKind === "fixed-version-control") continue;
  const id = isLead ? event.leadId : event.findingId;
  const ref = `${row.campaign_id}\u0000${isLead ? "L" : "F"}\u0000${id}`;
  if (typeof id !== "string" || seen.has(ref)) continue;
  seen.add(ref);
  const artifact = (event.artifacts ?? []).find(
    (candidate) => candidate.kind === (isLead ? "lead" : "finding"),
  );
  const content = body(artifact?.digest, isLead ? "lead.json" : "finding.json");
  const ends = endpoints(content?.sourceTrace);
  if (ends === undefined) unreadable += 1;
  members.push({
    kind: isLead ? "lead" : "finding",
    id,
    campaignId: row.campaign_id,
    snapshotDigest: event.snapshotDigest,
    trial: event.trialId ?? event.runId,
    impact: isLead
      ? token(event.primitive ?? content?.primitive)
      : token(event.category ?? content?.impact),
    actor: token(content?.attackerPosition),
    keys: keysOf(ends),
  });
}

// --------------------------------------------------------------- grouping

// Connected components over members in ledger order, scoped by Snapshot; the
// root of a component is its first member (same rule as overlapComponents).
const parent = members.map((_, index) => index);
const root = (index) => {
  while (parent[index] !== index) index = parent[index];
  return index;
};
const owner = new Map();
for (const [index, member] of members.entries())
  for (const key of member.keys) {
    const scoped = `${member.snapshotDigest}\u0000${key}`;
    const earlier = owner.get(scoped);
    if (earlier === undefined) owner.set(scoped, index);
    else {
      const [left, right] = [root(earlier), root(index)];
      parent[Math.max(left, right)] = Math.min(left, right);
    }
  }

const components = new Map();
for (const [index, member] of members.entries()) {
  const at = root(index);
  if (!components.has(at)) components.set(at, []);
  components.get(at).push(member);
}

const sorted = (items) =>
  [...new Set(items.filter((item) => item !== undefined))].sort();
const groups = [...components.values()].map((group) => {
  const representative =
    group.find((member) => member.kind === "lead") ?? group[0];
  return {
    groupId: sha256(
      JSON.stringify([
        representative.campaignId,
        representative.kind,
        representative.id,
      ]),
    ),
    snapshotDigest: representative.snapshotDigest,
    representative: {
      kind: representative.kind,
      id: representative.id,
      campaignId: representative.campaignId,
    },
    members: group.length,
    leads: group.filter((member) => member.kind === "lead").length,
    findings: group.filter((member) => member.kind === "finding").length,
    trials: new Set(group.map((member) => member.trial)).size,
    impacts: sorted(
      group.map((member) =>
        member.impact === undefined
          ? undefined
          : `${member.kind === "lead" ? "lead" : "finding"}:${member.impact}`,
      ),
    ),
    actors: sorted(group.map((member) => member.actor)),
  };
});
groups.sort(
  (a, b) =>
    b.members - a.members ||
    b.trials - a.trials ||
    a.groupId.localeCompare(b.groupId),
);

const summary = {
  rule: values.rule,
  snapshots: new Set(members.map((member) => member.snapshotDigest)).size,
  leads: members.filter((member) => member.kind === "lead").length,
  findings: members.filter((member) => member.kind === "finding").length,
  withoutSourceTrace: unreadable,
  groups: groups.length,
  groupsWithLead: groups.filter((group) => group.leads > 0).length,
  groupsWithAtLeastTwoMembers: groups.filter((group) => group.members >= 2)
    .length,
  groupsInAtLeastTwoTrials: groups.filter((group) => group.trials >= 2).length,
  groupsWithLeadAndFinding: groups.filter(
    (group) => group.leads > 0 && group.findings > 0,
  ).length,
};

if (values.json) {
  console.log(JSON.stringify({ summary, groups }, null, 2));
  process.exit(0);
}

const pad = (value, width) => String(value).padEnd(width);
const out = [];
out.push(
  `${pad("group", 14)}${pad("snapshot", 14)}${pad("representative", 16)}${pad("members", 8)}${pad("L", 4)}${pad("F", 4)}${pad("trials", 7)}${pad("impacts", 40)}actor`,
);
for (const group of groups)
  out.push(
    `${pad(short(group.groupId), 14)}${pad(short(group.snapshotDigest), 14)}${pad(`${group.representative.kind === "lead" ? "L" : "F"}:${short(group.representative.id)}`, 16)}${pad(group.members, 8)}${pad(group.leads, 4)}${pad(group.findings, 4)}${pad(group.trials, 7)}${pad(group.impacts.join(",") || "-", 40)}${group.actors.join(",") || "-"}`,
  );
out.push("");
out.push(
  `rule=${summary.rule} snapshots=${summary.snapshots} leads=${summary.leads} findings=${summary.findings} without-sourceTrace=${summary.withoutSourceTrace}`,
);
out.push(
  `groups=${summary.groups} with-lead=${summary.groupsWithLead} members>=2=${summary.groupsWithAtLeastTwoMembers} trials>=2=${summary.groupsInAtLeastTwoTrials} lead+finding=${summary.groupsWithLeadAndFinding}`,
);
console.log(out.join("\n"));
