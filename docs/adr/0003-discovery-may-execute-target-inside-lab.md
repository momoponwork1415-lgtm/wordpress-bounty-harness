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

- `discovery.lab: attached` の campaign では、Trial ごとに探索 Lab を 1 台立て、その Trial の wall の間だけ使う。検証 Lab とは別のインスタンスで、host lease は取らない。`--repeat` は使わない。検証 Lab（Finding ごと、`verify next --handoff`）は変えない。
- sandbox から届くのは Lab の HTTP（`http://wordpress`、Lab の recorder 経由）と制御口 `http://labctl/` だけで、Lab DB は渡さない。Lab は `--internal` network の上にあり、外向き通信は従来どおり broker 経由の provider API だけである。対象も recorder も制御口も gVisor で動かす。
- 制御口 labctl は Lab network の上で待ち受けるので、sandbox のほかに WordPress の container からも IP で届く。そこから届いた要求にできるのは、予算を使うことと、処理中の要求があるときに 409 busy を返させることだけで、権限は上がらず、外向き通信もできない。sandbox は WordPress の固定 IP にも届き、recorder を通らずに要求を送れる。数えて捕捉するのは `http://wordpress`（recorder）を通った要求だけである。
- agent には、Trial の間ずっと管理者 account と低権限 account（subscriber、設定により customer）を渡す。管理者で作った設定は `configurationPrecondition` に書かせる。
- 制御口は `POST /reset` だけを受ける。Harness が WordPress・DB・site volume を作り直し、同じ setup から初期化する（setup digest は変わらない）。回数は `discovery.lab.maxResets`（既定 2、上限 5）で、超えた要求は拒否して数える。処理中に Harness が例外を出した要求には、固定の理由 `harness-error` を付けた `failed` を返し、1 回に数え、制御口は続ける。答えが制御口に届かなければ 1 回だけ送り直し、それでも届かなければ数える。`http://wordpress` を通った HTTP の要求は数えるだけで制限しない。
- 探索 Lab には canary を置かない。Harness は判定しない。recorder の `capture.jsonl` と、Lab の世代（最初と再供給ごと）の状態の before / after / 差分を Trial 単位で Private Evidence に封じ、台帳の `discovery-run-finished` に `exploration-lab` の digest と `labObserved`（要求数、記録上限を超えて捨てた数、再供給の回数、拒否の回数、制御口に届かなかった答えの数）を残す。何が起きたかの判断は、agent が Finding / Lead の `labObservations` に書き、人間が捕捉と並べて読む。
- 再開（ADR 0029 / 0036 の規則は変えない）。所有者は 2026-10-25 に、入口の掃引が終わるまで wide で走らせ、時間は気にしないと決めた。120 分の上限に当たった Trial も、規則どおり再開区間として続ける。前の区間の Lab は、その区間の終わりに封じて壊してある。再開区間では、前の区間の Lab の `lab-provisioned.setupDigest` と同じ setup から新しい Lab を立てる。digest が違えば再開を拒否する（`lab-setup-differs`）。digest が記録されていなければ `lab-setup-unrecorded` で拒否する。再供給の予算は Trial 全体で数え、前の区間までの `labObserved.resets` の合計を引いた残りを渡す。再開区間の最初の turn では、固定した再開段落の前に、その区間の `## Lab` 節を置く。節には、site を立て直したこと、前の Lab の状態は残らないこと、account が入れ替わったこと、予算のうち何回を使ったかを書く。続きの turn は従来どおり再開段落だけを送る。区間ごとに自分の `exploration-lab` を封じる。Codex の `provider-limited` と死んだ持ち主の `interrupted` は、Lab の無い Trial と同じように runner が自動で再開する。名指しの再開（`campaign resume --run`）も同じ経路を通る。Lab を付けて始めた Trial を `discovery.lab: none` の設定で再開しようとすると拒否する（`lab-mode-differs`）。予算は Trial のもので区間ごとに変えないので、Trial を始めたときの `configuration.lab.maxResets` と今の設定が違えば拒否する（`lab-budget-differs`）。再開区間の Lab が立たなければ拒否する（`lab-provision-failed`）。Lab 無しで始めた Trial に再開で Lab を付けることもしない。2026-10-23 より前の attached Trial（`configuration.lab` の無いもの）は、従来どおり `lab-attached` で拒否する。
- 被害者側の画面を開く観測コマンド（`/observe`）は Phase D2 で扱う。
