---
status: accepted
---
# 対象固有のコードはTarget Profileに閉じ込め、汎用モジュールはprofileを型でしか知らない

将来、別言語・別プラットフォームのバグバウンティへ使い回すため、WordPress固有の部分（WordPress.orgからの取得、WordPress + MySQLのLab供給、PHP向けの判定器、Wordfence / Patchstackの対象範囲方針、trust境界宣言の雛形、file分担の規則）を `profiles/wordpress/` に閉じ込める。selection / snapshot / lab / discovery / verification / ledger / review / evaluation の汎用モジュールは、profileが実装するインターフェース（source取得、Lab provisioner、判定器集合、scope方針、prompt雛形）だけに依存し、WordPressの型やpathをimportしない。Anthropic defending-code-reference-harnessの「汎用loop + `/customize` で言語・検出器・脆弱性種別を差し替える」構成に合わせる。

## Consequences

- 2つ目のprofileが存在するまで、profileインターフェースを汎用化しない（先回りした抽象化を作らない）。WordPress版の完成後に、2つ目の対象で初めて共通部分を抽出する。
- WordPress固有の語（plugin、slug、hook、AJAX action、wp_options）が汎用モジュールに現れたら、それはprofileへ移す合図。
- 評価の答えの鍵と判定器の成功条件もprofile側に置く。
