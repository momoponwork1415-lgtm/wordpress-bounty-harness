import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AcquiredSource } from "../../../snapshot/index.js";
import type { TargetIntakePacket } from "./contracts.js";

/** Reads only the captured bytes named by an intake packet. */
export function acquiredSourceFromIntakePacket(
  packet: TargetIntakePacket,
  intakeStorageDirectory: string,
): AcquiredSource {
  const files = new Map(
    packet.sourceTree.manifest.entries.map((entry) => [
      entry.path,
      entry.digest,
    ]),
  );
  return {
    identity: packet.pluginIdentity,
    version: packet.version,
    manifest: packet.sourceTree.manifest,
    async readFile(path) {
      const digest = files.get(path);
      if (digest === undefined)
        throw new Error("File is absent from source manifest");
      return readFile(join(intakeStorageDirectory, "blobs", digest.slice(7)));
    },
  };
}
