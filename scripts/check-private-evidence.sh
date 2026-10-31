#!/usr/bin/env bash
set -eu
# base との二点 diff だと、PR branch が古い main から分岐している間に main 側へ入った変更が逆向きに見える。merge-base からの三点 diff にする。
merge_base=$(git merge-base "$BASE" "$HEAD")
added=$(git diff --name-only --diff-filter=AMR "$merge_base" "$HEAD")
bad=$(printf '%s\n' "$added" | grep -Ei \
  '(^|/)(\.private|evidence|poc|attachments|private-evidence)(/|$)|(^|/)(wordfence-fill|submission-package|human-verification|verification-package)[^/]*\.json$|\.(har|sqlite|sqlite3|db|png|jpe?g|gif|webp|mp4|mov|webm|zip|tar|gz|7z|pcap|pem|key)$' \
  || true)
if [ -n "$bad" ]; then
  echo "Private Evidence か提出 package の構成物に見える path があります（SPEC.md 第 2 節 8、docs/DEVELOPMENT.md 第 5 節）:"
  echo "$bad"
  exit 1
fi
big=$(printf '%s\n' "$added" | while read -r f; do
  [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 524288 ] && echo "$f ($(wc -c < "$f") bytes)" || true
done)
if [ -n "$big" ]; then
  echo "512 KiB を超えるファイルが追加されています。記録や複製は Git 外に置く:"
  echo "$big"
  exit 1
fi
# 内容走査: 文書・設定・script に Lab の canary token、HTTP 捕捉の行、秘密鍵が貼られていないか。
# src/ と tests/ は fixture が同じ語を使うので対象外（path guard のみ）。
diff=$(git diff -U0 "$merge_base" "$HEAD" -- docs/ examples/ scripts/ containers/ '*.md' ':!src/**' ':!tests/**' ':!.github/workflows/check.yml')
content=$(printf '%s\n' "$diff" \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -nE 'wbh-canary-[A-Za-z0-9-]{8,}|\{"request":\s*\{"method":|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|wordpress_logged_in_[0-9a-f]{32}=' || true)
if [ -n "$content" ]; then
  echo "Private Evidence に見える内容（canary token、HTTP 捕捉、秘密鍵、session cookie）が文書に貼られています。検出した本文はログに表示しません。"
  exit 1
fi
echo "private-guard: ok"
