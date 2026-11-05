#!/bin/sh
# enumerate-sinks-v2: prints calls where a value leaves plugin code for an
# effect in the site. Output matches are grouped by function (or top level)
# within each file; text keeps the first match and the extra count. Other
# kinds keep one line per match, tab-separated: kind, file, line,
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
# Tokenize source as data; never include or evaluate a source file.
php <<'PHP'
<?php
$files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator('.', FilesystemIterator::SKIP_DOTS));
foreach ($files as $file) {
    if ($file->isLink() || !$file->isFile() || !str_ends_with($file->getFilename(), '.php')) continue;
    $source = file_get_contents($file->getPathname());
    if ($source === false) throw new RuntimeException('Cannot read source');
    $matches = [];
    $offset = 0;
    foreach (explode("\n", $source) as $line => $text) {
        if (preg_match('/(\b(echo|print)\s+[^;]*\$|<\?=|\bprintf\s*\()/', $text, $match, PREG_OFFSET_CAPTURE)) {
            $matches[] = ['offset' => $offset + $match[0][1], 'line' => $line + 1,
                'text' => substr(str_replace("\t", ' ', trim($text, " \t\r")), 0, 200)];
        }
        $offset += strlen($text) + 1;
    }
    $groups = [];
    $functions = [];
    $depth = 0;
    $offset = 0;
    $next = 0;
    foreach (token_get_all($source) as $token) {
        $id = is_array($token) ? $token[0] : null;
        $text = is_array($token) ? $token[1] : $token;
        if ($id === T_FUNCTION || $id === T_FN) {
            $functions[] = ['id' => $offset + 1, 'depth' => null,
                'arrow' => $id === T_FN, 'base' => $depth, 'body' => false];
        }
        $last = array_key_last($functions);
        if ($id === T_DOUBLE_ARROW && $last !== null && $functions[$last]['arrow'] && $functions[$last]['base'] === $depth) {
            $functions[$last]['body'] = true;
        }
        while ($last !== null && $functions[$last]['arrow'] && $functions[$last]['body']
            && $functions[$last]['base'] === $depth
            && ($id === T_CLOSE_TAG || in_array($token, [',', ';', ')', ']', '}'], true))) {
            array_pop($functions);
            $last = array_key_last($functions);
        }
        if (in_array($token, ['{', '(', '['], true)) {
            $depth++;
            if ($token === '{' && $last !== null && !$functions[$last]['arrow']
                && $functions[$last]['depth'] === null) $functions[$last]['depth'] = $depth;
        } elseif ($id === T_CURLY_OPEN || $id === T_DOLLAR_OPEN_CURLY_BRACES || $id === T_ATTRIBUTE) $depth++;
        while (isset($matches[$next]) && $matches[$next]['offset'] < $offset + strlen($text)) {
            $scope = $functions === [] ? 0 : $functions[array_key_last($functions)]['id'];
            if (!isset($groups[$scope])) $groups[$scope] = $matches[$next] + ['extra' => 0];
            else $groups[$scope]['extra']++;
            $next++;
        }
        $last = array_key_last($functions);
        if (in_array($token, ['}', ')', ']'], true)) {
            if ($last !== null && $functions[$last]['depth'] === $depth) array_pop($functions);
            $depth--;
        } elseif ($token === ';' && $last !== null && $functions[$last]['depth'] === null) array_pop($functions);
        $offset += strlen($text);
    }
    foreach ($groups as $group) {
        echo "output\t", substr($file->getPathname(), 2), "\t", $group['line'], "\t",
            $group['text'], ' (+', $group['extra'], ")\n";
    }
}
PHP
emit query '(\$wpdb->(query|get_results|get_var|get_row|get_col|prepare)[[:space:]]*\(|->query[[:space:]]*\()'
emit file '(\b(include|require)(_once)?\b|\b(file_put_contents|file_get_contents|fopen|unlink|rename|copy|mkdir|readfile|fpassthru|move_uploaded_file|wp_handle_upload|wp_upload_bits|wp_delete_file)[[:space:]]*\(|\bZipArchive\b)'
emit deserialize '\b(unserialize|maybe_unserialize)[[:space:]]*\('
emit write '\b(update_option|add_option|update_user_meta|wp_update_user|wp_set_password|wp_insert_user|wp_create_user|set_role|add_role|add_cap|wp_set_auth_cookie|wp_set_current_user)[[:space:]]*\('
emit message '\b(wp_mail|wp_redirect|wp_safe_redirect|wp_remote_get|wp_remote_post|wp_remote_request)[[:space:]]*\('
