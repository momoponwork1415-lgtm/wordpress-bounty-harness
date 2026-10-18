import { runNativeModelProcess } from "../../../infrastructure/native-model-process.js";

export type DockerRequest = {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};
export type DockerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
export interface DockerRunner {
  run(request: DockerRequest): Promise<DockerResult>;
}

export class LabDockerFailure extends Error {
  constructor(readonly diagnostic: string) {
    super("gVisor Lab command failed");
  }
}

/** Runs one Docker command and reports its exit status without throwing. */
export type RunDocker = (
  args: readonly string[],
  timeoutMs?: number,
  maxOutputBytes?: number,
) => Promise<DockerResult>;
/** Runs one Docker command and throws `LabDockerFailure` on a non-zero exit. */
export type RequireDocker = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<DockerResult>;
/** Runs WP-CLI in a throwaway runsc container on the session's Lab network. */
export type WordPressCommand = (
  args: readonly string[],
  environment?: readonly string[],
) => Promise<DockerResult>;

export interface LabDocker {
  readonly run: RunDocker;
  readonly require: RequireDocker;
}

export function nativeDockerRunner(executablePath: string): DockerRunner {
  return {
    async run(request: DockerRequest): Promise<DockerResult> {
      const result = await runNativeModelProcess({
        executablePath,
        args: request.args,
        ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
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
      return result.kind === "exited"
        ? result
        : { exitCode: -1, stdout: "", stderr: result.stderr };
    },
  };
}

export function createLabDocker(runner: DockerRunner): LabDocker {
  const run: RunDocker = (
    args,
    timeoutMs = 60_000,
    maxOutputBytes = 64 * 1024,
  ) => runner.run({ args, timeoutMs, maxOutputBytes });
  return {
    run,
    async require(args, timeoutMs) {
      const result = await run(args, timeoutMs);
      if (result.exitCode !== 0)
        throw new LabDockerFailure(
          result.stderr ||
            result.stdout ||
            `Docker command exited with status ${result.exitCode}`,
        );
      return result;
    },
  };
}
