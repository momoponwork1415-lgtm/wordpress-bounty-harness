import { resolve, join } from "node:path";

import { PrivateArtifactStore } from "../../../infrastructure/private-artifact-store.js";
import { Ledger } from "../../../ledger/index.js";
import { ProviderAttachmentStore } from "../../../discovery/provider-research-report.js";
import { reacceptWordPressRun } from "./reaccept-candidates.js";

/** Offline reinterpretation: reads sealed reports and appends events; never starts a Lab. */
async function main(args: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || flags.has(key))
      throw new Error(
        "Expected unique --state, --attachments, --campaign and --run options",
      );
    flags.set(key, value);
  }
  const state = flags.get("--state");
  const attachmentRoot = flags.get("--attachments");
  const campaignId = flags.get("--campaign");
  const runId = flags.get("--run");
  if (flags.size !== 4 || !state || !attachmentRoot || !campaignId || !runId)
    throw new Error("Expected --state, --attachments, --campaign and --run");
  const root = resolve(state);
  const evidence = new PrivateArtifactStore({
    rootDirectory: join(root, "private-evidence"),
    maxEntries: 64,
    maxBytes: 72 * 1024 * 1024,
  });
  const ledger = new Ledger({
    databasePath: join(root, "ledger.sqlite"),
    artifactStore: evidence,
  });
  const result = await reacceptWordPressRun({
    campaignId,
    runId,
    ledger,
    evidence,
    attachments: new ProviderAttachmentStore(resolve(attachmentRoot)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Reacceptance failed"}\n`,
  );
  process.exitCode = 1;
});
