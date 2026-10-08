import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  canonicalDigest,
  canonicalJson,
} from "../../../infrastructure/canonical-json.js";
import {
  openProgrammeIntelligence,
  type ProgrammeEligibilitySnapshotRef,
  type ProgrammeIntelligence,
} from "../programme-intelligence/index.js";
import {
  wordfenceProgrammePageDocumentSchema,
  type WordfenceProgrammeSourceKind,
} from "./contracts.js";
import { createWordfenceProgrammeAdapters } from "./wordfence-programme-adapter.js";

/** wordfence.com blocks automated retrieval; a human transcribes the three official pages. */
export const wordfenceProgrammeTranscriptionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transcribedAt: z.iso.date(),
  pages: z.array(wordfenceProgrammePageDocumentSchema).length(3),
});

const OFFICIAL_URLS: Readonly<Record<WordfenceProgrammeSourceKind, string>> = {
  programme: "https://www.wordfence.com/threat-intel/bug-bounty-program/",
  terms:
    "https://www.wordfence.com/threat-intel/bug-bounty-program/terms-and-conditions/",
  "report-form":
    "https://www.wordfence.com/threat-intel/vulnerabilities/submit/",
};

/** The scope policy is reviewed monthly; an older transcription stops selection. */
const MAX_AGE_DAYS = 35;

export async function openTranscribedWordfenceProgramme(options: {
  readonly transcriptionPath: string;
  readonly storageDirectory: string;
  readonly clock: () => Date;
}): Promise<{
  readonly programme: ProgrammeIntelligence;
  readonly programmeRef: ProgrammeEligibilitySnapshotRef;
}> {
  const transcription = wordfenceProgrammeTranscriptionSchema.parse(
    JSON.parse(await readFile(options.transcriptionPath, "utf8")) as unknown,
  );
  const ageDays =
    (options.clock().getTime() - Date.parse(transcription.transcribedAt)) /
    86_400_000;
  if (ageDays > MAX_AGE_DAYS)
    throw new Error(
      `Wordfence Programme transcription is older than ${MAX_AGE_DAYS} days`,
    );
  const freshness = {
    kind: "programme-eligibility-freshness-policy" as const,
    schemaVersion: 1 as const,
    id: "wordfence-transcription-freshness-v1",
    maximumAgeMs: {
      targetSelectionBatch: 86_400_000,
      submissionStaging: 3_600_000,
    },
  };
  const programme = openProgrammeIntelligence({
    storageDirectory: options.storageDirectory,
    sourceAdapters: createWordfenceProgrammeAdapters({
      pages: transcription.pages.map((page) => ({
        sourceKind: page.sourceKind,
        sourceUrl: OFFICIAL_URLS[page.sourceKind],
        parserVersion: `human-transcription-${transcription.transcribedAt}`,
        retrieve: async () => Buffer.from(canonicalJson(page)),
        parse: (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8")),
      })),
    }),
    freshnessPolicy: { ...freshness, digest: canonicalDigest(freshness) },
    clock: options.clock,
  });
  const refreshed = await programme.refresh({
    kind: "programme-intelligence-refresh",
    schemaVersion: 1,
    programmeIdentity: "programme:wordfence",
  });
  if (refreshed.status !== "current")
    throw new Error("Wordfence Programme transcription is not usable");
  return { programme, programmeRef: refreshed.snapshotRef };
}
