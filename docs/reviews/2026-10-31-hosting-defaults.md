# 日本のレンタルサーバー 2 社の WordPress 既定堅牢化設定（一次資料調査）

- 確認日: 2026-10-31（全行共通。各ページに最終更新日の表示が無いものが多いため、確認日で代える）
- 対象: エックスサーバー（以下 Xserver）、さくらのレンタルサーバ（以下 さくら）
- 方法: 各社の公式マニュアル・サポートページ・お知らせ・機能ページを WebFetch で読んだ。bot 検査で読めないページは無かった。管理画面は見ていない（契約アカウントが無い）。
- 表の「区分」列: **一次** = 公式ページに明記。**一次から推論** = 公式ページの手順・文脈から読み取れるが明記は無い。**二次** = ブログ・第三者資料。**不明** = 調べた範囲で記載なし。

---

## 1. エックスサーバー

### 1.1 一次資料で確認できたもの

| 設定項目 | 既定値 | 区分 | 出典 URL | 確認日 |
|---|---|---|---|---|
| 国外アクセス制限設定（WordPress セキュリティ設定、ドメイン単位） | **ON**（「本機能は初期状態で『ON(有効)』」）。下位 4 項目の個別初期値はマニュアルに明記なし | 一次 | https://www.xserver.ne.jp/manual/man_server_wpsecurity.php | 2026-10-31 |
| └ ダッシュボード アクセス制限 | 対象 `/wp-admin`、`/wp-login.php`。国外 IP と「海外の主要クラウドサービスが所有する日本国内 IP」を制限。OFF にすると REST API 制限も同時に OFF | 一次 | 同上 | 2026-10-31 |
| └ XML-RPC API アクセス制限 | 対象 `/xmlrpc.php`。国外と「一部の国内ホスティング環境」のアドレスを制限。Jetpack は対象外 | 一次 | 同上 | 2026-10-31 |
| └ REST API アクセス制限 | 対象 `/wp-json`。国外からの接続を制限。Jetpack は対象外。**初期状態 ON** と 2017 年のお知らせに明記 | 一次 | 同上、https://www.xserver.ne.jp/news_detail.php?view_id=3206 、https://www.xserver.ne.jp/news_detail.php?view_id=3149 | 2026-10-31 |
| └ wlwmanifest.xml アクセス制限 | 対象 `/wlwmanifest.xml`。国外からの接続を制限 | 一次 | 同上 | 2026-10-31 |
| 国外アクセス制限の範囲強化（2025-01-29〜02-07 段階適用） | 国外 IP だけでなく「国外からのアクセス」全般へ。国内にサーバーを置く海外クラウド・ホスティングも観測に応じて追加しうる。利用者作業なし | 一次 | https://www.xserver.ne.jp/news_detail.php?view_id=14591 | 2026-10-31 |
| IP アドレス制限（`/wp-admin`、`/wp-login.php` のホワイトリスト制） | **OFF**。ON にすると国外アクセス制限より優先（2026-06-18 追加） | 一次 | man_server_wpsecurity.php、https://www.xserver.ne.jp/news_detail.php?view_id=18691 | 2026-10-31 |
| ログイン試行回数制限 | **ON**。短時間の連続失敗で制限し 24 時間後に解除。しきい値・対象 URL は記載なし | 一次 | man_server_wpsecurity.php | 2026-10-31 |
| 大量コメント・トラックバック制限 | **ON**。スパム時に一時制限、6 時間後に自動解除 | 一次 | 同上 | 2026-10-31 |
| 国外からのコメント・トラックバック制限 | **OFF** | 一次 | 同上 | 2026-10-31 |
| 画像認証（CAPTCHA） | サーバー機能としての記載なし | 不明 | 同上 | 2026-10-31 |
| WAF の検査項目 | 6 種: XSS（スクリプトタグ）、SQL（SQL 構文らしい文字列）、ファイル（`.htpasswd`/`.htaccess`/`httpd.conf` などを含む要求）、メール（to/cc/bcc などメールヘッダ関連文字列）、コマンド（kill/ftp/mail/ping/ls などのコマンド語）、PHP（セッション関連・ファイル操作などの関数名）。検知時はアクセス拒否とエラーページ。反映まで最大 30 分程度 | 一次 | https://www.xserver.ne.jp/manual/man_server_waf.php | 2026-10-31 |
| WAF の既定（ON/OFF） | **公式に記載なし**（マニュアル、2018-07-18 提供開始告知のどちらにも無い） | 不明 | man_server_waf.php、https://www.xserver.ne.jp/news_detail.php?view_id=4601 | 2026-10-31 |
| WAF の製品名 | 公式に記載なし | 不明 | 同上 | 2026-10-31 |
| WordPress 簡単インストールの WP 版 | 版の選択や「最新版が入る」との記載はマニュアルに無い。2026-08-26 に「WordPress 7.1 日本語版」へ対応と告知 | 一次（告知） | https://www.xserver.ne.jp/manual/man_install_auto_word.php 、https://www.xserver.ne.jp/news_detail.php?view_id=19293 | 2026-10-31 |
| 簡単インストールの同梱物 | 利用者が選んだテーマとプラグインを同時導入。テーマ付属プラグインの例: Snow Monkey 系 4 種、Lightning の VK FullSite Installer。既定チェックの有無・有効化の有無は記載なし | 一次 | man_install_auto_word.php | 2026-10-31 |
| 簡単インストールの DB | 新パネルは「自動でデータベースを生成する」。対応は MySQL 5.7/5.5、MariaDB 10.5/10.11。utf8mb4 | 一次 | 同上 | 2026-10-31 |
| 簡単インストール（旧パネル）のキャッシュ自動削除 | Cron で一定間隔に削除する選択項目あり | 一次 | 同上 | 2026-10-31 |
| PHP の版 | 8.5.x〜5.1.6 を提供。「PHP 8.5.x」を「WordPress 推奨バージョン」と記載。8.2.x は「旧バージョン」。新規ドメインの既定版は記載なし。機能ページでは動作確認を PHP 8.1 / MariaDB 10.11 で実施 | 一次 | https://www.xserver.ne.jp/manual/man_program_php_ver.php 、https://www.xserver.ne.jp/functions/ | 2026-10-31 |
| PHP 実行方式 | FastCGI と OPcache/APC が標準で有効 | 一次 | man_program_php_ver.php | 2026-10-31 |
| Web サーバー | nginx を採用。Apache 向けの `.htaccess` をそのまま利用可能 | 一次 | https://www.xserver.ne.jp/functions/ 、https://www.xserver.ne.jp/manual/man_server_htaccess.php | 2026-10-31 |
| php.ini の既定（一部） | `display_errors = ON`、`display_startup_errors = OFF`、`error_reporting = E_ALL & ~E_NOTICE & ~E_STRICT & ~E_DEPRECATED`、`default_charset = UTF-8`、`date.timezone = Asia/Tokyo`、mbstring 系。2017-03 改定の初期値 | 一次 | https://www.xserver.ne.jp/manual/man_server_phpini_setting_item.php | 2026-10-31 |
| php.ini の既定（Xアクセラレータ Ver.2 利用時に固定される「サーバーの初期値」） | `allow_url_fopen = On`、`allow_url_include = Off`、`disable_functions` = 値なし（無効化関数なし）、`disable_classes` = 値なし、`enable_dl = On`、`expose_php = Off`、`file_uploads = On`、`max_file_uploads = 20`、`sendmail_path = /usr/sbin/sendmail -t -i`。`open_basedir` は表に無い | 一次 | https://www.xserver.ne.jp/manual/man_server_phpini_setting_ignore_item.php | 2026-10-31 |
| php.ini の上書き | サーバーパネルでドメイン単位に項目変更・直接編集・初期化ができる。Xアクセラレータ Ver.2 利用時は `.user.ini` が php.ini の役割をし、表の項目は上書き不可 | 一次 | https://www.xserver.ne.jp/manual/man_server_phpini_edit.php 、man_server_phpini_setting_ignore_item.php | 2026-10-31 |
| `.htaccess` | 利用可。パネルの機能や WordPress が自動で記述を書く場合がある。既定の内容、使えないディレクティブ、`php_value` の可否は記載なし。REST API 制限は `.htaccess` に `SetEnvIf Request_URI ".*" AllowRestApi` を書くと解除できる（＝制限はサーバー側規則で環境変数を見ている） | 一次 | man_server_htaccess.php、news view_id=3149 | 2026-10-31 |
| ファイル権限（推奨） | フォルダ 755/705、HTML・PHP 等 644、`.htaccess` 644、CGI 755/705、直接実行しないライブラリ・データ・ログ 600。実行ユーザーの記載なし | 一次 | https://www.xserver.ne.jp/manual/man_server_permission.php | 2026-10-31 |
| WordPress 自動更新 | ホスト側の自動更新機能や既定変更の記載なし。WP 7.1 対応告知でも既存サイトは「管理ページにて手動でのアップデートが可能」とのみ | 不明 | news view_id=19293 | 2026-10-31 |
| Cron | 全プランで利用可。コマンドパスを明記して登録（例 `/usr/bin/php7.4 ...`）。最短間隔・上限・WP-Cron の扱いは記載なし | 一次 | https://www.xserver.ne.jp/manual/man_program_cron.php | 2026-10-31 |
| メール送信数の上限 | 調べた公式ページに記載なし | 不明 | https://www.xserver.ne.jp/functions/ | 2026-10-31 |
| SMTP 認証・SSH の IP アドレス制限 | 2026-08-17 追加。初期状態は記載なし | 一次（初期値は不明） | https://www.xserver.ne.jp/news_detail.php?view_id=19215 | 2026-10-31 |

### 1.2 推測・二次情報

| 項目 | 内容 | 区分 | 出典 | 確認日 |
|---|---|---|---|---|
| WAF の既定 | 6 項目とも「最初は全て OFF」。複数のブログで同じ記述 | 二次（2020-11 公開・2021-06 更新） | https://blog.saboh.net/xserver_security_waf/ | 2026-10-31 |
| WordPress セキュリティ設定の既定 | ログイン試行制限 ON、国外 IP アクセス制限 ON、大量コメント制限 ON、国外コメント制限 OFF（マニュアルと一致） | 二次 | 同上 | 2026-10-31 |
| `/wp-admin/admin-ajax.php`・`admin-post.php` がダッシュボード制限の対象か | マニュアルは対象を「`/wp-admin`」とだけ書く。除外の有無は不明。**再現性に直結するので実アカウントで確かめる必要がある** | 不明 | — | — |
| PHP の実行ユーザー | FastCGI のため契約者ユーザーで動くと推測。WordPress が `wp-content` へ直接書ける（プラグイン導入が FTP 情報なしで動く）と推測 | 推測 | — | — |

---

## 2. さくらのレンタルサーバ

### 2.1 一次資料で確認できたもの

| 設定項目 | 既定値 | 区分 | 出典 URL | 確認日 |
|---|---|---|---|---|
| 国外 IP アドレスフィルター | **有効**（「初期提供時のデフォルト設定で国外IPアドレスフィルターが有効になっています」） | 一次 | https://help.sakura.ad.jp/rs/2260/ | 2026-10-31 |
| └ HTTP/HTTPS の制限対象 | 管理画面: `/wp-admin/`、`/phpmyadmin/`、`wp-login.php`、`mt.cgi`、`admin.cgi`、`wlwmanifest.xml`。コメント・フォーム: `wp-comments-post.php`、`mt-comments.cgi`、`mailformpro.cgi`、`/wp-json/contact-form-7/v1/contact-forms/`。API: `xmlrpc.php`、`mt-xmlrpc.cgi`。制限時は 403。Jetpack と Googlebot は対象外 | 一次 | https://help.sakura.ad.jp/rs/2234/ | 2026-10-31 |
| └ 個別制限（チェック項目）の既定 | 各チェックの初期状態は記載なし。ページ内に「チェックしていなくても制限される」と「チェックしていない項目は制限されない」の両方の文がある（前者は FTP/SSH 等を含む全体の説明、後者は HTTP/HTTPS の個別項目の説明と読める） | 一次（ただし曖昧） | 同上 | 2026-10-31 |
| └ 他プロトコル | FTP/FTPS、SSH/SFTP（公開鍵認証は対象外）、SMTP 認証送信、WebDAV も国外を拒否 | 一次 | 同上 | 2026-10-31 |
| └ 一般の REST API（`/wp-json/` 全体） | フィルター対象として載っているのは Contact Form 7 の経路だけ。`/wp-json/` 全体は対象一覧に無い | 一次 | 同上 | 2026-10-31 |
| WAF の製品 | SiteGuard（シグネチャ型 WAF）。XSS や SQL インジェクションなどを対象 | 一次 | https://rs.sakura.ad.jp/function/waf/ | 2026-10-31 |
| WAF の動作 | 「シグネチャ検査やセッション管理などの検査」で攻撃と判断した接続を遮断し、自動復旧しない。HTTP/HTTPS が対象。特定地域だけの遮断は不可。検出ログは前日分を表示。有効時は mod_deflate の gzip が使えない。mod_rewrite で挙動が変わる場合あり。CGI/PHP のインストールに影響することがある | 一次 | https://help.sakura.ad.jp/rs/2233/ | 2026-10-31 |
| WAF の既定（ON/OFF） | **明記なし**。設定手順は「WAF設定ドメイン」で対象ドメインに「利用する」を選んで保存する、という有効化手順 | 一次から推論（既定は無効と読める） | 同上 | 2026-10-31 |
| ログイン試行制限・画像認証 | サーバー機能としての記載なし | 不明 | https://help.sakura.ad.jp/rs/2162/ | 2026-10-31 |
| クイックインストールの WP 版 | 「更新のタイミングによって最新ではない場合があります」。インストール後に最新版へ更新するよう案内 | 一次 | https://help.sakura.ad.jp/rs/2161/ | 2026-10-31 |
| クイックインストールの同梱プラグイン | 「いくつかのプラグインが自動でインストール」され、「初期設定では無効」。名指しされているのは「TS Webfonts for SAKURA RS」と「All-In-One Security (AIOS)」（AIOS は「クイックインストールで導入済み」「手動での有効化が必要」） | 一次 | https://help.sakura.ad.jp/rs/2159/ 、https://help.sakura.ad.jp/rs/2162/ | 2026-10-31 |
| クイックインストールで入る Web サーバー設定 | mod_deflate（gzip）と mod_expire を適用。対象はクイックインストールの WordPress に限る | 一次 | https://help.sakura.ad.jp/rs/2159/ | 2026-10-31 |
| クイックインストールの DB・設置先 | DB は「自動設定」が標準（名前・パスワード・接頭辞を自動生成）。初期ドメイン直下には入れられずサブディレクトリが要る。ライトプランは不可 | 一次 | https://help.sakura.ad.jp/rs/2161/ 、https://rs.sakura.ad.jp/function/wp/ 、https://www.sakura.ad.jp/corporate/information/announcements/2019/09/11/1968201081/ | 2026-10-31 |
| WordPress のセキュリティ推奨（さくらの案内） | 本体・テーマ・プラグインの更新、`xmlrpc.php` など不要機能の無効化、AIOS を手動で有効にしてログイン URL 変更・XML-RPC 完全遮断・コメントスパム対策。WordPress は既定でマイナー版と翻訳の自動更新を持ち「基本的に有効のまま運用」と案内 | 一次 | https://help.sakura.ad.jp/rs/2162/ | 2026-10-31 |
| PHP の版 | 既定版は「契約時期によって標準設定されているPHPバージョンが異なります」。新規 WordPress では PHP 8.x を推奨。CGI モードは全プラン、モジュールモードはスタンダード以上で PHP 7 以上 | 一次 | https://help.sakura.ad.jp/rs/2241/ 、https://help.sakura.ad.jp/rs/2161/ | 2026-10-31 |
| php.ini | 共用サーバーのため全体の php.ini は編集不可。コントロールパネルの「php.ini設定」で `/www` 配下に適用。PHP 8 以降は「弊社規定の設定」に追記分が加わる（PHP 8 未満は記載分だけ）。管理者権限が要る項目は設定できない場合あり。既定値（`allow_url_fopen`、`disable_functions` など）は公開されていない | 一次 | https://help.sakura.ad.jp/rs/2889/ | 2026-10-31 |
| `.htaccess` | アクセス制御に利用可。2017-10-06 の Apache 更新で `<Limit>` の書き方の扱いが変わった（メソッド名は大文字、存在しないメソッドは不可） | 一次 | https://help.sakura.ad.jp/rs/2214/ 、https://help.sakura.ad.jp/rs/2258/ | 2026-10-31 |
| 自動更新（ホスト側） | ホスト側の自動更新機能の記載なし | 不明 | https://rs.sakura.ad.jp/function/wp/ | 2026-10-31 |
| CRON | スタンダード以上。コントロールパネルから最大 10 個。極端に短い間隔は予告なく解除しうる | 一次 | https://help.sakura.ad.jp/rs/2242/ | 2026-10-31 |
| メール送信数制限 | 2020-04-30 以降の契約で、申込みから 15 日未満または電話番号未認証なら「1日のメール送信数を制限」。上限値は記載なし | 一次 | https://help.sakura.ad.jp/mail/2126/ | 2026-10-31 |
| ウェブサイトアクセス制御 | AI ボットの HTTP/HTTPS アクセスを制御する機能。既定値の記載なし。WordPress ログインには無関係 | 一次 | https://help.sakura.ad.jp/rs/2902/ | 2026-10-31 |

### 2.2 推測・二次情報

| 項目 | 内容 | 区分 | 出典 | 確認日 |
|---|---|---|---|---|
| WAF の既定 | 「the default setting has the WAF disabled」（東京大学 情報基盤センター WEB PARK の FAQ。日付なし） | 二次 | https://www.itc.u-tokyo.ac.jp/education/en/services/webpark/support/page-908/ | 2026-10-31 |
| WAF の既定（古い記事） | 2013 年時点でデフォルト OFF | 二次（古い） | https://gatespace.jp/2013/07/25/sakura-wordpress-waf/ （検索結果の要約のみ） | 2026-10-31 |
| WAF の誤検知例 | WAF 有効時に `core` を含むディレクトリ名への要求が「意図しないファイルの公開の可能性」として遮断された（2021-11 のブログ） | 二次 | https://highfivecreate.com/blog/wordpress/6013.html | 2026-10-31 |
| ファイル権限・実行ユーザー | ディレクトリ・ファイルは 755/705、所有者以外に書き込み権があると suEXEC でエラー | 二次（東大 ITC の FAQ） | https://www.itc.u-tokyo.ac.jp/education/en/?p=800 （検索結果の要約のみ） | 2026-10-31 |
| `/wp-admin/admin-ajax.php`・`admin-post.php` が `/wp-admin/` 制限の対象か | 公式は「`/wp-admin/`」とだけ書く。除外の有無は不明。**実アカウントで確かめる必要がある** | 不明 | — | — |

### 2.3 参考: SiteGuard Server Edition の製品仕様（さくらが使う版と同じかは不明）

開発元 EG セキュアソリューションズの製品ページ（https://eg-secure.co.jp/siteguard/product/siteguard-server-edition 、確認日 2026-10-31）に載る検出対象: SQL インジェクション、XSS、ディレクトリトラバーサル、OS コマンドインジェクション、改行コードインジェクション（HTTP ヘッダ・メールヘッダ）、XXE、パラメータ改ざん、ブルートフォース、クリックジャッキング、Apache Struts の脆弱性、Log4Shell。検査はトラステッド・シグネチャ（メーカー定義）とカスタム・シグネチャ。さくらのレンタルサーバがどの版・どのシグネチャ集合を使うかは公開されていない。

---

## 3. WordPress 本体の既定（両社共通の前提。WordPress.org 側の一次資料）

| 項目 | 既定値 | 出典 | 確認日 |
|---|---|---|---|
| 本体の自動更新 | WordPress 5.6 以降の新規インストールは、マイナー版とメジャー版の両方が既定で自動更新。既存インストールはマイナー版のみ | https://make.wordpress.org/core/2020/11/24/core-major-versions-auto-updates-ui-changes-in-wordpress-5-6-correction/ 、https://core.trac.wordpress.org/ticket/53330 | 2026-10-31 |
| プラグイン・テーマの自動更新 | 既定は無効（利用者が個別に有効にする方式。今回 WordPress.org の該当ページは開いておらず、調査前からの知識による）。両社ともホスト側で変える記載なし | 両社の公式ページに変更の記載なし | 2026-10-31 |
| WP-Cron | 両社とも無効化や置き換えの記載なし（WordPress 既定のまま＝ページアクセス契機で実行） | 記載なし | 2026-10-31 |

両社の簡単／クイックインストールが `wp-config.php` に `WP_AUTO_UPDATE_CORE`、`DISALLOW_FILE_EDIT`、`FS_METHOD` などを書き足すかは、公式ページに記載が無い（不明）。

---

## 4. 2 社に共通する堅牢化設定と Lab 基準 `hosting-default-v1` 案

### 4.1 前提として分かったこと

- 2 社が**既定で掛けている**のは、ほぼ「**国外からの要求を特定パスで止める**」ことだけである。WAF は両社とも既定で有効だという一次資料が無く、二次資料と手順の文脈はどちらも「既定は無効」を示している。
- 2 社に共通する国外制限の対象パスは `/wp-admin/`、`/wp-login.php`、`/xmlrpc.php`、`wlwmanifest.xml` の 4 つである。
  - Xserver だけ: `/wp-json` 全体。
  - さくらだけ: `wp-comments-post.php`、Contact Form 7 の REST 経路、`/phpmyadmin/`。
- 国内 IP からの要求は、どちらの国外制限も止めない。ただし Xserver は、国内にある海外クラウドの IP と一部の国内ホスティングの IP も止める。このため、攻撃者が日本国内の一般回線から来るなら、両社とも既定の状態で WordPress 自体への要求は素の WordPress と変わらない。
- ログイン試行制限と大量コメント制限は Xserver だけにある（さくらは AIOS を同梱するが無効）。共通ではない。
- PHP の設定で一次資料から値が取れたのは Xserver だけである（`allow_url_fopen=On`、`allow_url_include=Off`、`disable_functions` なし、`display_errors=ON`）。さくらは既定値を公開していない。

### 4.2 `hosting-default-v1` 案 — WordPress 側

1. WordPress 本体: Snapshot で固定した安定版を使う。Xserver は最新版に追随しているが、さくらは最新でない場合があると明記しているので、本体の版は「固定版」として台帳に記録する。
2. 同梱プラグイン: 有効なものは置かない。さくらの同梱プラグインは「初期設定では無効」で、Xserver の同梱は利用者が選んだものだけなので、どちらも有効な追加コードは無い。
3. 自動更新: WordPress 既定のまま（新規インストール扱い＝本体はメジャー・マイナーとも有効、プラグイン・テーマは無効）。Lab は外向き通信を持たないので、実際には更新は走らない。走らないことも記録する。
4. WP-Cron: 既定のまま有効にする。
5. ディスカッション設定・パーマリンク・ユーザー登録: WordPress 既定のまま。どちらのホストも変える記載は無い。パーマリンクは、簡単インストール後の既定（「基本」か投稿名か）がどちらも不明である。現行 Lab の値を記録しておく。
6. PHP: 8 系にする（Xserver は 8.5 を推奨、さくらは「PHP 8.x」を推奨）。php.ini は Xserver で一次確認できた値に合わせる: `allow_url_fopen=On`、`allow_url_include=Off`、`disable_functions` 空、`file_uploads=On`、`expose_php=Off`、`date.timezone=Asia/Tokyo`。このうち `allow_url_fopen`・`allow_url_include`・`disable_functions` は PHP 本体の既定値と同じで、さくらがこれと違う値だという根拠は見つからなかった（さくらの値は未確認のまま）。
   - `display_errors` は 2 社で揃わない（Xserver は ON、さくらは不明）。v1 では OFF にし、Xserver 変種で ON にする。
7. ファイル権限: ディレクトリ 755、ファイル 644、`.htaccess` 644。PHP は WordPress ファイルの所有者で動かし、`wp-content` に書けるようにする（FastCGI / suEXEC 型の共用サーバーの推測。一次資料では未確認と記録する）。
8. `.htaccess`: 有効にする（Apache 互換で `AllowOverride All` 相当）。2 社とも `.htaccess` を使え、WordPress が自動で書く。

### 4.3 `hosting-default-v1` 案 — Web サーバー／WAF 側

1. **WAF の模擬規則は既定では置かない。** 2 社とも、既定で WAF が有効だという一次資料が無い。v1 の判定に WAF を入れると「既定」ではなくなる。
2. **国外アクセス制限の模擬規則（共通部分）を置く。** Lab の中では実際の国を判定できない。代わりに、攻撃者の位置に `origin: domestic | foreign` の属性を持たせる。`foreign` のときだけ、次のパスへの要求に 403 を返すリバースプロキシ規則を掛ける。
   - `/wp-admin/` 以下
   - `/wp-login.php`
   - `/xmlrpc.php`
   - `wlwmanifest.xml`

   `domestic` では何も止めない。Finding ごとに両方の結果を記録すると、「日本の既定ホスティングで、国外の攻撃者にも届くか」が分かる。
   - **未確定点（要実機確認）:** `/wp-admin/admin-ajax.php` と `/wp-admin/admin-post.php` が `/wp-admin/` 制限に含まれるかは、2 社とも公式に書いていない。ここで結論が変わる Finding が多いので、v1 では 2 通りを用意する。
     - `strict`: 含む。
     - `lenient`: 除く。

     実アカウントで確かめてからどちらかに固定する。
3. **ホスト別の変種**（v1 の基準には入れず、比較用に名前を分ける）
   - `hosting-xserver-v1`: 国外制限に `/wp-json` 全体を加える。`display_errors=On`。ログイン試行制限（しきい値は不明なので、規則の数値は「不明」と記録して置かないか、仮値と明記する）。大量コメント制限。
   - `hosting-sakura-v1`: 国外制限に `wp-comments-post.php`、`/wp-json/contact-form-7/v1/contact-forms/`、`/phpmyadmin/` を加える。
4. **WAF を有効にした変種**（任意。所有者が「WAF を ON にした利用者でも成立するか」を見たいときだけ）。`hosting-waf-v1` として、Xserver マニュアルの 6 分類に合わせた模擬規則を置く。
   - XSS: 要求の中のスクリプトタグ相当
   - SQL: SQL 構文らしい文字列
   - ファイル: `.htaccess`、`.htpasswd`、`httpd.conf` などのサーバー設定ファイル名を含む要求
   - メール: to / cc / bcc などメールヘッダ関連の文字列
   - コマンド: シェルコマンド名
   - PHP: セッション・ファイル操作系の関数名

   さくらの SiteGuard の分類（ディレクトリトラバーサル、改行コードインジェクション、XXE など）は、製品ページにはあるが、さくらが使う版で有効かは不明である。模擬規則は製品のシグネチャを再現しない。このため、変種で通っても「実 WAF を通る」証拠にはしない。結果は参考列として残す。
5. 置き場所: これらの規則と変種名は WordPress 固有なので `profiles/wordpress/` の Lab 供給側に置く（AGENTS.md の ADR 0011 の規則）。Harness の判定には使わない。人間の観測（`review observe`）で、どの変種の Lab で観測したかを記録する属性として扱う。

### 4.3a `hosting-default-v2`（2026-10-31 追記、#706）

v1 の Lab はパーマリンクが「基本」（`permalink_structure` が空）のままで、投稿名の URL や oEmbed の埋め込み URL のような、pretty パーマリンクを前提にする経路が 404 になった。2026-10-31 には BuddyPress の 1 単位がこれで `incomplete(precondition)` に止まった。v2 は v1 に次の 2 点だけを足す。

- パーマリンク構造を `/%postname%/` にする。サイトを作るときに WP-CLI の `rewrite structure` で 1 回だけ設定し、`permalink_structure` を読み戻す。両社のクイックインストール後の既定は、上の 4.2 の 5 と 4.4 の 5 のとおり一次資料では確かめられていない。v2 は「よく使われる設定」として決めたもので、ホストの既定を確かめた値ではない。
- `.htaccess` に WordPress 標準の書き換えブロック（`# BEGIN WordPress` から `# END WordPress` まで）を置く。Lab の WordPress image は、このブロックを持つ `.htaccess` を最初から置いている。v2 では、ブロックが無いときだけ追記し、プラグインが有効化のときに書いたブロックは上書きしない。読み戻しでは、ブロックの行がそろっているかを確かめる。ファイル権限は v1 と同じ 644 である。

国外 403 の 4 パス、認証済みの攻撃者を国内に置く扱い、PHP の値、同梱プラグインを置かないことは v1 と同じである。v1 のファイルと digest は変えない。`verify next --handoff` は v2 を使い、`lab-provisioned.baseline.id` に `hosting-default-v2` を記録する。

### 4.4 実機確認が要る残りの問い（推測で埋めなかったもの）

1. `/wp-admin/admin-ajax.php`・`admin-post.php` は、両社の `/wp-admin` 国外制限の対象か。
2. Xserver の WAF の既定（公式記載なし。ブログは全 OFF）。さくらの WAF の既定（公式は手順のみ。第三者 FAQ は無効）。
3. Xserver 国外アクセス制限の下位 4 項目は、それぞれ初期 ON か（REST API は ON と明記、他は親設定 ON の記載のみ）。
4. さくらの国外フィルターで、HTTP の個別チェック項目が初期状態で全部入っているか。
5. 簡単／クイックインストールが `wp-config.php` と `.htaccess` に書く内容（自動更新定数、`DISALLOW_FILE_EDIT`、パーマリンク設定など）。
6. 新規ドメインの既定 PHP 版と、さくらの php.ini 既定値（`allow_url_fopen`、`disable_functions`、`display_errors`）。
7. Xserver のログイン試行制限のしきい値と対象 URL（`wp-login.php` だけか、`xmlrpc.php` も含むか）。
