export const DOWNLOAD_MONITOR_SCENARIO_ID = "public-file-download-v1";

/** Create a public page and a small ordinary download in a disposable Lab. */
export function downloadMonitorOrdinarySetupScript(): string {
  return [
    'require "/var/www/html/wp-load.php";',
    '$admin=get_user_by("login","harness-admin");',
    'if (!$admin || !user_can($admin,"manage_options")) throw new RuntimeException("Lab administrator is unavailable");',
    "wp_set_current_user($admin->ID);",
    'if (!in_array("download-monitor/download-monitor.php",get_option("active_plugins",[]),true) || !post_type_exists("dlm_download") || !post_type_exists("dlm_download_version") || !shortcode_exists("download")) throw new RuntimeException("Public downloads are unavailable");',
    "$upload=wp_upload_dir();",
    'if (!empty($upload["error"]) || !wp_mkdir_p($upload["basedir"])) throw new RuntimeException("Upload directory is unavailable");',
    '$fixture="Ordinary Lab download.\n";',
    '$path=$upload["basedir"]."/lab-download.txt";',
    'if (file_put_contents($path,$fixture)!==strlen($fixture) || file_get_contents($path)!==$fixture) throw new RuntimeException("Download fixture is unavailable");',
    '$url=$upload["baseurl"]."/lab-download.txt";',
    '$download=wp_insert_post(["post_type"=>"dlm_download","post_status"=>"publish","post_title"=>"Lab download","post_author"=>$admin->ID],true);',
    'if (is_wp_error($download) || !$download) throw new RuntimeException("Download creation failed");',
    '$version=wp_insert_post(["post_type"=>"dlm_download_version","post_status"=>"publish","post_title"=>"Version 1","post_parent"=>$download,"post_author"=>$admin->ID],true);',
    'if (is_wp_error($version) || !$version) throw new RuntimeException("Download version creation failed");',
    'update_post_meta($version,"_files",wp_json_encode([$url]));',
    'update_post_meta($version,"_version","1.0");',
    'download_monitor()->service("transient_manager")->clear_versions_transient($download);',
    "$shortcode='[download id=\"'.$download.'\"]';",
    '$page=wp_insert_post(["post_type"=>"page","post_status"=>"publish","post_title"=>"Public download","post_name"=>"lab-public-download","post_content"=>$shortcode,"post_author"=>$admin->ID],true);',
    'if (is_wp_error($page) || !$page) throw new RuntimeException("Public page creation failed");',
    '$model=download_monitor()->service("download_repository")->retrieve_single($download);',
    "$activeVersion=$model->get_version();",
    'if (!$model->exists() || !$activeVersion || count($activeVersion->get_mirrors())!==1) throw new RuntimeException("Published download is unavailable");',
    'if (json_decode((string)get_post_meta($version,"_files",true),true)!==[$url]) throw new RuntimeException("Download file was not attached");',
    "$downloadPost=get_post($download); $versionPost=get_post($version); $publicPage=get_post($page);",
    'if (!$downloadPost || !$versionPost || !$publicPage || $downloadPost->post_status!=="publish" || $versionPost->post_parent!==$download || $publicPage->post_status!=="publish" || $publicPage->post_name!=="lab-public-download" || !has_shortcode($publicPage->post_content,"download")) throw new RuntimeException("Public download page is unavailable");',
    'if (get_option("default_role")!=="subscriber") throw new RuntimeException("Ordinary subscriber role is unavailable");',
  ].join(" ");
}
