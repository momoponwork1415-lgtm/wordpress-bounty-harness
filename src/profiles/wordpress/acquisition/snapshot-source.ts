import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  SourceAcquisitionError,
  type AcquiredSource,
  type SourceAcquisition,
  type SourceAcquisitionFailureKind,
} from "../../../snapshot/index.js";
import type {
  WordPressOrgAcquireRequest,
  WordPressOrgAcquisitionResult,
  WordPressOrgTargetSource,
} from "./wordpress-org-contracts.js";

function failureKind(
  acquired: Exclude<WordPressOrgAcquisitionResult, { status: "ready" }>,
): SourceAcquisitionFailureKind {
  if (acquired.status === "rejected") return "invalid-archive";
  if (acquired.status === "deferred") return "deferred";
  if ("diagnostic" in acquired && acquired.diagnostic?.kind !== undefined)
    return acquired.diagnostic.kind;
  switch (acquired.reason) {
    case "not-found":
    case "rate-limited":
      return "http-response";
    case "metadata-archive-mismatch":
    case "requested-version-mismatch":
      return "source-mismatch";
    case "quota-exceeded":
      return "quota-exceeded";
    case "network-failure":
      return "network";
  }
}

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
        throw new SourceAcquisitionError(failureKind(acquired), {
          status: acquired.status,
          ...("reason" in acquired ? { reason: acquired.reason } : {}),
          ...("reasons" in acquired ? { reasons: acquired.reasons } : {}),
          ...("diagnostic" in acquired && acquired.diagnostic !== undefined
            ? { transport: acquired.diagnostic }
            : {}),
        });
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
