# #241: merged P5 selection safety audit (2026-10-15)

正本は SPEC、ADR、DEVELOPMENT。この記録は `origin/main` の P5a/P5b 実装を照合した結果で、旧 DB・queue・Private Evidence の実データは読んでいない。

| 修正 | 根拠 | 確認方法 |
| --- | --- | --- |
| 終了・子・候補の記録がない run、または source 0・子 0・broker 転送 1 以下の run は非 Trial | SPEC §6、最終設計 D2 / P5a。途中まで走った Trial は数える | 選定除外と同じ campaign / ordinal の再開テスト（#270） |
| `reconsider` は `legacy-*` と `previously-selected` を解除 | 最終設計 D2 / P5a の所有者操作 | schema の重複検査を維持し、started・ambiguous・現行 Trial の解除をテスト |
| 候補源による campaign 実行は `revisitPolicy: never` のみ | ADR 0032 Q6。追加 Trial の承認形式は未実装 | 版・prompt 変更による再訪方針で campaign が始まらない CLI テスト |
| 選定時の旧履歴 digest を campaign 起動時にも照合 | SPEC §5 の固定 Snapshot と同じく、既往の判断材料を実行中にすり替えない | 選定後に旧 JSON を変えると台帳に campaign event を書かず停止する CLI テスト |

## 未達・運用上の保留

- 選定時の台帳走査は既存の `runKind: explore` だけを Trial 対象にし、対応する target-selected が無い探索開始は読み飛ばす。Finding に対応する選定が無い場合の既存の停止は維持する。
- 本 PR 前に束縛した batch の `legacyHistoryDigest: null` は、現在の legacy JSON digest と一致せず `legacy-history-changed` で停止する。互換扱いで通さず、選定をやり直す。
- 旧 queue と archive の取り込み、旧 DB の全所在と writer 停止、旧 `--state` の網羅、実データの照合は未完了。`scripts/export-legacy-slugs.mjs` は実データに対して実行していない。旧 queue を入力に含めるかは所有者回答待ち。
- 選定変更の DEVELOPMENT §5 gate は異なる slug の初回 completed 3 Trial。現時点は 0/3 で、この変更は Draft のまま扱う。
