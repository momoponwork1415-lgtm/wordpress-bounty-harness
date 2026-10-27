# 本体の機能の悪用: Wordfence mirror の先例の集計（2026-10-28）

「調べて報告」の記録。正本ではない。所有者決定（2026-10-28、[承認用の要約](2026-10-28-adopted-design-for-approval.md) §6 の Q6・Q11〜Q13）: プラグインのソースだけでは見つからない「本体の機能の悪用」を、全プラグイン共通の固定知識として脅威モデルの形で用意し、先例の件数を優先度の目安として添える。この文書はその導出で、一覧そのものは [`core-fixed-list-v1.md`](../../src/profiles/wordpress/discovery/tools/core-fixed-list-v1.md)（agent に渡る文章、digest 固定）にある。Issue #632。

## 1. 元データ

- ローカルの Wordfence 履歴 mirror（`history.sqlite`、読み取り専用）。2026-10-27 19:10 UTC の更新、42,848 件（`content_sha256` は `62498fcd…`）。
- 数えたのは、プラグインの記録（`software.type = 'plugin'`）で、2026-10-27 までに公開され、`informational` でないもの。公開日 2025-01-01 以降に絞って 19,114 件。研究者の名前が付いた記録は 19,056 件（99.7%）なので、「研究者経由か」の列は意味を持たず、載せていない。

## 2. 分類の規則

題名と説明文を結合した文字列に、機能ごとの正規表現（大文字小文字を区別しない）を当てた。1 件が複数の機能に数えられる。「unauthenticated attackers」を含む記録を未認証として別に数えた。規則は次のとおり（抜粋。完全な表現は集計 script にある）。

| 機能 | 当てた語 |
|---|---|
| password-reset | password reset、reset key、retrieve_password、wp_set_password、forgot / lost password |
| user-create-role | wp_insert_user、wp_create_user、register as an administrator、user registration、set_role、add_role、default role、privilege escalation |
| auth-cookie-login | wp_set_auth_cookie、wp_set_current_user、log in as、authentication bypass、magic link、one-time login / code、login token、social login、account takeover |
| user-meta-profile | user_meta、update_user_meta、profile field、display name |
| user-delete | wp_delete_user、delete arbitrary users |
| options | update_option、arbitrary option、options update、plugin settings、settings import、transient |
| upload-media | wp_handle_upload、media library、file upload、arbitrary file upload、sideload |
| file-read-delete-include | file read / deletion / download / inclusion、directory traversal、local / remote file inclusion、arbitrary file write、unlink |
| database-query | sql injection、$wpdb、prepare(、get_results、time-based blind |
| html-output | cross-site scripting、output escaping |
| mail | wp_mail、send arbitrary emails、email header / body / template、mail injection |
| redirect | wp_redirect、wp_safe_redirect、open redirect、redirect_to |
| http-request | wp_remote_*、server-side request forgery、arbitrary URL、fetch a remote resource |
| rest-api | rest api、rest route、register_rest_route、/wp-json/ |
| ajax | ajax、admin-ajax、wp_ajax |
| shortcode | shortcode、do_shortcode |
| cron | cron、scheduled event、wp_schedule |
| post-content-meta | wp_insert_post、wp_update_post、post_meta、arbitrary posts、post status |
| deserialize | php object injection、unserialize |
| plugin-theme-install | install / activate plugins or themes、plugin installation、activate_plugin |
| comments | wp_insert_comment、comment form / submission、arbitrary comments、comment_meta |
| taxonomy-terms | taxonomy、wp_insert_term、wp_set_object_terms、term meta |

## 3. 件数（2025-01-01 以降、19,114 件のうち）

| 機能 | 記録 | うち未認証 |
|---|---|---|
| html-output（ページ出力） | 7,529 | 3,155 |
| file-read-delete-include（file の読み書き・削除・include） | 1,521 | 712 |
| database-query（DB の query） | 1,487 | 640 |
| shortcode（shortcode の展開） | 1,396 | 212 |
| ajax | 1,025 | 469 |
| user-create-role（利用者の作成と role） | 887 | 481 |
| upload-media（media の upload） | 629 | 290 |
| options（option と transient） | 607 | 348 |
| auth-cookie-login（認証状態） | 489 | 357 |
| deserialize（serialize された値） | 470 | 218 |
| rest-api | 393 | 228 |
| http-request（外向きの HTTP） | 294 | 99 |
| user-meta-profile（user meta と profile） | 288 | 130 |
| mail | 265 | 177 |
| post-content-meta（投稿と post meta） | 191 | 69 |
| password-reset | 84 | 52 |
| redirect | 77 | 72 |
| plugin-theme-install（plugin / theme の導入と有効化） | 69 | 28 |
| taxonomy-terms | 64 | 24 |
| comments | 56 | 45 |
| cron | 25 | 17 |
| user-delete | 18 | 10 |

## 4. 読み方と限界

- 公開は受理を示すだけで、却下は示さない。0 に近い機能に先例が無いのは、提出されていないか、別の語で書かれているかのどちらかで、弱い証拠にしかならない。
- 語の一致なので粗い。たとえば user-create-role は「privilege escalation」を含むため、role と関係ない記録も混ざる。shortcode は contributor 以上の投稿者による記録が多く、未認証の割合が低い。件数は順位の目安であって、どの機能を読むべきかを決めるものではない。
- 一覧に載せた「dispatch」4 行（shortcode、ajax、rest-api、cron）は出口ではなく、本体が要求をプラグインのコードに解決する経路である。hook の登録そのものは列挙 script が拾うので数えていない。
- 分類の script は session の scratchpad にあり、repo には入れていない。更新は所有者決定 Q13 のとおり、mirror の月次の集計で新しい類が出たときだけ、数字付きの PR で一覧の版を上げる。そのときはこの文書に日付の節を足す。
