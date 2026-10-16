import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wbh-continuous-lock-"));
  roots.push(root);
  for (const name of ["continuous-lock", "continuous"]) {
    const source = await readFile(
      new URL(`../../src/cli/${name}.ts`, import.meta.url),
      "utf8",
    );
    await writeFile(
      join(root, `${name}.ts`),
      source.replace('"./continuous-lock.js"', '"./continuous-lock.ts"'),
    );
  }
  const worker = join(root, "worker.mjs");
  await writeFile(
    worker,
    `import { createContinuousRunner } from "./continuous.ts";
process.stdout.write("READY " + process.pid + "\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
process.stdin.pause();
const runner = createContinuousRunner({
  stateDirectory: process.argv[2],
  campaignPrefix: "prod",
  ledger: { read: () => [] },
  select: async () => {
    process.stdout.write("SELECT " + process.pid + "\\n");
    return { batchId: "selection-1", targets: ["x"] };
  },
  runCampaign: async () => {
    process.stdout.write("CAMPAIGN " + process.pid + "\\n");
    await new Promise(() => setInterval(() => undefined, 1000));
  },
  cleanupLeftovers: async () => {
    process.stdout.write("CLEANUP " + process.pid + "\\n");
    return 0;
  },
  preflight: async () => undefined,
  legacyHistoryAvailable: async () => true,
  floorPolicyAvailable: async () => true,
  readAuth: async () => ({ expiresAt: new Date(Date.now() + 30 * 86_400_000) }),
  programmeObservedAt: async () => new Date(),
  statfs: async () => ({ freeBytes: 100 * 1024 ** 3 }),
  loginMarginMinutes: 600,
  clock: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signals: process,
  pid: process.pid,
  io: { log: () => undefined },
});
try {
  await runner.run();
} catch (error) {
  process.stdout.write("ERROR " + error.message + "\\n");
  process.exitCode = 1;
}
`,
  );
  return { root, worker, state: join(root, "state") };
}

function launch(worker: string, state: string, env = process.env) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", worker, state],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString()));
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    closed,
    output: () => output,
    error: () => error,
    go: () => child.stdin.end("go\n"),
  };
}

const stripTypesAvailable =
  spawnSync(process.execPath, ["--experimental-strip-types", "-e", ""], {
    stdio: "ignore",
  }).status === 0;
const linuxIt =
  process.platform === "linux" && stripTypesAvailable ? it : it.skip;

linuxIt(
  "allows one of two processes to start work and releases on SIGKILL",
  async () => {
    const { worker, state } = await fixture();
    const first = launch(worker, state);
    const second = launch(worker, state);
    let third: ReturnType<typeof launch> | undefined;
    try {
      await vi.waitFor(() => expect(first.output()).toContain("READY"), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(second.output()).toContain("READY"), {
        timeout: 10_000,
      });
      first.go();
      second.go();
      await vi.waitFor(
        () =>
          expect(
            [first, second].filter((run) => run.output().includes("CAMPAIGN")),
          ).toHaveLength(1),
        { timeout: 10_000 },
      );
      const winner = first.output().includes("CAMPAIGN") ? first : second;
      const loser = winner === first ? second : first;
      expect(winner.output()).toContain("SELECT");
      await vi.waitFor(() => expect(loser.output()).toContain("ERROR"), {
        timeout: 10_000,
      });
      expect(loser.output()).toContain("state lock");
      expect(loser.output()).not.toContain("CLEANUP");
      expect(loser.output()).not.toContain("SELECT");
      expect(loser.output()).not.toContain("CAMPAIGN");
      expect((await loser.closed).code).toBe(1);

      winner.child.kill("SIGKILL");
      expect((await winner.closed).signal).toBe("SIGKILL");
      third = launch(worker, state);
      await vi.waitFor(() => expect(third?.output()).toContain("READY"), {
        timeout: 10_000,
      });
      third.go();
      await vi.waitFor(() => expect(third?.output()).toContain("CAMPAIGN"), {
        timeout: 10_000,
      });
      // The crashed campaign is resumed under its saved id, without reselecting.
      expect(third.output()).not.toContain("SELECT");
    } finally {
      first.child.kill("SIGKILL");
      second.child.kill("SIGKILL");
      third?.child.kill("SIGKILL");
      await Promise.all([first.closed, second.closed, third?.closed]);
    }
  },
  25_000,
);

linuxIt("does not start work when flock is unavailable", async () => {
  const { worker, state } = await fixture();
  const run = launch(worker, state, { ...process.env, PATH: "/nonexistent" });
  try {
    await vi.waitFor(() => expect(run.output()).toContain("READY"), {
      timeout: 10_000,
    });
    run.go();
    expect((await run.closed).code).toBe(1);
    expect(run.output()).toContain("flock is required");
    expect(run.output()).not.toContain("CLEANUP");
    expect(run.output()).not.toContain("SELECT");
    expect(run.output()).not.toContain("CAMPAIGN");
  } finally {
    run.child.kill("SIGKILL");
    await run.closed;
  }
});
