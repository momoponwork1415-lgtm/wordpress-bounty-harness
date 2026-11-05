# 自動 campaign 評価: 2026-10-12 第 1 周

- Issue: #100
- Campaign ID: `production-2026-10-12-v3-01`
- 既定 state・台帳、`promptId: wp2shell-bounty-v3`、5 対象、対象ごとに協調 Trial 1 回、wall 上限 60 分
- 集計元: `ledger funnel --campaign` と同じ campaign ID の追記専用 event。候補本文、payload、HTTP 記録、Private Evidence はこの文書に含めない。

## 実行

`history status` は fresh（公開履歴 41,919 件）、`runtime check` は成功。`select` が 5 対象を選定し、5 件の Snapshot を固定した。`campaign run --all` は 4 対象目の探索失敗で一度 `incomplete` 停止（exit 3）。同じ campaign ID で再開し、残りの対象まで処理して exit 0 となった。開始から最後の台帳 event までは 2026-10-12 10:24:29〜11:44:43 UTC。

Lab 供給は ready 9 回、failed 0 回。9 回には再開時に完了済み対象へ供給し直した Lab 4 回を含む。探索は 5 Trial のうち 4 Trial が正常に終了し、1 Trial が失敗した。失敗 Trial を正常な候補 0 件には数えない。

## Ledger funnel

| 最終 JSON 到達 | 受理 | 保留 | raw Finding | verifier 通過 | runtime-confirmed | contradicted | incomplete | reviewed | in-scope | submitted | outcome |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 12 | 0 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |

受理 12 件は Finding 2 件と Lead 10 件の合計。`verifier 通過` は検証結果 event がある件数で、確証を意味しない。検証の最新結果と全試行はともに 2 件で、いずれも `incomplete`。

## 未完了の理由

| 段 | 理由コード | 件数 |
| --- | --- | ---: |
| Lab 供給 | failed | 0 |
| 探索 run | `schema / child-final-message-not-report` | 3 |
| 探索 run | `provider / cli-exit:1` | 1 |
| 検証（全試行、最新結果とも同数） | `no-judge` | 2 |

探索 run は 20 件中 16 件が `completed`、4 件が `failed`。provider limit として型付けされた停止は 0 件。検証の `precondition` は 0 件で、不足した Lab 前提の種類別件数は **該当なし 0 件**。この周回では scenario を追加しない。

## 使用量と測定限界

- 非 cache 入力: 3,137,543 token。対象別の最大値は 1,067,620 token で、1,000 万 token の停止は 0 件。
- agent run wall の合計: 12,930.8 秒。並列の Root と子を足した値で、campaign の経過時間ではない。
- source 読取の観測下限: 正常終了 16 run で 1,632 回、失敗 4 run で 19 回。いずれも読取 0 回の run はなかった。agent 内部の全読取を数えた値ではない。
- USD 実費: 20 run すべて `unavailable`。token と wall を代替の使用量とする。
- この周回の設定は Programme Boundary の版表示を `wordfence-2026-10-09` としていたが、人間が記録した正本は 2026-10-08 版。日付以外の範囲本文は同一で、次周回用の設定を正本の版表示へ訂正した。この周回の版の来歴は正確でないため、提出判断には用いない。

runtime-confirmed は 0 件。未検証の候補本文や検証の操作記録は外へ出していない。
