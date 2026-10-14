import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

async function assertOutsideGit(directory: string): Promise<void> {
  for (let current = directory; ; current = dirname(current)) {
    try {
      await lstat(join(current, ".git"));
      throw new Error("Coverage audit files must stay outside Git");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !Reflect.has(error, "code") ||
        Reflect.get(error, "code") !== "ENOENT"
      )
        throw error;
    }
    if (current === dirname(current)) return;
  }
}

export async function privateExistingAuditFile(
  value: string,
): Promise<{ readonly path: string; readonly identity: string }> {
  if (!isAbsolute(value))
    throw new Error("Coverage audit paths must be absolute");
  const original = await lstat(value, { bigint: true });
  if (!original.isFile() || original.isSymbolicLink())
    throw new Error("Coverage audit input is not a regular file");
  const path = await realpath(value);
  await assertOutsideGit(dirname(path));
  const current = await lstat(path, { bigint: true });
  if (
    !current.isFile() ||
    current.dev !== original.dev ||
    current.ino !== original.ino
  )
    throw new Error("Coverage audit input changed while validating");
  return { path, identity: `${original.dev}:${original.ino}` };
}

export async function privateNewAuditPath(value: string): Promise<string> {
  if (!isAbsolute(value))
    throw new Error("Coverage audit paths must be absolute");
  const parent = await realpath(dirname(value));
  await assertOutsideGit(parent);
  return join(parent, basename(value));
}
