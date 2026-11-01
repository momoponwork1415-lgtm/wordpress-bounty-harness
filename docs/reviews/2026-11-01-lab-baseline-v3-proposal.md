# Lab 基準 `hosting-default-v3` の提案（2026-11-01）

状態: 提案。所有者の確認待ち。PR は出していない。前の項目（選定）は PR #740 と #743 で終えた。

## 1. 今の状態（事実）

基準ファイルは `src/profiles/wordpress/lab/baselines/hosting-default-v2.json`、適用と読み戻しは `src/profiles/wordpress/lab/baseline.ts`、host 入口の 403 は `host-exposure.ts` の filtering gateway が返す。

| 項目 | v2 の値 | 備考 |
| --- | --- | --- |
| 同梱プラグイン | 無し | `wp plugin delete --all` |
| 自動更新の定数 | 未定義（WordPress 既定） | Lab は外向き通信を持たないので更新は走らない |
| PHP | 8 系、`display_errors` off、`allow_url_include` off、`allow_url_fopen` on、`disable_functions` 空 | |
| ファイル権限 | 755 / 644 | |
| パーマリンク | `/%postname%/`、`.htaccess` に WordPress の書き換えブロック | #706 |
| 未認証攻撃者の位置 | `foreign`。`/wp-admin`（admin-ajax、admin-post を除く）、`/wp-login.php`、`/xmlrpc.php`、`*/wlwmanifest.xml` に 403 | Xserver とさくらの国外制限の共通部分 |
| ログインする攻撃者の位置 | `domestic`。何も止めない | 2026-10-31 決定 |
| 適用先 | 検証 Lab と review Lab だけ。探索 Lab には当てない | #699 の 4。再開が `setupDigest` を照合するため |

`wp-config` の定数は「未定義」しか表せない。`DISALLOW_FILE_EDIT` のような true の定数、ディスカッション設定のような option、全員に対する 403 は、今の schema に無い。

**所有者の指示との食い違い:** v2 は国外の未認証攻撃者に `/wp-login.php` を 403 にする。所有者は「ログインページは制限せずアクセスできる状態に」と指示した（Wordfence はログイン画面を入口とする報告を受け付ける）。

**WordPress 公式の Hardening ガイド（developer.wordpress.org、最終更新 2026-10-14）が書いていること:** 更新、強いパスワードと 2 段階認証、ファイル権限 755/644、`wp-config.php` の保護（権限 400/440、`.htaccess` で拒否）、`DISALLOW_FILE_EDIT` を true、`wp-includes` の PHP を `.htaccess` で止める、`wp-admin` にサーバー側の認証、admin ユーザー名を使わない、テーブル接頭辞の変更、使わないプラグインの削除。**XML-RPC、pingback、trackback、REST API、ユーザー登録、アプリケーションパスワード、コメントには触れていない。** XML-RPC を止める根拠は公式ガイドではなく、さくらの案内（「`xmlrpc.php` など不要機能の無効化」、同梱 AIOS の「XML-RPC 完全遮断」）と Xserver の国外制限になる。提案ではそう書く。

**Wordfence の不採用との対応:** 不採用 40 件のうち 2 件が「WordPress 本体の既知の弱点に依存する連鎖。本体が直れば contributor 以上」。この規則は Git 外の不採用データにだけあり、`wbh-screen` の本文には無い（grep で `xmlrpc`、`core-dependency`、`本体の` が 0 件）。Lab の設定だけでは本体のロジックの弱点は消せないので、審査の規則も要る。

## 2. 提案

v3 は v2 に次を足し、1 つを外す。版を上げるので v1、v2 のファイルと digest は変えない。

| # | 変更 | 根拠 | 誰に効くか |
| --- | --- | --- | --- |
| 1 | `/wp-login.php` を 403 の一覧から外す | 所有者の指示。Wordfence がログイン画面の入口を受け付ける | 国外の未認証攻撃者 |
| 2 | `/xmlrpc.php` を**全員**に 403 にする（新しい `origins: all` の規則）。加えて `xmlrpc_enabled` フィルタを false にする mu-plugin を置く | さくらの案内と AIOS、Xserver の国外制限。本体の XML-RPC（pingback の SSRF 的な連鎖、認証の総当たり）を plugin の脆弱性の足場にさせない | 全員 |
| 3 | ディスカッション既定を「新規投稿の pingback / trackback を受け付けない」にする（`default_ping_status: closed`、`default_pingback_flag: 0`） | pingback の受信は普通は切る機能。コメントは開けたまま（本体の低権限入力として残す） | 全員 |
| 4 | `DISALLOW_FILE_EDIT` を true にする（schema に true の定数を足す） | 公式ガイド | 管理者 |
| 5 | `wp-includes/*.php` と `wp-admin/includes/` への直接要求を `.htaccess` で止める | 公式ガイド。本体の include 専用ファイルの直叩きを plugin の経路に数えさせない | 全員 |
| 6 | 同梱テーマは既定テーマ 1 つだけ、admin のログイン名は `harness-admin` のまま、テーブル接頭辞は `wp_` のまま | 既定テーマの削除は Lab の見た目を変える。接頭辞の変更は SQLi の再現文を変える（Wordfence は `wp_` 前提の PoC を受ける） | 変更なし |
| 7 | `wbh-screen` に規則 1 行を足す: 「連鎖が WordPress 本体の弱点（XML-RPC、pingback、既知の本体 CVE）を前提にするなら、本体が直った位置で権限を評価し、contributor 以上なら対象外」 | 不採用 2 件の規則 | 審査 |
| 8 | 探索 Lab（ADR 0044 の付属 Lab）にも v3 を当てる。別 PR。再開は `setupDigest` を照合するので、ランナー再起動の境界で切り替える | 所有者の「常に起動できる」。探索中の AI が XML-RPC を足場に連鎖を組まないようにする | 探索 |

変えないもの: PHP の値、ファイル権限、パーマリンク、同梱プラグイン無し、`/wp-admin` と `wlwmanifest.xml` の国外 403、認証済み攻撃者を国内に置く扱い、判定器を置かないこと（基準から scope を推定しない）、台帳は `baseline: { id, digest }` だけ。

## 3. 残す問い（Lab では答えが出ないもの）

- REST API の `/wp-json/wp/v2/users` によるユーザー列挙は本体の既定の振る舞いで、Wordfence は plugin の脆弱性として受けない。Lab で止めると、plugin が REST に足した経路まで見えなくなるので止めない。審査の規則 7 で扱う。
- アプリケーションパスワード（5.6 以降は既定で有効）は本体の機能で、止める根拠が公式にもホストにも無い。既定のまま。
- `display_errors` は Xserver が ON、さくらは不明。v2 のまま off。

## 4. 実装の大きさ（OK が出たら）

- `baseline.ts`: pathRule に `origins`（省略時 `["foreign"]`）、wp-config の定数に `true`、`wordpress` の `option` 設定、`web-server` の `includes-denied`。読み戻しも各 1 つ。
- `baselines/hosting-default-v3.json`、`CURRENT_WORDPRESS_LAB_BASELINE_ID` を v3 に。
- filtering gateway: 規則の `origins` を見る。
- mu-plugin 1 ファイル（`xmlrpc_enabled` false）。ソースは Snapshot の外なので digest は基準ファイルに入れる。
- `wbh-screen` の 1 行（owner-approved）。
- テスト: 国外・国内・認証済みの 3 位置で xmlrpc が 403、wp-login が 200、`/wp-admin` の国外 403 が維持。読み戻し不一致で `failureStage: seed`。
- PR 2 本（基準 v3 と審査 1 行 / 探索 Lab への適用）。docs/reviews/2026-10-31-hosting-defaults.md に 4.3b を追記。

## 5. 確認してほしい点

1. `/wp-login.php` を国外にも開ける（提案 1）。
2. XML-RPC は全員に対して止め、pingback / trackback の受信も切る（提案 2、3）。公式ガイドではなくホストの案内が根拠であることを了解できるか。
3. 探索 Lab にも当てる（提案 8）。

## 6. 所有者の決定（2026-11-01）と v3 の確定

所有者: 「Wordfence が受け付けるものについてはいいので、そこは制限しなくていい。攻撃面として認めるべき。あとは推奨で。」

これで v3 は次のとおり確定する。

- **国外 403 を全部外す（`deniedPaths: []`）。** Wordfence は未認証・subscriber・customer の攻撃者からの、どの URL への経路も受け付ける。`/wp-login.php`、`/xmlrpc.php`、`/wp-admin` 配下はすべて攻撃面として認める。提案 2（XML-RPC を全員に 403）と提案 3（pingback / trackback の受信を切る）は取り下げる。XML-RPC 経由で plugin が登録した経路や、pingback を処理する plugin の経路は Wordfence が受ける攻撃面だからである。`attacker.origin` の欄は台帳の互換のために残し、v3 では何も止めない。
- **本体の弱点への依存は Lab ではなく審査で落とす（提案 7）。** `wbh-screen` に規則 1 行を足す。
- **推奨どおり入れるもの:** `DISALLOW_FILE_EDIT` true（提案 4）、`wp-includes` と `wp-admin/includes` の直叩きを `.htaccess` で止める（提案 5。plugin のコードは `wp-content` にあるので攻撃面を削らない）、同梱テーマ・admin 名・接頭辞は据え置き（提案 6）、探索 Lab にも当てる（提案 8、別 PR）。
