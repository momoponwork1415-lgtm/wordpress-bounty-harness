# 自動 campaign 評価: 2026-10-12 第 3 周

- Issue: #100
- Campaign ID: `production-2026-10-12-v3-03`
- 既定 state・台帳、`promptId: wp2shell-bounty-v3`、5 対象、対象ごとに協調 Trial 1 回、wall 上限 60 分
- 集計元: `ledger funnel --campaign` と同じ campaign ID の追記専用 event。候補本文、payload、HTTP 記録、Private Evidence はこの文書に含めない。

## 実行

`history status` は fresh（公開履歴 41,919 件）、`runtime check` は成功。`select` が 5 対象を選定し、5 件の Snapshot を固定した。5 対象すべての探索と既存の検証が終了した。開始から最後の台帳 event までは 2026-10-12 12:54:36〜14:17:04 UTC。

Lab は探索用 5 件、検証用 3 件の供給 event がすべて ready。供給失敗は 0 件。5 協調 Trial が正常終了し、Root と子の 20 run はすべて `completed`。provider / schema 失敗を正常な候補 0 件に混ぜていない。

## Ledger funnel

| 最終 JSON 到達 | 受理 | 保留 | raw Finding | verifier 通過 | runtime-confirmed | contradicted | incomplete | reviewed | in-scope | submitted | outcome |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 20 | 0 | 8 | 8 | 0 | 0 | 8 | 0 | 0 | 0 | 0 |

受理 20 件は Finding 8 件と Lead 12 件の合計。`verifier 通過` は検証結果 event がある件数で、確証を意味しない。検証の最新結果と全試行はともに 8 件で、いずれも `incomplete`。

## 未完了の理由

| 段 | 理由コード・種類 | 件数 |
| --- | --- | ---: |
| Lab 供給 | failed | 0 |
| 探索 run | failed | 0 |
| 検証（全試行、最新結果とも同数） | `no-judge` | 5 |
| 検証（全試行、最新結果とも同数） | `observation` | 2 |
| 検証（全試行、最新結果とも同数） | `precondition` | 1 |

不足した Lab 前提の種類別件数は「管理者による対象固有の設定状態」1 件。plugin 非依存の通常機能 scenario としては追加できず、`incomplete(precondition)` のまま数える。設定名や手順はこの文書に載せない。

## 使用量と測定限界

- 非 cache 入力: 2,533,648 token。対象別の最大値は 973,290 token で、1,000 万 token の停止は 0 件。
- agent run wall の合計: 14,260.5 秒。並列の Root と子を足した値で、campaign の経過時間ではない。
- source 読取の観測下限: 20 run で 1,520 回。読取 0 回の run はない。agent 内部の全読取を数えた値ではない。
- USD 実費: 20 run すべて `unavailable`。token と wall を代替の使用量とする。

runtime-confirmed は 0 件。未検証の候補本文や検証の操作記録は外へ出していない。
