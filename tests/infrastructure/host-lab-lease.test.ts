import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireHostLabLease } from "../../src/infrastructure/host-lab-lease.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "wbh-host-lab-lease-"));
  directories.push(root);
  return root;
}

const acquire = (root: string) =>
  acquireHostLabLease({ directory: root, waitMs: 0 });

describe("host verification Lab lease", () => {
  it("excludes another process and releases its kernel lock when that process dies", async () => {
    const root = await directory();
    const supervisor = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require('node:child_process');
         const child = spawn('/usr/bin/flock', ['-x', '${join(root, "verification.lock")}', '/bin/sh', '-c', "printf 'READY\\n'; cat >/dev/null"], { stdio: 'pipe' });
         child.stdout.once('data', (bytes) => process.stdout.write(bytes));
         child.on('error', (error) => { process.stderr.write(error.message); process.exit(1); });
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        supervisor.stdout.once("data", (bytes: Buffer) =>
          bytes.toString("utf8").includes("READY")
            ? resolve()
            : reject(new Error("Lock holder did not become ready")),
        );
        supervisor.once("error", reject);
        supervisor.once("exit", () => reject(new Error("Lock holder exited")));
      });
      expect(await acquire(root)).toBeNull();
    } finally {
      supervisor.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        supervisor.once("close", () => resolve()),
      );
    }
    const lease = await acquireHostLabLease({ directory: root, waitMs: 1000 });
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it("keeps a failed Lab cleanup blocked until its exact resources disappear", async () => {
    const root = await directory();
    const labId = randomUUID();
    const original = await acquire(root);
    expect(original).not.toBeNull();
    await original!.reserveLab(labId);
    await original!.cleanupNeeded();
    await original!.release();

    const blocked = await acquire(root);
    expect(blocked).not.toBeNull();
    expect(await blocked!.recover(async (id) => id === labId)).toMatchObject({
      status: "blocked",
    });
    await blocked!.release();

    const recovered = await acquire(root);
    expect(recovered).not.toBeNull();
    expect(await recovered!.recover(async () => false)).toEqual({
      status: "ready",
    });
    await recovered!.reserveLab(randomUUID());
    await recovered!.clear();
    await recovered!.release();
  });

  it("fails closed when a live owner loses the lock during an active Lab", async () => {
    const root = await directory();
    const original = await acquire(root);
    expect(original).not.toBeNull();
    await original!.reserveLab(randomUUID());
    await original!.release();

    const next = await acquire(root);
    expect(next).not.toBeNull();
    expect(await next!.recover(async () => false)).toMatchObject({
      status: "blocked",
    });
    await next!.release();
  });

  it("recovers a crashed owner's reservation only after its Lab is gone", async () => {
    const root = await directory();
    const labId = randomUUID();
    const original = await acquire(root);
    expect(original).not.toBeNull();
    await original!.reserveLab(labId);
    await original!.release();
    const reservationPath = join(root, "verification.json");
    const record = JSON.parse(await readFile(reservationPath, "utf8")) as {
      owner: { bootId: string };
    };
    record.owner.bootId = "previous-boot";
    await writeFile(reservationPath, JSON.stringify(record));

    const blocked = await acquire(root);
    expect(blocked).not.toBeNull();
    expect(await blocked!.recover(async (id) => id === labId)).toMatchObject({
      status: "blocked",
    });
    await blocked!.release();

    const recovered = await acquire(root);
    expect(recovered).not.toBeNull();
    expect(await recovered!.recover(async () => false)).toEqual({
      status: "ready",
    });
    await recovered!.release();
  });

  it("recovers a sweep reservation an older runner left after its death (#526)", async () => {
    const root = await directory();
    await writeFile(
      join(root, "verification.json"),
      JSON.stringify({
        kind: "sweep",
        token: randomUUID(),
        owner: { pid: 1, bootId: "previous-boot", startTicks: "1" },
      }),
    );
    const lease = await acquire(root);
    expect(lease).not.toBeNull();
    expect(await lease!.recover(async () => true)).toEqual({ status: "ready" });
    await lease!.reserveLab(randomUUID());
    await lease!.clear();
    await lease!.release();
  });
});
