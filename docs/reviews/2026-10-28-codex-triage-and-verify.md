# Codex への依頼（2026-10-28）: 振り分けと検証を列から回す

「調べて報告」の記録ではなく、所有者が Codex に貼る依頼文。正本は AGENTS.md と docs/agents/。前の依頼文 `~/.local/state/wordpress-bounty-harness/CODEX-VERIFY-BRIEF-20261027.md` の B は Lab が 0 件のまま止まっているので、この文で置き換える。

共通: リポジトリは `/home/dev/worktree/prod26`（本番 checkout、ビルド済み）。CLI は `node --no-warnings dist/cli/main.js --state /home/dev/.local/state/wordpress-bounty-harness --host /home/dev/.config/wordpress-bounty-harness/host-production-v8-codex0164.json <command>`。skill は `.claude/skills/<name>/SKILL.md` を読んでそのとおりに行う。Private Evidence の本文、payload、対象固有の関数名・URL を GitHub と chat に書かない。

## A. runner を v14-wide に戻す（先にこれだけ、5 分）

いまの runner は `campaign-production-codex-wide-5-v18-20261028.json`（promptId v18-wide、archived 済み）で動いている。`continuous stop` の後、`campaign-production-codex-wide-5-20261028.json`（promptId v14-wide、同じ同時 5、maxChildren 8）で `continuous run --resume` し直す。最初の `discovery-run-started` の `configuration.promptVariant` が `wp2shell-bounty-v14-wide`、`contractDigest` が `sha256:5acd5157…` であることを 1 行で報告する。

## B. 段 1b（固定ソースの読み直し）: 59 件 / 20 対象

skill は `wbh-source-check` v1。対象ごとに 1 単位、10 件まで。Lab も通信も要らない。各 Finding は `review export --campaign <id> --finding <id>` で読み、Snapshot の固定ソースは export が指す場所から読む。

結果の記録:
- 不成立 → `review decide --campaign <id> --finding <id> --decision reject --reason source-check-input|source-check-reach --by codex`
- 未決（依存ソースが Snapshot に無い、sink がテーマ側）→ `review decide … --decision defer --reason source-check-unknown --by codex`
- 成立 → 何も打たず、C の列の末尾に足す（群につき代表 1 件）
- 対象ごとの memo を `~/.local/state/wordpress-bounty-harness/private-evidence/source-check-report-2026-10-28-<slug>.md` に書く

| 対象 | campaign | 件 | finding（先頭 8 桁） |
|---|---|---|---|
| acf-extended@0.9.2.8 | p3-acf-extended-r3 | 4 | eb77bc12 508dd419 da3f64e3 b0f553d7 |
| advanced-custom-fields-font-awesome@6.2.0 | prod-20261027-7 | 4 | fa92a0bc 2afa53cb a443b6de ebbbc1bd |
| buddypress@14.5.4 | prod-20261027-12 | 4 | a7bacc5b 541ebd8c 66f4c8d0 8686c8b3 |
| codepress-admin-columns@7.1.7 | p3-codepress-admin-columns-r3 | 3 | 4d553bbc ef41ac9f ac06d192 |
| customer-reviews-woocommerce@5.126.0 | prod-20261027-3 | 2 | 0f7ea86e fd2eec89 |
| depicter@4.8.3 | prod-20261027-2 | 2 | d6c0279d 1aba6f96 |
| easy-accordion-free@3.1.11 | prod-20261027-10 | 6 | 4ebde369 afcce758 972b284c c5652461 73fc8318 7dde7dd0 |
| email-encoder-bundle@2.5.5 | prod-20261027-8 | 4 | 62fdced5 630ae147 678e8f31 66ef2f32 |
| everest-forms@3.6.3 | prod-20261027-11 | 3 | 5b237061 a4e0252a 0d854339 |
| insert-php@2.7.10 | prod-20261027-16 | 1 | 3c62bffb |
| jupiterx-core@4.62.0 | prod-20261027-11 | 4 | 11bbe43c 1b493197 4d0d1e3f 3f816d28 |
| koko-analytics@2.5.3 | prod-20261027-17 | 2 | 02a8489a 6a0ffd06 |
| login-customizer@2.5.4 | prod-20261027-16 | 4 | cf40947d 705bf473 47eb1036 b9bab914 |
| mobile-menu@2.9 | prod-20261027-12 | 2 | 4ca0f88d b892db9a |
| ninja-tables@5.2.18 | prod-20261027-6 | 2 | 6afdbd97 69236d8b |
| pods@3.3.9.2 | p3-pods-r2 | 3 | 2c9993e2 d7a0b55d d6daf2e6 |
| tracking-code-manager@2.8.0 | prod-20261027-17 | 2 | 00939858 8d9c8460 |
| weglot@6.4.3 | prod-20261027-12 | 4 | b3ab90c6 5b9c2df3 d388a32a 45f508e8 |
| wp-carousel-free@5.0.0 | prod-20261027-15 | 2 | c7f9e0c4 7842e99c |
| wp-recipe-maker@10.9.1 | prod-20261027-10 | 1 | a7b20695 |

すでに読み終えて記録だけ残っているもの: hello-plus@1.7.8（prod-20261028-3、fdbd90a7 63d2ed55 a700d329 025117b0）は 4 件とも 不成立（input）。`review decide … --decision reject --reason source-check-input --by codex` を 4 回打つ。memo は `private-evidence/source-check-report-2026-10-28.md` にある。

## C. Lab（段 3）: 1 枠直列、群につき代表 1 件

`verify next --config /home/dev/.config/wordpress-bounty-harness/campaign-production-codex-wide-5-20261028.json --handoff <新しい dir> --campaign <id> --finding <id>` で Lab を立て、skill `wbh-verify` のとおりに前提を作り（`setup-done`）、`observation-ready` の後に攻撃者位置だけで route を実行して 6 ファイルを書く。Codex は判定しない。`observation-ready` に着いたら、所有者が自分のブラウザで alert を見る（2026-10-26 の決定）。所有者の観測の記録（`review observe … --by <所有者>`）と採否（`review decide`）は所有者が打つ。Codex は 1 件終えるごとに 1 行で報告する: 順番、campaign、代表 finding、結果（observation-ready / abort の理由 / incomplete の理由）、所要分。

Lab は 1 台 1 枠。前の Lab が `lab down` されるまで次を立てない。30 分の壁は `lab.json` が書かれた時点から始まる。

| 順 | 対象 | campaign | 代表 finding | 前提の要点 | 備考 |
|---|---|---|---|---|---|
| 1 | wp-ulike@5.2.5 | prod-20261027-15 | a787a4d6 | Subscriber の表示名 → BuddyPress 通知。BuddyPress と既定でない設定が要る | 段 1 で 提出可 中 |
| 2 | wp-table-builder@2.2.4 | prod-20261028-5 | 26bca5ac | 管理者が設定で Subscriber を表の編集役に加える | 段 1b 成立 2 件、代表 1 |
| 3 | stream@4.4.0 | prod-20261028-6 | 70bf0b17 | 管理者が除外規則で攻撃者の利用者を選んで保存 | 段 1b 成立 2 件、代表 1 |
| 4 | enable-media-replace@4.2.2 | prod-20261019-10 | 47d1671c | Subscriber の first_name → 管理者が既定モードで置き換えを 1 回 → Users 一覧 | Lead L2 で前提が「列挙したどれかの画像」に狭まることを確認。memo `private-evidence/lead-source-check-2026-10-28-enable-media-replace.md`。永続オブジェクトキャッシュ無し |
| 5 | depicter@4.8.3 | prod-20261027-2 | d6c0279d | 未認証のフォーム入力 → 管理者のリード一覧でリンクになる | B の結果が成立なら |
| 6 | pods@3.3.9.2 | prod-20261019-9 | da8adf10 | 公開タクソノミーの追加フォーム + 既定の Website フィールド | 群 14 件。p3-pods-r2 の 3 件は B の結果を見てから |
| 7 | siteorigin-panels@2.38.0 | prod-20261020-2 | 2b1c2856 | プラグイン有効化のみ、Subscriber | 1 件 |
| 8 | shortcodes-ultimate@7.9.2 | prod-20261019-9 | 649dbb00 | Latest Comments ブロック | 群 10 件。コメント → shortcode 家族 |
| 9 | customer-reviews-woocommerce@5.126.0 | prod-20261027-3 | 0f7ea86e | 顧客のレビュー名 → 管理者の編集画面 | B の結果が成立なら |
| 10 | email-encoder-bundle@2.5.5 | prod-20261027-8 | 62fdced5 | 既定でない保護設定、確率的に発火 | B の結果が成立なら。2 群 |
| 11 | optimole-wp@4.2.17 | prod-20261018-1 | 1d899ea4 | Optimole 接続済み + 既定置換 | 判定器時代の runtime-confirmed は新しい流れで再検証 |
| 12 | schema-and-structured-data-for-wp@1.68 | opus-prod-20261019-3 | 23e2cc3e | 公開ページのレビューフォーム + 管理者がレビュー公開 | 1 件 |
| 13 | click-to-chat-for-whatsapp@4.45 | prod-20261020-2 | 94d92ac7 | 旧版 UI が残った更新サイト | 前提が弱いので後ろ |
| 14 | cookieadmin@1.2.6 / woo-smart-wishlist@6.2.0 | 台帳の finding-recorded で引く | a004b36c / afdb86cc | 管理者の Scan 実行 / wishlist key を知っている | 影響が弱い。最後 |

10-27 の表にあった codepress-admin-columns、vk-blocks、check-email、official-mailerlite-sign-up-forms は所有者がすでに Wordfence に提出済み（または重複判定）なので Lab に掛けない。B で成立になった対象は 14 の後に足す。

## 触らないもの

- プロンプト、スキル、docs、src、git、GitHub の merge / close / ラベル。
- 台帳への直接の書き込み（CLI の `review decide` と skill が書く記録は可）。
- 探索 runner を止めない（A の切り替え以外）。検証 Lab と探索は並走してよい。memoryBudget が足りなければ Codex の判断で探索の同時数を一時的に下げ、報告に書く。
- Private Evidence の中身を chat や Issue に貼らない。
