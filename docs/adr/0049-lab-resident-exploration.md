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

## 2026-11-02 追記 1: `trace` を実装した（#793 の PR 2）

B の 3 つ目の観測器 `POST /trace` を、決定どおりに実装した。体は `{"method": "GET" | "POST", "path": "/...", "cookie"?, "contentType"?, "body"?}` で、path の規則は `observe` と同じ、contentType は `application/x-www-form-urlencoded` / `application/json` / `text/plain` のいずれか、body は 8192 文字まで、GET の body は `invalid-request`（`field: body`）で拒否する。Harness はその 1 リクエストを WordPress container の中から curl で site（`http://wordpress`、自身の loopback）に送り、Xdebug の function trace（format 1）から plugin / mu-plugin ディレクトリ内の関数の入口だけを呼び出し順に取り出して、HTTP status、各 entry の深さ・関数名・file（site root 相対）・行、`entryCount`（上限前の総数）、`truncated` を返す。entry は 2000 件まで。

- 予算は `find` / `sql` と同じ `discovery.lab.maxLookups` を共有し、新しい設定項目は無い。記録は `lookupLog` の `command: "trace"` で、request には method、path、contentType、body（agent の入力なので本文を残す）、bodyLength、cookieLength（cookie は値を残さず長さだけ）を書く。答え（entry の列を含む）は `answer` に封じる。拒否の理由は `budget` / `invalid-request` / `unavailable` / `harness-error`、失敗は `failed`。
- Lab image（`containers/wordpress-lab/Dockerfile`）に Xdebug 3.4.7 を trigger mode（`xdebug.mode=trace`、`start_with_request=trigger`）で入れた。起動値 `xdebug.trigger_value` は container 起動時の環境変数 `WBH_XDEBUG_TRIGGER` で、Harness が Lab ごとに乱数（32 hex）を作り、Lab session にだけ持つ。handle にも、agent に渡る文章にも入れない。Xdebug は起動値を GET / POST / cookie / 環境変数からしか読まない（header は読まない）ので、Harness はその 1 リクエストに `XDEBUG_TRIGGER=<値>` の cookie を付けて送る。agent が cookie を渡したときは、その後ろに続ける。
- 旧 image（Xdebug 無し）の Lab では trace 用ディレクトリが無く、`trace` は `unavailable` で拒否する。供給は失敗しない。
- `trace` の curl は container 内の loopback へ送るので、recorder の捕捉（`capture.jsonl`）には残らない。要求と答えは `lookupLog` が持つ。
- **操作者の手順**: Dockerfile が変わったので image の digest が変わる。`containers/wordpress-lab/README.md` の手順で image を再 build（`pecl install` のため build に network が要る）、push し、host 設定の `images.wordpress` を新しい digest に再 pin して runner を再起動する。再 pin まで、Lab は旧 image で動き `trace` は `unavailable` を返す。
- 計測: bench h34（h33 と同じ 6 対象、37 record）。合格線は HTML 書き換え・変換系の record への到達が増え、Finding が h33 を下回らないこと。[measurement.md](../agents/measurement.md) 5b に行を足した。
- 消し方: `CONTROL_COMMANDS` から `trace` を外し、`lab-trace.ts` と driver の経路、`## Lab` 節の Trace 段落を消し、image から Xdebug を外す。記録済みの `lookupLog` の `trace` は読み続ける。

## 2026-11-02 追記 2: Lead が残った Trial の第 2 Trial をランナーが自動で組む（#793 の PR 3、決定 C）

決定 C を実装した。規則は「終了した Trial に Lead が 1 件以上あり、同じ Snapshot に第 2 Trial がまだ無ければ、連続ランナーは新しい対象を取る前に、その対象の第 2 Trial（ADR 0044 の Lead 入力 Trial）を 1 回組む」である。組まれる Trial は今日の名指しの第 2 Trial と同じもので、`## Prior leads` 節、`discovery.priorResearch: same-target` なら `## Prior research` 節、探索 Lab（既定 `attached`）を受ける。目的文、スキル、生成節の文面は変えていない。

- **Harness が読むもの。** 台帳の event だけである。終了した Trial の判定は `discovery-run-started`（explore、再開区間でない、後の start に置き換えられていない、`configuration.priorLeads` が無い）と、その最新区間の `discovery-run-finished`（outcome が `provider-limited` でなく、reason が `interrupted` でないもの。`completed` と、wall や schema で終わった封じ済みの報告を含む）。Lead は同じ campaign・同じ Snapshot の `lead-recorded` の件数と id の列（台帳順）で、Lead の本文は読まない。代表は台帳順の先頭 8 件（ADR 0044 の上限）で、`lead-groups.mjs` の群分けは Lead の中身（入口と効果の file と関数）を読む判断なので Harness は行わない。重複した代表が混ざりうることは受け入れ、`leadCount` に総数を残す。
- **候補の範囲。** そのランナー（campaign prefix）が最後に対象を選定した campaign（`<prefix>-<YYYYMMDD>-<n>` で `target-selected` があり `follow-up-scheduled` が無いもの）の Trial に限る。それより前の campaign の Trial は組まない。有効にした時点で台帳にある数百の旧 Trial を一斉に組み直して新しい探索を止めないためで、過去の Trial は従来どおり `discovery.priorLeads` で名指しして組む。
- **順序と同時数。** 後続は新しい選定より先に走る。1 回の後続 campaign に、その batch の Snapshot 全部の後続を入れ、同時数は通常の campaign と同じ上限（`maxConcurrentTargets`、runtime 別の上限、live の上書き）に従う。後続 campaign は選定 batch を束ねず、選定の pool を探らないので、拒否と無進捗の停止規則（`holding-refusals`、`no-progress`）には数えない。再開の規則（ADR 0036）は変えていない。後続 Trial の再開区間は、campaign 設定に名指しが無いので、記録した `configuration.priorLeads.leadIds` から節を作り直して digest を照合する。
- **設定。** `discovery.followUp: "leads" | "none"`。書かなければ Lab に従う（`lab: attached` なら `leads`、`lab: none` なら `none`）。`lab: none` で `leads` を名指しすると設定の検査で止める。`none` では何も変わらない。`discovery.priorLeads` を書いた campaign 設定は従来どおり `continuous run` で拒否する。
- **台帳。** 後続を組むとき、後続 campaign の id で `follow-up-scheduled`（`ofRunId`、`ofCampaignId`、`leadCount`）を Snapshot ごとに 1 件、解決の前に書く。拒否されても失敗しても同じ Snapshot をもう一度組まないための印である。後続 Trial の `discovery-run-started.configuration` には `priorLeads`（ADR 0044 と同じ）に加えて `followUp: { of: <第 1 Trial の Root の runId>, leadCount }` を書く。再開区間にも写す。ADR 0044 の拒否（`prior-leads-already-run` を含む）は `target-skipped`（stage `discovery`、reason `follow-up-refused`、`reasonDetail` に拒否の code）で記録し、ランナーの log に 1 行書いて、他の Snapshot は走らせる。どれも追加の任意項目で、旧 event はそのまま読める。
- **計測。** 本番 2 週。分母は Codex 時間。後続 Trial は `configuration.followUp` のある run で数え、Lead → Finding の転換を leads2（名指しの第 2 Trial 14 本で Finding 4）と比べる。数え方は [measurement.md](../agents/measurement.md) 5c にある。
- **消し方。** `discovery.followUp`、`wordPressFollowUpPolicy`、`pendingFollowUps` と runner の分岐、`resolveWordPressFollowUp`、profile の `followUpPolicy`、`CliProfile.runCampaign` の `followUp` を revert する。記録済みの `follow-up-scheduled`、`configuration.followUp`、`target-skipped` の `follow-up-refused` は読み続ける（任意項目のまま残す）。

## 2026-11-02 追記 3: 研究 file の引き継ぎを広げた（#793 の PR 4、決定 D）

決定 D を実装した。詳細は [ADR 0048 の 2026-11-02 追記](0048-prior-research-input.md)にある。同じ対象の別の版の最新 Trial から渡す file に `REGISTRY.md`、`assumptions/*.md`、`walks/*.md` と、その Trial の `lookupLog` から Harness が写した保存先の表 `stores.json` を足し、全部で 2 MiB・64 file までにした。`research import --from <state dir>` で別の台帳（bench）の終了 Trial を候補に取り込める（`research-imported`）。計測は Issue #793 の表の 4 行目（同じ plugin の新版で Root 時間が短くなり F が落ちないこと）。消し方は決定の「D は渡す file を 2 つに戻す」のとおりで、`research-imported` は読み続ける。


## 2026-11-02 追記 4: 決定 E のうち目的文の削除を行った（#793 の PR 5 の一部）

決定 E の「目的文の手順段落の削除」を、`wp2shell-bounty-v22-wide`（[ADR 0039 追記 21](0039-discovery-launch-modes.md)）で行った。v21-wide から、`hooks.tsv` の行数を登録簿に保って行が残る間は閉じない段落、スキル段落のその一覧を指す節、停止文の行数の半分を消し、停止文は「Stop when the Trial wall is reached.」になった。語は足していない。終わってよいかの判断はスキル（`wbh-recon` v3 の手順 9）と Trial の wall が持つ。決定 E の残り、`wbh-falsify` v3（Store / Transformation の行を Lab の答えで埋める）と第 2 Trial のスキルの producer の後ろ向き探索は、まだ行っていない。計測は本番で v22-wide の Trial を v21-wide の Trial と並べる（[measurement.md](../agents/measurement.md) 5b）。消し方は ADR 0039 追記 21 のとおり。

## 2026-11-02 追記 5: スキル `wbh-lab-v1`（決定 E のスキル側）

決定 E のスキル側を実装した。詳細は [ADR 0043 の 2026-11-02 追記 7](0043-exploration-skills-in-the-sandbox.md)にある。Find / Query / Trace / Observe をどの open の行に、どの順で使い、答えをどこに書き、最終報告の前に何を通すかを `wbh-lab-v1` が言う。Harness の命令、予算、`lookupLog` は変えていない。目的文の削除（v22-wide）は ADR 0039 の 2026-11-02 追記にある。計測は Issue #793 の表の分母（Lab 発火 / Codex 時間）と measurement.md 5b。消し方は ADR 0043 追記 7 のとおり。

## 2026-11-02 追記 6: `## Lab` 節が staging 済みの `wbh-lab` を名指す（#793）

事実（本番 campaign `prod-v21-20261102-4`、目的文 v22-wide、スキル recon-v3 + tools-v1 + setup-v1 + wbh-lab-v1、Lab 付き、2026-11-02）: 終了した 5 Root の diagnostic で、`skills/wbh-recon/SKILL.md`、`skills/wbh-setup/SKILL.md`、`skills/wbh-tools/SKILL.md` はそれぞれ 4 回以上読まれ、`skills/wbh-lab/SKILL.md` は 0 回。`lab-facts.md` を書いた Trial は 0、lookups は 0〜2 / Trial。目的文は先の 3 つを名前で指し（「Read wbh-recon …」「Read wbh-tools …」「Read wbh-setup …」）、`wbh-lab` を名指す文はどこにも無かった。Find / Query / Trace / Observe を導入するのは Harness が生成する `## Lab` 節（`src/cli/wordpress.ts` の `wordPressLabSection`）なので、そこに 1 文を足した。Trace 段落の直後、結びの「The Harness records …」段落の前に、独立の段落として `The installed skill wbh-lab describes when to use Find, Query, Trace and Observe from the research files and how to record each answer; read it before the first of these commands.` を置く。条件は、staging するスキルの front matter の `name` が `wbh-lab` であること（id ではなく名前で合わせるので、将来の v2 も当たる）。`wbh-lab` を staging しない Trial の節は従来と byte 単位で同じで、過去の Trial のプロンプトは digest と照合できる。再開区間の通知も同じ関数で作るので、同じ条件で同じ 1 文が入る。目的文、スキル本文、命令、予算、`lookupLog` は変えていない。測り方は、同じ v22-wide の設定で、前（この 5 Root）と後の Trial で、diagnostic artifact の `skills/wbh-lab/SKILL.md` の読み回数、research artifact の `lab-facts.md` の有無、`labObserved.lookups` / Trial を並べる（[measurement.md](../agents/measurement.md) 5b）。消し方は、この 1 文と `wordPressLabSection` の `skillNames` 引数（`wordPressDiscoveryPromptText` と `resumeWithExplorationLab` に渡す値）を消す。訳と出典は [docs/reviews/2026-11-02-lab-section-names-wbh-lab.md](../reviews/2026-11-02-lab-section-names-wbh-lab.md)。
