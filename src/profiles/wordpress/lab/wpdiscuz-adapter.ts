export const WPDISCUZ_COMMENT_SCENARIO_ID = "public-plugin-comment-v1";

/** Run the plugin's ordinary first administrator visit, then check public comment prerequisites. */
export function wpDiscuzOrdinarySetupScript(): string {
  return [
    'if (!class_exists("wpDiscuzForm")) throw new RuntimeException("Comment plugin is unavailable");',
    '$admin=get_user_by("login","harness-admin");',
    'if (!$admin || !user_can($admin,"manage_options")) throw new RuntimeException("Administrator is unavailable");',
    "wp_set_current_user($admin->ID);",
    'require_once ABSPATH."wp-admin/includes/plugin.php";',
    'do_action("admin_init");',
    '$forms=get_posts(["post_type"=>"wpdiscuz_form","post_status"=>"publish","posts_per_page"=>1]);',
    'if (!$forms) throw new RuntimeException("Public comment form is unavailable");',
    '$posts=get_posts(["post_type"=>"post","post_status"=>"publish","posts_per_page"=>20]);',
    "$ready=false;",
    "foreach ($posts as $post) {",
    "if (!comments_open($post->ID)) continue;",
    'if (get_comments(["post_id"=>$post->ID,"status"=>"approve","count"=>true]) > 0) { $ready=true; break; }',
    "}",
    'if (!$ready) throw new RuntimeException("Approved public comment is unavailable");',
  ].join(" ");
}
