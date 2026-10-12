export const USER_REGISTRATION_SCENARIO_ID =
  "public-registration-and-account-v1";

/** Prepare the plugin's ordinary registration flow in a disposable Lab. */
export function userRegistrationOrdinarySetupScript(): string {
  return [
    'if (!class_exists("UR_Install")) throw new RuntimeException("Registration plugin is unavailable");',
    "UR_Install::create_form();",
    "UR_Install::create_pages();",
    '$login_id=(int)get_option("user_registration_login_page_id");',
    "if ($login_id === 0) {",
    '$login_id=wp_insert_post(["post_type"=>"page","post_title"=>"Login","post_name"=>"login","post_status"=>"publish","post_content"=>"[user_registration_login]"],true);',
    'if (is_wp_error($login_id)) throw new RuntimeException("Login page creation failed");',
    'update_option("user_registration_login_page_id",$login_id);',
    "}",
    'update_option("users_can_register",1);',
    '$form=get_post((int)get_option("user_registration_default_form_page_id"));',
    'if (!$form || $form->post_type !== "user_registration" || $form->post_status !== "publish") throw new RuntimeException("Registration form is unavailable");',
    '$pages=["user_registration_registration_page_id"=>"user_registration_form","user_registration_myaccount_page_id"=>"user_registration_my_account","user_registration_login_page_id"=>"user_registration_login"];',
    "foreach ($pages as $option => $shortcode) {",
    "$page=get_post((int)get_option($option));",
    'if (!$page || $page->post_type !== "page" || $page->post_status !== "publish" || !has_shortcode($page->post_content,$shortcode)) throw new RuntimeException("Ordinary registration page is unavailable");',
    "}",
    'if ((int)get_option("users_can_register") !== 1 || get_option("default_role") !== "subscriber") throw new RuntimeException("Ordinary subscriber registration is unavailable");',
  ].join(" ");
}
