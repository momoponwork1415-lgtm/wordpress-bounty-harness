# 索引の基準値（正規表現のみ、agent 補完なし、2026-10-18）

Issue #328 の分母。7 件の固定 source（開発セットと所有者の有償事例の版）に対して、現行の `buildWordPressSourceIndex`（main 46c1168 時点）と、sink 候補の素朴な走査が何件拾うかを記録する。agent による索引補完（brief 1a-1）が入ったあと、同じ 7 件で再計測して差を見る。

計測の条件: 固定 source は `~/.local/state/wordpress-bounty-harness-evaluation/sources/` の zip。索引は `dist/profiles/wordpress/discovery/storage-index.js` をそのまま呼んだ。sink 候補の列は `grep` の件数で、重複と誤検知を含む（基準値の目的は「どれだけ見えているか」の桁を記録すること）。

## 入口索引

| source | php | 索引の入口 | 内訳 | add_action 全体 / リテラル / 変数・連結 | wp_ajax リテラル / 連結 | REST 全体 / 第 2 引数が連結 | request param で dispatch | call_user_func | incomplete |
|---|---|---|---|---|---|---|---|---|---|
| translatepress-multilingual 3.2.6 | 180 | 96 | ajax 31, ajax-nopriv 1, shortcode 5, request-hook 59 | 261 / 253 / 4 | 31 / 0 | 0 / 0 | 103 | 4 | false |
| translatepress-multilingual 3.3.1 | 182 | 102 | ajax 33, ajax-nopriv 2, shortcode 5, request-hook 62 | 269 / 260 / 4 | 32 / 3 | 0 / 0 | 105 | 4 | false |
| relevanssi 4.28.3 | 107 | 25 | ajax 8, ajax-nopriv 1, shortcode 9, request-hook 7 | 71 / 69 / 0 | 9 / 0 | 0 / 0 | 13 | 4 | false |
| brizy 2.8.11 | 997 | 55 | ajax 9, admin-post 3, request-hook 43 | 282 / 190 / 90 | 3 / 16 | 0 / 0 | 18 | 8 | false |
| simply-schedule-appointments 1.6.10.0 | 518 | 120 | rest-route 52, ajax 7, ajax-nopriv 1, shortcode 8, request-hook 52 | 255 / 239 / 1 | 1 / 2 | 52 / 36（名前が `/` に潰れる） | 18 | 21 | false |
| unlimited-elements-for-elementor 2.0.16 | 793 | 27 | ajax 5, admin-post 1, request-hook 21 | 156 / 131 / 11 | 4 / 3 | 0 / 0 | 11 | 30 | false |
| custom-facebook-feed 4.13.0 | 354 | 77 | ajax 59, ajax-nopriv 2, shortcode 1, request-hook 15 | 163 / 160 / 1 | 59 / 0 | 0 / 0 | 35 | 13 | false |

読み: リテラルで登録する plugin（translatepress、relevanssi、custom-facebook-feed）は入口の大半が載る。prefix 連結（brizy）、route 連結（simply-schedule-appointments）、自前 dispatcher（unlimited-elements）では登録の多くが落ちる。`incomplete` は 7 件とも false で、取りこぼしを知らせない。

## sink 候補（grep、重複・誤検知を含む）

| source | 管理画面の描画点 | `$wpdb` 読み書き全体 / `prepare` を通らず変数を含む | core data の読み | `wp_remote_*` | JS/PHP の `v-html` / `innerHTML=` / `.html(` |
|---|---|---|---|---|---|
| translatepress-multilingual 3.2.6 | 17 | 40 / 28 | 33 | 107 | 88 |
| translatepress-multilingual 3.3.1 | 17 | 44 / 32 | 33 | 108 | 92 |
| relevanssi 4.28.3 | 4 | 78 / 76 | 24 | 3 | 15 |
| brizy 2.8.11 | 7 | 79 / 61 | 57 | 4 | 384 |
| simply-schedule-appointments 1.6.10.0 | 6 | 90 / 72 | 16 | 21 | 68 |
| unlimited-elements-for-elementor 2.0.16 | 8 | 32 / 31 | 36 | 7 | 330 |
| custom-facebook-feed 4.13.0 | 14 | 122 / 98 | 11 | 6 | 416 |

読み: sink 候補は入口より桁が多い。sink 索引（#328 B）は grep の全件を課題にするのではなく、管理画面の描画点と `prepare` を通らない `$wpdb` を軸にまとめ、JS の描画点は PHP の endpoint と結び付いたものだけを課題にする必要がある。

## 再計測のしかた

1. 同じ 7 件に対して `buildWordPressSourceIndex` を呼び、`unresolved`（brief 1a-0 の追加）の件数を列に足す。
2. agent 補完（brief 1a-1）を 1 回回し、`origin: agent` の入口と sink の件数、費用（agent 数、token、wall）を列に足す。
3. 所有者の 7 件について、攻撃者の入口か sink が索引に載るかを ○ / × で記録する（答えは agent に渡さない。索引の網羅の確認）。目標 7 / 7、最低 6 / 7。

## 補足

- 2026-10-18 の開発セット測定（v6 / v5 の arm B / C）は provider の cyber policy 拒否で 9 / 9 run が 20 秒以内に終わり、数字が取れていない。本番と同一構成の旧 build でも拒否されたので、原因は build や prompt ではなく provider か account 側。provider が戻ってから同じ driver でやり直す。
