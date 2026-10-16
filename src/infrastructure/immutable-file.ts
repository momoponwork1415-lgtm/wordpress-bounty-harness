import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function persistImmutableFile(
  path: string,
  bytes: Uint8Array,
): Promise<"stored" | "conflict"> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(directory, ".immutable-"));
  const stagingPath = join(stagingDirectory, "record");
  try {
    await writeFile(stagingPath, bytes, { flag: "wx" });
    try {
      await link(stagingPath, path);
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
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
