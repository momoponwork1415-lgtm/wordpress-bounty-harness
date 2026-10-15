import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

const LOCK_CONFLICT_EXIT = 73;

export class ContinuousLockBusyError extends Error {
  constructor() {
    super("continuous run already holds this state lock");
    this.name = "ContinuousLockBusyError";
  }
}

/**
 * `flock` locks fd 3, which is the same open file description held by this
 * process. Its exit code is the acquisition handshake; closing the parent FD
 * (including on SIGKILL) releases the lock. Never unlink the lock file.
 */
export async function acquireContinuousLock(
  stateDirectory: string,
): Promise<{ release(): Promise<void> }> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const file = await open(
    join(stateDirectory, "continuous.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error("continuous.lock must be a regular file");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        "flock",
        ["-n", "-E", String(LOCK_CONFLICT_EXIT), "3"],
        {
          stdio: ["ignore", "ignore", "ignore", file.fd],
        },
      );
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (status === null)
          reject(new Error(`flock exited on signal ${signal ?? "unknown"}`));
        else resolve(status);
      });
    });
    if (code === LOCK_CONFLICT_EXIT) throw new ContinuousLockBusyError();
    if (code !== 0) throw new Error(`flock failed with exit code ${code}`);
    return { release: () => file.close() };
  } catch (error) {
    await file.close();
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("flock is required for continuous run");
    throw error;
  }
}
