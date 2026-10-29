# core-fixed-list-v2 の全文と日本語訳（2026-10-29）

この文書は #677 の agent-facing 固定道具のレビュー用対照である。英語本文は固定道具と同じ byte 内容を示す。評価の進行状態と結果は Issue の comment に置く。

## 英語本文

```text
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
```

## 日本語訳

# プラグインが渡した値に作用する WordPress 本体の機能（core-fixed-list-v2）

すべてのプラグインに共通する固定の参照資料。WordPress 本体が値を効果に変える場所、またはリクエストをプラグインのコードへ割り当てる場所を挙げる。プラグインは本体の関数を通じてこれらへ到達するため、プラグインのファイルだけを読むと見逃しやすい。効果を生むのは本体であり、値について決めるのはプラグインである。出口と割り当ての種類を探すチェックリストとして使う。何が誤りかを列挙したものではなく、特定のプラグインも挙げない。

## 効果: 本体が値に作用する

| 本体の機能 | 本体が値に対して行うこと | 効果の種類 |
|---|---|---|
| ページ出力（`echo`、`printf`、テンプレート、`wp_kses` の文脈） | 訪問者や管理者が読み込むページに値を出力する | その人のブラウザでスクリプトが動く |
| ファイルシステム（`include`/`require`、`file_get_contents`、`file_put_contents`、`unlink`、`rename`、`copy`、`ZipArchive`、`WP_Filesystem`） | 値をパスとして解決し、ファイルを読み、書き、消し、または実行する | ファイルの読取、書込、削除、またはコード実行 |
| データベース（`$wpdb->query`、`get_results`、`get_var`、`get_row`、`get_col`、`prepare`） | 値をクエリの一部として実行する | サイトが意図していないクエリ |
| ユーザー作成と役割（`wp_insert_user`、`wp_create_user`、`register_new_user`、`set_role`、`add_role`、`add_cap`、既定の役割オプション） | アカウントを作る、または指定された役割を割り当てる | 攻撃者が選んだアカウントまたは権限 |
| メディアのアップロード（`wp_handle_upload`、`wp_handle_sideload`、`media_handle_upload`、`wp_upload_bits`、`wp_insert_attachment`） | 指定された名前と種類でファイルを uploads に保存する | サイトが許さなかった種類の保存ファイル |
| オプションと transient（`update_option`、`add_option`、`set_transient`、設定の取込） | 値をサイトの設定として保存する | 値によるサイトの振る舞いの変更 |
| 認証状態（`wp_set_auth_cookie`、`wp_set_current_user`、`wp_signon`、プラグインが発行するログイントークンと一回限りのコード） | リクエストを指定されたユーザーとして動かす | 別のユーザーとしてのセッション |
| シリアライズされたデータ（`unserialize`、`maybe_unserialize`、シリアライズされたオプション・メタ・transient） | 値からオブジェクトを再構築する | オブジェクト注入 |
| 外向き HTTP（`wp_remote_get`、`wp_remote_post`、`wp_remote_request`、`wp_safe_remote_*`、`download_url`） | 指定されたアドレスをサーバーから取得する | 選んだアドレスへのサーバーからのリクエスト |
| ユーザーメタとプロフィール（`update_user_meta`、`wp_update_user`、プロフィール項目） | 値をユーザー記録に書き込む | メタを通じた権限・役割・識別項目の変更 |
| メール（`wp_mail` の宛先、件名、本文、ヘッダー） | サイトからメールを送る | 選んだ宛先、本文、ヘッダーのメール |
| 投稿と投稿メタ（`wp_insert_post`、`wp_update_post`、`update_post_meta`、投稿の状態と種類） | 値が指定する内容を作成・編集する | コンテンツの公開、編集、種類変更 |
| パスワードのリセット（`get_password_reset_key`、`check_password_reset_key`、`reset_password`、`wp_set_password`、`retrieve_password`） | 指定されたユーザーのリセットを発行、確認、または適用する | 別のユーザーのパスワードの設定 |
| リダイレクト（`wp_redirect`、`wp_safe_redirect`、`redirect_to`、`allowed_redirect_hosts`） | 指定されたアドレスへブラウザを送る | 選んだアドレスへの訪問者の移動 |
| プラグイン・テーマのインストールまたは有効化（`Plugin_Upgrader`、`activate_plugin`、`switch_theme`、`install_plugin_install_status`） | 指定されたパッケージをインストールまたは有効化する | 攻撃者が選んだコードのインストール |
| タクソノミーのターム（`wp_insert_term`、`wp_set_object_terms`、タームメタ） | 指定されたタームを作成または割り当てる | 分類やターム内容の変更 |
| コメント（`wp_insert_comment`、`wp_new_comment`、コメントメタ） | 指定された著者と状態でコメントを保存する | 指定された保存・承認・著者表示のコメント |
| ユーザー削除（`wp_delete_user`、`wpmu_delete_user`） | 指定されたアカウントを削除する | アカウントの削除 |

## 割り当て: 本体がリクエストをプラグインのコードへ解決する

| 本体の機能 | 本体がリクエストに対して行うこと |
|---|---|
| ショートコード（`add_shortcode`、保存または送信されたテキストに対する `do_shortcode`） | テキストが表示される場所で、その属性と内容を渡してハンドラーを実行する |
| AJAX（`wp_ajax_*`、`wp_ajax_nopriv_*`、`admin-ajax.php`） | リクエストが指定する `action` のハンドラーを呼ぶ。`nopriv` はログインを要しない |
| REST ルート（`register_rest_route`、`permission_callback`、`rest_api_init`） | ルートが宣言する permission callback の後に callback を呼ぶ |
| スケジュールされたイベント（`wp_schedule_event`、`wp_schedule_single_event`、`wp_cron`） | スケジュール時に保存した引数で、後からフックを実行する |

表に数えていないが割り当てに当たるもの: リクエスト時のフック（`init`、`admin_init`、`admin_post_*`、`template_redirect`、`wp_loaded`、`parse_request`）での `add_action` / `add_filter`、`admin-post.php`、rewrite rule と query var、XML-RPC method、block と widget、Customizer、Heartbeat、`pluggable.php` の override、有効化とアンインストールのフック、WP-CLI command。列挙スクリプトは、これらの多くについて登録された字面を出力する。
