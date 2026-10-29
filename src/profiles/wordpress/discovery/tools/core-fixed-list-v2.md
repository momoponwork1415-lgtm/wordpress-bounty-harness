# Core features that act on a value a plugin hands them (core-fixed-list-v2)

A fixed reference, the same for every plugin. It names the places where WordPress core itself turns a value into an effect, or resolves a request into plugin code. A plugin reaches these through core functions, so they are easy to miss when reading only the plugin's own files: the effect lives in core, the decision about the value lives in the plugin. Use it as a checklist of exit kinds and dispatch kinds to look for; it is not a list of what is wrong, and it names no plugin.

## Effects: core acts on the value

| Core feature | What core does with the value | Effect kind |
|---|---|---|
| Page output (`echo`, `printf`, templates, `wp_kses` contexts) | Prints it into a page a visitor or an administrator loads | Script runs in that person's browser |
| Filesystem (`include`/`require`, `file_get_contents`, `file_put_contents`, `unlink`, `rename`, `copy`, `ZipArchive`, `WP_Filesystem`) | Resolves it as a path, reads, writes, deletes or runs the file | File read, write, deletion or code execution |
| Database (`$wpdb->query`, `get_results`, `get_var`, `get_row`, `get_col`, `prepare`) | Runs it as part of a query | Query the site did not intend |
| User creation and role (`wp_insert_user`, `wp_create_user`, `register_new_user`, `set_role`, `add_role`, `add_cap`, the default role option) | Creates the account or assigns the role it names | Account or capability the attacker chose |
| Media upload (`wp_handle_upload`, `wp_handle_sideload`, `media_handle_upload`, `wp_upload_bits`, `wp_insert_attachment`) | Stores the file under uploads with the name and type it is given | Stored file of a type the site did not allow |
| Options and transients (`update_option`, `add_option`, `set_transient`, settings import) | Stores it as site configuration | Site behaviour changed by the value |
| Authentication state (`wp_set_auth_cookie`, `wp_set_current_user`, `wp_signon`, login tokens and one-time codes the plugin issues) | Makes the request act as the user it names | Session as another user |
| Serialized data (`unserialize`, `maybe_unserialize`, serialized options, meta and transients) | Rebuilds objects from the value | Object injection |
| Outbound HTTP (`wp_remote_get`, `wp_remote_post`, `wp_remote_request`, `wp_safe_remote_*`, `download_url`) | Fetches the address it is given from the server | Request from the server to a chosen address |
| User meta and profile (`update_user_meta`, `wp_update_user`, profile fields) | Writes it onto the user record | Capability, role or identity field changed through meta |
| Mail (`wp_mail`: recipient, subject, body, headers) | Sends it from the site | Mail with a chosen recipient, body or header |
| Posts and post meta (`wp_insert_post`, `wp_update_post`, `update_post_meta`, post status and type) | Creates or edits the content it describes | Content published, edited or retyped |
| Password reset (`get_password_reset_key`, `check_password_reset_key`, `reset_password`, `wp_set_password`, `retrieve_password`) | Issues, checks or applies a reset for the user it names | Password of another user set |
| Redirect (`wp_redirect`, `wp_safe_redirect`, `redirect_to`, `allowed_redirect_hosts`) | Sends the browser to the address it is given | Visitor sent to a chosen address |
| Plugin and theme install or activation (`Plugin_Upgrader`, `activate_plugin`, `switch_theme`, `install_plugin_install_status`) | Installs or activates the package it names | Code of the attacker's choice installed |
| Taxonomy terms (`wp_insert_term`, `wp_set_object_terms`, term meta) | Creates or assigns the terms it names | Classification or term content changed |
| Comments (`wp_insert_comment`, `wp_new_comment`, comment meta) | Stores it as a comment with the author and status it carries | Comment stored, approved or attributed as given |
| User deletion (`wp_delete_user`, `wpmu_delete_user`) | Removes the account it names | Account removed |

## Dispatch: core resolves a request into plugin code

| Core feature | What core does with the request |
|---|---|
| Shortcodes (`add_shortcode`, `do_shortcode` on stored or submitted text) | Runs the handler with attributes and content from the text, wherever that text is rendered |
| AJAX (`wp_ajax_*`, `wp_ajax_nopriv_*`, `admin-ajax.php`) | Calls the handler for the `action` the request names; `nopriv` needs no login |
| REST routes (`register_rest_route`, `permission_callback`, `rest_api_init`) | Calls the callback after the permission callback the route declares |
| Scheduled events (`wp_schedule_event`, `wp_schedule_single_event`, `wp_cron`) | Runs the hook later with the arguments stored at scheduling time |

Not counted, still dispatch: `add_action` / `add_filter` on request-time hooks (`init`, `admin_init`, `admin_post_*`, `template_redirect`, `wp_loaded`, `parse_request`), `admin-post.php`, rewrite rules and query vars, XML-RPC methods, blocks and widgets, the Customizer, Heartbeat, `pluggable.php` overrides, activation and uninstall hooks, and WP-CLI commands. The enumeration scripts print the literal registrations of most of these.
