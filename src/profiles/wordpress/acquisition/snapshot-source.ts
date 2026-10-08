import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AcquiredSource,
  SourceAcquisition,
} from "../../../snapshot/index.js";
import type {
  WordPressOrgAcquireRequest,
  WordPressOrgTargetSource,
} from "./wordpress-org-contracts.js";

/** Bridges the WordPress.org acquisition receipt to the generic snapshot contract. */
export function openWordPressOrgSnapshotSource(options: {
  readonly targetSource: WordPressOrgTargetSource;
  readonly storageDirectory: string;
  readonly dependencies?: () => Promise<readonly AcquiredSource[]>;
}): SourceAcquisition<WordPressOrgAcquireRequest> {
  return {
    async acquire(selection) {
      const acquired = await options.targetSource.acquire(selection);
      if (acquired.status !== "ready") {
        throw new Error(
          `Source acquisition did not complete: ${acquired.status}`,
        );
      }
      const packet = acquired.intake.packet;
      const files = new Map(
        packet.sourceTree.manifest.entries.map((entry) => [
          entry.path,
          entry.digest,
        ]),
      );
      const target: AcquiredSource = {
        identity: packet.pluginIdentity,
        version: packet.version,
        manifest: packet.sourceTree.manifest,
        async readFile(path) {
          const digest = files.get(path);
          if (digest === undefined)
            throw new Error("File is absent from source manifest");
          return readFile(
            join(
              options.storageDirectory,
              "target-intake",
              "blobs",
              digest.slice(7),
            ),
          );
        },
      };
      return {
        target,
        dependencies: (await options.dependencies?.()) ?? [],
      };
    },
  };
}
