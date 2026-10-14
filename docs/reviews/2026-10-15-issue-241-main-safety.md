# #241: merged P5 selection safety audit (2026-10-15)

正本は SPEC、ADR、DEVELOPMENT。この記録は `origin/main` の P5a/P5b 実装を照合した結果で、旧 DB・queue・Private Evidence の実データは読んでいない。

| 修正 | 根拠 | 確認方法 |
| --- | --- | --- |
| `discovery-run-started` があれば既往として保留 | SPEC §6、ADR 0029 の非 Trial 条件。`observed` の 0 は観測下限であり、source 未読の証明にならない | source 0・子 0・broker 1 の拒否も除外するテスト |
| `reconsider` は `ambiguous` のうち旧記録照合で初回と確認した slug だけ | 所有者の判別不能保留判断、ADR 0032 Q6 の同一 slug 追加 Trial 逐次承認 | JSON schema が `started` 重複を拒否。台帳の開始済み run は解除せず、exporter も不正な指定を拒否 |
| 候補源による campaign 実行は `revisitPolicy: never` のみ | ADR 0032 Q6。追加 Trial の承認形式は未実装 | 版・prompt 変更による再訪方針で campaign が始まらない CLI テスト |
| 選定時の旧履歴 digest を campaign 起動時にも照合 | SPEC §5 の固定 Snapshot と同じく、既往の判断材料を実行中にすり替えない | 選定後に旧 JSON を変えると台帳に campaign event を書かず停止する CLI テスト |

## 未達・運用上の保留

- #241 受入条件 4 の「source 0・子 0・broker 転送 1 以下の run を非 Trial と確定して再選定」は未実装。完全な観測の仕様と計測が決まるまで開始済み対象を保留する。
- 旧 queue と archive の取り込み、旧 DB の全所在と writer 停止、旧 `--state` の網羅、実データの照合は未完了。`scripts/export-legacy-slugs.mjs` は実データに対して実行していない。旧 queue を入力に含めるかは所有者回答待ち。
- 選定変更の DEVELOPMENT §5 gate は異なる slug の初回 completed 3 Trial。現時点は 0/3 で、この変更は Draft のまま扱う。
