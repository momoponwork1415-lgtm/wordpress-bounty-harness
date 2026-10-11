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
  {
    id: "private-post-v1",
    version: 1,
    name: "非公開の投稿",
    pluginSlug: null,
    approvedComment: false,
    secondaryLocale: null,
    translation: null,
    content: {
      type: "post",
      status: "private",
      slug: "lab-private-post",
      title: "Lab private post",
      body: "Ordinary private content for an authorized reader.",
    },
  },
  {
    id: "private-page-v1",
    version: 1,
    name: "非公開の固定ページ",
    pluginSlug: null,
    approvedComment: false,
    secondaryLocale: null,
    translation: null,
    content: {
      type: "page",
      status: "private",
      slug: "lab-private-page",
      title: "Lab private page",
      body: "Ordinary private page content for an authorized reader.",
    },
  },
] as const;

const pins: Record<(typeof definitions)[number]["id"], string> = {
  "approved-comment-v1":
    "sha256:a9c59e0011d96d800a5b44657f6d608eb914af00c6d2a16bad85dfc31d960ebe",
  "translatepress-translation-data-v1":
    "sha256:111ae6445c8290ae49494ebf4ae116994262722f74114994ed4115ad5930bffc",
  "private-post-v1":
    "sha256:2bcd33b635494333e9337af9a0a08e5336bb82d6be7098f59ba044d4b98ccb26",
  "private-page-v1":
    "sha256:8699068b8ba01eec99b5675b63d6c27d5ab612118ed4248df38998457e27d147",
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

/** Profile-owned seed operations. These are Lab setup data, never discovery input. */
export function translatePressLocaleSetupScript(locale: string): string {
  return `$settings=get_option("trp_settings"); if(!is_array($settings)) exit(1); $base=$settings["default-language"] ?? "en_US"; $secondary="${locale}"; $settings["translation-languages"]=array_values(array_unique([$base,$secondary])); $settings["publish-languages"]=array_values(array_unique([$base,$secondary])); $settings["url-slugs"][$secondary]=strtolower(substr($secondary,0,2)); update_option("trp_settings",$settings); TRP_Translate_Press::get_trp_instance()->get_component("query")->check_table($base,$secondary); $admin=get_user_by("login","harness-admin"); if(!$admin) exit(2); update_user_meta($admin->ID,"locale",$secondary); if(get_user_locale($admin->ID)!==$secondary) exit(3);`;
}

export function translatePressCanaryAdministratorLocaleScript(
  username: string,
  locale: string,
): string {
  const user = JSON.stringify(username);
  const language = JSON.stringify(locale);
  return `$admin=get_user_by("login",${user}); if(!$admin) exit(1); update_user_meta($admin->ID,"locale",${language}); if(get_user_locale($admin->ID)!==${language}) exit(2);`;
}

export function scenarioTranslationSeedScript(
  scenario: WordPressScenario | undefined,
): string | undefined {
  if (scenario?.translation === null || scenario?.translation === undefined)
    return undefined;
  const locale = scenario.secondaryLocale;
  const original = JSON.stringify(scenario.translation.original);
  const translated = JSON.stringify(scenario.translation.translated);
  return `$settings=get_option("trp_settings"); $base=$settings["default-language"] ?? "en_US"; $table=$GLOBALS["wpdb"]->prefix."trp_dictionary_".strtolower($base)."_".strtolower(${JSON.stringify(locale)}); if(!preg_match("/^[a-z0-9_]+$/",$table)) exit(1); $ok=$GLOBALS["wpdb"]->insert($table,["original"=>${original},"translated"=>${translated},"status"=>2,"block_type"=>0]); if($ok!==1) exit(2); $count=$GLOBALS["wpdb"]->get_var($GLOBALS["wpdb"]->prepare("SELECT COUNT(*) FROM ".$table." WHERE original=%s AND translated=%s",${original},${translated})); if((int)$count<1) exit(3);`;
}

/** Ordinary, plugin-independent content that a separate authorized reader can open. */
export function scenarioContent(scenario: WordPressScenario | undefined):
  | {
      readonly type: "post" | "page";
      readonly status: "private";
      readonly slug: string;
      readonly title: string;
      readonly body: string;
    }
  | undefined {
  return scenario !== undefined && "content" in scenario
    ? scenario.content
    : undefined;
}

/** Match stated prerequisites, never the claimed impact or a recipe. */
export function nextWordPressScenario(
  precondition: string,
  currentId?: string,
  context?: { readonly secondaryLocaleConfigured: boolean },
): string {
  const text = precondition.toLowerCase();
  const privatePost = /\bprivate[ -]post\b|非公開.{0,8}投稿/.test(text);
  const privatePage = /\bprivate[ -]page\b|非公開.{0,8}(?:page|ページ)/.test(
    text,
  );
  const translation =
    /translat|dictionary|secondary language|二次言語|翻訳|辞書/.test(text);
  const comment = /approved comment|comment fixture|承認済みコメント/.test(
    text,
  );
  const privateContent = privatePost || privatePage;
  const needsDictionary =
    /dictionary|translated data|machine translation|翻訳辞書|翻訳済み/.test(
      text,
    );
  const needsSecondaryLocale = /secondary (?:language|locale)|二次言語/.test(
    text,
  );
  if (
    privateContent &&
    ((privatePost && privatePage) ||
      comment ||
      needsDictionary ||
      (needsSecondaryLocale && context?.secondaryLocaleConfigured !== true))
  )
    return "catalogue に無い前提";
  const id = privatePost
    ? "private-post-v1"
    : privatePage
      ? "private-page-v1"
      : translation
        ? "translatepress-translation-data-v1"
        : comment
          ? "approved-comment-v1"
          : undefined;
  const scenario = id === undefined ? undefined : wordPressScenario(id);
  const current =
    currentId === undefined ? undefined : wordPressScenario(currentId);
  const alreadyPresent =
    scenario !== undefined &&
    (scenario.id === currentId ||
      (scenario.id === "approved-comment-v1" &&
        current?.approvedComment === true));
  return scenario === undefined || alreadyPresent
    ? "catalogue に無い前提"
    : `${scenario.id}: ${scenario.name}`;
}
