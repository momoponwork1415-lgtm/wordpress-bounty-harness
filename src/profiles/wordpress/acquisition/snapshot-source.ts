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
import type { TargetIntakePacket } from "./contracts.js";
import {
  openCapturedWordPressOrgSvnSource,
  type CapturedWordPressOrgSvnPin,
} from "./pinned-svn-source.js";

export type WordPressSnapshotAcquireRequest = WordPressOrgAcquireRequest & {
  readonly capturedSvnTarget?: {
    readonly slug: string;
    readonly pin: CapturedWordPressOrgSvnPin;
  };
};

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
  readonly pluginDependencies?: (
    packet: TargetIntakePacket,
    pins: Readonly<Record<string, string>>,
    slugs: readonly string[],
    versionPolicy: "stable-observed" | "pinned-only",
    targetSource: AcquiredSource,
  ) => Promise<readonly AcquiredSource[]>;
}): SourceAcquisition<WordPressSnapshotAcquireRequest> {
  return {
    async acquire(selection) {
      let packet: TargetIntakePacket;
      let target: AcquiredSource;
      if (selection.capturedSvnTarget !== undefined) {
        const imported = await openCapturedWordPressOrgSvnSource({
          pin: selection.capturedSvnTarget.pin,
          slug: selection.capturedSvnTarget.slug,
          version: selection.requestedVersion,
          policy: selection.policy,
        });
        packet = imported.packet;
        target = imported.source;
      } else {
        const { capturedSvnTarget: _capturedSvnTarget, ...archiveRequest } =
          selection;
        const acquired = await options.targetSource.acquire(archiveRequest);
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
        packet = acquired.intake.packet;
        const files = new Map(
          packet.sourceTree.manifest.entries.map((entry) => [
            entry.path,
            entry.digest,
          ]),
        );
        target = {
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
      }
      return {
        target,
        dependencies: [
          ...((await options.dependencies?.()) ?? []),
          ...((await options.pluginDependencies?.(
            packet,
            selection.pluginDependencyPins ?? {},
            selection.pluginDependencySlugs ?? [],
            selection.dependencyVersionPolicy ?? "pinned-only",
            target,
          )) ?? []),
        ],
      };
    },
  };
}
