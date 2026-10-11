import type { DockerResult, Resources } from "./index.js";

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
) => Promise<DockerResult>;

const TARGET_SLUG = "brizy";

/** A generic builder-page scenario needs a target adapter before provision. */
export function assertBrizyBuilderPageTarget(
  builderPage: boolean,
  targetSlug: string,
): void {
  if (builderPage && targetSlug !== TARGET_SLUG)
    throw new Error("No builder-page Lab adapter for this target");
}

/** Publish a harmless page and enable the plugin's ordinary page editor. */
export async function seedBrizyBuilderPage(input: {
  readonly builderPage: boolean;
  readonly targetSlug: string;
  readonly resource: Resources;
  readonly wp: WordPressCommand;
}): Promise<void> {
  if (!input.builderPage) return;
  assertBrizyBuilderPageTarget(input.builderPage, input.targetSlug);

  // This follows the pinned plugin's normal "Edit with Brizy" enable flow:
  // create a page, enable its editor, choose its template, and save storage.
  const script = [
    'if(!class_exists("Brizy_Editor_Post") || !class_exists("Brizy_Editor_Entity") || !class_exists("Brizy_Config") || !defined("BRIZY_VERSION")) exit(1);',
    '$admin=get_user_by("login","harness-admin"); if(!$admin) exit(2); wp_set_current_user($admin->ID);',
    '$id=wp_insert_post(["post_type"=>"page","post_status"=>"publish","post_name"=>"lab-builder-page","post_title"=>"Lab builder page","post_content"=>"<div class=\\"brz-root__container\\"></div>"],true);',
    "if(is_wp_error($id) || !is_numeric($id) || (int)$id<1) exit(3);",
    '$editor=Brizy_Editor_Post::get($id); $editor->enable_editor(); $editor->set_template(Brizy_Config::BRIZY_BLANK_TEMPLATE_FILE_NAME); $editor->set_plugin_version(BRIZY_VERSION); $editor->set_pro_plugin_version(defined("BRIZY_PRO_VERSION")?BRIZY_PRO_VERSION:null); $editor->saveStorage();',
    '$page=get_post($id); if(!$page || $page->post_type!=="page" || $page->post_status!=="publish" || !Brizy_Editor_Entity::isBrizyEnabled($id) || get_post_meta($id,"_wp_page_template",true)!==Brizy_Config::BRIZY_BLANK_TEMPLATE_FILE_NAME || strpos($page->post_content,"brz-root__container")===false) exit(4);',
  ].join(" ");
  await input.wp(input.resource, ["eval", script]);
}
