import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** One host and one Unix user share this path, regardless of campaign state. */
export const HOST_LAB_LEASE_DIRECTORY = join(
  homedir(),
  ".local",
  "state",
  "wordpress-bounty-harness-host",
);

const ownerSchema = z.strictObject({
  pid: z.number().int().positive(),
  bootId: z.string().min(1),
  startTicks: z.string().regex(/^\d+$/),
});
const reservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("lab"),
    labId: z.string().uuid(),
    phase: z.enum(["active", "cleanup-needed"]),
    token: z.string().uuid(),
    owner: ownerSchema,
  }),
  z.strictObject({
    kind: z.literal("sweep"),
    token: z.string().uuid(),
    owner: ownerSchema,
  }),
]);
export type HostLabReservation = z.infer<typeof reservationSchema>;
type Owner = z.infer<typeof ownerSchema>;

const paths = (directory: string) => ({
  lock: join(directory, "verification.lock"),
  reservation: join(directory, "verification.json"),
});

/** Linux's process start tick disambiguates a reused pid after a crash. */
async function startTicks(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  if (ticks === undefined || !/^\d+$/.test(ticks))
    throw new Error("Host Lab owner identity is unavailable");
  return ticks;
}

async function ownerNow(): Promise<Owner> {
  return {
    pid: process.pid,
    bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    startTicks: await startTicks(process.pid),
  };
}

async function ownerAlive(owner: Owner): Promise<boolean> {
  const bootId = (
    await readFile("/proc/sys/kernel/random/boot_id", "utf8")
  ).trim();
  if (bootId !== owner.bootId) return false;
  try {
    return (await startTicks(owner.pid)) === owner.startTicks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readReservation(
  path: string,
): Promise<HostLabReservation | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return reservationSchema.parse(JSON.parse(raw) as unknown);
}

async function publishReservation(
  path: string,
  reservation: HostLabReservation,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(reservation), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * `flock` owns the kernel lock while its stdin stays open. A crashed Node
 * parent closes the pipe, so a later process can acquire without pid-file races.
 */
async function acquireFlock(
  path: string,
  waitMs: number,
): Promise<ChildProcessWithoutNullStreams | null> {
  const child = spawn(
    "/usr/bin/flock",
    [
      "-x",
      "-E",
      "75",
      ...(waitMs === 0 ? ["-n"] : ["-w", String(waitMs / 1000)]),
      path,
      "/bin/sh",
      "-c",
      "printf 'LOCKED\\n'; cat >/dev/null",
    ],
    { stdio: "pipe" },
  );
  // An unexpected holder exit can close the pipe before its caller releases it.
  child.stdin.on("error", () => undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let diagnostic = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!settled && output.includes("LOCKED\n")) {
        settled = true;
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString("utf8").slice(0, 1024);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 75) resolve(null);
      else reject(new Error(`Host Lab lock failed: ${diagnostic || code}`));
    });
  });
}

export interface HostLabLease {
  readonly reservation: HostLabReservation | null;
  /** The previous process is gone, or explicitly ended a failed cleanup. */
  recover(
    hasLabResources: (labId: string) => Promise<boolean>,
  ): Promise<
    | { readonly status: "ready" }
    | { readonly status: "blocked"; readonly reason: string }
  >;
  reserveLab(labId: string): Promise<void>;
  reserveSweep(): Promise<void>;
  cleanupNeeded(): Promise<void>;
  clear(): Promise<void>;
  release(): Promise<void>;
}

/** Null means another process held the lease until the bounded wait expired. */
export async function acquireHostLabLease(input: {
  readonly directory?: string;
  readonly waitMs: number;
}): Promise<HostLabLease | null> {
  if (!Number.isSafeInteger(input.waitMs) || input.waitMs < 0)
    throw new Error("Host Lab lock wait must be nonnegative");
  const directory = input.directory ?? HOST_LAB_LEASE_DIRECTORY;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = paths(directory);
  const child = await acquireFlock(path.lock, input.waitMs);
  if (child === null) return null;
  try {
    const owner = await ownerNow();
    const token = randomUUID();
    let reservation = await readReservation(path.reservation);
    let released = false;
    let closed: number | null | undefined;
    const closure = new Promise<number | null>((resolve) =>
      child.once("close", (code) => {
        closed = code;
        resolve(code);
      }),
    );
    const assertHeld = () => {
      if (
        released ||
        closed !== undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error("Host Lab lock was lost");
    };
    const owned = async (): Promise<HostLabReservation> => {
      assertHeld();
      const current = await readReservation(path.reservation);
      if (current === null || current.token !== token)
        throw new Error("Host Lab reservation ownership was lost");
      return current;
    };
    return {
      get reservation() {
        return reservation;
      },
      async recover(hasLabResources) {
        assertHeld();
        if (reservation === null) return { status: "ready" };
        const alive = await ownerAlive(reservation.owner);
        if (
          alive &&
          (reservation.kind === "sweep" || reservation.phase === "active")
        )
          return {
            status: "blocked",
            reason:
              "A live process still owns the previous Host Lab reservation",
          };
        if (
          reservation.kind === "lab" &&
          (await hasLabResources(reservation.labId))
        )
          return {
            status: "blocked",
            reason: `Lab ${reservation.labId} remains after a prior verification; inspect and remove it before retry`,
          };
        await rm(path.reservation);
        reservation = null;
        return { status: "ready" };
      },
      async reserveLab(labId) {
        assertHeld();
        if (reservation !== null)
          throw new Error("Host Lab reservation exists");
        const next: HostLabReservation = {
          kind: "lab",
          labId,
          phase: "active",
          token,
          owner,
        };
        await publishReservation(path.reservation, next);
        assertHeld();
        reservation = next;
      },
      async reserveSweep() {
        assertHeld();
        if (reservation !== null)
          throw new Error("Host Lab reservation exists");
        const next: HostLabReservation = { kind: "sweep", token, owner };
        await publishReservation(path.reservation, next);
        assertHeld();
        reservation = next;
      },
      async cleanupNeeded() {
        const current = await owned();
        if (current.kind !== "lab")
          throw new Error("Only a Lab can need cleanup");
        const next: HostLabReservation = {
          ...current,
          phase: "cleanup-needed",
        };
        await publishReservation(path.reservation, next);
        reservation = next;
      },
      async clear() {
        await owned();
        await rm(path.reservation);
        reservation = null;
      },
      async release() {
        if (released) return;
        released = true;
        if (
          closed !== undefined ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          throw new Error("Host Lab lock was lost before release");
        child.stdin.end();
        const exit = await closure;
        if (exit !== 0) throw new Error("Host Lab lock release failed");
      },
    };
  } catch (error) {
    child.stdin.end();
    throw error;
  }
}
