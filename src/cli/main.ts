#!/usr/bin/env node
import { homedir } from "node:os";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCli, type CliIo } from "./index.js";
import { openState } from "./index.js";
import {
  createWordPressHostProfile,
  loadWordPressHostConfig,
} from "./wordpress-host.js";
import { openWordPressReviewLab } from "../profiles/wordpress/lab/review-lab.js";
import { wordPressReviewFindingReady } from "../profiles/wordpress/review-finding-readiness.js";
import { SqliteRepeatTrialGate } from "../profiles/wordpress/discovery/repeat-trial-gate.js";
import { SqliteHostResourceClaims } from "../infrastructure/host-resource-claims.js";
import {
  assertContinuousStateDirectory,
  SqliteContinuousRunJournal,
} from "../infrastructure/continuous-run-journal.js";
import { SqliteContinuousRunOwner } from "../infrastructure/continuous-run-owner.js";
import { canonicalDigest } from "../infrastructure/canonical-json.js";
import { runNativeModelProcess } from "../infrastructure/native-model-process.js";
import { recoverHostClaim } from "./resource-recovery.js";
import { runContinuousControl } from "./continuous-control.js";
import { continuousReviewExportCheck } from "./continuous-review-readiness.js";
import { runContinuousParent } from "./continuous-runner.js";
import { assertInitialContinuousInventory } from "./continuous-preflight.js";

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
  const repeatTrialGatePath = join(
    homedir(),
    ".local",
    "state",
    "wordpress-bounty-harness",
    "repeat-trials.sqlite",
  );
  let hostPath = process.env.WBH_HOST_CONFIG;
  const at = args.indexOf("--host");
  if (at >= 0) {
    hostPath = args[at + 1];
    args.splice(at, 2);
  }
  let stateDirectory =
    process.env.WBH_STATE_DIRECTORY ??
    join(homedir(), ".local", "state", "wordpress-bounty-harness");
  const stateAt = args.indexOf("--state");
  if (stateAt >= 0) {
    if (args[stateAt + 1] === undefined)
      throw new Error("Use --state <directory>");
    stateDirectory = resolve(args[stateAt + 1]!);
    args.splice(stateAt, 2);
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
    const repeatTrialGate = new SqliteRepeatTrialGate(repeatTrialGatePath);
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
  if (
    args[0] === "continuous" &&
    (args[1] === "status" || args[1] === "stop")
  ) {
    const journal = new SqliteContinuousRunJournal(
      join(
        homedir(),
        ".local",
        "state",
        "wordpress-bounty-harness",
        "continuous-runs.sqlite",
      ),
    );
    try {
      // A stop request must reach the host-common journal even if the selected
      // campaign state or Private Evidence cannot currently be opened.
      if (args[1] === "stop")
        return await runContinuousControl(args, journal, io);
      if (args.length !== 4 || args[2] !== "--run" || !args[3])
        throw new Error("Use continuous status --run <parent run id>");
      const parent = journal.get(args[3]);
      if (parent === null) throw new Error("Continuous run not found");
      const physicalStateDirectory = await realpath(stateDirectory);
      assertContinuousStateDirectory(parent, physicalStateDirectory);
      const state = await openState(physicalStateDirectory, {});
      return await runContinuousControl(args, journal, io, {
        ledger: state.ledger,
        reviewExportReady: continuousReviewExportCheck(
          state,
          undefined,
          (request) => wordPressReviewFindingReady(state, request),
        ),
      });
    } finally {
      journal.close();
    }
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
    const repeatTrialGate = new SqliteRepeatTrialGate(repeatTrialGatePath);
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
    if (args[0] === "continuous") {
      const [group, action, runFlag, parentRunId, configFlag, configPath] =
        args;
      if (
        group !== "continuous" ||
        (action !== "start" && action !== "resume") ||
        runFlag !== "--run" ||
        parentRunId === undefined ||
        configFlag !== "--config" ||
        configPath === undefined ||
        args.length !== 6
      )
        throw new Error(
          "Use continuous start|resume --run <parent id> --config <campaign path>",
        );
      const selectedConfigPath = resolve(configPath);
      const configDigest = canonicalDigest(
        JSON.parse(await readFile(selectedConfigPath, "utf8")) as unknown,
      );
      const journal = new SqliteContinuousRunJournal(
        join(
          homedir(),
          ".local",
          "state",
          "wordpress-bounty-harness",
          "continuous-runs.sqlite",
        ),
      );
      const owner = new SqliteContinuousRunOwner(
        join(
          homedir(),
          ".local",
          "state",
          "wordpress-bounty-harness",
          "continuous-owners.sqlite",
        ),
      );
      try {
        if (action === "start")
          await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
        const physicalStateDirectory = await realpath(stateDirectory);
        if (action === "resume") {
          const parent = journal.get(parentRunId);
          if (parent === null) throw new Error("Continuous run not found");
          assertContinuousStateDirectory(parent, physicalStateDirectory);
          if (parent.configDigest !== configDigest)
            throw new Error("Continuous parent campaign config changed");
        }
        const state = await openState(physicalStateDirectory, {});
        if (action === "start") {
          if (journal.get(parentRunId) !== null)
            throw new Error("Continuous parent already exists; use resume");
          const policyDigest = await profile.continuousPolicyDigest!(state, {
            configPath: selectedConfigPath,
          });
          const inventory = await profile.collectInventory(state, {
            configPath: selectedConfigPath,
          });
          assertInitialContinuousInventory(inventory);
          const observedConfigDigest = canonicalDigest(
            JSON.parse(await readFile(selectedConfigPath, "utf8")) as unknown,
          );
          const observedPolicyDigest = await profile.continuousPolicyDigest!(
            state,
            {
              configPath: selectedConfigPath,
            },
          );
          if (
            observedConfigDigest !== configDigest ||
            observedPolicyDigest !== policyDigest
          )
            throw new Error(
              "Continuous parent config or selection policy changed during inventory collection",
            );
          journal.create({
            parentRunId,
            stateDirectory: physicalStateDirectory,
            configDigest,
            policyDigest,
            inventoryDigest: inventory.inventoryDigest,
          });
        } else {
          assertContinuousStateDirectory(
            journal.get(parentRunId)!,
            physicalStateDirectory,
          );
        }
        const result = await runContinuousParent({
          parentRunId,
          configPath: selectedConfigPath,
          configDigest,
          state,
          profile,
          journal,
          owner,
          claims: resourceClaims,
          io,
          findingRecordReady: (request) =>
            wordPressReviewFindingReady(state, request),
        });
        io.stdout(
          JSON.stringify({
            parentRunId,
            state: result.state,
            reason: result.reason,
            children: result.children.length,
          }),
        );
        return result.state === "RECOVERING" ? 1 : 0;
      } finally {
        owner.close();
        journal.close();
      }
    }
    return await runCli(
      args,
      {
        stateDirectory,
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
