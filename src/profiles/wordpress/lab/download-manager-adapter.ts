export const DOWNLOAD_MANAGER_SCENARIO_ID =
  "public-and-subscriber-downloads-v1";

/** Create ordinary public and subscriber downloads in a disposable Lab. */
export function downloadManagerOrdinarySetupScript(): string {
  return [
    'require "/var/www/html/wp-load.php";',
    '$admin=get_user_by("login","harness-admin");',
    'if (!$admin || !user_can($admin,"manage_options")) throw new RuntimeException("Lab administrator is unavailable");',
    "wp_set_current_user($admin->ID);",
    'if (!is_plugin_active("download-manager/download-manager.php") || !post_type_exists("wpdmpro") || !shortcode_exists("wpdm_package") || !defined("UPLOAD_DIR")) throw new RuntimeException("Download packages are unavailable");',
    "\\WPDM\\WordPressDownloadManager::createDir();",
    'if (!is_dir(UPLOAD_DIR) || !is_writable(UPLOAD_DIR) || !is_file(UPLOAD_DIR.".htaccess")) throw new RuntimeException("Protected download storage is unavailable");',
    '$fixtures=["public"=>"wbh-public-fixture.txt","member"=>"wbh-member-fixture.txt"];',
    '$contents=["public"=>"PUBLIC-LAB-FIXTURE","member"=>"MEMBER-LAB-FIXTURE"];',
    'foreach ($fixtures as $kind=>$name) { if (file_put_contents(UPLOAD_DIR.$name,$contents[$kind])!==strlen($contents[$kind])) throw new RuntimeException("Download fixture was not saved"); }',
    '$public=\\WPDM\\Package\\PackageController::create(["post_title"=>"Lab Public Download","post_content"=>"Public sample text file.","post_status"=>"publish","files"=>[$fixtures["public"]],"access"=>["guest"]]);',
    '$member=\\WPDM\\Package\\PackageController::create(["post_title"=>"Lab Member Download","post_content"=>"Member sample text file.","post_status"=>"publish","files"=>[$fixtures["member"]],"access"=>["subscriber","administrator"]]);',
    'if (!is_int($public) || !is_int($member) || $public<1 || $member<1) throw new RuntimeException("Download packages were not created");',
    `$page=wp_insert_post(["post_type"=>"page","post_status"=>"publish","post_title"=>"Lab Downloads","post_name"=>"lab-downloads","post_content"=>'[wpdm_package id="'.$public.'"] [wpdm_package id="'.$member.'"]',"post_author"=>$admin->ID],true);`,
    'if (is_wp_error($page) || !$page) throw new RuntimeException("Public download page was not created");',
    "$public_post=get_post($public); $member_post=get_post($member); $download_page=get_post($page);",
    'if (!$public_post || !$member_post || !$download_page || $public_post->post_type!=="wpdmpro" || $member_post->post_type!=="wpdmpro" || $public_post->post_status!=="publish" || $member_post->post_status!=="publish" || $download_page->post_status!=="publish") throw new RuntimeException("Download content is unavailable");',
    'if (get_post_meta($public,"__wpdm_access",true)!==["guest"] || get_post_meta($member,"__wpdm_access",true)!==["subscriber","administrator"]) throw new RuntimeException("Download access was not saved");',
    'if (get_post_meta($public,"__wpdm_files",true)!==[$fixtures["public"]] || get_post_meta($member,"__wpdm_files",true)!==[$fixtures["member"]]) throw new RuntimeException("Download files were not attached");',
    'foreach ($fixtures as $kind=>$name) { if (!is_file(UPLOAD_DIR.$name) || file_get_contents(UPLOAD_DIR.$name)!==$contents[$kind]) throw new RuntimeException("Download fixture is unavailable"); }',
    'if (get_option("default_role")!=="subscriber") throw new RuntimeException("Ordinary subscriber role is unavailable");',
  ].join(" ");
}
