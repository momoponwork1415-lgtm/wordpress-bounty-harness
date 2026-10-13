import type { DockerResult, Resources } from "./index.js";
import {
  scenarioSearchableComment,
  type WordPressScenario,
} from "./scenarios.js";

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
) => Promise<DockerResult>;

/** This adapter is needed only for search backends that index comments. */
export function assertSearchableCommentTarget(
  scenario: WordPressScenario | undefined,
  targetSlug: string,
): void {
  if (
    scenarioSearchableComment(scenario) !== undefined &&
    targetSlug !== "relevanssi"
  )
    throw new Error("No comment-search index adapter for this target");
}

/** Use the plugin's ordinary indexing settings and index builder in the Lab. */
export async function buildSearchableCommentIndex(input: {
  readonly scenario: WordPressScenario | undefined;
  readonly targetSlug: string;
  readonly postId: string | undefined;
  readonly resource: Resources;
  readonly wp: WordPressCommand;
}): Promise<void> {
  const searchable = scenarioSearchableComment(input.scenario);
  if (searchable === undefined) return;
  assertSearchableCommentTarget(input.scenario, input.targetSlug);
  if (input.postId === undefined || !/^[1-9][0-9]*$/.test(input.postId))
    throw new Error("Searchable comment post ID is unavailable");

  await input.wp(input.resource, [
    "option",
    "update",
    "relevanssi_index_comments",
    "normal",
  ]);
  const script = [
    `$post_id=${input.postId};`,
    `$term=${JSON.stringify(searchable.searchTerm)};`,
    'if(!function_exists("relevanssi_build_index") || get_option("relevanssi_index_comments")!=="normal") exit(1);',
    "$result=relevanssi_build_index();",
    "if(!is_array($result) || $result[0]!==true || $result[1]<1) exit(2);",
    'global $wpdb; $table=$wpdb->prefix."relevanssi";',
    'if(!preg_match("/^[a-zA-Z0-9_]+$/",$table)) exit(3);',
    '$count=$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM ".$table." WHERE doc=%d AND term=%s AND comment>0",$post_id,$term));',
    "if((int)$count<1) exit(4);",
  ].join(" ");
  await input.wp(input.resource, ["eval", script]);
}
