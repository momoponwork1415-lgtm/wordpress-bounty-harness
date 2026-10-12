import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const waiterUrl = pathToFileURL(
  join(process.cwd(), "src/profiles/wordpress/lab/review-lab-wait.ts"),
).href;

function startWaiter(releaseAfterMs?: number) {
  const source = `
    import { createReviewLabWaiter } from ${JSON.stringify(waiterUrl)};
    const waiter = createReviewLabWaiter();
    const waiting = waiter.wait();
    console.log("READY");
    ${releaseAfterMs === undefined ? "" : `setTimeout(() => waiter.release(), ${releaseAfterMs});`}
    await waiting;
    console.log("DONE", process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"));
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return { child, output: () => ({ stdout, stderr }) };
}

async function ready(
  child: ChildProcess,
  output: () => { stdout: string; stderr: string },
) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`review waiter did not start: ${output().stderr}`));
    }, 5_000);
    const onData = () => {
      if (!output().stdout.includes("READY\n")) return;
      cleanup();
      resolve();
    };
    const onExit = () => {
      cleanup();
      reject(
        new Error(`review waiter exited before ready: ${output().stderr}`),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

describe("review Lab process wait", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "keeps the child alive until %s, then removes both signal listeners",
    async (signal) => {
      const { child, output } = startWaiter();
      try {
        await ready(child, output);
        await delay(150);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();

        const closed = once(child, "close");
        expect(child.kill(signal)).toBe(true);
        const [code, terminationSignal] = await closed;
        expect({ code, terminationSignal }, output().stderr).toEqual({
          code: 0,
          terminationSignal: null,
        });
        expect(output().stdout).toContain("DONE 0 0");
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    },
  );

  it("releases a pending wait on explicit close without retaining signals", async () => {
    const { child, output } = startWaiter(100);
    try {
      await ready(child, output);
      const [code, terminationSignal] = await once(child, "close");
      expect({ code, terminationSignal }, output().stderr).toEqual({
        code: 0,
        terminationSignal: null,
      });
      expect(output().stdout).toContain("DONE 0 0");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  });
});
