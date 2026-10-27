#!/bin/sh
# enumerate-sinks-v1: prints calls where a value leaves plugin code for an
# effect in the site. One line per match, tab-separated: kind, file, line,
# text. Paths are relative to the source root given as the first argument
# (default /workspace/main). Only literal calls match; a call through a
# variable function name, a bundled framework's own wrapper, or a method the
# plugin defines over one of these does not, and must be added by hand.
set -eu
root="${1:-/workspace/main}"
cd "$root"
emit() {
  grep -rn --include='*.php' -E "$2" . 2>/dev/null \
    | sed -e 's|^\./||' \
    | awk -v kind="$1" 'BEGIN { OFS = "\t" }
      {
        i = index($0, ":"); file = substr($0, 1, i - 1); rest = substr($0, i + 1)
        j = index(rest, ":"); line = substr(rest, 1, j - 1); text = substr(rest, j + 1)
        gsub(/^[ \t]+|[ \t]+$/, "", text); gsub(/\t/, " ", text)
        print kind, file, line, substr(text, 1, 200)
      }' || true
}
emit output '(\b(echo|print)[[:space:]]+[^;]*\$|<\?=|\bprintf[[:space:]]*\()'
emit query '(\$wpdb->(query|get_results|get_var|get_row|get_col|prepare)[[:space:]]*\(|->query[[:space:]]*\()'
emit file '(\b(include|require)(_once)?\b|\b(file_put_contents|file_get_contents|fopen|unlink|rename|copy|mkdir|readfile|fpassthru|move_uploaded_file|wp_handle_upload|wp_upload_bits|wp_delete_file)[[:space:]]*\(|\bZipArchive\b)'
emit deserialize '\b(unserialize|maybe_unserialize)[[:space:]]*\('
emit write '\b(update_option|add_option|update_user_meta|wp_update_user|wp_set_password|wp_insert_user|wp_create_user|set_role|add_role|add_cap|wp_set_auth_cookie|wp_set_current_user)[[:space:]]*\('
emit message '\b(wp_mail|wp_redirect|wp_safe_redirect|wp_remote_get|wp_remote_post|wp_remote_request)[[:space:]]*\('
