---
status: accepted
---

# contributor 以上を信頼側に置き、公開事例の再発見を配線の証明とする

## 決定

探索の攻撃者位置は未認証、subscriber、customer 相当までとする。contributor 以上と、管理者が意図して付与する権限は trust 境界の信頼側に置く。これは2026-10-08と10-11の所有者の判断であり、programme ごとの scope 判定と技術的検証は引き続き別段階にする。

所有者が発見済みの公開7件を再発見ベンチマークに使う。見る指標は (1) 一段目で source に根拠のある候補が出るか、(2) 新 Lab の Harness 判定器が `runtime-confirmed` を出し、同じ経路が修正版の別 Snapshot で成立しないか、の2つ。0件は source を読まずに終わった場合と、読んでも候補が出なかった場合を分ける。TranslatePress 以外で Stored XSS 1件以上と SQLi 1件以上を通すことを受入目標にする。既知事例の再発見は配線と分類ごとの能力を示すだけで、未知脆弱性の発見率を推定しない。

探索へ渡す履歴は [ADR 0012](0012-time-cut-known-vulnerability-history.md) の公開時点より前のカタログ情報に限る。評価記録の description、PoC、payload、原因箇所、修正差分を渡さない。prompt と scenario は対象固有の関数名、option名、URL、画面名を含めず、公開事例の答えへ合わせた調整をしない。ベンチマーク結果は台帳と日付付きの評価文書に残す。

## 理由

contributor 以上を探索対象に含めると、既に固定した低権限の trust 境界と収益対象がずれる。公開事例は探索と判定器のどこで欠けるかを測るには使えるが、モデルが既知経路を記憶している可能性があり、未知の発見率の標本にはならない。

根拠: [完成度レビュー](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-harness-completeness-review.md) 第6節、[prompt 下書き](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-two-stage-prompts-draft.md)。

## 採らなかった選択肢

- contributor からの欠陥を探索の主目標に加える: 現行の権限境界と、所有者が指定した対象範囲を変える。
- 再発見件数を未知脆弱性の発見率として使う: 公開情報による汚染と評価対象選択の偏りを除けない。

## 既存決定との関係と帰結

- [ADR 0010](0010-programme-scope-does-not-gate-verification.md) の programme scope と検証の分離を維持する。対象範囲を広げる場合は所有者の明示承認を要する。
- [ADR 0016](0016-root-plus-three-first-vertical-slice.md) の初期ゲートの既知経路確認を拡張する評価であり、過去の通過結果を書き換えない。
