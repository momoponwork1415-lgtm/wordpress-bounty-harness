# #241: merged P5 selection safety audit (2026-10-15; corrected 2026-10-16)

正本は SPEC、ADR、DEVELOPMENT。この記録は PR #262 のレビュー指摘を反映した照合結果で、旧 DB・queue・Private Evidence の実データは読んでいない。

| 修正 | 根拠 | 確認方法 |
| --- | --- | --- |
| source 0・子 0・broker 転送 1 以下で終わった run と、終了記録のない開始直後の attempt は Trial に数えず次の選定へ戻す。途中まで走った Trial は既往とする | SPEC §6、ADR 0029、#270 blocker 1 | 非 Trial と途中停止の選定テスト。同じ campaign・ordinal の再開テスト |
| `reconsider` は所有者が `legacy-*` と `previously-selected` を解除する口とする | 最終設計 D2 / P5a | started / ambiguous / 現行台帳の既往を解除するテスト。ambiguous 外の slug も schema と exporter が受理 |
| 候補源による campaign 実行は `revisitPolicy: never` のみ | ADR 0032 Q6。追加 Trial の承認形式は未実装 | 版・prompt 変更による再訪方針で campaign が始まらない CLI テスト |
| 選定時の旧履歴 digest を campaign 起動時にも照合 | #241 の実行前整合 | 選定後に旧 JSON を変えると台帳に campaign event を書かず停止する CLI テスト |

## 未達・運用上の保留

- 旧 queue と archive の取り込み、旧 DB の全所在と writer 停止、旧 `--state` の網羅、実データの照合は未完了。旧 queue を入力に含めるかは未確定。
- 選定変更の DEVELOPMENT §5 gate は異なる slug の初回 completed 3 Trial。実機の数字が揃うまでこの PR は Draft とする。
- PR #262 より前の選定 report に `legacyHistory` が無い batch は digest が `null` と解釈され、旧履歴 JSON を要求する自動 campaign で `legacy-history-changed` となる。再選定が必要。
