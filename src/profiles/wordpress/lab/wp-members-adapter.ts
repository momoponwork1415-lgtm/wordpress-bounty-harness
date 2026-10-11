export const WP_MEMBERS_SCENARIO_ID = "public-member-post-v1";

/** Prepare ordinary registration, login, and a member post in a disposable Lab. */
export function wpMembersOrdinarySetupScript(): string {
  return [
    'if (!shortcode_exists("wpmem_form")) throw new RuntimeException("Member forms are unavailable");',
    '$settings=get_option("wpmembers_settings");',
    'if (!is_array($settings) || !isset($settings["block"]["post"],$settings["show_excerpt"]["post"],$settings["user_pages"])) throw new RuntimeException("Member settings are unavailable");',
    '$pages=[["register","lab-member-register","Member registration","[wpmem_form register]"],["login","lab-member-login","Member login","[wpmem_form login]"]];',
    "$page_ids=[];",
    "foreach ($pages as [$kind,$slug,$title,$shortcode]) {",
    '$id=wp_insert_post(["post_type"=>"page","post_status"=>"publish","post_name"=>$slug,"post_title"=>$title,"post_content"=>$shortcode],true);',
    'if (is_wp_error($id) || !$id) throw new RuntimeException("Member page creation failed");',
    "$page=get_post($id);",
    'if (!$page || $page->post_status!=="publish" || $page->post_name!==$slug || !has_shortcode($page->post_content,"wpmem_form")) throw new RuntimeException("Public member page is unavailable");',
    '$settings["user_pages"][$kind]=(int)$id;',
    "$page_ids[$kind]=(int)$id;",
    "}",
    '$settings["block"]["post"]=1;',
    '$settings["show_excerpt"]["post"]=1;',
    'update_option("wpmembers_settings",$settings);',
    'update_option("users_can_register",0);',
    'update_option("rss_use_excerpt",1);',
    '$persisted=get_option("wpmembers_settings");',
    'if (!is_array($persisted) || (int)($persisted["block"]["post"]??0)!==1 || (int)($persisted["show_excerpt"]["post"]??0)!==1) throw new RuntimeException("Member post settings were not saved");',
    "foreach ($pages as [$kind,$slug,$title,$shortcode]) {",
    'if ((int)($persisted["user_pages"][$kind]??0)!==$page_ids[$kind]) throw new RuntimeException("Member page setting was not saved");',
    "$page=get_post($page_ids[$kind]);",
    'if (!$page || $page->post_type!=="page" || $page->post_status!=="publish" || $page->post_name!==$slug || $page->post_content!==$shortcode) throw new RuntimeException("Public member page was not saved");',
    "}",
    '$post_id=wp_insert_post(["post_type"=>"post","post_status"=>"publish","post_name"=>"lab-member-post","post_title"=>"Lab member post","post_content"=>"Lab member teaser.<!--more-->Lab member full content."],true);',
    'if (is_wp_error($post_id) || !$post_id) throw new RuntimeException("Member post creation failed");',
    "$post=get_post($post_id);",
    'if (!$post || $post->post_status!=="publish" || $post->post_name!=="lab-member-post" || !str_contains($post->post_content,"<!--more-->")) throw new RuntimeException("Member post is unavailable");',
    'if ((int)get_option("rss_use_excerpt")!==1 || (int)get_option("users_can_register")!==0 || get_option("default_role")!=="subscriber") throw new RuntimeException("Ordinary member settings are unavailable");',
  ].join(" ");
}
