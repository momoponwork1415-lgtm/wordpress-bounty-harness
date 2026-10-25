---
status: accepted
---
# 探索エージェントは隔離Lab内で対象を実行してよい

Discovery runは、gVisor内の使い捨てWordPress + MySQL Labに対してHTTP・DB読み取り・canary確認を行い、仮説を実行で確かめてよい。Lab外への到達、外向き通信、ホストでの対象実行、永続化は禁止。読み取り専用sourceだけで探索する旧方針は採らない。高い真陽性率を公開した設計（Mythos / Glasswing、Firefox、XBOW）はすべて探索エージェント自身が対象を動かしており、ソースのみで同等の精度が出た公開証拠はないため。

## Considered Options

- 読み取り専用sourceのみ: 安全だが精度の根拠がない。
- Lab内実行を許可: Labの供給費用が増えるが、公開事例と一致する。採用。

## 2026-10-25 追記: 探索 Lab の復活（再供給と捕捉、canary なし）

所有者決定（2026-10-25、[探索アーキテクチャの再設計](../reviews/2026-10-25-exploration-architecture-redesign.md) §6・§12 Q1〜Q5）により、2026-10-23 に退役した attached の探索 Lab を次の形で戻す（Phase D1）。決定の本文は変えない。

- `discovery.lab: attached` の campaign では、Trial ごとに探索 Lab を 1 台立て、その Trial の wall の間だけ使う。検証 Lab とは別のインスタンスで、host lease は取らない。`--repeat` と再開は使わない。検証 Lab（Finding ごと、`verify next --handoff`）は変えない。
- sandbox から届くのは Lab の HTTP（`http://wordpress`、Lab の recorder 経由）と制御口 `http://labctl/` だけで、Lab DB は渡さない。Lab は `--internal` network の上にあり、外向き通信は従来どおり broker 経由の provider API だけである。対象も recorder も制御口も gVisor で動かす。
- agent には、Trial の間ずっと管理者 account と低権限 account（subscriber、設定により customer）を渡す。管理者で作った設定は `configurationPrecondition` に書かせる。
- 制御口は `POST /reset` だけを受ける。Harness が WordPress・DB・site volume を作り直し、同じ setup から初期化する（setup digest は変わらない）。回数は `discovery.lab.maxResets`（既定 2、上限 5）で、超えた要求は拒否して数える。HTTP の回数は数えるだけで制限しない。
- 探索 Lab には canary を置かない。Harness は判定しない。recorder の `capture.jsonl` と、Lab の世代（最初と再供給ごと）の状態の before / after / 差分を Trial 単位で Private Evidence に封じ、台帳の `discovery-run-finished` に `exploration-lab` の digest と `labObserved`（要求数、記録上限を超えて捨てた数、再供給の回数、拒否の回数）を残す。何が起きたかの判断は、agent が Finding / Lead の `labObservations` に書き、人間が捕捉と並べて読む。
- 被害者側の画面を開く観測コマンド（`/observe`）は Phase D2 で扱う。
