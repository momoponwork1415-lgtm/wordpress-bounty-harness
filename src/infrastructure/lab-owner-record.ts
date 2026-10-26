import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

/**
 * One file per live Lab, shared by every state directory of one host user.
 * It is not a lock: nothing waits on it and any number of Labs may run (#432).
 * It only tells a broad cleanup which Labs still have a living owner.
 */
export const LAB_OWNER_DIRECTORY = join(
  homedir(),
  ".local",
  "state",
  "wordpress-bounty-harness-host",
  "lab-owners",
);

const labIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ownerSchema = z.strictObject({
  pid: z.number().int().positive(),
  bootId: z.string().min(1),
  startTicks: z.string().regex(/^\d+$/),
});
type Owner = z.infer<typeof ownerSchema>;
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  labId: z.string().regex(labIdPattern),
  owner: ownerSchema,
});
/**
 * The single-slot lease that #415 wrote (deleted in #432). A process built
 * before #432 may still hold a Lab under it; read it so a broad cleanup in a
 * newer process leaves that Lab alone. Remove once no such process remains.
 */
const legacyReservationSchema = z.looseObject({
  kind: z.literal("lab"),
  labId: z.string().regex(labIdPattern),
  owner: ownerSchema,
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
    throw new Error("Lab owner identity is unavailable");
  return ticks;
}

const bootId = async () =>
  (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

async function ownerAlive(owner: Owner, currentBoot: string): Promise<boolean> {
  if (currentBoot !== owner.bootId) return false;
  try {
    return (await startTicks(owner.pid)) === owner.startTicks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const recordPath = (directory: string, id: string) =>
  join(directory, `${id}.json`);

export interface OwnerRecord {
  /** Removes the record; call only once the owned resources are gone. */
  release(): Promise<void>;
}
export type LabOwnerRecord = OwnerRecord;

/** Writes one owner record for this process, atomically, before the resource exists. */
async function writeOwnerRecord(
  directory: string,
  id: string,
  body: (owner: Owner) => unknown,
): Promise<OwnerRecord> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const record = body({
    pid: process.pid,
    bootId: await bootId(),
    startTicks: await startTicks(process.pid),
  });
  const path = recordPath(directory, id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { release: () => rm(path, { force: true }) };
}

/** Records this process as the owner of `labId` before any of its resources exist. */
export async function recordLabOwner(input: {
  readonly labId: string;
  readonly directory?: string;
}): Promise<LabOwnerRecord> {
  if (!labIdPattern.test(input.labId)) throw new Error("Lab id is invalid");
  return writeOwnerRecord(
    input.directory ?? LAB_OWNER_DIRECTORY,
    input.labId,
    (owner) =>
      recordSchema.parse({ schemaVersion: 1, labId: input.labId, owner }),
  );
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // An unreadable record is not proof that its Lab is free.
    return null;
  }
}

/**
 * The ids in `directory` whose recorded owner process still lives, and those
 * whose owner is gone. A record that cannot be read counts as live: removing
 * a resource needs positive proof that nobody owns it.
 */
async function readOwners(
  directory: string,
  idPattern: RegExp,
  ownerOf: (raw: unknown, id: string) => Owner | undefined,
): Promise<{ live: Set<string>; dead: Set<string>; currentBoot: string }> {
  const live = new Set<string>();
  const dead = new Set<string>();
  const currentBoot = await bootId();
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!idPattern.test(id)) continue;
    const raw = await readJson(join(directory, name));
    if (raw === undefined) continue;
    const owner = ownerOf(raw, id);
    if (owner === undefined || (await ownerAlive(owner, currentBoot)))
      live.add(id);
    else dead.add(id);
  }
  return { live, dead, currentBoot };
}

/**
 * Lab ids whose recorded owner process still lives, and the records whose
 * owner is gone. A record that cannot be read counts as live: removing a
 * Lab needs positive proof that nobody owns it.
 */
export async function readLabOwners(directory = LAB_OWNER_DIRECTORY): Promise<{
  readonly live: ReadonlySet<string>;
  readonly dead: ReadonlySet<string>;
}> {
  const { live, dead, currentBoot } = await readOwners(
    directory,
    labIdPattern,
    (raw, labId) => {
      const parsed = recordSchema.safeParse(raw);
      return parsed.success && parsed.data.labId === labId
        ? parsed.data.owner
        : undefined;
    },
  );
  const legacy = legacyReservationSchema.safeParse(
    await readJson(join(dirname(directory), "verification.json")),
  );
  if (legacy.success && (await ownerAlive(legacy.data.owner, currentBoot)))
    live.add(legacy.data.labId);
  for (const labId of live) dead.delete(labId);
  return { live, dead };
}

/** Removes the records of Labs whose owner died, after their resources were removed. */
export async function forgetLabOwners(
  labIds: Iterable<string>,
  directory = LAB_OWNER_DIRECTORY,
): Promise<void> {
  for (const labId of labIds)
    if (labIdPattern.test(labId))
      await rm(recordPath(directory, labId), { force: true });
}

/**
 * One file per live disposable discovery resource (an agent container, a
 * broker container, a grant network), named after the Docker resource and
 * shared by every state directory and checkout of one host user. Like a Lab's
 * record it is not a lock: it only tells a broad cleanup which discovery
 * resources still have a living owner (#550).
 */
export const DISCOVERY_OWNER_DIRECTORY = join(
  dirname(LAB_OWNER_DIRECTORY),
  "discovery-owners",
);

/** Docker's container and network name grammar. */
const resourceNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const resourceRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resource: z.string().regex(resourceNamePattern),
  owner: ownerSchema,
});

/** Records this process as the owner of the Docker resource `resource` before it exists. */
export async function recordDiscoveryOwner(input: {
  readonly resource: string;
  readonly directory?: string;
}): Promise<OwnerRecord> {
  if (!resourceNamePattern.test(input.resource))
    throw new Error("Discovery resource name is invalid");
  return writeOwnerRecord(
    input.directory ?? DISCOVERY_OWNER_DIRECTORY,
    input.resource,
    (owner) =>
      resourceRecordSchema.parse({
        schemaVersion: 1,
        resource: input.resource,
        owner,
      }),
  );
}

/** Discovery resource names whose owner process lives, and those whose owner is gone. */
export async function readDiscoveryOwners(
  directory = DISCOVERY_OWNER_DIRECTORY,
): Promise<{
  readonly live: ReadonlySet<string>;
  readonly dead: ReadonlySet<string>;
}> {
  const { live, dead } = await readOwners(
    directory,
    resourceNamePattern,
    (raw, resource) => {
      const parsed = resourceRecordSchema.safeParse(raw);
      return parsed.success && parsed.data.resource === resource
        ? parsed.data.owner
        : undefined;
    },
  );
  return { live, dead };
}

/** Removes the records of discovery resources whose owner died, after the resources were removed. */
export async function forgetDiscoveryOwners(
  resources: Iterable<string>,
  directory = DISCOVERY_OWNER_DIRECTORY,
): Promise<void> {
  for (const resource of resources)
    if (resourceNamePattern.test(resource))
      await rm(recordPath(directory, resource), { force: true });
}
