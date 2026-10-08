import { canonicalJson } from "../acquisition/canonical-json.js";
import {
  normalizedProgrammePolicySchema,
  programmeEligibilitySchema,
  programmePolicyConflictSignalSchema,
  type ProgrammePolicySourceAdapter,
  type ProgrammePolicySourceContent,
} from "../programme-intelligence/contracts.js";
import {
  wordfenceProgrammePageDocumentSchema,
  wordfenceProgrammeSourceKindSchema,
  type CreateWordfenceProgrammeAdaptersOptions,
  type WordfenceProgrammePageAdapter,
  type WordfenceProgrammePageDocument,
  type WordfenceProgrammeSourceKind,
} from "./contracts.js";

const sourceOrder: readonly WordfenceProgrammeSourceKind[] = [
  "programme",
  "terms",
  "report-form",
];

function sourceId(kind: WordfenceProgrammeSourceKind): string {
  const ordinal = sourceOrder.indexOf(kind) + 1;
  return `programme:wordfence:0${ordinal}-${kind}`;
}

function conflictSignal() {
  return programmePolicyConflictSignalSchema.parse({
    kind: "programme-policy-conflict",
    schemaVersion: 1,
  });
}

function hasEligibilityConflict(
  authoritative: NonNullable<
    WordfenceProgrammePageDocument["assertions"]["eligibility"]
  >,
  asserted: NonNullable<
    WordfenceProgrammePageDocument["assertions"]["eligibility"]
  >,
): boolean {
  const keys = [
    "assets",
    "vulnerabilityClasses",
    "attackerRoles",
    "activeInstallThreshold",
    "researcherTiers",
    "exclusions",
    "conditions",
    "limits",
  ] as const;
  return keys.some(
    (key) =>
      asserted[key] !== undefined &&
      canonicalJson(asserted[key]) !== canonicalJson(authoritative[key]),
  );
}

async function normalizePages(
  pages: readonly WordfenceProgrammePageAdapter[],
  sources: readonly ProgrammePolicySourceContent[],
): Promise<unknown> {
  const documents: WordfenceProgrammePageDocument[] = [];
  for (const expectedKind of sourceOrder) {
    const page = pages.find(
      (candidate) => candidate.sourceKind === expectedKind,
    );
    const content = sources.find(
      (candidate) => candidate.sourceId === sourceId(expectedKind),
    );
    if (page === undefined || content === undefined) {
      throw new Error("Wordfence Programme required source is missing");
    }
    const document = wordfenceProgrammePageDocumentSchema.parse(
      await page.parse(content.bytes),
    );
    if (document.sourceKind !== expectedKind) {
      throw new Error("Wordfence Programme source binding is invalid");
    }
    documents.push(document);
  }

  const programme = documents[0];
  if (programme === undefined) {
    throw new Error("Wordfence Programme source is missing");
  }
  const eligibilityResult = programmeEligibilitySchema.safeParse(
    programme.assertions.eligibility,
  );
  if (
    !eligibilityResult.success ||
    eligibilityResult.data.conditions === undefined ||
    eligibilityResult.data.limits === undefined ||
    !eligibilityResult.data.limits.some(
      (limit) => limit.key === "pending-submission-cap",
    ) ||
    programme.assertions.programmeOpportunityBand === undefined
  ) {
    throw new Error("Wordfence Programme source is incomplete");
  }

  for (const document of documents.slice(1)) {
    if (
      document.assertions.eligibility !== undefined &&
      hasEligibilityConflict(
        eligibilityResult.data,
        document.assertions.eligibility,
      )
    ) {
      return conflictSignal();
    }
    if (
      document.assertions.programmeOpportunityBand !== undefined &&
      document.assertions.programmeOpportunityBand !==
        programme.assertions.programmeOpportunityBand
    ) {
      return conflictSignal();
    }
  }

  return normalizedProgrammePolicySchema.parse({
    programmeIdentity: "programme:wordfence",
    eligibility: eligibilityResult.data,
    programmeOpportunityBand: programme.assertions.programmeOpportunityBand,
  });
}

export function createWordfenceProgrammeAdapters(
  options: CreateWordfenceProgrammeAdaptersOptions,
): readonly ProgrammePolicySourceAdapter[] {
  const pages = [...options.pages];
  for (const page of pages) {
    wordfenceProgrammeSourceKindSchema.parse(page.sourceKind);
  }
  if (
    pages.length !== sourceOrder.length ||
    sourceOrder.some(
      (kind) => pages.filter((page) => page.sourceKind === kind).length !== 1,
    )
  ) {
    throw new Error("Wordfence Programme requires exactly three source pages");
  }
  return sourceOrder.map((kind) => {
    const page = pages.find((candidate) => candidate.sourceKind === kind);
    if (page === undefined) {
      throw new Error("Wordfence Programme required source is missing");
    }
    return {
      sourceId: sourceId(kind),
      programmeIdentity: "programme:wordfence",
      sourceUrl: page.sourceUrl,
      parserVersion: page.parserVersion,
      retrieve: () => page.retrieve(),
      parse: (_bytes, sources) => {
        if (sources === undefined) {
          throw new Error("Wordfence Programme source context is missing");
        }
        return normalizePages(pages, sources);
      },
    };
  });
}
