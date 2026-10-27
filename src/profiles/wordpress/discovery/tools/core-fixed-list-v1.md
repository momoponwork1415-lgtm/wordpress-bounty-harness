# Mechanisms WordPress core offers for reaching plugin code (v1)

A fixed list of the ways core resolves a request into code a plugin registered. A plugin can use any of them; the scripts in this directory match only literal registrations, so read this list to know what to look for by hand.

- Hooks that run on every request: `muplugins_loaded`, `plugins_loaded`, `init`, `wp_loaded`, `parse_request`, `wp`, `template_redirect`, `shutdown`, via `add_action` / `add_filter`.
- `admin-ajax.php`: `wp_ajax_{action}` for logged-in users and `wp_ajax_nopriv_{action}` for visitors, selected by the `action` request parameter.
- `admin-post.php`: `admin_post_{action}` and `admin_post_nopriv_{action}`, selected the same way.
- REST: `rest_api_init` then `register_rest_route`, with a `permission_callback` per route.
- XML-RPC: methods added through the `xmlrpc_methods` filter.
- Shortcodes: `add_shortcode`, run wherever post content is rendered, including excerpts, widgets and some feeds.
- Blocks: `register_block_type` with a `render_callback`, run on render.
- Widgets: `register_widget`, run on sidebar render and saved from the widgets screen.
- Rewrite rules, endpoints and query vars: `add_rewrite_rule`, `add_rewrite_endpoint`, the `query_vars` filter, `template_include`.
- Comments: `preprocess_comment`, `comment_post`, `wp_insert_comment`, and comment meta.
- Login, registration and passwords: `authenticate`, `wp_login`, `login_form`, `register_form`, `user_register`, `lostpassword_post`, `retrieve_password`, `password_reset`, `profile_update`, `personal_options_update`.
- Cron: `wp_schedule_event` / `wp_schedule_single_event` bound to an action, run by `wp-cron.php` on a request.
- Uploads: `wp_handle_upload_prefilter`, `wp_handle_upload`, `wp_upload_bits`, `async-upload.php`, `media_handle_upload`.
- Admin screens: `admin_menu` with `add_menu_page` / `add_submenu_page` callbacks, `admin_init`, `load-{page}`, and `options.php` saving settings registered with `register_setting` and its `sanitize_callback`.
- Front-end and admin output: `wp_head`, `wp_footer`, `wp_enqueue_scripts`, `admin_enqueue_scripts`, `wp_print_scripts`, `the_content` and other content filters.
- Heartbeat: `heartbeat_received` and `heartbeat_nopriv_received`.
- Post and user data: `save_post`, `wp_insert_post_data`, `register_post_type`, `register_taxonomy`, `register_meta` (with `show_in_rest`), `edit_user_profile_update`.
- Pluggable functions: a plugin that declares a core function guarded by `function_exists` replaces it site-wide.
- Activation and uninstall: `register_activation_hook`, `register_deactivation_hook`, `uninstall.php`.
- WP-CLI: `WP_CLI::add_command`; not reachable by request, listed so it is not mistaken for an entry.
