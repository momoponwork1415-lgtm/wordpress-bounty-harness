---
status: accepted
date: 2026-11-02
amends: 0003（探索 Lab の制御口に 2 コマンドを足し、`discovery.lab` の既定を `attached` にする）、0044（Lead の第 2 Trial を自動で組む段を予定する）
---

# Lab 常設探索: 全 Trial に Lab を付け、保存先の観測器を足す（#793）

## 背景

Codex の Trial は Lead を出すが、Lead の大半は「入れた値がどこに保存され、どこで読まれるか」で止まる。bench h31（20 plugin、62 record）は Finding 20 / Lead 止まり 20 / 未到達 22 で、本番 leads2 の Lead 160 件の大半も producer（保存先に書く側）が見つからずに止まった。保存先はコードだけでは決まらないが、実行して観測すれば 1 回で決まる。

2026-11-02 時点で Lab が付くのは第 2 Trial（Lead 入力、ADR 0044）と検証だけで、第 1 Trial は固定ソースだけを読む。探索 Lab の制御口（ADR 0003 の 2026-10-25 追記）が受けるのは `POST /reset` と `POST /observe` の 2 つで、DB の読み取りは `labAccess.database` が `"none"` 固定だった（読み取り専用ユーザー `wbh_reader` は供給側に既にある）。保存先の検索も実行トレースも無かった。Root は 120 分のうち 30〜40 分で閉じる。

所有者は 2026-11-02 に、[Lab 常設探索の設計](../reviews/2026-11-02-lab-resident-exploration-design.html) を読んで「これでいこう」と承認した。これは 11 月の設計変更（ADR 0045 の追記 1〜3 の 1 まとまり）に加える。ADR 0045 の凍結 5 の第 1〜4 項（人間の観測だけが確定、Harness は制御だけ、台帳は追記専用、分母は 1 つ）は変えない。目的文の文面も触らない。

## 決定

Issue #793 の A〜E を決定とする。

- **A.** campaign 設定 `discovery.lab` の既定を `none` から `attached` にする。全 Trial に探索 Lab を 1 基付ける。Lab 1 基のメモリを測って同時数を決める。`none` は設定で名指ししたときだけになる。
- **B.** Lab の観測器を 3 つ足す。制御口は `reset` / `observe` に加えて次を受ける。
  - `POST /find`: 体 `{"marker": "<10〜15 桁、先頭 0 でない>"}`。印の文字列が site の DB のどの table / column に入ったか（table ごとに主キーの値を 20 まで）と、`wp-content` 配下のどの file に入ったか（50 まで）を返す。見つからないことは「この検索での不在」で、保存されなかった証明ではない。
  - `POST /sql`: 体 `{"select": "<SELECT 1 文>"}`。読み取り専用ユーザー `wbh_reader` で 1 文の SELECT を実行し、列名と 200 行までを返す。SELECT 1 文でない形の要求と、DB が拒否した文は `sql-error` と DB のメッセージで拒否する。
  - `POST /trace`: Xdebug の function trace を Harness が起動して返す（後続 PR）。
  - `find` と `sql` は 1 つの予算 `discovery.lab.maxLookups`（既定 60、0〜300）を共有し、再供給・観測と同じく Trial 全体で数える。答えは毎回、使った回数と上限を述べる。
  - 答えは Trial の `exploration-lab.json`（`lookupLog`）に封じ、台帳の `labObserved` に `lookups` / `refusedLookups` を足す（追加のみ）。Harness は答えを読まない。
  - 探索 Lab は常に `databaseAccess: read-only` で供給し、`reset` の後も読み取り専用ユーザーを作り直す。台帳の `discovery-run-started.configuration.labAccess.database` は attached の Trial で `read-only` になる。
- **C.** 終了した Trial に Lead が 1 件以上あり、同じ Snapshot に第 2 Trial が無ければ、選定が第 2 Trial（ADR 0044）を 1 回組む。Lead の中身は読まない。
- **D.** 研究 file の引き継ぎ（ADR 0048）に `assumptions`、`walks`、保存先の表を足す。
- **E.** スキル: `wbh-falsify` v3（Store / Transformation の行を Lab の答えで埋める）、第 2 Trial のスキルに producer の後ろ向き探索、目的文の手順段落の削除。

**この PR（#793 の PR 1）が実装するもの**: A と、B のうち `find` / `sql`（予算、記録、`## Lab` 節の 2 段落、台帳の項目）。**後続**: B の `trace`（PR 2）、C（PR 3）、D（PR 4）、E（PR 5）。順序と合格線は Issue #793 の表にある。

変えないこと: Harness は判定しない。探索は広いまま。1 Trial 1 Lab。凍結 5 項目。制限時間の上限は、Closing が wall で終わったと言う Trial が出てから上げる。

## 理由

- 保存先の問いは観測の問いである。`find` は agent が植えた印を site 全体から探すだけで、何を植えるか、どこを見るかは agent が決める。Harness に探索の手順は入らない（AGENTS.md「Harness と AI の責務」）。
- `sql` を読み取り専用ユーザーに限るのは、Lab の状態を agent の手で変える経路を HTTP（site の通常機能）だけに保つためである。形の検査（SELECT 1 文）は本当の守りではなく、読み取り専用アカウントが守りで、形の検査は要求を答えられる範囲にそろえるためにある。
- 答えを Harness が読まないのは不変条件 3 と ADR 0040 のままである。答えは観測で、agent が `labObservations` に書き、人間が捕捉と並べて読む。
- 既定を `attached` にするのは、第 1 Trial と第 2 Trial で Lab の有無が違うと、Lead 入力の効果と Lab の効果が分けられなかったからである（measurement.md 5c）。全 Trial に Lab を付ければ、分母は ADR 0045 のまま 1 つで比べられる。

## 採らなかった選択肢

- sandbox に DB を直接渡す（`labAccess.database` を agent の資格情報にする）: ADR 0003 の 2026-10-25 追記が「Lab DB は渡さない」と決めた。制御口を通せば、要求と答えが全件 Private Evidence に残り、予算で数えられる。
- `find` を Harness の判定に使う（印が見つかれば Finding にする）: 判定器になる。Harness は観測を記録するだけで、確定は人間の観測である（不変条件 3）。
- 任意の SQL（書き込みを含む）: Lab の状態を HTTP 以外で変える経路ができ、捕捉と状態の差分が site の通常機能の記録でなくなる。
- `/observe` の予算に `find` / `sql` を相乗りさせる: ブラウザ観測と保存先の検索は回数の性質が違う。別の 1 予算にして台帳で分ける。
- 既定を `none` のまま、campaign ごとに `attached` を書く: 本番の全 Trial に付けるのが決定なので、書き忘れた campaign が Lab 無しで走る状態を残さない。

## 帰結

- `src/lab/control/index.ts` の `CONTROL_COMMANDS` に `find` と `sql` を足す。制御口は中継だけで、中身を読まない。
- WordPress profile に `lab-lookup.ts`（要求 schema、`isSingleSelect`、`findInExplorationLab`、`queryExplorationLab`）を置き、`WordPressLab` に 2 つのメソッドを足す。探索 Lab の driver（`exploration-lab.ts`）が予算と記録を持つ。
- `discovery.lab` の既定を `attached` にし、`maxLookups` を足す。再開（ADR 0036）は `maxLookups` も Trial の予算として照合し（`lab-budget-differs`）、前の区間までの `labObserved.lookups` の合計を引いた残りを渡す。
- `## Lab` 節に Find と Query の 2 段落を足す。agent に渡る文章なので `owner-approved` を要する。本文は `src/cli/wordpress.ts` の `wordPressLabSection` にあり、設計文書の B 節に対応する。
- 計測: bench h33（h32 と同じ 6 対象、37 record）。合格線は Finding が h32 を上回り、Lead 止まりが減ること。分母は Lab 発火 / Codex 時間（ADR 0045）。[measurement.md](../agents/measurement.md) 5b に行を足す。
- 本番の同時数は Lab 1 基のメモリを測ってから決める。測るまでは `resources.memoryBudgetMiB` の既定で Harness が止める。

## 消し方

A は `discovery.lab` の既定を `none` に戻す。B は `CONTROL_COMMANDS` から 2 つを外し、`lab-lookup.ts` と `exploration-lab.ts` の find / sql の経路、`## Lab` 節の 2 段落、`maxLookups` を消す。C は設定項目を外す。D は渡す file を 2 つに戻す。記録済みの `lookupLog` と台帳の `labObserved.lookups` / `configuration.lab.maxLookups` は読み続ける（任意項目のまま残す）。
