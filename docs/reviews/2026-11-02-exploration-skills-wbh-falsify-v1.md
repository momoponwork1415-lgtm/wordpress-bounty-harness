# 探索スキル wbh-falsify v1 の全文・日本語訳・出典対照表（2026-11-02）

[Issue #786](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/786)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-02 追記 5、[ADR 0045](../adr/0045-frozen-core-and-three-exploration-forces.md) の 2026-11-02 追記 3。所有者が 2026-11-02 に「推奨で」と選んだ案 A（形ごとの対策ではなく、1 つの読み方の変更でまとめて狙う）の実装である。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-falsify-v1/SKILL.md`（支援 file なし）
- digest: `sha256:724b71ff23bff049b8f842dd29ace1ac94f19994e103c7a5022d57f9f0efe5fe`
- registry: `wbh-falsify-v1`（name `wbh-falsify`、status `current`）
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v3", "wbh-tools-v1", "wbh-setup-v1", "wbh-falsify-v1"] }`。地図を前提にするので `wbh-recon-v3` と一緒に名指しする（measurement.md 5b）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-falsify/SKILL.md`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-falsify/SKILL.md`

## 何を変えるか（数字）

bench h30（#726、2026-11-02）の外れ 35 記録の形は、最終 HTML を書き換える最適化系 12、訪問者の値が管理画面や JavaScript の表で描画される 12、署名・token・権限の論理 9、保存→再利用の形の崩れ 3、連結 SQL の Lead 止まり 2。当たった 69 記録は「要求の値が handler の中で直接 sink に届く」形だった。本番の Lead の `missingEdge` は producer が Lead 入力 Trial で 124 / 168、v21 第 1 Trial で 86 / 128。いまの agent は「sink はどこか」を探す。外れた形に共通するのは、sink ではなく「コードが暗黙に頼っている仮定が破れている」ことなので、仮定を表にして強制されていない行を読む手順を 1 本にした。

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-falsify
description: Use after the map exists, when an agent takes one subsystem of the plugin's pinned source to read in depth, and for each prior lead when the Trial states a Prior leads section. Writes, for that unit, a table of what its code assumes about who reaches it, what the values it reads are, who writes each store it reads back, what each rewrite or parse of text preserves and what each signature or token covers, with the file and line where the source enforces each assumption or "not found"; then reads every "not found" row hop by hop, backward to every writer and forward to every reader, under /workspace/research/traces, and leaves the file, function and line rows a Finding or Lead draft needs for its sourceTrace.
---

# wbh-falsify v1

A reader who looks for the place where a value is used finds the places that have a name: a query, a file operation, an output call. A plugin also fails in places that have no such name, where its code relies on something it never checks: that only one role writes a store another screen renders; that a signature covers every field the handler later trusts; that a rewrite of the finished page keeps the boundaries of the markup it rewrites; that a value comes back from storage in the shape it went in. This skill describes how to write those assumptions down for one unit of the plugin, how to find where the source enforces each one, and how to read the rows it does not enforce through to the rows a Finding or Lead draft needs. It does not say which assumptions matter, which routes to report, or what is in scope. The objective, the trust boundary and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial. The map is /workspace/research/recon-map.md, with its Entries tables, Wrappers table, shared gate functions, shared helpers, stores and effects, JavaScript boundary and Corrections section. When the listings from wbh-tools exist, /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv are there too; when the Trial has a Lab, /workspace/research/lab-setup.md records what was built in it. Assumption tables go under /workspace/research/assumptions, one file per unit; traces go under /workspace/research/traces, one file per row read.

## Step 1: the unit

A unit is one subsystem of the map with its entries, gate, shared helpers, stores, read-backs and JavaScript boundary, as Step 8 of wbh-recon hands it over. Read the map's section for the unit, the Wrappers table, the shared gate functions and the Corrections section before opening the source. When the Trial states a `## Prior leads` section, each prior lead is a unit of its own, made of the subsystem that holds its entry place and the subsystem that holds its effect place; take those units first, and start their tables from the two places the lead names and the sentence it stated. A place the map lacks goes into the Corrections section first, so the next agent finds it.

## Step 2: write the assumptions

Create /workspace/research/assumptions/<subsystem>.md and write one row per assumption the unit's code relies on, reading the bodies of the functions rather than their names, comments or option names. Write rows of these kinds:

- Reach: who the code assumes reaches each entry, and by what: a role or capability, a login, a nonce or token, a referer or origin, a request address, a secret carried in the request, or nothing.
- Value: what a handler assumes about each value it reads from the request: its type and shape, that it is one of a listed set, that it names an object the caller owns or may see, that it is a path, a URL or an identifier of a particular form.
- Store: for each store the unit writes or reads (an option, post or user meta, a custom table, a transient, a file, data held by another service), who the code assumes can write it and in what form; and at each place it is read back, what the reader assumes about the content: already escaped, already validated, the same shape and type as written, written by the same role that reads it.
- Transformation: for each place the code rewrites, parses, splits, decodes, re-encodes, serializes or unserializes text or data (a filter on the output buffer, a minifier, a placeholder scheme that reserves and restores blocks, a regular expression over markup or over a query, a serializer, a template engine), what it assumes the input looks like and what it assumes the output preserves: attribute and tag boundaries, quoting, the match between a placeholder and the block it stood for, the length and type of fields, the meaning of a delimiter.
- Proof: for each signature, hash, token, nonce, key or password comparison, which fields of the request it covers and which it leaves out, how the comparison is made, what it assumes about who holds the secret, and whether a value can be presented twice.
- State: what the code assumes about the site or the order of steps: a setting enabled, another plugin or a service present, a licence or mode, a step completed before this one runs, a file or record already present.

Each row has the assumption in one sentence, the file and line where the code relies on it, and a column named enforced at: the file and line of the check or construction that makes the assumption hold, or the words not found. Not found is not a conclusion. It is the row to read in Step 3. A check in a shared registration wrapper enforces a row for every entry behind the wrapper; a check inside one handler enforces it for that handler only; a check that the handler is left to make enforces nothing until the handler is read. A helper that sanitizes, escapes or prepares enforces a row only for the form it handles, as its pinned source shows; name the function and the line, not the word sanitize.

## Step 3: read the rows not found

For each row whose enforcement was not found, create /workspace/research/traces/<subsystem>-<short-name>.md and follow the value in both directions, one hop at a time, each hop with its file, function and line, what the value is at that point and what the code does to it there. A line in a listing or in the map is a place to read, not a hop, until it has been read.

- Backward to every producer. From the place that relies on the assumption, list every writer of the store or every caller that supplies the argument, using the map's stores and effects and shared helpers sections and, when present, the matching lines of sinks.tsv and hooks.tsv; for each writer or caller, follow it back to the entry that reaches it and record who reaches that entry as the map's gate column records it, and what that path does to the value on the way. A store written in one subsystem and read in another crosses units: read the other side instead of stopping at the boundary, and add what the map lacked to its Corrections section. A producer that is a visitor's header, a form a visitor submits, a comment, a profile field or data another service delivers counts as a producer like any other.
- Forward to every consumer. From a write or a transformation, follow the result to every place it is rendered into a page, placed by JavaScript, written to a file, used in a query, passed to the file system, included, unserialized or compared, as the map's read-back rows record and as the source shows.
- For a Transformation row, read the code with an input that contains the delimiter it handles: the quote, bracket or tag boundary a regular expression matches, the prefix a placeholder scheme reserves, the separator a serializer counts; record, line by line, what the output becomes.
- For a Proof row, list the fields of the request the handler trusts after the comparison and mark each as covered or not covered by what was signed, hashed or compared; record how the secret is obtained and whether the same value is accepted again.
- For a State row, record the setting, mode or presence the route depends on as the source shows it, with the file and line that reads it. The output contract has a place for a setting a route depends on; a row is not dropped for depending on one.

When the Trial has a Lab and the unit's setup is recorded in /workspace/research/lab-setup.md, a row not found may also be exercised there from the position the row names, after setup is done; record the request sent and what was observed in the trace file beside the hops. An observation shows reach; the row still needs its hops.

## Step 4: settle each row

Under each row, write its state when the read ends, one of three: enforced, with the file and line of the check found while reading; not enforced, with the hop sequence from an entry the map records to the place that relies on the assumption, and who reaches that entry; or open, with the hop not yet read and the reason. Mark any hop inferred rather than read as inferred. A row without a file and a line is not settled.

## Step 5: from a row to a draft

The hops of a row not enforced, entry first and the place that relies on the assumption last, with store, read-back and transformation hops between them, are the sourceTrace of a draft: each carries the file, function and line the output contract asks for. A row with no open hop gives a Finding draft its route; a row with an open hop gives a Lead draft its route, with the missing hop named in the reporting agent's own words. Whether to report it, and as which, is decided under the objective and the output contract. Write the row and its hops either way: a route that exists only in an agent's context is lost.

## Step 6: hand-over and closing

The assumptions file and the trace files are the hand-over surface. An agent that continues a unit, or re-reads a row another agent wrote as the closing step of wbh-recon asks, starts from the row and its trace file, reads the map's section and the Corrections section before the source, and appends under the row instead of rewriting it; a note on another agent's row goes under it, dated. An agent that finishes a unit appends a Counts section to the assumptions file: rows by kind, and rows by state as enforced, not enforced and open. The agent that coordinates the Trial reads these counts when it decides whether the work is finished: a unit whose rows not found have not been read is open, however many entries it has classified.
```

## 日本語訳

front matter: name `wbh-falsify`。description「地図ができた後、agent がプラグインの固定ソースの 1 つの subsystem を深く読むために取るとき、また Trial が Prior leads 節を述べているときはその lead ごとに使う。その単位について、コードが『誰が届くか』『読む値は何か』『読み戻す保存先に誰が書くか』『文章の書き換えや parse は何を保つか』『署名や token は何を覆うか』について何を仮定しているかの表を、source がそれを強制している file と行、無ければ "not found" とともに書く。次に "not found" の行をすべて、書き手側へ遡り読み手側へ進んで 1 hop ずつ /workspace/research/traces の下に読み、Finding か Lead の下書きが `sourceTrace` に要る file・function・行の行を残す」。

### wbh-falsify v1

値が使われる場所を探す読み手は、名前のある場所を見つける。query、file 操作、出力の呼び出しである。プラグインは、そういう名前の無い場所でも壊れる。コードが一度も確かめないことに頼っている場所である。別の画面が描画する保存先に書くのは 1 つの役割だけだ、という仮定。署名は handler が後で信じるすべての欄を覆っている、という仮定。出来上がったページの書き換えは、書き換える markup の境界を保つ、という仮定。値は保存に入れたときの形で戻ってくる、という仮定。このスキルは、プラグインの 1 単位についてそれらの仮定を書き出す方法、source がそれぞれをどこで強制しているかを見つける方法、強制されていない行を Finding か Lead の下書きが要る行まで読み通す方法を述べる。どの仮定が大事か、どの経路を報告するか、何が対象範囲内かは言わない。目的文、trust 境界、出力契約がそれを言う。

**Inputs。** 固定したプラグインソースは /workspace/main にある。固定した WordPress 本体のソースは、供給されていれば /workspace/wordpress に、他のプラグインや library のソースは /workspace/dependencies/<slug> の下にある。本体、framework、library が何をするかは、記憶ではなく供給されたソースを読む。研究 directory /workspace/research は書き込めて、Trial のすべての agent が共有する。地図は /workspace/research/recon-map.md で、Entries 表、Wrappers 表、共有の門の関数、共有 helper、保存先と効果、JavaScript 境界、Corrections 節を持つ。wbh-tools の一覧があれば /workspace/research/tools/hooks.tsv と sinks.tsv もそこにある。Trial に Lab があれば /workspace/research/lab-setup.md がそこで作ったものを記録している。仮定の表は /workspace/research/assumptions の下に単位ごとに 1 file、trace は /workspace/research/traces の下に読んだ行ごとに 1 file。

**手順 1: 単位。** 単位は、地図の 1 つの subsystem と、その entry、門、共有 helper、保存先、読み戻し、JavaScript 境界で、wbh-recon の手順 8 が渡すものである。source を開く前に、その単位の地図の節、Wrappers 表、共有の門の関数、Corrections 節を読む。Trial が `## Prior leads` 節を述べているときは、各 prior lead がそれ自体で 1 単位になる。その lead の entry の場所を持つ subsystem と effect の場所を持つ subsystem から成る。これらの単位を先に取り、その表を lead が名指した 2 つの場所と lead が述べた文から始める。地図に無い場所は先に Corrections 節に入れ、次の agent が見つけられるようにする。

**手順 2: 仮定を書く。** /workspace/research/assumptions/<subsystem>.md を作り、単位のコードが頼っている仮定 1 つにつき 1 行を書く。関数の名前、comment、option 名ではなく本体を読む。行の種類は次のとおり。

- Reach: 各 entry に誰が届くとコードが仮定しているか、何によってか。役割か capability、ログイン、nonce か token、referer か origin、要求元の address、要求に載る秘密、または何も無い。
- Value: handler が要求から読む各値について何を仮定しているか。型と形、列挙された集合の 1 つであること、呼び出し元が所有するか見てよい object を名指すこと、特定の形の path、URL、識別子であること。
- Store: 単位が書くか読む各保存先（option、post や user の meta、custom table、transient、file、別のサービスが持つ data）について、誰がどんな形で書けるとコードが仮定しているか。読み戻す各場所で、読み手が内容について何を仮定しているか。escape 済み、validation 済み、書いたときと同じ形と型、読む役割と同じ役割が書いた。
- Transformation: コードが文章や data を書き換え、parse し、分割し、decode し、再 encode し、serialize し、unserialize する各場所（出力バッファの filter、minifier、ブロックを退避して復元する placeholder の仕組み、markup や query に掛ける正規表現、serializer、template engine）について、入力がどう見えると仮定し、出力が何を保つと仮定しているか。属性とタグの境界、引用、placeholder と元のブロックの対応、欄の長さと型、区切り文字の意味。
- Proof: 署名、hash、token、nonce、鍵、password の各比較について、要求のどの欄を覆い、どの欄を外しているか、比較はどう行われるか、秘密を持つ者について何を仮定しているか、同じ値を 2 度出せるか。
- State: site や手順の順序についてコードが何を仮定しているか。設定が有効、別のプラグインやサービスがある、licence や mode、この処理の前にある段が終わっている、file や record がすでにある。

各行は、仮定を 1 文で、コードがそれに頼っている file と行、そして「enforced at」の列を持つ。仮定を成り立たせる検査か構成の file と行、または「not found」の語である。not found は結論ではない。手順 3 で読む行である。共有の登録 wrapper の中の検査は wrapper の後ろのすべての entry について行を強制し、1 つの handler の中の検査はその handler についてだけ強制し、handler に任された検査は handler を読むまで何も強制しない。サニタイズ、escape、prepare をする helper は、その固定ソースが示す形についてだけ行を強制する。sanitize という語ではなく、関数と行を名指す。

**手順 3: not found の行を読む。** 強制が見つからなかった各行について /workspace/research/traces/<subsystem>-<short-name>.md を作り、値を両方向に 1 hop ずつ追う。各 hop に file、function、行、その時点の値、そこでコードが値に何をするかを書く。一覧や地図の 1 行は、読むまでは hop ではなく読む場所である。

- 書き手側へ遡る。仮定に頼っている場所から、保存先のすべての書き手、または引数を供給するすべての呼び出し元を、地図の保存先と効果の節、共有 helper の節、あれば sinks.tsv と hooks.tsv の該当行を使って並べる。各書き手・呼び出し元について、それに届く entry まで遡り、その entry に誰が届くかを地図の門の列のとおりに記録し、その経路が途中で値に何をするかも記録する。ある subsystem で書かれ別の subsystem で読まれる保存先は単位をまたぐ。境界で止まらず反対側を読み、地図に無かったものを Corrections 節に足す。訪問者のヘッダ、訪問者が送るフォーム、comment、profile の欄、別のサービスが届ける data も、他と同じく書き手に数える。
- 読み手側へ進む。書き込みや変換から、その結果がページに描画される、JavaScript が置く、file に書かれる、query に使われる、file system に渡る、include される、unserialize される、比較される、すべての場所へ、地図の読み戻しの行と source の示すとおりに追う。
- Transformation の行では、それが扱う区切りを含む入力でコードを読む。正規表現が合わせる引用符、括弧、タグの境界。placeholder の仕組みが退避する接頭辞。serializer が数える区切り。出力が何になるかを行ごとに記録する。
- Proof の行では、比較の後に handler が信じる要求の欄を並べ、署名・hash・比較の対象に覆われているか否かを欄ごとに印を付ける。秘密をどう得るか、同じ値が再び受け付けられるかを記録する。
- State の行では、経路が依存する設定、mode、存在を source の示すとおりに、それを読む file と行とともに記録する。出力契約には経路が依存する設定を書く場所がある。設定に依存することを理由に行を落とさない。

Trial に Lab があり、単位の setup が /workspace/research/lab-setup.md に記録されているなら、not found の行は setup 完了後に、その行が名指す位置から Lab で試してもよい。送った要求と観測したことを trace file の hop の横に記録する。観測は到達を示す。行にはそれでも hop が要る。

**手順 4: 各行を決着させる。** 各行の下に、読み終えたときの状態を 3 つのうち 1 つで書く。enforced: 読んでいる間に見つけた検査の file と行とともに。not enforced: 地図が記録する entry から仮定に頼っている場所までの hop の列と、その entry に誰が届くかとともに。open: まだ読んでいない hop と理由とともに。読まずに推測した hop は推測と印を付ける。file と行の無い行は決着していない。

**手順 5: 行から下書きへ。** not enforced の行の hop は、entry を先頭、仮定に頼る場所を最後にし、その間に保存先、読み戻し、変換の hop を挟むと、下書きの `sourceTrace` になる。各 hop が出力契約の求める file、function、行を持つ。open の hop が無い行は Finding の下書きに経路を与え、open の hop がある行は Lead の下書きに経路を与え、欠けた hop を報告する agent 自身の言葉で名指す。報告するか、どちらとしてかは、目的文と出力契約の下で決める。どちらでも行と hop は書く。agent の文脈にしか無い経路は失われる。

**手順 6: 引き継ぎと終了。** 仮定の file と trace file が引き継ぎの面である。単位を続ける agent、または wbh-recon の終了の段が求めるとおり別の agent が書いた行を読み直す agent は、その行と trace file から始め、source より先に地図の節と Corrections 節を読み、行を書き直さずにその下に追記する。別の agent の行への注記はその下に日付付きで置く。単位を終えた agent は仮定の file に Counts 節を追記する。種類ごとの行数と、enforced / not enforced / open の状態ごとの行数である。Trial を調整する agent は、作業が終わったかを決めるときにこの数を読む。not found の行が読まれていない単位は、entry をいくつ分類していても open である。

## 出典対照表

出典は ADR 0043〜0045、既存の探索スキル（`wbh-recon` v3、`wbh-tools` v1、`wbh-setup` v1）、#697 の `wbh-trace` 下書き、bench h30 の外れ分析（#726、#786）、所有者決定の日付に限った。要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| スキル 1 本 1 手順で「反証」を受け持つ。どの仮定が大事か、対象範囲内かは書かない | 冒頭の段落 | ADR 0043「後続は … 反証を、それぞれ 1 本ずつ PR にする」「本文の規則: 手順だけを書く」。所有者決定 2026-11-02「推奨で」（案 A） |
| sink の名前ではなく「コードが頼っている仮定」を読む。4 つの例（保存先の書き手、署名の覆う欄、書き換えが保つ境界、保存の形） | 冒頭の段落、手順 2 の 6 種 | bench h30 の外れ 35 記録の形（#726 の 2026-11-02 comment、#786「背景」）: 最適化系 12、遠い描画先 12、論理 9、保存→再利用 3 |
| 固定ソースの置き場、記憶ではなく供給ソースを読む、/workspace/research の共有 | Inputs | `wbh-recon-v3` Inputs、`wbh-tools-v1` Inputs（同じ文） |
| 地図の節・Wrappers 表・共有の門の関数・Corrections を先に読む。単位は手順 8 の渡し方のまま | Inputs、手順 1 | `wbh-recon-v3` 手順 8「a subsystem with its entries, its shared helpers and its stores is one unit … reads the map before the source」 |
| `## Prior leads` があればその lead を先に取り、2 つの場所と文から始める | 手順 1 | ADR 0044「節に入れるのは … file と関数の名前と … 示せなかったことの一文」。本番の Lead の producer 止まり 124 / 168（#715 の 2026-11-02 comment） |
| 地図に無い場所は先に Corrections に足す。上書きせず追記する | 手順 1・3・6 | `wbh-recon-v3` 手順 7（Corrections 節、他の agent は上書きしない）、`wbh-tools-v1` 手順 3・4 |
| Reach の行: 役割、ログイン、nonce / token、要求元 | 手順 2 | `wbh-recon-v3` 手順 4「capability checks, nonce or token checks, login checks, ownership checks, and where each check sits」 |
| 検査が置かれた場所と覆う範囲（共有 wrapper / handler 内 / handler 任せ） | 手順 2 末尾 | `wbh-recon-v3` 手順 4「A check in a shared registration wrapper covers every entry behind the wrapper; …」 |
| Store の行: option、meta、custom table、transient、file、外部サービスの data。読み戻しの場所 | 手順 2 | `wbh-recon-v3` 手順 5「list what the plugin stores and where … Record where stored values are read back out and rendered」 |
| Transformation の行: 出力バッファの filter、minifier、placeholder、正規表現、serializer、template engine | 手順 2 | bench h30 の最適化系 12 記録と保存→再利用 3 記録（#786「背景」）。`wbh-recon-v3` 手順 5「serialization helpers, and the plugin's own escaping or validation functions」 |
| Proof の行: 署名・token・鍵の比較が覆う欄と覆わない欄、再提出 | 手順 2・3 | bench h30 の論理系 9 記録（#786「背景」）。`wbh-recon-v3` 手順 4「nonce or token checks」 |
| State の行: 設定、別のプラグイン、mode、順序。設定に依存する行を落とさない | 手順 2・3 | 所有者決定 2026-10-26「探索は広く出し、落とすのはレビュー側で行う」（AGENTS.md）。出力契約 v4 の設定の前提の欄（ADR 0038 追記 15。欄の名前は本文に写さない） |
| helper は名前でなく本体で、扱う形についてだけ強制する | 手順 2 末尾 | `wbh-recon-v3` 手順 4「State what you read, not what the plugin's comments or option names claim」、`wbh-trace` 下書き手順 5「Read the body of each function … rather than relying on its name」 |
| 書き手側へ遡る: 保存先の書き手と引数の供給元を全部並べ、各 entry の門を記録する | 手順 3 | `wbh-trace` 下書き手順 3「list every caller that reaches it … follow each caller back to the entries that supply its arguments」。本番 Lead の `missingEdge` producer（#786） |
| 読み手側へ進む: 描画、JavaScript、file、query、include、unserialize、比較 | 手順 3 | `wbh-trace` 下書き手順 2・4（write → read-back、JavaScript が置く最後の hop）、`wbh-recon-v3` 手順 6 |
| 訪問者のヘッダ、フォーム、comment、profile の欄、外部サービスの data も書き手 | 手順 3 | bench h30 の遠い描画先 12 記録（#786）。所有者決定 2026-10-26 の追記「外部サービス由来の経路は本物になり得る」（AGENTS.md、ADR 0046） |
| 一覧の行は読むまでは hop でなく読む場所 | 手順 3 冒頭 | `wbh-tools-v1` 手順 5「A match in either list is a place to read, not a conclusion」、`wbh-trace` 下書き手順 3 |
| Lab での試行は setup 後、行が名指す位置から。観測は到達を示すが hop は要る | 手順 3 末尾 | ADR 0044「Lab を付けるのは、到達性を agent 自身が確かめる場を与えるためで、判定は人間に残す」、`wbh-setup-v1`（lab-setup.md の記録、setup 後に要求を送る） |
| 行の 3 状態（enforced / not enforced / open）、推測に印、file と行の無い行は未決着 | 手順 4 | `wbh-recon-v3` 手順 9 の (2)「決着（file と行）か、供給ソースでは決着できない（足りないもの）」、手順 7「mark anything inferred as inferred」 |
| hop の列が `sourceTrace`。欠けた hop は Lead で名指す。どちらでも書く | 手順 5 | `wbh-trace` 下書き手順 7。契約 v4 が `sourceTrace` に file と行を求める（ADR 0019）。LESSONS 5・10 |
| 引き継ぎは行と trace file から。別の agent の再読は recon 手順 9 の (2) | 手順 6 | `wbh-recon-v3` 手順 8・9、`wbh-trace` 下書き手順 8 |
| Counts 節（種類別・状態別）を調整役が終了判断に読む | 手順 6 | `wbh-recon-v3` 手順 9「The Trial ends when the research files show that nothing readable is left open, not when the rows of a listing have been counted」 |

## 書かなかったもの（規則どおり）

- 型の一覧、判断の基準、脆弱性の語、「この検査があれば安全」のような判定、どの仮定が対象範囲内か: ADR 0043 の本文の規則、契約 v5 / v17 の教訓（ADR 0038 追記 15、ADR 0039 追記 12）。本文は仮定と強制を「記録する」とだけ言い、効くかどうかは言わない。
- `missingEdge`、`configurationPrecondition` などの欄の名前（`sourceTrace` を除く）: 出力契約は Harness が生成する節にある（ADR 0019）。
- 最低時間、子の数、行数や hop 数の上限: Harness が Run parameters で強制するか、目的文が言う（ADR 0039 追記 3・4）。
- 対象固有の名前、再現の手順、公開履歴の個別記録: 不変条件 1。bench の答えの中身は Git の外にあり、本文にも対照表にも写していない。
- 目的文の変更: v21-wide の routing 段落は 3 つのスキルを名指すが、足さない（ADR 0045 第 5 項「消す方向にしか触らない」）。CLI が description を一覧し、`wbh-recon` の手順 8・9 が単位と再読を渡すので、名指しが無くても読まれる。
