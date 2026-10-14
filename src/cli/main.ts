#!/usr/bin/env node
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCli, type CliIo } from "./index.js";
import {
  createWordPressHostProfile,
  loadWordPressHostConfig,
} from "./wordpress-host.js";
import { openWordPressReviewLab } from "../profiles/wordpress/lab/review-lab.js";
import { SqliteRepeatTrialGate } from "../profiles/wordpress/discovery/repeat-trial-gate.js";
import { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import { runNativeModelProcess } from "../infrastructure/native-model-process.js";
import { recoverHostClaim } from "./resource-recovery.js";

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
    (args[1] === "bootstrap" || args[1] === "approve")
  ) {
    if (args.length !== 4 || args[2] !== "--file" || args[3] === undefined)
      throw new Error(
        "Use trial bootstrap|approve --file <Git-outside JSON path>",
      );
    const value: unknown = JSON.parse(await readFile(resolve(args[3]), "utf8"));
    if (args[1] === "bootstrap") {
      const result = repeatTrialGate.bootstrap(value);
      io.stdout(
        `Trial gate initialized; imported ${result.importedTrials} prior starts`,
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
  const resourceClaims = new SqliteHostResourceClaims(
    join(
      homedir(),
      ".local",
      "state",
      "wordpress-bounty-harness",
      "host-resources.sqlite",
    ),
    host.resourceLimits ?? { maxTargets: 1, providers: { codex: 1 } },
  );
  try {
    if (args.length === 2 && args[0] === "resources" && args[1] === "status") {
      io.stdout(JSON.stringify(resourceClaims.status()));
      return 0;
    }
    if (args[0] === "resources" && args[1] === "recover") {
      if (args.length !== 4 || args[2] !== "--claim")
        throw new Error("Use resources recover --claim <claim id>");
      const result = await recoverHostClaim({
        claims: resourceClaims,
        claimId: args[3]!,
        docker: {
          async run(request) {
            const processResult = await runNativeModelProcess({
              executablePath: host.dockerExecutablePath,
              args: request.args,
              workingDirectory: "/",
              environment: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                LANG: "C",
                LC_ALL: "C",
                TZ: "UTC",
              },
              timeoutMs: request.timeoutMs,
              maxOutputBytes: request.maxOutputBytes,
            });
            return processResult.kind === "exited"
              ? processResult
              : { exitCode: -1, stdout: "", stderr: processResult.stderr };
          },
        },
      });
      io.stdout(
        JSON.stringify({
          status: result.released ? "released" : "recovery-needed",
          reportDigest: result.reportDigest,
          recoveryEligibleAt: result.recoveryEligibleAt,
          unresolvedRunCount: result.unresolvedRunIds.length,
          leftoverCounts: Object.fromEntries(
            Object.entries(result.leftovers).map(([kind, names]) => [
              kind,
              names.length,
            ]),
          ),
        }),
      );
      return result.released ? 0 : 1;
    }
    const baseProfile = await createWordPressHostProfile({
      host,
      repeatTrialGate,
      resourceClaims,
      onResourceWait: (reason) =>
        io.stderr(`Waiting for host resources: ${reason}`),
    });
    const profile = {
      ...baseProfile,
      reviewLab: (
        state: Parameters<NonNullable<typeof baseProfile.reviewLab>>[0],
        input: { readonly packageDigest: string; readonly category: string },
      ) => openWordPressReviewLab({ host, store: state.store, ...input }),
    };
    return await runCli(
      args,
      {
        stateDirectory:
          process.env.WBH_STATE_DIRECTORY ??
          join(homedir(), ".local", "state", "wordpress-bounty-harness"),
        profile,
      },
      io,
    );
  } finally {
    resourceClaims.close();
  }
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
