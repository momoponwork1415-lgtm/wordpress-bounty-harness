import { openState } from "../dist/cli/state.js";
import {
  inspectParkedWordPressFinding,
  restoreParkedWordPressFinding,
} from "../dist/profiles/wordpress/discovery/restore-parked-finding.js";

const usage =
  "node scripts/restore-parked-finding.mjs --state <private-state-dir> --campaign <id> --finding <id> [--apply]";
const apply = process.argv.includes("--apply");
const values = process.argv.slice(2).filter((value) => value !== "--apply");
const args = new Map();
for (let index = 0; index < values.length; index += 2) {
  const key = values[index];
  const value = values[index + 1];
  if (!key?.startsWith("--") || !value || args.has(key)) throw new Error(usage);
  args.set(key, value);
}
if (
  args.size !== 3 ||
  ["--state", "--campaign", "--finding"].some((key) => !args.has(key))
)
  throw new Error(usage);

const campaignId = args.get("--campaign");
const findingId = args.get("--finding");
const state = await openState(args.get("--state"), {}, { readOnly: !apply });
const options = {
  ledger: state.ledger,
  evidence: state.store,
  campaignId,
  findingId,
};
if (apply) {
  const result = await restoreParkedWordPressFinding(options);
  console.log(JSON.stringify({ campaignId, findingId, ...result }));
} else {
  const result = await inspectParkedWordPressFinding(options);
  console.log(JSON.stringify({ campaignId, findingId, ...result }));
}
