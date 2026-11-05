import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import {
  SourceAcquisitionError,
  type AcquiredSource,
} from "../../../snapshot/index.js";
import { acquiredSourceFromIntakePacket } from "./local-directory-target-intake.js";
import {
  targetIntakePacketSchema,
  targetIntakePolicySchema,
  type TargetIntakePacket,
  type TargetIntakePolicy,
} from "./contracts.js";
import { wordPressOrgPluginIdentity } from "../target-identity.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** An operator-pinned capture, stored outside Git after a revision-pinned export. */
export const capturedWordPressOrgSvnPinSchema = z.strictObject({
  kind: z.literal("captured-wordpress-org-svn-export"),
  storageDirectory: z.string().refine(isAbsolute),
  packetDigest: digestSchema,
  sourceTreeDigest: digestSchema,
  revision: z.number().int().positive(),
});

export type CapturedWordPressOrgSvnPin = z.infer<
  typeof capturedWordPressOrgSvnPinSchema
>;

export interface PinnedWordPressOrgSvnSource {
  readonly source: AcquiredSource;
  readonly packet: TargetIntakePacket;
}

/** Reopens a sealed SVN capture without fetching or executing the target. */
export async function openCapturedWordPressOrgSvnSource(options: {
  readonly pin: CapturedWordPressOrgSvnPin;
  readonly slug: string;
  readonly version: string;
  readonly policy: TargetIntakePolicy;
}): Promise<PinnedWordPressOrgSvnSource> {
  const pin = capturedWordPressOrgSvnPinSchema.parse(options.pin);
  const policy = targetIntakePolicySchema.parse(options.policy);
  let packet: TargetIntakePacket;
  try {
    packet = targetIntakePacketSchema.parse(
      JSON.parse(
        await readFile(
          join(
            pin.storageDirectory,
            "objects",
            `${pin.packetDigest.slice(7)}.json`,
          ),
          "utf8",
        ),
      ),
    );
  } catch {
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "captured-svn-packet-unavailable",
    });
  }
  const expectedUrl = `https://plugins.svn.wordpress.org/${options.slug}/trunk/`;
  const mainEntry = packet.sourceTree.manifest.entries.find(
    (entry) => entry.path === packet.mainPluginFile,
  );
  const directories = new Set<string>();
  let totalBytes = 0;
  const withinLimits = packet.sourceTree.manifest.entries.every((entry) => {
    totalBytes += entry.size;
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth++)
      directories.add(segments.slice(0, depth).join("/"));
    return (
      entry.size <= policy.limits.maxFileBytes &&
      Buffer.byteLength(entry.path, "utf8") <= policy.limits.maxPathBytes &&
      segments.length - 1 <= policy.limits.maxDepth
    );
  });
  if (
    canonicalDigest(packet) !== pin.packetDigest ||
    packet.policy.id !== policy.id ||
    packet.policy.digest !== policy.digest ||
    !withinLimits ||
    packet.sourceTree.manifest.entries.length + directories.size >
      policy.limits.maxEntries ||
    totalBytes > policy.limits.maxTotalBytes ||
    packet.pluginIdentity !== wordPressOrgPluginIdentity(options.slug) ||
    packet.canonicalInstallDirectory !== options.slug ||
    packet.version !== options.version ||
    packet.targetSnapshot.pluginSlug !== options.slug ||
    packet.targetSnapshot.version !== options.version ||
    packet.sourceTree.digest !== pin.sourceTreeDigest ||
    canonicalDigest(packet.sourceTree.manifest) !== pin.sourceTreeDigest ||
    packet.sourceTree.entries !== packet.sourceTree.manifest.entries.length ||
    packet.sourceCapture.kind !== "captured-wordpress-org-svn-export" ||
    packet.sourceCapture.digest !== pin.sourceTreeDigest ||
    canonicalJson(packet.sourceCapture.files) !==
      canonicalJson(packet.sourceTree.manifest.entries) ||
    packet.versionEvidence.requestedVersion !== options.version ||
    packet.versionEvidence.mainHeaderVersion !== options.version ||
    packet.versionEvidence.mainFileDigest !== mainEntry?.digest ||
    packet.provenance.kind !== "wordpress-org-svn" ||
    packet.provenance.sourceUrl !== expectedUrl ||
    packet.provenance.revision !== pin.revision ||
    packet.provenance.acquisitionRef.id !== `wporg-svn-r${pin.revision}` ||
    packet.provenance.acquisitionRef.digest !== pin.sourceTreeDigest
  )
    throw new SourceAcquisitionError("source-mismatch", {
      reason: "captured-svn-pin-mismatch",
    });
  return {
    packet,
    source: acquiredSourceFromIntakePacket(packet, pin.storageDirectory),
  };
}
