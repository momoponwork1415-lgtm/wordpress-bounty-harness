export const USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID =
  "public-free-membership-v1";

/** Use the plugin's ordinary free membership installer in the disposable Lab. */
export function userRegistrationMembershipInstallScript(): string {
  return [
    'if (!function_exists("ur_membership_install_required_pages")) throw new RuntimeException("Membership installer is unavailable");',
    "ur_membership_install_required_pages();",
  ].join(" ");
}

/** Enroll the Lab subscriber with the plugin's normal free membership service. */
export function userRegistrationMembershipEnrollmentScript(
  subscriberUsername: string,
): string {
  const username = JSON.stringify(subscriberUsername);
  return [
    'if (!ur_check_module_activation("membership") || !class_exists("WPEverest\\URMembership\\Admin\\Services\\MembershipService")) throw new RuntimeException("Membership module is unavailable");',
    'if (!WPEverest\\URMembership\\Admin\\Database\\Database::tables_exist()) throw new RuntimeException("Membership tables are unavailable");',
    '$plans=get_posts(["post_type"=>"ur_membership","post_status"=>"publish","posts_per_page"=>-1]);',
    'if (count($plans)!==1) throw new RuntimeException("Free membership plan is unavailable");',
    '$plan=$plans[0]; $meta=json_decode(wp_unslash(get_post_meta($plan->ID,"ur_membership",true)),true);',
    'if (($meta["type"]??null)!=="free" || ($meta["role"]??null)!=="subscriber" || (float)($meta["amount"]??-1)!==0.0) throw new RuntimeException("Ordinary free plan is unavailable");',
    '$page=get_post((int)get_option("user_registration_member_registration_page_id"));',
    'if (!$page || $page->post_status!=="publish" || !has_shortcode($page->post_content,"user_registration_form")) throw new RuntimeException("Public membership form is unavailable");',
    `$subscriber=get_user_by("login",${username});`,
    'if (!$subscriber || !in_array("subscriber",$subscriber->roles,true)) throw new RuntimeException("Lab subscriber is unavailable");',
    '$result=(new WPEverest\\URMembership\\Admin\\Services\\MembershipService())->create_membership_order_and_subscription(["username"=>$subscriber->user_login,"email"=>$subscriber->user_email,"membership"=>$plan->ID,"start_date"=>date("Y-m-d"),"payment_method"=>"free"]);',
    'if (($result["status"]??false)!==true || empty($result["subscription_id"])) throw new RuntimeException("Free membership enrollment failed");',
    "$subscription=(new WPEverest\\URMembership\\Admin\\Repositories\\MembersSubscriptionRepository())->get_subscription_data_by_member_and_membership_id($subscriber->ID,$plan->ID);",
    'if (!$subscription || ($subscription["status"]??null)!=="active") throw new RuntimeException("Active free membership is unavailable");',
    'if (!ur_should_show_subscriptions_menu() || !in_array("subscriber",get_userdata($subscriber->ID)->roles,true)) throw new RuntimeException("Ordinary membership administration is unavailable");',
  ].join(" ");
}
