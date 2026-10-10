import { canonicalDigest } from "../../../infrastructure/canonical-json.js";

/** Ordinary site content only. A scenario never changes a visitor's privileges. */
const definitions = [
  {
    id: "approved-comment-v1",
    version: 1,
    name: "承認済みコメント",
    pluginSlug: null,
    approvedComment: true,
    secondaryLocale: null,
    translation: null,
  },
  {
    id: "translatepress-translation-data-v1",
    version: 1,
    name: "TranslatePress の二次言語・翻訳データ・承認済みコメント",
    pluginSlug: "translatepress-multilingual",
    approvedComment: true,
    secondaryLocale: "fr_FR",
    translation: {
      original: "Sample page for translation",
      translated: "Exemple de page traduite",
    },
  },
] as const;

const pins: Record<(typeof definitions)[number]["id"], string> = {
  "approved-comment-v1":
    "sha256:a9c59e0011d96d800a5b44657f6d608eb914af00c6d2a16bad85dfc31d960ebe",
  "translatepress-translation-data-v1":
    "sha256:111ae6445c8290ae49494ebf4ae116994262722f74114994ed4115ad5930bffc",
};

export const wordPressScenarioCatalogue = definitions.map((definition) => {
  const digest = pins[definition.id];
  if (canonicalDigest(definition) !== digest)
    throw new Error(
      `WordPress Lab scenario changed without a version bump: ${definition.id}`,
    );
  return { ...definition, digest };
});
export type WordPressScenario = (typeof wordPressScenarioCatalogue)[number];

export function wordPressScenario(id: string): WordPressScenario | undefined {
  return wordPressScenarioCatalogue.find((scenario) => scenario.id === id);
}

/** Match stated prerequisites, never the claimed impact or a recipe. */
export function nextWordPressScenario(
  precondition: string,
  currentId?: string,
): string {
  const text = precondition.toLowerCase();
  const id = /translat|dictionary|secondary language|二次言語|翻訳|辞書/.test(
    text,
  )
    ? "translatepress-translation-data-v1"
    : /approved comment|comment fixture|承認済みコメント/.test(text)
      ? "approved-comment-v1"
      : undefined;
  const scenario = id === undefined ? undefined : wordPressScenario(id);
  return scenario === undefined || scenario.id === currentId
    ? "catalogue に無い前提"
    : scenario.name;
}
