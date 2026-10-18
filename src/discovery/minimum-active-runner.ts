/** Runs inside the disposable gVisor container, never on the host. */
export const MINIMUM_ACTIVE_RUNNER_SOURCE = String.raw`
import { spawn } from "node:child_process";

const minimumActiveMs = Number(process.argv[2]);
const initialArgs = JSON.parse(process.argv[3]);
const resumeArgs = JSON.parse(process.argv[4]);
const resumePrompt = process.argv[5];
// Operator-triggered resume of an earlier segment: the Root thread already exists.
const resumeThreadId = process.argv[6];
if (
  !Number.isSafeInteger(minimumActiveMs) ||
  minimumActiveMs <= 0 ||
  !Array.isArray(initialArgs) ||
  !Array.isArray(resumeArgs) ||
  typeof resumePrompt !== "string" ||
  resumePrompt.length === 0 ||
  (resumeThreadId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(resumeThreadId))
) {
  process.exit(2);
}

let initialPrompt = "";
for await (const chunk of process.stdin) initialPrompt += chunk.toString();
let threadId = resumeThreadId;
let activeChild;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => activeChild?.kill(signal));
}

async function turn(args, prompt) {
  const child = spawn("codex", args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  activeChild = child;
  child.stdin.end(prompt);
  let pending = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    pending += text;
    let next;
    while ((next = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, next);
      pending = pending.slice(next + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          if (threadId !== undefined && event.thread_id !== threadId)
            throw new Error("A resumed turn changed Root thread identity");
          threadId = event.thread_id;
        }
      } catch (error) {
        if (error.message === "A resumed turn changed Root thread identity") {
          child.kill("SIGTERM");
          process.exitCode = 2;
        }
      }
    }
  });
  const exitCode = await new Promise((resolve) => {
    child.on("error", () => resolve(2));
    child.on("close", (code) => resolve(code ?? 2));
  });
  activeChild = undefined;
  return exitCode;
}

const startedAt = Date.now();
let exitCode;
if (resumeThreadId === undefined) {
  exitCode = await turn(initialArgs, initialPrompt);
  if (exitCode !== 0 || process.exitCode === 2) process.exit(exitCode || 2);
  if (threadId === undefined) process.exit(2);
} else {
  // The first turn of a resumed segment continues the restored thread with the
  // same pinned directive; the initial objective is not sent again.
  exitCode = await turn([...resumeArgs, threadId, "-"], resumePrompt);
  if (exitCode !== 0 || process.exitCode === 2) process.exit(exitCode || 2);
}

while (Date.now() - startedAt < minimumActiveMs) {
  exitCode = await turn([...resumeArgs, threadId, "-"], resumePrompt);
  if (exitCode !== 0 || process.exitCode === 2) process.exit(exitCode || 2);
}
`;
