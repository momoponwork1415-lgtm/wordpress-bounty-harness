#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { runCli, type CliIo } from "./index.js";
import {
  createWordPressHostProfile,
  loadWordPressHostConfig,
} from "./wordpress-host.js";

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
  let hostPath = process.env.WBH_HOST_CONFIG;
  const at = args.indexOf("--host");
  if (at >= 0) {
    hostPath = args[at + 1];
    args.splice(at, 2);
  }
  if (hostPath === undefined || hostPath.length === 0) {
    io.stderr(
      "A host configuration is required: --host <path> or WBH_HOST_CONFIG",
    );
    return 2;
  }
  const host = await loadWordPressHostConfig(resolve(hostPath));
  const profile = await createWordPressHostProfile({ host });
  return runCli(
    args,
    {
      stateDirectory:
        process.env.WBH_STATE_DIRECTORY ??
        join(homedir(), ".local", "state", "wordpress-bounty-harness"),
      ...(process.env.WBH_FINDING_GROUP_KEY_CACHE === undefined
        ? {}
        : {
            findingGroupKeyCachePath: process.env.WBH_FINDING_GROUP_KEY_CACHE,
          }),
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
