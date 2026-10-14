#!/usr/bin/env node
import { homedir } from "node:os";
import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCli, type CliIo } from "./index.js";
import {
  createWordPressHostProfile,
  loadWordPressHostConfig,
} from "./wordpress-host.js";
import { openWordPressReviewLab } from "../profiles/wordpress/lab/review-lab.js";
import { SqliteRepeatTrialGate } from "../profiles/wordpress/discovery/repeat-trial-gate.js";
import { auditLegacyCoveragePlan } from "../profiles/wordpress/discovery/legacy-coverage-audit.js";
import {
  privateExistingAuditPath,
  privateNewAuditPath,
} from "../infrastructure/private-audit-path.js";

const io: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  async askMinutes(action) {
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await terminal.question(`${action} に使った分数: `);
      if (!/^\d+(?:\.\d{1,2})?$/.test(answer) || Number(answer) > 1440)
        throw new Error("分数は 0〜1440、少数第2位までで入力してください");
      return Number(answer);
    } finally {
      terminal.close();
    }
  },
};

/** `harness [--host <path>] [--state <dir>] <command>`; the host file stays outside Git. */
async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args[0] === "trial" && args[1] === "coverage-audit") {
    if (
      args.length !== 6 ||
      args[2] !== "--file" ||
      args[3] === undefined ||
      args[4] !== "--out" ||
      args[5] === undefined
    )
      throw new Error(
        "Use trial coverage-audit --file <Git-outside plan.json> --out <Git-outside candidate.json>",
      );
    const planPath = await privateExistingAuditPath(args[3]);
    const outputPath = await privateNewAuditPath(args[5]);
    if (planPath === outputPath)
      throw new Error("Audit output must differ from the input plan");
    const value: unknown = JSON.parse(await readFile(planPath, "utf8"));
    const result = await auditLegacyCoveragePlan(value);
    const output = await open(outputPath, "wx", 0o600);
    try {
      await output.writeFile(`${JSON.stringify(result.candidate, null, 2)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    io.stdout(JSON.stringify(result.publicSummary));
    return 0;
  }
  // This path is deliberately independent of --state / WBH_STATE_DIRECTORY.
  // Every host CLI process must share one Trial index.
  const repeatTrialGate = new SqliteRepeatTrialGate(
    join(
      homedir(),
      ".local",
      "state",
      "wordpress-bounty-harness",
      "repeat-trials.sqlite",
    ),
  );
  let hostPath = process.env.WBH_HOST_CONFIG;
  const at = args.indexOf("--host");
  if (at >= 0) {
    hostPath = args[at + 1];
    args.splice(at, 2);
  }
  if (
    args[0] === "trial" &&
    (args[1] === "bootstrap" ||
      args[1] === "approve" ||
      args[1] === "coverage-import")
  ) {
    if (args.length !== 4 || args[2] !== "--file" || args[3] === undefined)
      throw new Error(
        "Use trial bootstrap|approve|coverage-import --file <Git-outside JSON path>",
      );
    const value: unknown = JSON.parse(await readFile(resolve(args[3]), "utf8"));
    if (args[1] === "bootstrap") {
      const result = repeatTrialGate.bootstrap(value);
      io.stdout(
        `Trial gate initialized; imported ${result.importedTrials} prior starts`,
      );
    } else if (args[1] === "coverage-import") {
      const coverageDigest = repeatTrialGate.importCoverage(value);
      io.stdout(
        `Legacy coverage imported: ${coverageDigest}; no discovery started`,
      );
    } else {
      repeatTrialGate.approve(value);
      io.stdout("One exact additional Trial approved; no discovery started");
    }
    return 0;
  }
  if (hostPath === undefined || hostPath.length === 0) {
    io.stderr(
      "A host configuration is required: --host <path> or WBH_HOST_CONFIG",
    );
    return 2;
  }
  const host = await loadWordPressHostConfig(resolve(hostPath));
  const baseProfile = await createWordPressHostProfile({
    host,
    repeatTrialGate,
  });
  const profile = {
    ...baseProfile,
    reviewLab: (
      state: Parameters<NonNullable<typeof baseProfile.reviewLab>>[0],
      input: { readonly packageDigest: string; readonly category: string },
    ) => openWordPressReviewLab({ host, store: state.store, ...input }),
  };
  return runCli(
    args,
    {
      stateDirectory:
        process.env.WBH_STATE_DIRECTORY ??
        join(homedir(), ".local", "state", "wordpress-bounty-harness"),
      profile,
    },
    io,
  );
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    io.stderr(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
