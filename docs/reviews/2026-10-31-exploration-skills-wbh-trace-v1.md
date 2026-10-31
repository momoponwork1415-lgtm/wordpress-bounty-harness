# 探索スキル wbh-trace v1 の全文・日本語訳・出典対照表（2026-10-31）

[Issue #682](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/682)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md)。スキル系列の 3 本目で、ADR 0043 の「後続は … 追跡と引き継ぎ … をそれぞれ 1 本ずつ PR にする」と、図 [2026-10-30-exploration-skills-architecture.svg](2026-10-30-exploration-skills-architecture.svg) の「wbh-trace 3 方向の追跡と引継ぎ」に当たる。agent に渡る文章の規則（DEVELOPMENT 第 5 節）に従い、全文、日本語訳、出典対照表を置く。本文は手順だけで、型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数は書いていない（test `tests/profiles/wordpress/skill-definitions.test.ts` で固定）。

このスキルは、Root や子が地図（`wbh-recon-v1`）から選んだ入口・保存先・効果の間を、固定ソースだけで 1 hop ずつ追い、途中の検査と変換を表にして `/workspace/research/traces/` に残す手順である。表の行は、Finding か Lead の下書きの `sourceTrace` にそのまま使える。Harness は本文を解釈せず、trace の file も読まない。支援 file は無い。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-trace-v1/SKILL.md`
- digest: `sha256:5f2e2eaf166b7a2f01270cff3982e1e6629a4a42396186bb1af7f0e117500597`
- registry: `src/profiles/wordpress/prompts/skills.ts` の `wbh-trace-v1`（name `wbh-trace`、status `current`、支援 file 無し）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-trace/SKILL.md`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-trace/SKILL.md`
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v1", "wbh-trace-v1"] }`（`deep` / `wide` のみ。`wbh-tools-v1` と併せてもよい）。地図を前提にするので `wbh-recon-v1` と一緒に名指しする（measurement.md 5b）

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-trace
description: Use when an agent has picked a request entry, a store or an effect from /workspace/research/recon-map.md and needs to follow a value between them through the pinned source. Follows the value forward from the entry, backward from the effect and across stores and deferred callbacks, records every hop with the checks and transformations on the way as a table under /workspace/research/traces, and leaves the file, function and line rows a Finding or Lead draft needs for its sourceTrace.
---

# wbh-trace v1

A route is a sequence of hops, and the hop that decides it is often the one a reader skips. A trace that jumps from an entry to an effect by name passes over the place where the value is checked, changed or dropped; a trace written hop by hop, each with the line that shows it, can be read again by another agent, by the root and by the later human review. This skill describes how to follow one value through the pinned source from where a request supplies it to where it takes effect, how to record what the code does to it on the way, and how to leave the record where other agents and the final report can use it. It does not say which routes matter or whether a route is in scope. The objective, the trust boundary and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial. The map is /workspace/research/recon-map.md, with its Wrappers table, its shared gate functions, shared helpers, stores and effects, JavaScript boundary and Corrections section. When the listing from wbh-tools exists, /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv are there too. Traces go under /workspace/research/traces, one file per route.

## Step 1: start from a row of the map

Start from one row of the map: a request entry, a store, or an effect. Read the map's section for that subsystem, the Wrappers table and the Corrections section before opening the source. Create /workspace/research/traces/<subsystem>-<short-name>.md and write the starting row in it by file and line. If the place you start from has no row in the map, add it to the map's Corrections section first, so the next agent finds it.

## Step 2: forward from the entry

From the entry's registration, reach the handler through the wrapper rule the map records, and follow the parameter the handler reads. At each hop record the file, function and line, and what the value is at that point: the request field or argument it came from and its name in this scope. Follow calls into shared helpers, core functions and library code by reading their pinned source, not by their names. Where the value is written to a store rather than used, name the store and continue in Step 4. Where the handler returns data that the shipped JavaScript places into the page, the last hop is in the JavaScript file the map names beside that handler.

## Step 3: backward from the effect

When the starting row is an effect or a store, or when the forward trace reaches a helper that several subsystems call, go the other way. From the call that takes effect, list every caller that reaches it, using the map's shared helpers section and, when it exists, the matching lines of sinks.tsv, and follow each caller back to the entries that supply its arguments. Read the helper once and record what it does with each argument; then record each caller as its own route, in the same trace file or in one beside it that names this one. A listed line is a place to read, not a hop, until you have read it.

## Step 4: across stores and deferred work

A value written to a store is read again elsewhere, and the map's stores and effects section records where. Follow the value from the write to every read-back the map records, and from a scheduled event, a queued job or a callback registered for later to the place where it runs. Keep the trace in the same file with the store as the joining hop, and record the write and the read-back as separate rows, each with who reaches it as the map records it. A read-back the map does not record is a correction to the map.

## Step 5: the checks and transformations on the way

For each hop, record what the code does to the request or the value at that point, as the source shows it: capability, login and ownership checks; nonce or token checks; sanitizing and validation; escaping and query preparation, whether by core or by the plugin's own functions; and any serializing or other change to the value. Record each one where it sits, in the order the code runs, and which hops it covers: a check in a shared registration wrapper, a check inside one handler, and a check left to the handler are recorded as such. Read the body of each function in the pinned source rather than relying on its name, its comments or the option names around it.

## Step 6: write the table

In the trace file, write these parts in this order. Ends: the starting row and the last hop, each with file and line. Hops: one table with one row per hop in the order the value moves, with columns file, function, line, role (entry, through, store, read-back, effect), the value at that hop, and the checks and transformations at that hop. Reach: who reaches the entry, as the map records it, and any setting the route passes through, as the source shows it. Open: the hops not yet read or not settled, each with the reason. Mark any hop you inferred rather than read as inferred. A row without a file and a line is not a hop yet.

## Step 7: from the table to a draft

The rows of the Hops table, entry first and effect last, with the store and read-back rows between them, are the sourceTrace of a draft: each carries the file, function and line the output contract asks for. A table with no Open rows gives a Finding draft its route; a table with an Open row gives a Lead draft its route, with the missing hop named in the reporting agent's own words. Whether to report it, and as which, is decided under the objective and the output contract. Write the table either way: a route that exists only in an agent's context is lost.

## Step 8: hand-over

When a trace is handed to another agent or continued by a fresh one, name the trace file and its Open rows together with the map's section for the subsystem. The next agent reads the trace file, that section and the Corrections section before the source, and appends to the trace instead of rewriting it; a note on another agent's trace goes under it, dated. A trace that showed the map wrong, or found an entry, wrapper, store or read-back the map lacked, adds a dated correction to the map's Corrections section with the file and line that shows it. An agent that finishes writes which traces it wrote and which Open rows remain into its own research file, so that the next agent on the same unit continues instead of restarting.
```

## 日本語訳

front matter: name `wbh-trace`。description「agent が /workspace/research/recon-map.md から要求の入口、保存先、効果のどれかを選び、その間で値を固定ソースの中で追う必要があるときに使う。値を入口から前向きに、効果から後ろ向きに、保存先と遅延 callback をまたいで追い、各 hop と途中の検査・変換を /workspace/research/traces の下に表として記録し、Finding か Lead の下書きが `sourceTrace` に要る file、function、line の行を残す。」

### wbh-trace v1

経路は hop の列であり、経路を決める hop は読み手が飛ばす hop であることが多い。入口から効果へ名前で跳ぶ trace は、値が検査され、変えられ、落とされる場所を通り過ぎる。hop ごとに、それを示す行とともに書いた trace は、別の agent、Root、後の人間のレビューが読み直せる。このスキルは、要求が値を渡す場所から値が効果になる場所まで、固定ソースの中で 1 つの値を追う方法、途中でコードが値に何をするかを記録する方法、その記録を他の agent と最終報告が使える場所に残す方法を書く。どの経路が大事か、経路が対象範囲内かは書かない。それは目的文、trust 境界、出力契約が言う。

**Inputs。** 固定したプラグインソースは /workspace/main にある。固定した WordPress 本体のソースは、供給されていれば /workspace/wordpress に、他のプラグインや library のソースは /workspace/dependencies/<slug> の下にある。本体、framework、library が何をするかは、記憶ではなく供給されたソースを読む。/workspace/research は書き込み可で、Trial の全 agent が共有する。地図は /workspace/research/recon-map.md で、Wrappers 表、共有の関門関数、共有 helper、保存先と効果、JavaScript の境界、Corrections 節を持つ。wbh-tools の一覧があれば /workspace/research/tools/hooks.tsv と sinks.tsv もある。trace は /workspace/research/traces の下に、経路 1 本につき 1 file で置く。

**手順 1: 地図の 1 行から始める。** 地図の 1 行（要求の入口、保存先、効果のどれか）から始める。ソースを開く前に、その subsystem の地図の節、Wrappers 表、Corrections 節を読む。/workspace/research/traces/<subsystem>-<short-name>.md を作り、始めの行を file と行で書く。始める場所に地図の行が無ければ、次の agent が見つけられるよう、先に地図の Corrections 節に足す。

**手順 2: 入口から前向きに。** 入口の登録から、地図が記録した wrapper の規則で handler に着き、handler が読む parameter を追う。各 hop で、file、function、line と、その時点で値が何か（どの request の欄か引数から来たか、この scope での名前）を記録する。共有 helper、本体の関数、library のコードへの呼び出しは、名前ではなく固定ソースを読んで追う。値が使われずに保存先へ書かれるところでは、保存先を名指しして手順 4 へ進む。handler が返すデータを出荷された JavaScript が page に置くところでは、最後の hop は、地図がその handler の横に書いた JavaScript の file にある。

**手順 3: 効果から後ろ向きに。** 始めの行が効果か保存先のとき、または前向きの trace が複数の subsystem から呼ばれる helper に着いたときは、逆に進む。効果になる呼び出しから、それに届く呼び出し元をすべて、地図の共有 helper 節と、あれば sinks.tsv の該当行を使って並べ、各呼び出し元を、その引数を渡す入口まで戻って追う。helper は 1 回読み、各引数をどう扱うかを記録する。次に、各呼び出し元をそれぞれ 1 本の経路として、同じ trace file か、この file を名指しする隣の file に記録する。一覧の行は、読むまでは hop ではなく、読む場所である。

**手順 4: 保存先と遅延処理をまたいで。** 保存先に書かれた値は別の場所で読み戻され、その場所は地図の保存先と効果の節が記録している。値を、書き込みから地図が記録したすべての読み戻しへ、また scheduled event、queue の job、後で呼ぶよう登録された callback から、それが動く場所へ追う。保存先をつなぎの hop にして同じ file で trace を続け、書き込みと読み戻しを、地図が記録したとおりの「誰が届くか」を付けて別の行にする。地図が記録していない読み戻しは、地図への訂正である。

**手順 5: 途中の検査と変換。** 各 hop で、コードがその時点で要求か値に何をするかを、ソースが示すとおりに記録する: capability、ログイン、所有の検査。nonce や token の検査。サニタイズと validation。escape と query の準備（本体のものか、プラグイン自前の関数か）。serialize その他の値の変更。それぞれを、置かれた場所に、コードが動く順に記録し、どの hop を覆うかを書く。共有の登録 wrapper にある検査、1 つの handler の中の検査、handler に任された検査は、そのように記録する。各関数は、名前、コメント、周りの option 名に頼らず、固定ソースで本体を読む。

**手順 6: 表を書く。** trace file に、次の部分をこの順で書く。Ends: 始めの行と最後の hop（それぞれ file と行）。Hops: 値が動く順に 1 hop 1 行の表 1 つ。列は file、function、line、役（entry、through、store、read-back、effect）、その hop での値、その hop での検査と変換。Reach: 地図が記録したとおりの、入口に誰が届くかと、ソースが示すとおりの、経路が通る設定。Open: まだ読んでいない hop、決着していない hop（それぞれ理由付き）。読まずに推測した hop は推測と印を付ける。file と行の無い行は、まだ hop ではない。

**手順 7: 表から下書きへ。** Hops 表の行は、入口を先頭、効果を最後にし、その間に保存先と読み戻しの行を挟むと、下書きの `sourceTrace` になる。各行が、出力契約の求める file、function、line を持つ。Open 行の無い表は Finding の下書きに経路を与え、Open 行のある表は Lead の下書きに経路を与え、欠けた hop は報告する agent が自分の言葉で名指しする。報告するか、どちらとして報告するかは、目的文と出力契約のもとで決める。どちらでも表は書く。agent の context にしかない経路は失われる。

**手順 8: 引き継ぎ。** trace を別の agent に渡すとき、または新しい agent が続けるときは、trace file とその Open 行を、その subsystem の地図の節とともに名指しする。次の agent は、ソースより先に trace file、その節、Corrections 節を読み、trace を書き直さずに追記する。別の agent の trace への注記は、その下に日付付きで書く。地図の誤りを示した trace、地図に無い入口、wrapper、保存先、読み戻しを見つけた trace は、それを示す file と行とともに、地図の Corrections 節に日付付きの訂正を足す。終えた agent は、書いた trace と残った Open 行を自分の研究 file に書き、同じ単位の次の agent がやり直さずに続けられるようにする。

## 出典対照表

出典は ADR 0043（とその図）、既存のスキル、LESSONS、所有者決定の日付に限った。要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| スキル 1 本 1 手順で「追跡と引き継ぎ」を受け持つ。中身は手順だけで、どの経路が大事か・対象範囲内かは書かない | 冒頭の段落 | ADR 0043「後続は … 追跡と引き継ぎ … それぞれ 1 本ずつ PR にする」「本文の規則: 手順だけを書く」。所有者決定 2026-10-30（#682「巨大プロンプトではなくスキルに分ける」）。所有者決定 2026-10-27「中身は AI、形は Harness」 |
| 3 方向: 入口から前向き、効果から後ろ向き、保存先と遅延 callback をまたぐ | description、手順 2・3・4 | ADR 0043 の図「wbh-trace 3 方向の追跡と引継ぎ」と #682 の PR 1 comment（2026-10-29）。3 方向の中身は、所有者が報酬を得た `bounded-wp2shell/v1.7`（LESSONS 6・12 が名指しする版）の「forward from attacker-controlled entry … backward from an accepted terminal … across persistence, deferred callbacks, wrappers」（`prompts/wp2shell-whitebox-v1.7.md`）。本文には判定の語（accepted terminal）を写さず、方向だけを取った |
| 名前で跳ばず hop ごとに行を付ける。後の人間のレビューが読み直す | 冒頭の段落、手順 6 | `wbh-review` 規則 6「hop を補わない。`sourceTrace` に書かれていない辺を自分で埋めない」。`wbh-report` が `sourceTrace` の file と行を Affected Code References に使う。`wbh-recon-v1` 手順 7「Every row carries a file and line」 |
| 固定ソースの置き場、記憶ではなく供給ソースを読む、/workspace/research の共有 | Inputs | `wbh-recon-v1` Inputs、`wbh-tools-v1` Inputs（同じ文） |
| 地図・Wrappers 表・共有の関門関数・Corrections を先に読む | Inputs、手順 1、手順 8 | `wbh-recon-v1` 手順 8「Each agent receives the map's section for its unit, the Wrappers table, and the list of shared gate functions, and reads the map before the source」 |
| tools の一覧は、あれば使う。一覧の行は読むまでは hop でなく読む場所 | Inputs、手順 3 | `wbh-tools-v1` 手順 5「A match in either list is a place to read, not a conclusion」、手順 6 |
| 地図に無い場所は先に Corrections に足す。上書きせず追記する | 手順 1・4・8 | `wbh-recon-v1` 手順 7（Corrections 節、他の agent は上書きしない）、`wbh-tools-v1` 手順 3・4 |
| wrapper の規則で handler に着く | 手順 2 | `wbh-recon-v1` 手順 3（wrapper の項目がどの本体の仕組みに行き着くかの規則） |
| 呼び出しは名前でなく固定ソースを読んで追う | 手順 2・5 | `wbh-recon-v1` Inputs「Read the supplied source instead of recalling」、手順 4「State what you read, not what the plugin's comments or option names claim」 |
| 最後の hop が JavaScript の file にある場合 | 手順 2 | `wbh-recon-v1` 手順 6「has its last step in the JavaScript file, so the map names that file beside the PHP handler」 |
| 共有 helper は 1 回読み、呼び出し元を並べる | 手順 3 | `wbh-recon-v1` 手順 5「For each helper record what it wraps … and which subsystems call it」、`wbh-tools-v1` 手順 4（数の多い関数は全行でなく流れ込む値を言う） |
| 書き込みから読み戻しへ。書き込みと読み戻しで「誰が届くか」を分ける | 手順 4 | `wbh-recon-v1` 手順 5「Record where stored values are read back out and rendered」、手順 4（誰が届くか） |
| 途中の検査と変換の種類（capability、ログイン、所有、nonce / token、サニタイズと validation、escape と query の準備、serialize） | 手順 5 | `wbh-recon-v1` 手順 4（capability、nonce や token、ログイン、所有の検査）、手順 5（プラグイン自前の escape や validation の関数、query builder、serialization の helper）。サニタイズは 2026-10-31 の依頼が役割に挙げた 4 つ（nonce、権限、エスケープ、サニタイズ）の 1 つ |
| 検査が置かれた場所と覆う範囲（共有 wrapper / handler 内 / handler 任せ） | 手順 5 | `wbh-recon-v1` 手順 4「A check in a shared registration wrapper covers every entry behind the wrapper; a check inside one handler covers that handler only; a wrapper that leaves the check to the handler covers nothing by itself」 |
| 表の部分（Ends、Hops、Reach、Open）と、推測に印 | 手順 6 | 2026-10-31 の依頼の役割「入口／経由／sink／途中の制御を表にする」。`wbh-recon-v1` 手順 7（表、file と行、推測は推測と印、Open questions）。Reach の 2 項は段 1b `wbh-source-check` の 2 つの問い（入力を握れるか、既定かもっともらしい設定で届くか）が読む事実で、答えは書かせない |
| 表の行が `sourceTrace` になる。欠けた hop は Lead の下書きで名指しする | 手順 7 | `wbh-recon-v1` 対照表の手順 7 行（契約 v4 が `sourceTrace` に file と行を求める）。契約 v4 の Lead schema が欠けた辺（`missingEdge`）を持つ。種別の enum は本文に写さない（ADR 0043「型の一覧は書かない」） |
| 報告するかは目的文と契約が決める。どちらでも表は書く | 手順 7 | 所有者決定 2026-10-26「探索は広く出し、落とすのはレビュー側で行う」。LESSONS 5「人間に見えない成果は無いのと同じ」、LESSONS 10「見込み薄の候補は捨てずに残す」 |
| 引き継ぎは trace file と Open 行を名指しし、次の agent はやり直さずに続ける | 手順 8 | `wbh-recon-v1` 手順 8（読んだもの・未読を研究 file と Corrections に書き、次の agent が続ける）、`wbh-tools-v1` 手順 6 |

## 書かなかったもの（規則どおり）

- 型の一覧、判断の基準、脆弱性の語、「この検査があれば安全」のような判定: 契約 v5 / v17 の教訓（ADR 0038 追記 15、ADR 0039 追記 12）と ADR 0043 の本文の規則。本文は検査と変換を「記録する」とだけ言い、効くかどうかは言わない。
- `missingEdge` などの enum、Finding / Lead の欄の名前（`sourceTrace` を除く）: 出力契約は Harness が生成する節にある（ADR 0019）。
- 目的文 v14-wide にある「shapes that recur」や入口の頻度順: 目的文の側にあり、スキルで重ねない。
- 最低時間、子の数、hop 数の上限: Harness が Run parameters で強制するか、目的文が言う（ADR 0039 追記 3・4）。
- 対象固有の名前、再現の手順、公開履歴の個別記録: 不変条件 1。
