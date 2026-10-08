import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type NativeModelProcessResult =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "timed-out" | "output-limit-exceeded";
      readonly stdout: string;
      readonly stderr: string;
    };

export interface NativeModelProcessRunOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly redact?: (text: string) => string;
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    )) {
      throw error;
    }
  }
}

export function runNativeModelProcess(
  options: NativeModelProcessRunOptions,
): Promise<NativeModelProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executablePath, options.args, {
      cwd: options.workingDirectory,
      detached: process.platform !== "win32",
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalKind: "timed-out" | "output-limit-exceeded" | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (kind: "timed-out" | "output-limit-exceeded"): void => {
      if (terminalKind !== undefined) return;
      terminalKind = kind;
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
      }, 2_000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => terminate("timed-out"), options.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxOutputBytes) {
        terminate("output-limit-exceeded");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes;
      if (remaining <= 0) return;
      const kept = chunk.subarray(0, remaining);
      stderr.push(kept);
      stderrBytes += kept.byteLength;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      reject(error);
    });
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signalProcessTree(child, "SIGKILL");
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      const redact = options.redact ?? ((text: string) => text);
      const stdoutText = redact(Buffer.concat(stdout).toString("utf8"));
      const stderrText = redact(Buffer.concat(stderr).toString("utf8"));
      if (terminalKind !== undefined) {
        signalProcessTree(child, "SIGKILL");
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve({ kind: terminalKind, stdout: stdoutText, stderr: stderrText });
        return;
      }
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        kind: "exited",
        exitCode: exitCode ?? -1,
        stdout: stdoutText,
        stderr: stderrText,
      });
    });

    if (options.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.stdin, "utf8");
    }
  });
}
