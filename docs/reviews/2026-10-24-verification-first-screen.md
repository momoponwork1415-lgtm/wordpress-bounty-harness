# 検証前の選別を明示除外に絞る（2026-10-24）

## 問い

Wordfence の受理が未確定というだけで Finding を止めず、明白な除外以外を Lab 検証へ渡せるか。

## 観測

- 本番台帳の検証試行 49 件のうち、判定器の `runtime-confirmed` は 12 件、理由付き `incomplete` は 37 件だった。Finding ごとの最新結果では 27 件中 10 件が `runtime-confirmed`、17 件が `incomplete`。未完の内訳は前提 10、観測 4、手順 2、証拠 1。判定器の条件を緩める前に、Lab 前提と観測を通す余地が大きい。
- 旧 screen の `reject` により通常の検証列から外れていた現行対象 13 件を再点検した。Wordfence の明示除外と確証できたものは 0 件。8 件は現行の Programme Boundary の下で旧判断を `defer` として追記し、検証列への復帰を各 `review export` で確認した。残る 5 件は、既定で無効な Developer Mode に対する現行の管理者設定 park 規則と衝突し、規則の整理が必要である。個別根拠と ID は Git 外の Private Evidence に置いた。
- 別に、本番の 261 件の Finding のうち 3 件が管理者設定前提として探索出口で park され、screen や検証列に届いていなかった。条件文は通常の表示チェックボックス、互換機能、否定形や製品名への文字列一致を含み、明白な危険設定とは確認できなかった。この入口は今回の skill 変更だけでは直らない。

## 決定と残る境界

`wbh-screen` v4 は `検証へ / 明示除外` の二値にする。条件付きの Wordfence 除外、通常構成、実害、再現性、近接する公開修正、ミラーの先例数を検証前の停止条件にしない。判定器の `runtime-confirmed` は nonce 付き canary と同じ Snapshot digest による決定論的な判定に限り、失敗は `incomplete` のまま扱う。

既存の Programme Boundary と管理者設定 park は、この変更では変更しない。旧 `reject` の残り 5 件と入口で park された 3 件は、管理者設定の境界を決めてから扱う。

## 出典

- 所有者の 2026-10-24 の指示「明らかな除外 findings 以外は検証」「検証を通すことに集中」。
- [Wordfence Bug Bounty Program](https://www.wordfence.com/threat-intel/bug-bounty-program/) の Explicitly Out of Scope と Common False Positive Reports（2026-10-24 確認）。競合は「一般的な構成で容易に再現できない」場合、設定は管理者による誤設定・危険な設定の場合という条件が付く。
- `docs/SPEC.md` 第 2・7 節、`docs/adr/0038-verification-phases-and-submission-flow.md` 追記 6、Private Evidence の `screen-v4-legacy-reject-audit-2026-10-24.csv`。

## 戻し方

v4 の skill を `versions/v3.1.md` に戻し、OPERATIONS と review skill の参照を戻す。台帳に追記した 8 件の `defer` は削除せず、必要なら各 Finding に新しい判断を追記する。
