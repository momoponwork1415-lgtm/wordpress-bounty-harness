import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** True when a thrown value carries the given Node error code. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** Whether a path exists. Symbolic links are not followed unless asked. */
export async function pathExists(
  path: string,
  options: { readonly followSymbolicLinks?: boolean } = {},
): Promise<boolean> {
  try {
    await (options.followSymbolicLinks === true ? stat(path) : lstat(path));
    return true;
  } catch {
    return false;
  }
}

export async function persistImmutableFile(
  path: string,
  bytes: Uint8Array,
): Promise<"stored" | "conflict"> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(path);
    if (!existing.equals(bytes)) return "conflict";
  }
  return "stored";
}

/** For content-addressed paths where different bytes under one name are a defect. */
export async function persistContentAddressedFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  if ((await persistImmutableFile(path, bytes)) === "conflict") {
    throw new Error(`Content-addressed artifact conflict: ${path}`);
  }
}
