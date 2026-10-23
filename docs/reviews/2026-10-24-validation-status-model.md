# 検証ステータスの再設計案（2026-10-24）

## 問いと結論

軽量観測を残し、人間が最終的に再現する方針で、Finding の進捗をどう表すか。
**検証結果に新しい単一ステータスを足さず、独立した事実と提出準備を分ける。**
台帳の既存イベントは追記専用のまま読み、最新版の Finding と検証に対する表示を導出する。
提出準備の到達点は SPEC 第 1・3・8 節と ADR 0038 追記 10 に従う。

## 現状で混ざって見えるもの

| 現在の値・表示 | 実際に示すこと | 示さないこと |
| --- | --- | --- |
| `runtime-confirmed` | Harness 判定器が nonce 付き canary を回収した | 人間の再現、Wordfence の採用 |
| `reproduced` | 新しい Lab で Harness の標準スクリプトが捕捉 HTTP 応答中の canary を観測した | 人間の再現 |
| `incomplete(observation)` | 判定器の証明が成立しなかった | 発火が一切なかったこと。数字 dialog の観測が別の証拠に残る場合がある |
| `contradicted` | 現行実装では固定版で同じ経路が成立しないことを捕捉した負の対照 | 元の脆弱版 Finding の一般的な棄却 |
| `human-reproduction-recorded` | 人間の `match` / `mismatch` / `unavailable` の履歴 | 最新の検証に対する結果とは限らない |
| `review-decided` の `accept` | その時点のレビュー判断。AI の予備判断にも人間の最終査読にも使う | その値だけで提出できること |

技術判定の定義は `src/verification/reproduction-package.ts`、固定版の負の対照は
`src/verification/index.ts`、数字 dialog と `incomplete` の併存は
`src/profiles/wordpress/verification/judges.ts` にある。
`review export` は Finding の最新の手動結果を表示するが、現在の verification ID で絞らない
（`src/review/export.ts`）。古い `match` が新しい `incomplete` と並び得る。
`ledger funnel` の reviewed / in-scope も履歴件数であり、現在の提出可否を表さない。

## 提案する表示モデル

| 軸 | 値と意味 | 所有する記録 |
| --- | --- | --- |
| 対象の位置 | 未検証、検証列、park。park は現行の 10 impact を維持 | Finding と park のイベント |
| 技術判定 | 最新 attempt の既存 4 値と理由。`reproduced` の表示名は「Harness スクリプト観測」 | `verification-finished` |
| 軽量観測 | なし、dialog のみ、同じ attempt の捕捉攻撃要求と marker・順序・別主体が整合した dialog。整合は因果関係の証明ではない | Harness の Private Evidence |
| 人間の確認 | 未実施、`match`、`mismatch`、`unavailable`。最新の Finding・Snapshot・検証・Lab setup・封印した再現資料に一致する結果だけを「現在」とする | 手動 Lab の receipt と Private Evidence を指す台帳イベント |
| 提出準備 | 上の事実、重複、Wordfence scope、文案・JSON、最終査読から次の作業と不足理由を**導出**する | 専用の保存ステータスを増やさない |

レビュー判断、重複照合、scope、文案、承認は別々の記録のままにする。
`incomplete` は「脆弱性がない」ではなく「その attempt の自動判定が未成立」。
人間の有効な `mismatch` は提出を止めるが `contradicted` へ変換しない。
環境や手順が足りない `unavailable` は再試行の理由と次の手を残す。

| 例 | 技術判定 | 軽量観測 | 人間 | 次の作業 |
| --- | --- | --- | --- | --- |
| 数字 dialog と要求が整合 | `incomplete(observation)` | 整合あり | 未実施 | 新しい Lab で手動確認 |
| canary 回収 | `runtime-confirmed` | 証拠に応じる | 未実施 | 手動確認 |
| 人間が同じ最新版で再現 | 技術判定は不変 | 証拠に応じる | `match` | 重複・scope・報告書を確認 |
| 有効な手順で再現しない | 技術判定は不変 | 証拠に応じる | `mismatch` | 提出停止、原因を調査 |
| Lab が使えず試せない | `incomplete` のまま | 証拠に応じる | `unavailable` | 環境を直して再試行 |
| 修正版で経路が消える | `contradicted`（固定版 basis） | 負の対照 | 該当なし | 元の Finding と版を分けて読む |

## 変更する順序と受入条件

1. `review export` と一覧に、最新 attempt に結び付く各軸と次の作業を表示する。
   旧い手動 `match` は履歴として残し、現在の `match` と表示しない。
   保存済みの `VerificationResult` や funnel の意味を変更しない。
2. 軽量観測の手動 Lab に session receipt を付け、人間の結果を同じ Snapshot・
   Lab setup・検証・資料・人間の証拠 digest に結び付けて追記する。
   `match` の自己申告だけで `runtime-confirmed` を出さない。
3. scope 評価には「人間が同じ最新版で確認した観測」という独立した basis を渡す。
   canary 判定器の条件を捏造しない。重複と通常利用構成も別途確かめる。
4. 既存の提出 gate は、最新の手動 `match`、その後の人間確認済み文案、
   `no-match` を含む最終査読、正確な承認を要求し、提出記録時に再評価する。
   軽量観測経路を追加しても、後発の `mismatch` / `unavailable`、新しい検証、
   新しい最新版 Finding で旧承認が失効する性質を維持する。
5. 文案と Fill-Only JSON が必要な欄まで根拠付きで揃ったときだけ
   「最終査読待ち」と数える。内部プレビューと未完成 JSON は含めない。

受入試験は、dialog のみでは scope・文案・承認に進まないこと、
同じ最新版の手動 `match` で初めて進めること、旧 Snapshot の結果が移らないこと、
後発の `mismatch` / `unavailable` が承認を止めること、
旧イベントを読めること、canary なしで `runtime-confirmed` を出さないことを確認する。

この文書は設計案であり、提出経路の変更を実装済みと主張しない。
