import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { z } from "zod";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import { privateExistingAuditPath } from "../../../infrastructure/private-audit-path.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const sourceClass = z.enum([
  "state-ledgers",
  "legacy-research-databases",
  "legacy-queues",
  "archives",
]);
const sourceEntry = z.strictObject({
  path: z.string().min(1),
  evidencePath: z.string().min(1),
});

/** An operator's explicit roster. This does not assert that the roster is exhaustive. */
export const legacyCoverageAuditPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  stateInventoryDigest: digest,
  sources: z.array(
    z.strictObject({
      sourceClass,
      entries: z.array(sourceEntry),
    }),
  ),
});

/** Metadata extracted and reviewed separately; no event body or payload is accepted. */
export const legacyCoverageAuditEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceDigest: digest,
  records: z.array(
    z.discriminatedUnion("classification", [
      z.strictObject({
        recordId: z.string().min(1).max(512),
        classification: z.literal("confirmed-start"),
        slug: slug.optional(),
      }),
      z.strictObject({
        recordId: z.string().min(1).max(512),
        classification: z.literal("possible-start"),
        slug: slug.optional(),
      }),
      z.strictObject({
        recordId: z.string().min(1).max(512),
        classification: z.literal("not-start"),
      }),
    ]),
  ),
});

type ClassifiedRecord = z.infer<
  typeof legacyCoverageAuditEvidenceSchema
>["records"][number];

type RecordReference = {
  readonly sourceDigest: string;
  readonly evidenceDigest: string;
  readonly recordId: string;
  readonly classification: ClassifiedRecord["classification"];
};

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function stableFile(path: string): Promise<{
  readonly bytes: Buffer;
  readonly digest: string;
  readonly identity: string;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new Error("Audit source or evidence is not a regular file");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const atPath = await lstat(path, { bigint: true });
    if (!unchanged(before, after) || !unchanged(before, atPath))
      throw new Error("Audit source or evidence changed while reading");
    return {
      bytes,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      identity: `${before.dev}:${before.ino}`,
    };
  } finally {
    await handle.close();
  }
}

async function stableFileDigest(path: string): Promise<{
  readonly digest: string;
  readonly identity: string;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new Error("Audit source or evidence is not a regular file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    const atPath = await lstat(path, { bigint: true });
    if (!unchanged(before, after) || !unchanged(before, atPath))
      throw new Error("Audit source or evidence changed while reading");
    return {
      digest: `sha256:${hash.digest("hex")}`,
      identity: `${before.dev}:${before.ino}`,
    };
  } finally {
    await handle.close();
  }
}

function addReference(
  map: Map<string, RecordReference[]>,
  value: string,
  reference: RecordReference,
): void {
  const references = map.get(value) ?? [];
  references.push(reference);
  map.set(value, references);
}

/**
 * A dry-run only. The result deliberately cannot pass repeatTrialCoverageManifestSchema:
 * completeness, source freeze, auditor identity, and owner approval are external facts.
 */
export async function auditLegacyCoveragePlan(value: unknown) {
  const plan = legacyCoverageAuditPlanSchema.parse(value);
  const classes = plan.sources.map((entry) => entry.sourceClass);
  if (classes.length !== 4 || new Set(classes).size !== 4)
    throw new Error(
      "Audit plan requires exactly one roster for each source class",
    );

  const paths = new Set<string>();
  const identities = new Set<string>();
  const starts = new Map<string, RecordReference[]>();
  const possible = new Map<string, RecordReference[]>();
  let unknownSlugStarts = 0;
  let confirmedStartRecords = 0;
  let possibleStartRecords = 0;
  let notStartRecords = 0;
  const sources = [];

  for (const group of [...plan.sources].sort((a, b) =>
    a.sourceClass.localeCompare(b.sourceClass),
  )) {
    const entries = [];
    for (const entry of group.entries)
      entries.push({
        path: await privateExistingAuditPath(entry.path),
        evidencePath: await privateExistingAuditPath(entry.evidencePath),
      });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const content: { path: string; digest: string }[] = [];
    const evidence: { path: string; digest: string }[] = [];
    let classUnknownSlugStarts = 0;

    for (const entry of entries) {
      if (entry.path === entry.evidencePath)
        throw new Error("Audit source and evidence must be separate files");
      for (const path of [entry.path, entry.evidencePath]) {
        if (paths.has(path)) throw new Error("Audit plan repeats a file path");
        paths.add(path);
      }
      const sourceFile = await stableFileDigest(entry.path);
      if (identities.has(sourceFile.identity))
        throw new Error("Audit plan repeats a file identity");
      identities.add(sourceFile.identity);
      const evidenceFile = await stableFile(entry.evidencePath);
      if (identities.has(evidenceFile.identity))
        throw new Error("Audit plan repeats a file identity");
      identities.add(evidenceFile.identity);
      const metadata = legacyCoverageAuditEvidenceSchema.parse(
        JSON.parse(evidenceFile.bytes.toString("utf8")) as unknown,
      );
      if (metadata.sourceDigest !== sourceFile.digest)
        throw new Error("Audit evidence refers to different source content");
      const afterEvidence = await stableFileDigest(entry.path);
      if (
        afterEvidence.identity !== sourceFile.identity ||
        afterEvidence.digest !== sourceFile.digest
      )
        throw new Error("Audit source changed after reading its evidence");
      const recordIds = new Set<string>();
      for (const record of metadata.records) {
        if (recordIds.has(record.recordId))
          throw new Error("Audit evidence repeats a record ID");
        recordIds.add(record.recordId);
        const reference = {
          sourceDigest: sourceFile.digest,
          evidenceDigest: evidenceFile.digest,
          recordId: record.recordId,
          classification: record.classification,
        };
        if (record.classification === "confirmed-start") {
          confirmedStartRecords += 1;
          if (record.slug === undefined) {
            unknownSlugStarts += 1;
            classUnknownSlugStarts += 1;
          } else addReference(starts, record.slug, reference);
        } else if (record.classification === "possible-start") {
          possibleStartRecords += 1;
          if (record.slug === undefined) {
            unknownSlugStarts += 1;
            classUnknownSlugStarts += 1;
          } else addReference(possible, record.slug, reference);
        } else notStartRecords += 1;
      }
      content.push({ path: entry.path, digest: sourceFile.digest });
      evidence.push({ path: entry.evidencePath, digest: evidenceFile.digest });
    }
    sources.push({
      sourceClass: group.sourceClass,
      rosterDigest: canonicalDigest(entries.map((entry) => entry.path)),
      contentDigest: canonicalDigest(content),
      evidenceDigest: canonicalDigest(evidence),
      sourceCount: entries.length,
      complete: false as const,
      unknownSlugStarts: classUnknownSlugStarts,
    });
  }

  const evidenceDigest = (references: readonly RecordReference[]) =>
    canonicalDigest(
      [...references].sort((a, b) =>
        canonicalDigest(a).localeCompare(canonicalDigest(b)),
      ),
    );
  // Copied records across old stores may be the same Trial. One confirmed
  // start proves a prior Trial, but this dry-run never adds duplicate counts.
  const legacyStarts = [...starts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, references]) => ({
      slug: value,
      minimumStartedTrials: 1,
      evidenceDigest: evidenceDigest(references),
    }));
  const heldSlugs = [...possible]
    .filter(([value]) => !starts.has(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, references]) => ({
      slug: value,
      evidenceDigest: evidenceDigest(references),
    }));
  const candidate = {
    schemaVersion: 1 as const,
    stateInventoryDigest: plan.stateInventoryDigest,
    auditDigest: canonicalDigest({
      stateInventoryDigest: plan.stateInventoryDigest,
      sources,
      legacyStarts,
      heldSlugs,
    }),
    status: "requires-independent-review" as const,
    importable: false as const,
    sources,
    legacyStarts,
    heldSlugs,
  };
  return {
    candidate,
    publicSummary: {
      sourceFiles: sources.reduce(
        (total, source) => total + source.sourceCount,
        0,
      ),
      confirmedStartRecords,
      possibleStartRecords,
      notStartRecords,
      knownStartedSlugs: legacyStarts.length,
      heldSlugs: heldSlugs.length,
      unknownSlugStarts,
      importable: false as const,
    },
  };
}
