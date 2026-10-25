import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  forgetLabOwners,
  readLabOwners,
  recordLabOwner,
} from "../../src/infrastructure/lab-owner-record.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function ownerDirectory() {
  const root = await mkdtemp(join(tmpdir(), "wbh-lab-owner-"));
  directories.push(root);
  return join(root, "lab-owners");
}

const deadOwner = { pid: 1, bootId: "previous-boot", startTicks: "1" };

describe("Lab owner records", () => {
  it("keeps one record per Lab, so any number of Labs are live at once", async () => {
    const directory = await ownerDirectory();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const records = await Promise.all(
      ids.map((labId) => recordLabOwner({ labId, directory })),
    );
    expect((await readLabOwners(directory)).live).toEqual(new Set(ids));
    await records[0]!.release();
    expect(await readLabOwners(directory)).toEqual({
      live: new Set(ids.slice(1)),
      dead: new Set(),
    });
    expect((await readdir(directory)).sort()).toEqual(
      ids
        .slice(1)
        .map((id) => `${id}.json`)
        .sort(),
    );
  });

  it("counts a record whose process exited or whose boot ended as dead", async () => {
    const directory = await ownerDirectory();
    const exited = randomUUID();
    // Another process owns this Lab while it lives.
    const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid!;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTicks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19]!;
    const bootId = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${exited}.json`),
      JSON.stringify({
        schemaVersion: 1,
        labId: exited,
        owner: { pid, bootId, startTicks },
      }),
    );
    expect((await readLabOwners(directory)).live).toEqual(new Set([exited]));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    const rebooted = randomUUID();
    await writeFile(
      join(directory, `${rebooted}.json`),
      JSON.stringify({ schemaVersion: 1, labId: rebooted, owner: deadOwner }),
    );
    expect(await readLabOwners(directory)).toEqual({
      live: new Set(),
      dead: new Set([exited, rebooted]),
    });
    await forgetLabOwners([exited], directory);
    expect((await readLabOwners(directory)).dead).toEqual(new Set([rebooted]));
  });

  it("treats an unreadable record as live: removal needs proof nobody owns the Lab", async () => {
    const directory = await ownerDirectory();
    await mkdir(directory, { recursive: true });
    const labId = randomUUID();
    await writeFile(join(directory, `${labId}.json`), "{not json");
    await writeFile(join(directory, "notes.txt"), "ignored");
    expect((await readLabOwners(directory)).live).toEqual(new Set([labId]));
  });

  it("honours a Lab that a pre-#432 process still holds under the old host lease", async () => {
    const directory = await ownerDirectory();
    const legacy = join(directory, "..", "verification.json");
    const record = await recordLabOwner({ labId: randomUUID(), directory });
    const [own] = await readdir(directory);
    // This process's own identity, as the old lease wrote it.
    const { owner } = JSON.parse(
      await readFile(join(directory, own!), "utf8"),
    ) as { owner: unknown };
    await record.release();
    const held = randomUUID();
    await writeFile(
      legacy,
      JSON.stringify({
        kind: "lab",
        labId: held,
        phase: "active",
        token: randomUUID(),
        owner,
      }),
    );
    expect((await readLabOwners(directory)).live).toEqual(new Set([held]));
    await writeFile(
      legacy,
      JSON.stringify({ kind: "lab", labId: held, owner: deadOwner }),
    );
    expect((await readLabOwners(directory)).live.size).toBe(0);
  });

  it("rejects an id that is not a Lab id", async () => {
    await expect(
      recordLabOwner({ labId: "../escape", directory: await ownerDirectory() }),
    ).rejects.toThrow("Lab id is invalid");
  });
});
