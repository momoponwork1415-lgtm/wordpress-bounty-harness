import { canonicalJson } from "../acquisition/canonical-json.js";
import {
  normalizedProgrammePolicySchema,
  programmeEligibilitySchema,
  programmePolicyConflictSignalSchema,
  type ProgrammePolicySourceAdapter,
  type ProgrammePolicySourceContent,
} from "../programme-intelligence/contracts.js";
import {
  patchstackProgrammePageDocumentSchema,
  patchstackProgrammeSourceKindSchema,
  type CreatePatchstackProgrammeAdaptersOptions,
  type PatchstackProgrammePageAdapter,
  type PatchstackProgrammePageDocument,
  type PatchstackProgrammeSourceKind,
} from "./contracts.js";

const sourceOrder: readonly PatchstackProgrammeSourceKind[] = [
  "rules",
  "report-form",
  "mvdp-directory",
  "marketing",
];

function sourceId(kind: PatchstackProgrammeSourceKind): string {
  const ordinal = sourceOrder.indexOf(kind) + 1;
  return `programme:patchstack:0${ordinal}-${kind}`;
}

function conflictSignal() {
  return programmePolicyConflictSignalSchema.parse({
    kind: "programme-policy-conflict",
    schemaVersion: 1,
  });
}

function hasEligibilityConflict(
  authoritative: NonNullable<
    PatchstackProgrammePageDocument["assertions"]["eligibility"]
  >,
  asserted: NonNullable<
    PatchstackProgrammePageDocument["assertions"]["eligibility"]
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
  ] as const;
  return keys.some(
    (key) =>
      asserted[key] !== undefined &&
      canonicalJson(asserted[key]) !== canonicalJson(authoritative[key]),
  );
}

async function normalizePages(
  pages: readonly PatchstackProgrammePageAdapter[],
  sources: readonly ProgrammePolicySourceContent[],
): Promise<unknown> {
  const documents: PatchstackProgrammePageDocument[] = [];
  for (const [index, expectedKind] of sourceOrder.entries()) {
    const page = pages.find(
      (candidate) => candidate.sourceKind === expectedKind,
    );
    const content = sources.find(
      (candidate) => candidate.sourceId === sourceId(expectedKind),
    );
    if (page === undefined || content === undefined) {
      throw new Error("Patchstack Programme required source is missing");
    }
    const document = patchstackProgrammePageDocumentSchema.parse(
      await page.parse(content.bytes),
    );
    if (
      document.sourceKind !== expectedKind ||
      document.precedence !== index + 1
    ) {
      throw new Error("Patchstack Programme source binding is invalid");
    }
    documents.push(document);
  }

  const rules = documents[0];
  if (rules === undefined) {
    throw new Error("Patchstack Rules source is missing");
  }
  const eligibilityResult = programmeEligibilitySchema.safeParse(
    rules.assertions.eligibility,
  );
  if (
    !eligibilityResult.success ||
    eligibilityResult.data.conditions === undefined ||
    rules.assertions.programmeOpportunityBand === undefined
  ) {
    throw new Error("Patchstack Rules source is incomplete");
  }

  const directory = documents.find(
    (document) => document.sourceKind === "mvdp-directory",
  );
  if (
    directory?.assertions.directoryEligibilityRules === undefined ||
    documents.some(
      (document) =>
        document.sourceKind !== "mvdp-directory" &&
        document.assertions.directoryEligibilityRules !== undefined,
    )
  ) {
    throw new Error(
      "Patchstack mVDP directory eligibility membership is incomplete",
    );
  }
  if (
    directory.assertions.directoryEligibilityRules.some(
      (rule) =>
        !eligibilityResult.data.conditions?.includes(
          rule.authorizationCondition,
        ),
    )
  ) {
    return conflictSignal();
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
        rules.assertions.programmeOpportunityBand
    ) {
      return conflictSignal();
    }
  }

  return normalizedProgrammePolicySchema.parse({
    programmeIdentity: "programme:patchstack",
    eligibility: {
      ...eligibilityResult.data,
      directoryEligibilityRules: directory.assertions.directoryEligibilityRules,
    },
    programmeOpportunityBand: rules.assertions.programmeOpportunityBand,
  });
}

export function createPatchstackProgrammeAdapters(
  options: CreatePatchstackProgrammeAdaptersOptions,
): readonly ProgrammePolicySourceAdapter[] {
  const pages = [...options.pages];
  for (const page of pages) {
    patchstackProgrammeSourceKindSchema.parse(page.sourceKind);
  }
  if (
    pages.length !== sourceOrder.length ||
    sourceOrder.some(
      (kind) => pages.filter((page) => page.sourceKind === kind).length !== 1,
    )
  ) {
    throw new Error("Patchstack Programme requires exactly four source pages");
  }
  return sourceOrder.map((kind) => {
    const page = pages.find((candidate) => candidate.sourceKind === kind);
    if (page === undefined) {
      throw new Error("Patchstack Programme required source is missing");
    }
    return {
      sourceId: sourceId(kind),
      programmeIdentity: "programme:patchstack",
      sourceUrl: page.sourceUrl,
      parserVersion: page.parserVersion,
      retrieve: () => page.retrieve(),
      parse: (_bytes, sources) => {
        if (sources === undefined) {
          throw new Error("Patchstack Programme source context is missing");
        }
        return normalizePages(pages, sources);
      },
    };
  });
}
