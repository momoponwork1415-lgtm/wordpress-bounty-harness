#!/bin/sh
# enumerate-hooks-v1: prints registrations that WordPress core resolves into
# plugin code. One line per match, tab-separated: kind, file, line, text.
# Paths are relative to the source root given as the first argument
# (default /workspace/main). Only literal registrations match; a name built
# at run time, a callback assembled from a variable, or a bundled framework's
# own dispatcher does not, and must be added by hand.
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
emit hook '\badd_(action|filter)[[:space:]]*\('
emit shortcode '\badd_shortcode[[:space:]]*\('
emit rest-route '\bregister_rest_route[[:space:]]*\('
emit block '\bregister_block_type[[:space:]]*\('
emit widget '\bregister_widget[[:space:]]*\('
emit rewrite '\badd_rewrite_(rule|endpoint|tag)[[:space:]]*\('
emit cron '\bwp_schedule_(single_)?event[[:space:]]*\('
emit setting '\bregister_setting[[:space:]]*\('
emit cli '\bWP_CLI::add_command[[:space:]]*\('
