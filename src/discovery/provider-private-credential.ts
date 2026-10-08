import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function readPrivateProviderCredential(
  path: string,
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("credential path is unavailable");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const expectedUid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid) ||
      metadata.size <= 0 ||
      metadata.size > 16_384
    ) {
      throw new Error("credential file is unavailable");
    }
    const value = (await handle.readFile("utf8")).trim();
    if (value.length < 8 || value.length > 16_384 || /[\0\r\n]/u.test(value)) {
      throw new Error("credential value is unavailable");
    }
    return value;
  } finally {
    await handle.close();
  }
}
