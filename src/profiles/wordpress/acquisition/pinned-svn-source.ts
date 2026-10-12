import { join } from "node:path";

import { canonicalJson } from "../../../infrastructure/canonical-json.js";
import {
  verifyCanonicalSourceTree,
  type ExpectedSourceTree,
} from "../../../infrastructure/canonical-source-tree.js";
import { persistImmutableFile } from "../../../infrastructure/immutable-file.js";
import type { AcquiredSource } from "../../../snapshot/index.js";
import { openLocalDirectoryTargetIntake } from "./local-directory-target-intake.js";
import { acquiredSourceFromIntakePacket } from "./intake-packet-source.js";
import type { TargetIntakePacket, TargetIntakePolicy } from "./contracts.js";

export interface PinnedWordPressOrgSvnSource {
  readonly source: AcquiredSource;
  readonly packet: TargetIntakePacket;
}

/**
 * Captures an already exported, revision-pinned WordPress.org SVN tree.
 * The caller performs `svn export -r`; this boundary never relabels it as a ZIP.
 */
export async function acquirePinnedWordPressOrgSvnSource(options: {
  readonly sourceDirectory: string;
  readonly storageDirectory: string;
  readonly slug: string;
  readonly version: string;
  readonly mainPluginFile: string;
  readonly sourceUrl: string;
  readonly revision: number;
  readonly expectedTree: ExpectedSourceTree;
  readonly policy: TargetIntakePolicy;
}): Promise<PinnedWordPressOrgSvnSource> {
  const url = new URL(options.sourceUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "plugins.svn.wordpress.org" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== `/${options.slug}/trunk/` ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isSafeInteger(options.revision) ||
    options.revision < 1
  )
    throw new Error("Expected a pinned WordPress.org SVN trunk source");

  const observed = await verifyCanonicalSourceTree(
    options.sourceDirectory,
    options.expectedTree,
  );
  if (!observed.matches)
    throw new Error("SVN export differs from its pinned source tree");

  const intake = openLocalDirectoryTargetIntake({
    storageDirectory: options.storageDirectory,
    sourceCaptureKind: "captured-wordpress-org-svn-export",
  });
  const disposition = await intake.intake({
    kind: "manual-target-intake",
    schemaVersion: 1,
    source: { kind: "local-directory", path: options.sourceDirectory },
    pluginIdentity: { kind: "wporg", slug: options.slug },
    requestedVersion: options.version,
    mainPluginFile: options.mainPluginFile,
    provenance: {
      kind: "wordpress-org-svn",
      sourceUrl: options.sourceUrl,
      revision: options.revision,
      acquisitionRef: {
        id: `wporg-svn-r${options.revision}`,
        digest: options.expectedTree.digest,
      },
    },
    policy: options.policy,
  });
  if (disposition.status !== "ready")
    throw new Error(
      `SVN target intake ${disposition.status}: ${disposition.reasons.join(", ")}`,
    );
  const packet = disposition.packet;
  const bytes = packet.sourceTree.manifest.entries.reduce(
    (total, entry) => total + entry.size,
    0,
  );
  if (
    packet.sourceTree.digest !== options.expectedTree.digest ||
    packet.sourceTree.entries !== options.expectedTree.entries ||
    bytes !== options.expectedTree.bytes
  )
    throw new Error("Captured SVN source differs from its pinned source tree");
  if (
    (await persistImmutableFile(
      join(
        options.storageDirectory,
        "objects",
        `${options.expectedTree.digest.slice(7)}.json`,
      ),
      Buffer.from(canonicalJson(packet.sourceTree.manifest)),
    )) !== "stored"
  )
    throw new Error("SVN export manifest artifact conflict");
  return {
    packet,
    source: acquiredSourceFromIntakePacket(packet, options.storageDirectory),
  };
}
