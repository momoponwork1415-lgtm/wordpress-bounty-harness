# 自動 campaign 評価: 2026-10-12 第 2 周

- Issue: #100
- Campaign ID: `production-2026-10-12-v3-02`
- 既定 state・台帳、`promptId: wp2shell-bounty-v3`、5 対象、対象ごとに協調 Trial 1 回、wall 上限 60 分
- 集計元: `ledger funnel --campaign` と同じ campaign ID の追記専用 event。候補本文、payload、HTTP 記録、Private Evidence はこの文書に含めない。

## 実行

`history status` は fresh（公開履歴 41,919 件）、`runtime check` は成功。`select` が 5 対象を選定し、5 件の Snapshot を固定した。`campaign run --all` は探索の schema 失敗で一度 `incomplete` 停止（exit 3）。同じ campaign ID で再開し、未消費の対象がない状態で exit 0 となった。開始から最後の台帳 event までは 2026-10-12 11:49:44〜12:49:56 UTC。

Lab は 3 対象で ready、2 対象で供給失敗。再開時の再供給を含む event は ready 6 回、failed 4 回。探索は 3 Trial のうち 2 Trial が正常終了し、1 Trial が schema 失敗した。Lab 失敗と schema 失敗を正常な候補 0 件には数えない。

## Ledger funnel

| 最終 JSON 到達 | 受理 | 保留 | raw Finding | verifier 通過 | runtime-confirmed | contradicted | incomplete | reviewed | in-scope | submitted | outcome |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0 | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |

受理 10 件は Finding 4 件と Lead 6 件の合計。`verifier 通過` は検証結果 event がある件数で、確証を意味しない。検証の最新結果と全試行はともに 4 件で、いずれも `incomplete`。

## 未完了の理由

| 段 | 理由コード・種類 | 件数 |
| --- | --- | ---: |
| Lab 供給（対象別） | 固定 WordPress core より高い最低版要求 | 1 |
| Lab 供給（対象別） | WP-CLI と共有 volume の所有者 UID 不一致 | 1 |
| 探索 run | `schema / unadmitted-event-type:error` | 1 |
| 検証（全試行、最新結果とも同数） | `no-judge` | 4 |

Lab 供給の台帳 reason はいずれも `provision`（再開を含め 4 event）。探索 run は 12 件中 11 件が `completed`、1 件が `failed`。provider limit として型付けされた停止は 0 件。検証の `precondition` は 0 件で、不足した Lab scenario 前提の種類別件数は **該当なし 0 件**。この周回では scenario を追加しない。

## 使用量と測定限界

- 非 cache 入力: 2,207,091 token。対象別の最大値は 1,231,306 token で、1,000 万 token の停止は 0 件。Lab 供給失敗の 2 対象には探索使用量がない。
- agent run wall の合計: 11,455.4 秒。並列の Root と子を足した値で、campaign の経過時間ではない。
- source 読取の観測下限: 正常終了 11 run で 1,479 回、失敗 1 run で 50 回。読取 0 回の run はない。agent 内部の全読取を数えた値ではない。
- USD 実費: 12 run すべて `unavailable`。token と wall を代替の使用量とする。

runtime-confirmed は 0 件。未検証の候補本文や検証の操作記録は外へ出していない。
