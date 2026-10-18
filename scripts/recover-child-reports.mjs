import { join, resolve } from "node:path";

import { ProviderAttachmentStore } from "../dist/discovery/index.js";
import { PrivateArtifactStore } from "../dist/infrastructure/private-artifact-store.js";
import { Ledger } from "../dist/ledger/index.js";
import { recoverWordPressChildReports } from "../dist/profiles/wordpress/discovery/recover-child-reports.js";

const usage =
  "node scripts/recover-child-reports.mjs --campaign <id> --state <private-state-dir> --attachments <private-provider-attachments-dir>";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(usage);
  args.set(key, value);
}
for (const key of ["--campaign", "--state", "--attachments"])
  if (!args.has(key)) throw new Error(usage);
const stateDirectory = resolve(args.get("--state"));
const store = new PrivateArtifactStore({
  rootDirectory: join(stateDirectory, "private-evidence"),
  maxEntries: 64,
  maxBytes: 72 * 1024 * 1024,
});
const ledger = new Ledger({
  databasePath: join(stateDirectory, "ledger.sqlite"),
  artifactStore: store,
});
const result = await recoverWordPressChildReports({
  campaignId: args.get("--campaign"),
  ledger,
  evidence: store,
  attachments: new ProviderAttachmentStore(resolve(args.get("--attachments"))),
});
console.log(
  `Recovered ${result.recovered} child reports, ${result.findings} findings, ${result.leads} leads into the append-only ledger.`,
);
