import { resolve } from "node:path";

import { openState } from "../dist/cli/state.js";
import { ProviderAttachmentStore } from "../dist/discovery/index.js";
import {
  recoverWordPressChildReports,
  recoverWordPressChildTurnReports,
} from "../dist/profiles/wordpress/discovery/recover-child-reports.js";

const usage =
  "node scripts/recover-child-reports.mjs --campaign <id> --state <private-state-dir> --attachments <private-provider-attachments-dir> [--mode failed|turns] [--dry-run]";
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === "--dry-run") {
    args.set(key, true);
    continue;
  }
  const value = process.argv[++index];
  if (!key?.startsWith("--") || !value) throw new Error(usage);
  args.set(key, value);
}
for (const key of ["--campaign", "--state", "--attachments"])
  if (!args.has(key)) throw new Error(usage);
const mode = args.get("--mode") ?? "failed";
if (mode !== "failed" && mode !== "turns") throw new Error(usage);
const dryRun = args.get("--dry-run") === true;
if (dryRun && mode !== "turns")
  throw new Error("--dry-run is available with --mode turns only");
// A dry run opens the state read-only: nothing is written anywhere.
const state = await openState(args.get("--state"), {}, { readOnly: dryRun });
const options = {
  campaignId: args.get("--campaign"),
  ledger: state.ledger,
  evidence: state.store,
  attachments: new ProviderAttachmentStore(resolve(args.get("--attachments"))),
};
const result =
  mode === "turns"
    ? await recoverWordPressChildTurnReports({ ...options, dryRun })
    : await recoverWordPressChildReports(options);
const skipped =
  "skipped" in result && result.skipped > 0
    ? ` Skipped ${result.skipped} children whose Root has not finished.`
    : "";
console.log(
  (dryRun
    ? `Dry run: ${result.recovered} child reports would add ${result.findings} findings and ${result.leads} leads (before parking and holds). Nothing was written.`
    : `Recovered ${result.recovered} child reports, ${result.findings} findings, ${result.leads} leads into the append-only ledger.`) +
    skipped,
);
