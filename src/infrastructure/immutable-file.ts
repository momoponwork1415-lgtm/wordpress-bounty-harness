import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function persistImmutableFile(
  path: string,
  bytes: Uint8Array,
): Promise<"stored" | "conflict"> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const existing = await readFile(path);
    if (!existing.equals(bytes)) return "conflict";
  }
  return "stored";
}
