# 入口索引の実測と、所有者の 7 件の data flow（2026-10-18）

調べて報告。所有者の問い「この探索方法は何を根拠にしているか」「source の網羅は正規表現だけでできるか」「私の発見一覧はどういう data flow か。この方法で行けるか」に答える。正本ではない。

## 0. 結論

1. 根拠は 3 つで、強さはまちまち。(a) 本番 115 Trial の自前の統計（Lead 403 件の 224 件が入口未発見で止まる、Root wall 中央値 7 分、候補の 8 割が受理されない種類）。(b) 外部の実践の共通形（Cloudflare、XBOW、OpenAnt、night-wolf、Big Sleep）。vendor blog が多く、査読付きは OpenAnt、Refute-or-Promote、AIxCC の総説くらい。(c) 所有者の 18 件の有償クラスの分布。dispatch が協調 Trial に勝つという対照実験は無い。だから gate を置いている。
2. 正規表現の索引は「文字列リテラルで登録された入口」しか見ない。7 件の source で測ると、Brizy は `add_action` 282 のうち 90 が変数か連結、Unlimited Elements は自前の AJAX dispatcher の内側に数十の action がある、SSA は REST route 52 のうち 36 が連結で名前が `/` に潰れる。索引の `incomplete` flag はサイズ上限だけを見ていて、これらの取りこぼしでは立たない。
3. 所有者の 7 件のうち、入口索引から出発する課題で入口に直接届くのは 2 件（TranslatePress 3.3.1、SSA は file:line 付きで部分的）。3 件は producer が core か外部（comment、Facebook）で、plugin 側は「読んで描画する側」。2 件は入口の登録が連結か内部 dispatcher で索引に無い。**所有者の型は「他者が書いた data を plugin が信じて読み、管理画面か未認証 endpoint に出す」が 4 / 7。** 入口から順方向に辿る課題だけでは半分しか届かない。sink 側から逆向きに辿る課題の家族と、索引の 3 つの修正が要る。

## 1. 7 件の data flow と索引の状態

| 事例 | producer（誰が書くか） | 保存先 | consumer（どこで壊れるか） | 攻撃者の入口 | 索引に入口があるか | 課題の向き |
|---|---|---|---|---|---|---|
| TranslatePress 3.3.1 ATO（CVE-2026-19632） | core の password reset が生成した URL を、plugin の自動文字列保存が翻訳辞書に書く | 独自 table（辞書） | 未認証 AJAX が辞書を返す | `wp_ajax_nopriv_trp_get_translations_regular`（リテラル） | **ある**（ajax-nopriv） | 順方向で届く。前提は管理者の locale（Lab scenario） |
| TranslatePress 3.2.6 stored XSS（CVE-2026-18512） | core の comment（Subscriber が投稿、承認） | core の comments table | 翻訳 editor の文字列 dropdown（管理者）が comment 本文をそのまま描画 | core の comment form。plugin 側は editor の AJAX | producer は無い。consumer は ajax として **ある** | 逆方向（sink → core data の reader） |
| Relevanssi 4.28.3 stored XSS（CVE-2026-97641） | core の comment（未認証） | core の comments table | 検索結果の excerpt 生成が comment を取り込み、許可 tag の前方一致で tag を通す | core の検索（`s`）。plugin は `posts_pre_query` filter | `posts_pre_query` は REQUEST_HOOKS にも CORE_HOOKS にも**無い** | 逆方向。前提は「Allowable tags」の既定例の値 |
| Brizy 2.8.11 stored XSS（CVE-2026-5324） | 未認証の form 送信 | form entries（plugin 保存） | 管理画面の entries 表示が entity decode して href に出す | `add_action($pref_nopriv . self::AJAX_SUBMIT_FORM, …)` | **無い**（連結。索引は ajax 9 件、実際は連結 16 件以上） | 順方向だが入口が見えない |
| SSA 1.6.10.0 SQLi（CVE-2026-3658） | 未認証の REST 要求 | — | `fields` parameter を SQL に連結 | `register_rest_route($namespace, '/' . $base, …)` | 52 件が **名前 `/` で登録**（file:line は残る） | 順方向。名前が潰れて分担に使いにくい |
| Unlimited Elements 2.0.16 SQLi（CVE-2026-18561） | 未認証の AJAX 要求 | — | `getWhereString()` が配列の要素 0 を演算子として連結 | `wp_ajax_nopriv_<plugin>_<action>` を変数で登録し、`onAjaxAction()` が内部 action に dispatch | **無い**（索引は ajax 5 件。内部 action は call_user_func 30 箇所の先） | 順方向だが dispatcher の内側が見えない |
| Smash Balloon CFF 4.13.0 stored XSS（CVE-2026-93756） | Facebook の comment（外部 API、`wp_remote_get`） | transient / option | 管理画面の builder preview が JS の `v-html` で描画 | WordPress の入口は無い | producer も sink（JS）も**無い** | 逆方向。sink は PHP でなく JS |

## 2. 索引の実測（7 件の source、`buildWordPressSourceIndex`）

| source | php | 索引の入口 | add_action 全体 / リテラル / 変数・連結 | wp_ajax リテラル / 連結 | REST 全体 / 変数 | request param で dispatch | call_user_func | incomplete |
|---|---|---|---|---|---|---|---|---|
| TranslatePress 3.2.6 | 180 | 96 | 261 / 253 / 4 | 31 / 0 | 0 | 103 | 4 | false |
| TranslatePress 3.3.1 | 182 | 102 | 269 / 260 / 4 | 32 / 3 | 0 | 105 | 4 | false |
| Relevanssi 4.28.3 | 107 | 25 | 71 / 69 / 0 | 9 / 0 | 0 | 13 | 4 | false |
| Brizy 2.8.11 | 997 | 55 | 282 / 190 / **90** | 3 / **16** | 0 | 18 | 8 | false |
| SSA 1.6.10.0 | 518 | 120 | 255 / 239 / 1 | 1 / 2 | 52 / **36** | 18 | 21 | false |
| Unlimited Elements 2.0.16 | 793 | 27 | 156 / 131 / 11 | 4 / 3 | 0 | 11 | **30** | false |
| CFF 4.13.0 | 354 | 77 | 163 / 160 / 1 | 59 / 0 | 0 | 35 | 13 | false |

読み方: 索引が得意なのは TranslatePress、Relevanssi、CFF のような「リテラルで登録する」plugin。Brizy、Unlimited Elements、SSA のように prefix 連結、自前 dispatcher、route 連結を使う plugin では入口の大半を落とす。`incomplete` は全件 false で、取りこぼしを知らせない。

## 3. 要る修正

### 3.1 索引（Phase 1a に先行、Codex 1 PR）

1. 同じ file か class 内で解ける連結を解く: `'wp_ajax_' . CONST`、`$pref . self::CONST`、`"{$prefix}_name"`。class 定数と直前の代入まで。解けないものは捨てずに `kind: "dynamic-hook"`、`name: "<unresolved> file:line"` として残す。
2. REST route の第 2 引数が連結のときは、namespace と file:line を保ち `name: "<ns> <dynamic>"` とする。`/` に潰さない。
3. 単一 dispatcher の検出: `$_REQUEST['action']`（か `action` / `task` / `cmd`）で分岐し `call_user_func` か `switch` に渡す callback を見つけたら、分岐先の文字列を内部 action として sub-entry にする（`kind: "dispatched-action"`）。
4. `incomplete` の意味を広げる: 変数・連結の登録数と dispatcher の数を `unresolved` として索引に持ち、0 でなければ割り当て節に「未解決の登録が N 件ある」と出す（既存の節の雛形に数字を埋めるだけ。新しい文は足さない）。
5. `posts_pre_query`、`pre_get_posts`、`the_content`、`the_excerpt`、`comment_text`、`wp_insert_comment`、`preprocess_comment` を CORE_HOOKS の crossing に足す（REQUEST_HOOKS ではなく、core data を読む側の印）。

### 3.2 sink から逆向きの課題の家族（Phase 1a の task-plan に 2 つ目の生成器）

入口索引からの順方向課題に加えて、**sink 索引**から課題を作る。

- sink の種類: (a) 管理画面の描画点（`add_menu_page` / `add_submenu_page` の callback、管理側 AJAX の応答、admin の template）、(b) `$wpdb` の連結（`prepare` を通らない `query` / `get_results` / `get_var` の引数に変数がある箇所）、(c) core data の reader（`get_comments`、`comment_content`、`get_user_meta`、`get_post_meta` の読み、`wp_remote_*` の応答を保存する箇所）、(d) JS の `v-html` / `innerHTML` / `.html(` と、それに data を渡す PHP の endpoint。
- 課題 = sink の群（同じ file か同じ管理画面）。agent への問いは「この sink に届く data は誰が書くか、その writer は攻撃者の立ち位置から届くか」。prompt 本文は変えず、割り当て節の見出しが「Assigned entry points」から「Assigned sinks」に変わるだけ（雛形は 1 つ追加になるので所有者が読む対象）。
- 所有者の 7 件のうち 4 件（TP 3.2.6、Relevanssi、CFF、Brizy の consumer 側）はこの家族から届く。

### 3.3 前提分類の注意（#316）

Relevanssi の「Allowable tags」は管理者の設定だが、既定の例の値で成立し、Wordfence は受理した。`admin-configuration` に分類して park すると、所有者が実際に報酬を得た型を落とす。設定画面の既定値・placeholder の例で成立するものは `default` か `common-usage` に寄せる規則を precondition-class.ts に足す。

## 4. 根拠の整理

| 主張 | 根拠 | 強さ |
|---|---|---|
| 入口から順に辿る課題は半分の chain で止まる | 本番 Lead 403 件の missingEdge: producer 224、consumer 69 | 自前、実測 |
| Root は早く閉じる | 本番 Root wall 中央値 7 分、60 分到達 0 | 自前、実測 |
| 狭い課題の並列と反証段 | Cloudflare Glasswing、XBOW、OpenAnt（12,177 → 393 → 20）、night-wolf（524 → 16） | 外部。vendor blog 中心、対照実験なし |
| 所有者の型は「他者の data を信じて読む」 | 7 件中 4 件が core comment / 外部 API / core email を producer にする | 自前、公開 advisory から |
| dispatch が協調 Trial より良い | 無い | 開発セットの gate で測る |

## 5. 次の一手

- Issue を 1 本立て、3.1 と 3.2 を Codex の Phase 1a の前に置く（brief 1a を「索引の修正 → 課題生成」の 2 PR に割る）。
- 開発セットの gate に「所有者の 7 件の入口か sink が索引か sink 索引に載ること」を足す。これは答えを渡すことではなく、索引の網羅の確認。
- 今日の v6 実験はそのまま続ける。協調 Trial の Root は索引に無い入口も source を読めば見つけられるので、索引の穴の影響は dispatch より小さい。
