# 探索スキル wbh-falsify v2 の全文・日本語訳・出典対照表（2026-11-02）

[Issue #791](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/791)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-02 追記 6。v1 の文書は [2026-11-02-exploration-skills-wbh-falsify-v1.md](2026-11-02-exploration-skills-wbh-falsify-v1.md)。所有者の 2026-11-02 の言葉「これが終わったら改善して、6 対象くらいに絞ってベンチマークにしましょう」を受けた改訂である。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-falsify-v2/SKILL.md`（支援 file なし、13,765 byte）
- digest: `sha256:9281aae8e625cac7c0b3bb905a697e50f9cec7012482bd1da0d64c6195b5c46e`
- registry: `wbh-falsify-v2`（name `wbh-falsify`、status `current`）。v1 は `archived`
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v3", "wbh-tools-v1", "wbh-setup-v1", "wbh-falsify-v2"] }`
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-falsify/SKILL.md`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-falsify/SKILL.md`

## 何を変えるか（数字）

bench h31（#786、2026-11-02）で v1 を 20 対象に掛け、終わった 16 件・鍵の記録 62 件を h30 → h31 で記録ごとに追った。Finding 到達 22 → 20、Lead 止まり 15 → 20、未到達 25 → 22。Lead 止まりから Finding に 3 件、未到達から新しく 10 件（うち Lead 止まり 7 件）が増えた一方、Finding だった 5 件（「handler の中で値が直接 sink に届く」形）が未到達に、3 件が Lead に下がった。Root の時間は 10〜83 分（中央値 39 分）で、自力で 120 分に当たった Trial は無い。仮定の表は sink の名前が無い形に効くが、その分だけ入口から順に読む読み方が薄くなった。v2 は、その 2 つの読み方を別々の子に分けて両方やる。

## v1 との差分（他は byte 単位で同じ）

1. description の末尾に 1 文（1 単位は 2 agent が 2 回読む）。冒頭の段落に、歩きと表の役割分担の 3 文。Inputs に `walks` の置き場。
2. 手順 1 の末尾に段落: 2 pass は別々の agent、表は歩きの file から始める、歩きの file が無ければ先に歩いて表は別の agent に残す、prior lead の単位は lead の経路そのものを歩く。
3. 新しい手順 2「the walk」。以降の手順番号が 1 つずつ繰り下がる（旧 2 → 3、…、旧 6 → 7）。本文内の参照（「手順 3 で読む行」→「手順 4」）も合わせた。
4. 手順 3（旧 2）の冒頭に 3 文: 歩きの file を先に読み、歩きの check は enforced at を埋め、use は行が頼る場所、経路はそのまま not enforced の行。
5. 手順 7（旧 6）: 引き継ぎの面に歩きの file を足し、Counts に歩きの数を写し、歩きの file が無い単位は open。

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-falsify
description: Use after the map exists, when an agent takes one subsystem of the plugin's pinned source to read in depth, and for each prior lead when the Trial states a Prior leads section. Writes, for that unit, a table of what its code assumes about who reaches it, what the values it reads are, who writes each store it reads back, what each rewrite or parse of text preserves and what each signature or token covers, with the file and line where the source enforces each assumption or "not found"; then reads every "not found" row hop by hop, backward to every writer and forward to every reader, under /workspace/research/traces, and leaves the file, function and line rows a Finding or Lead draft needs for its sourceTrace. Each unit is read twice, by two agents: a walk of every entry to the check that stops it or the use its value reaches, written under /workspace/research/walks first, then the table, started from the walk's rows.
---

# wbh-falsify v2

A reader who looks for the place where a value is used finds the places that have a name: a query, a file operation, an output call. A plugin also fails in places that have no such name, where its code relies on something it never checks: that only one role writes a store another screen renders; that a signature covers every field the handler later trusts; that a rewrite of the finished page keeps the boundaries of the markup it rewrites; that a value comes back from storage in the shape it went in. This skill describes how to write those assumptions down for one unit of the plugin, how to find where the source enforces each one, and how to read the rows it does not enforce through to the rows a Finding or Lead draft needs. Before the table, the same unit is walked: every entry read from the request to the check that stops it or to the use its value reaches. The walk finds the routes that have a name; the table finds the ones that do not; the two are done by different agents so that neither reading replaces the other. It does not say which assumptions matter, which routes to report, or what is in scope. The objective, the trust boundary and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial. The map is /workspace/research/recon-map.md, with its Entries tables, Wrappers table, shared gate functions, shared helpers, stores and effects, JavaScript boundary and Corrections section. When the listings from wbh-tools exist, /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv are there too; when the Trial has a Lab, /workspace/research/lab-setup.md records what was built in it. Walks go under /workspace/research/walks, one file per unit; assumption tables go under /workspace/research/assumptions, one file per unit; traces go under /workspace/research/traces, one file per row read.

## Step 1: the unit

A unit is one subsystem of the map with its entries, gate, shared helpers, stores, read-backs and JavaScript boundary, as Step 8 of wbh-recon hands it over. Read the map's section for the unit, the Wrappers table, the shared gate functions and the Corrections section before opening the source. When the Trial states a `## Prior leads` section, each prior lead is a unit of its own, made of the subsystem that holds its entry place and the subsystem that holds its effect place; take those units first, and start their tables from the two places the lead names and the sentence it stated. A place the map lacks goes into the Corrections section first, so the next agent finds it.

Each unit is read in two passes by two different agents: the walk of Step 2, then the table of Steps 3 to 6. The agent that writes the table is not the agent that walked the unit, and it starts from the walk file. When a unit has no walk file yet, the agent asked for its table walks it first and leaves the table to another agent. For a prior lead unit, the walk is the lead's own route, read from the entry place to the effect place the lead names, before any table is written.

## Step 2: the walk

Create /workspace/research/walks/<subsystem>.md and read every entry of the unit in the map's order, from the registration into the handler body and on through every function the handler calls with a request value, until one of two points: the request is stopped by a check, or a value that came from the request reaches a use: a query, a path or file operation, an output into a page or a response, an include, a redirect, a header, a comparison, a store write, or a call into another service. Write one row per entry: the entry as the map names it, the point reached with its file, function and line, which of the two points it is, and each request value that arrived there with what the code did to it on the way, hop by hop, each hop with its file and line. A handler read from its name, its registration or a comment has not been walked. When a value is handed to a helper, open the helper's pinned source and record what it does to that form of value; the word sanitize or validate in a name is not a hop. When a value reaches a store write, record the store and stop there; the read-back side belongs to the Store rows of Step 3.

A row whose value arrives at a use with no check between the entry and the use, or with a check the walk read and found not to cover that value, is a route: write it under a Routes heading in the walk file, entry first and the use last, with every hop, in the shape Step 6 describes. The walk ends when every entry of the unit has a row. Then append a Counts section to the walk file: entries walked to a check, entries walked to a use, entries not walked with the reason, and routes written.

## Step 3: write the assumptions

Read the unit's walk file first. A check the walk recorded fills the enforced at column of the row it covers; a use the walk recorded is the place a Store, Transformation or Proof row relies on; a route the walk wrote is already a row not enforced and enters the table as such, with its hops in the walk file. Then create /workspace/research/assumptions/<subsystem>.md and write one row per assumption the unit's code relies on, reading the bodies of the functions rather than their names, comments or option names. Write rows of these kinds:

- Reach: who the code assumes reaches each entry, and by what: a role or capability, a login, a nonce or token, a referer or origin, a request address, a secret carried in the request, or nothing.
- Value: what a handler assumes about each value it reads from the request: its type and shape, that it is one of a listed set, that it names an object the caller owns or may see, that it is a path, a URL or an identifier of a particular form.
- Store: for each store the unit writes or reads (an option, post or user meta, a custom table, a transient, a file, data held by another service), who the code assumes can write it and in what form; and at each place it is read back, what the reader assumes about the content: already escaped, already validated, the same shape and type as written, written by the same role that reads it.
- Transformation: for each place the code rewrites, parses, splits, decodes, re-encodes, serializes or unserializes text or data (a filter on the output buffer, a minifier, a placeholder scheme that reserves and restores blocks, a regular expression over markup or over a query, a serializer, a template engine), what it assumes the input looks like and what it assumes the output preserves: attribute and tag boundaries, quoting, the match between a placeholder and the block it stood for, the length and type of fields, the meaning of a delimiter.
- Proof: for each signature, hash, token, nonce, key or password comparison, which fields of the request it covers and which it leaves out, how the comparison is made, what it assumes about who holds the secret, and whether a value can be presented twice.
- State: what the code assumes about the site or the order of steps: a setting enabled, another plugin or a service present, a licence or mode, a step completed before this one runs, a file or record already present.

Each row has the assumption in one sentence, the file and line where the code relies on it, and a column named enforced at: the file and line of the check or construction that makes the assumption hold, or the words not found. Not found is not a conclusion. It is the row to read in Step 4. A check in a shared registration wrapper enforces a row for every entry behind the wrapper; a check inside one handler enforces it for that handler only; a check that the handler is left to make enforces nothing until the handler is read. A helper that sanitizes, escapes or prepares enforces a row only for the form it handles, as its pinned source shows; name the function and the line, not the word sanitize.

## Step 4: read the rows not found

For each row whose enforcement was not found, create /workspace/research/traces/<subsystem>-<short-name>.md and follow the value in both directions, one hop at a time, each hop with its file, function and line, what the value is at that point and what the code does to it there. A line in a listing or in the map is a place to read, not a hop, until it has been read.

- Backward to every producer. From the place that relies on the assumption, list every writer of the store or every caller that supplies the argument, using the map's stores and effects and shared helpers sections and, when present, the matching lines of sinks.tsv and hooks.tsv; for each writer or caller, follow it back to the entry that reaches it and record who reaches that entry as the map's gate column records it, and what that path does to the value on the way. A store written in one subsystem and read in another crosses units: read the other side instead of stopping at the boundary, and add what the map lacked to its Corrections section. A producer that is a visitor's header, a form a visitor submits, a comment, a profile field or data another service delivers counts as a producer like any other.
- Forward to every consumer. From a write or a transformation, follow the result to every place it is rendered into a page, placed by JavaScript, written to a file, used in a query, passed to the file system, included, unserialized or compared, as the map's read-back rows record and as the source shows.
- For a Transformation row, read the code with an input that contains the delimiter it handles: the quote, bracket or tag boundary a regular expression matches, the prefix a placeholder scheme reserves, the separator a serializer counts; record, line by line, what the output becomes.
- For a Proof row, list the fields of the request the handler trusts after the comparison and mark each as covered or not covered by what was signed, hashed or compared; record how the secret is obtained and whether the same value is accepted again.
- For a State row, record the setting, mode or presence the route depends on as the source shows it, with the file and line that reads it. The output contract has a place for a setting a route depends on; a row is not dropped for depending on one.

When the Trial has a Lab and the unit's setup is recorded in /workspace/research/lab-setup.md, a row not found may also be exercised there from the position the row names, after setup is done; record the request sent and what was observed in the trace file beside the hops. An observation shows reach; the row still needs its hops.

## Step 5: settle each row

Under each row, write its state when the read ends, one of three: enforced, with the file and line of the check found while reading; not enforced, with the hop sequence from an entry the map records to the place that relies on the assumption, and who reaches that entry; or open, with the hop not yet read and the reason. Mark any hop inferred rather than read as inferred. A row without a file and a line is not settled.

## Step 6: from a row to a draft

The hops of a row not enforced, entry first and the place that relies on the assumption last, with store, read-back and transformation hops between them, are the sourceTrace of a draft: each carries the file, function and line the output contract asks for. A row with no open hop gives a Finding draft its route; a row with an open hop gives a Lead draft its route, with the missing hop named in the reporting agent's own words. Whether to report it, and as which, is decided under the objective and the output contract. Write the row and its hops either way: a route that exists only in an agent's context is lost.

## Step 7: hand-over and closing

The walk file, the assumptions file and the trace files are the hand-over surface. An agent that continues a unit, or re-reads a row another agent wrote as the closing step of wbh-recon asks, starts from the row and its trace file, reads the map's section and the Corrections section before the source, and appends under the row instead of rewriting it; a note on another agent's row goes under it, dated. An agent that finishes a unit appends a Counts section to the assumptions file: rows by kind, rows by state as enforced, not enforced and open, and the counts of the unit's walk file copied in. The agent that coordinates the Trial reads these counts when it decides whether the work is finished: a unit without a walk file, or whose rows not found have not been read, is open, however many entries it has classified.
```

## 日本語訳（v1 から変わった部分。他の段落は v1 の文書の訳のまま）

front matter の description の末尾に足した 1 文:「各単位は 2 つの agent が 2 回読む。まず全 entry を、それを止める検査か、その値が届く use まで歩き、/workspace/research/walks の下に書く。次に表を、歩きの行から始める」。

冒頭の段落に足した 3 文:「表の前に、同じ単位を歩く。全 entry を要求から、それを止める検査か、その値が届く use まで読む。歩きは名前のある経路を見つけ、表は名前の無い経路を見つける。2 つは別々の agent が行い、どちらの読みも他方の代わりにしない」。

Inputs に足した句:「歩きは /workspace/research/walks の下に単位ごとに 1 file」。

**手順 1 の末尾に足した段落。** 各単位は別々の 2 つの agent が 2 回読む。手順 2 の歩き、次に手順 3〜6 の表である。表を書く agent は、その単位を歩いた agent ではなく、歩きの file から始める。単位にまだ歩きの file が無いとき、表を頼まれた agent はまず歩き、表は別の agent に残す。prior lead の単位では、歩きは lead の経路そのもので、lead が名指す entry の場所から effect の場所まで、表を書く前に読む。

**手順 2: 歩き（新規）。** /workspace/research/walks/<subsystem>.md を作り、単位の全 entry を地図の順に、登録から handler の本体へ、さらに handler が要求の値を渡して呼ぶすべての関数の中へと読む。止まるのは 2 つの点のどちらかである。要求が検査で止まる点か、要求から来た値が use に届く点。use とは、query、path や file の操作、ページや応答への出力、include、redirect、header、比較、保存先への書き込み、別のサービスへの呼び出しである。entry ごとに 1 行を書く。地図が名指す entry、届いた点の file・関数・行、2 つの点のどちらか、そこに届いた各要求の値と、途中でコードがそれに何をしたか（hop ごとに file と行）。名前、登録、comment から読んだ handler は歩いていない。値が helper に渡されたら、helper の固定ソースを開いて、その形の値に何をするかを記録する。名前の中の sanitize や validate の語は hop ではない。値が保存先への書き込みに届いたら、保存先を記録してそこで止める。読み戻し側は手順 3 の Store の行に属する。

entry と use の間に検査が無いまま、または歩きが読んで覆っていないと分かった検査のまま値が use に届いた行は経路である。歩きの file の Routes 見出しの下に、entry を先頭、use を最後にして、すべての hop を手順 6 の形で書く。歩きは単位の全 entry に行ができたら終わる。そして歩きの file に Counts 節を追記する。検査まで歩いた entry、use まで歩いた entry、理由付きで歩いていない entry、書いた経路の数。

**手順 3（旧 2）の冒頭に足した 3 文。** 単位の歩きの file を先に読む。歩きが記録した検査は、それが覆う行の enforced at の欄を埋める。歩きが記録した use は、Store、Transformation、Proof の行が頼る場所である。歩きが書いた経路はすでに not enforced の行で、hop を歩きの file に置いたまま表に入る。（続く本文は v1 の手順 2 と同じ。）

本文中の参照 1 か所:「not found は結論ではない。手順 4 で読む行である」。

**手順 7（旧 6）の変更。**「歩きの file、仮定の file、trace file が引き継ぎの面である」。Counts 節は「種類ごとの行数、enforced / not enforced / open の状態ごとの行数、そして単位の歩きの file の数を写したもの」。調整役の読み方は「歩きの file が無い単位、または not found の行が読まれていない単位は、entry をいくつ分類していても open である」。

## 出典対照表（足した要素だけ。v1 から引き継いだ要素は v1 の文書の表）

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 全 entry を「検査で止まる」か「値が use に届く」まで読み、file と行を記録する | 手順 2 | `wbh-recon-v3` 手順 9 の (1)「its handler has been read to the point where the request is stopped by a check or reaches its effect, with the file and line of that point recorded」。bench h31 で失った直接 sink 型 5 件と Lead に下がった 3 件（#791「背景」） |
| use の列挙（query、file 操作、出力、include、redirect、header、比較、保存先への書き込み、別サービスへの呼び出し） | 手順 2 | `wbh-recon-v3` 手順 5・6（stores and effects、read-back、JavaScript boundary）、`wbh-tools-v1` の sink の一覧が扱う呼び出しの種類、v1 手順 3 の読み手側の列挙 |
| 2 pass は別々の agent。表は歩いた agent とは別の agent | 手順 1・2 | `wbh-recon-v3` 手順 9 の (2)「read a second time by an agent other than the one that wrote it」。所有者の問い 2026-11-02「両方をスキルに分けて子のエージェントを増やす？」への AI の提案（本セッション）を所有者が「改善して」で採った |
| 名前、登録、comment から読んだ handler は歩いていない。helper は本体を開く | 手順 2 | `wbh-recon-v3` 手順 9 の (1)「A row classified from its registration or from the handler's name alone is still open」、v1 手順 2 末尾 |
| 保存先への書き込みで止め、読み戻し側は Store の行へ | 手順 2 | v1 手順 2 の Store の行の定義（読み戻す各場所で読み手が何を仮定しているか） |
| 検査なしに届いた行は Routes として hop 付きで書く | 手順 2 | v1 手順 5（hop の列が `sourceTrace`。経路は agent の文脈にしか無ければ失われる） |
| 歩きの Counts（検査まで / use まで / 未歩き / 経路）と、調整役が歩きの file の無い単位を open と読む | 手順 2・7 | `wbh-recon-v3` 手順 9「The Trial ends when the research files show that nothing readable is left open, not when the rows of a listing have been counted」 |
| prior lead の単位は lead の経路そのものを歩く | 手順 1 | ADR 0044（Prior leads 節は entry の場所と effect の場所を渡す）、v1 手順 1 |

## 書かなかったもの（規則どおり）

- 歩きに掛ける時間や entry 数の上限、子の数、2 pass の順序を強制する仕組み: Harness は `maxChildren` と制限時間だけを強制する（AGENTS.md「Harness と AI の責務」、ADR 0039 追記 3・4）。Root が子の数と順序を決める。
- 「直接 sink 型」「最適化系」のような形の名前、脆弱性の語、判定の基準: ADR 0043 の本文の規則。本文は読む手順と記録の形だけを言う。
- 対象固有の名前、bench の答え、公開記録: 不変条件 1。
- 目的文の変更: v21-wide は触らない（ADR 0045 第 5 項）。CLI が description を一覧し、`wbh-recon` の手順 8 が単位を渡すので、名指しが無くても読まれる。
