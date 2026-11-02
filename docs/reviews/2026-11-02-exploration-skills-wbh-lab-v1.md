# 探索スキル wbh-lab v1 の全文・日本語訳・出典対照表（2026-11-02）

[Issue #793](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/793) の決定 E、[ADR 0049](../adr/0049-lab-resident-exploration.md) の 2026-11-02 追記、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-02 追記 7。設計と事実は [2026-11-02-lab-resident-exploration-design.html](2026-11-02-lab-resident-exploration-design.html)（所有者「これでいこう」、2026-11-02）。agent に渡る文章の規則（DEVELOPMENT 第 5 節）に従い、全文、日本語訳、出典対照表を置く。本文は手順だけで、型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数は書いていない（test `tests/profiles/wordpress/skill-definitions.test.ts` で固定）。

このスキルは、Lab 付きの Trial で、ソースの読みが「この値はどこに保存されるか」「この要求は何を走らせるか」で止まったとき、Lab の Find / Query / Trace / Observe をどの順に、どの行のために使い、答えをどこに書くかを決める手順である。bench h34（Lab の find/sql/trace を付けた 6 対象）と本番（2026-11-02 再開後）では、道具はあるのに Trial あたりの使用が 1〜10 回・0〜3 回で、Root は 11〜47 分で閉じた。`## Lab` 節は命令の形だけを書き、どのスキルも Lab に触れていなかった。Harness は命令と予算と記録を持つだけで、どの行に使うかは言わない（AGENTS.md「Harness と AI の責務」）。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-lab-v1/SKILL.md`（支援 file なし）
- digest: `sha256:58548360a44e53b3e1049f7214eee411679ed6c86ffde6771e99c0f6dd5e6f35`
- registry: `src/profiles/wordpress/prompts/skills.ts` の `wbh-lab-v1`（name `wbh-lab`、status `current`）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-lab/`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-lab/`
- 有効化: campaign 設定 `"discovery": { "lab": { "mode": "attached", ... }, "skills": ["wbh-recon-v3", "wbh-tools-v1", "wbh-setup-v1", "wbh-lab-v1"] }`。Lab の無い Trial では `## Lab` 節が無いので使われない

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-lab
description: Use when the Trial has a Lab (the ## Lab section names a site and Find, Query, Trace and Observe commands), after the setup record exists, whenever a reading of the pinned source stops at a question the running site can answer: where a request value is stored, in what form it comes back, which functions a request ran, what a page shows to a role. Plants a marker through the site's ordinary use, finds where it landed, traces the request that carried it, observes the page that reads it back, and records each answer in /workspace/research/lab-facts.md and under the row it settles. Use it once more before the final report, to take every open row the Lab can still answer through the same steps.
---

# wbh-lab v1

A reading of the source that stops at "where does this value go" or "what runs when this request arrives" has stopped at a question the Lab answers in one request. The site in the Lab is the plugin as a site runs it, built by wbh-setup; a value sent through its ordinary use lands in a table, a column, a file or nowhere, and the Lab's Find command says which. The same request, sent with Trace, lists the plugin functions it ran, in order, with file and line. This skill describes how to turn an open hop in the research files into one marked request, how to read the Lab's answers back into the row that was open, and how to record each use so that no agent asks the Lab the same question twice. It does not say which rows matter or what a landing means. The objective, the trust boundary and the output contract say that.

## Inputs

The Trial's `## Lab` section names the site address, the accounts and their roles, and five commands: Reset, Observe, Find, Query and Trace, each with the body it takes and the budget it shares; read that section before the first command, and send the bodies exactly as it describes them. The pinned plugin source is at /workspace/main. The research directory /workspace/research is writable and shared by every agent in the Trial. The map is /workspace/research/recon-map.md, with its Entries tables, Stores and effects section and JavaScript boundary; the setup record is /workspace/research/lab-setup.md, with its Objects table, Settings changed section and Content section; when wbh-falsify was used, the walk files under /workspace/research/walks hold the entries read to a check or a use with their hops, and the assumption tables under /workspace/research/assumptions hold the Store and Transformation rows with their enforced at column. When the Trial states a Prior research section, /workspace/research/prior/stores.json lists the stores an earlier Trial's Lab found for this plugin; read it before planting a marker for a store it already names. The Lab facts file /workspace/research/lab-facts.md is this skill's record and lives beside the map.

## Step 1: the question

Take one open row: a walk row whose value reaches a store write and stops there, a Store row or a Transformation row whose enforced at column says not found, a route whose next hop the source does not show, a map entry whose handler stores or renders a value the reader could not follow, or a Lead draft whose missing hop is a store, a read-back or a function the source did not name. Write the question in one sentence of the form "value X, sent as role R to entry E, is stored where and read back where" or "request to entry E as role R runs which functions". A question that names no entry, no role and no value is not ready for the Lab; read the source until it does. Check lab-facts.md and prior/stores.json for the same entry and parameter: a marker already planted for them answers the question without a new command.

## Step 2: plant a marker

Make one marker for the question: a string of digits of the length the Observe command's dialogMarker accepts, not starting with 0, new for this Trial. Write the row in lab-facts.md first, with the marker, the question, the entry, the role and the parameter, so that the marker is recorded even if the request fails. Then send the value through the site's ordinary use, from the position the question names: as a visitor or the low-privilege account through the published page the Objects table names for the entry, with the form fields the page shows, or through the entry's own request as the map records it, with the marker as the value of the parameter in question. The administrator account is used only when the row's question is about what an administrator writes. A page whose form is built by JavaScript is filled through Observe with fill and click actions as the role, and the answer's status is the first fact of the row. Send the same marker once; a second send is a new row.

## Step 3: find the store

Send Find with the marker. The answer lists the tables and columns whose rows hold the marker, with key values, and the files under wp-content that contain it. Write each as a Store fact under the row: table and column, or file path, and the key values; this is the producer side of the store the walk stopped at, and the row's who-writes-it column now has a fact for the role that sent it. Then send Query with one SELECT on that table and column, narrowed by the key values, to read the stored form: whether the marker is stored as sent, inside a serialized or JSON value, inside markup, truncated, or changed; write the stored form beside the Store fact, with the exact text around the marker. A marker that Find does not report is written as not found in this search, with the request's status; it is an absence, and the row stays open until the source shows why.

## Step 4: trace the request

Send Trace with the same request: the entry's method and path, the role's cookie when the entry needs a login, the content type and the body with the marker, as the `## Lab` section's Trace command takes them. The answer is the plugin functions the request ran, in call order, with depth, file and line. Lay it beside the hops of the walk row or the route: a function the trace shows that the hops lack is a hop to read, open it at the file and line the trace gives and add it to the row; a function the hops name that the trace lacks did not run for this request and this role, so the hop is marked as not reached for this role with the trace as the reason. The trace shows one request as sent; a branch the request did not take is not in it, and the source still decides what the other branch does. When the stored form from Step 3 differs from the value sent, the function between the entry and the store write that changed it is in the trace; name it in the Transformation row with its file and line.

## Step 5: trace and observe the read-back

For each place the map's Stores and effects section says the store is read back, send Trace to the request that renders it, as the role the map says sees it: the public page, the admin screen, the feed, the response JavaScript renders. The functions between the read and the output are the consumer side of the row; write them under the row with file and line, and name the function that escapes, decodes or rewrites the stored value on the way, or write that none appears between the read and the output. Then send Observe to the same page as that role; a page an administrator sees is observed as the administrator, a public page as a visitor. The answer's status, whether a dialog opened, and, with the marker as dialogMarker, whether an alert with that exact text opened, go under the row as the observation, and into labObservations of the Finding or Lead that reports the row, in the words the `## Lab` section uses: an observation, not a confirmation.

## Step 6: record

Keep lab-facts.md as one table with columns marker, question, entry, role, parameter, request status, stores found as table.column or path with key values, stored form, trace file written, read-back pages observed with status and dialog, and the row it settles with its file. Write a line the moment a command returns, not at the end. Save each Trace answer to /workspace/research/lab-traces/<entry-short-name>-<marker>.md with the request as sent and the function list as returned, so that another agent reads the trace instead of sending it again. Under the row in the walk file, the assumptions table or the route, append a Lab line with the date, the marker and the lab-facts.md row; do not rewrite the row's own text. A fact the Lab gave replaces the words not found only when the file and line of the function the trace named have been opened in the source and read.

## Step 7: budget and reset

Find, Query and Trace share one budget and Observe has its own; each answer states how many are used, and the `## Lab` section states the limits. Spend the shared budget in the order Find, Query, Trace for a storing question and Trace alone for a function question; a question with a marker already in lab-facts.md costs nothing. Agents working in parallel read lab-facts.md before each command, so that two agents do not plant markers for the same entry and parameter. Reset only when the site state built by wbh-setup is gone or the plugin refuses further requests; after a reset, markers planted before it are no longer in the site, and the Objects table is rebuilt as wbh-setup's Step 5 says before a new marker is planted.

## Step 8: hand-over

When handing a unit to another agent, name the lab-facts.md rows and the lab-traces files that belong to its entries, beside the map's section and its rows of lab-setup.md. A child that reads them knows which stores its entries write, which markers are already in the site and which pages render them, before it reads the source. An agent that finds a row's Lab line wrong sends the commands again with a new marker and appends the correction, dated, under the row.

## Step 9: before the final report

Before the final report, the agent that coordinates the Trial reads the open rows of the research files, the Lead drafts, and lab-facts.md, and lists every row whose open hop is a storing, a read-back or a function question in the Step 1 form. While the shared budget and the observe budget the `## Lab` section states are not used up, each such row goes through Steps 2 to 6 before the report is written. A row that remains open after the Lab answered keeps the answer under it, and its Lead names the hop the source still does not show. A row left without a Lab answer states why in its Lead's labObservations: the budget was used up, the entry needs an outside service, the setup record has no page for it, or the request was refused by the site, with the status. Append to the Closing section the counts: markers planted, markers found, markers not found, traces sent, read-backs observed, rows settled by a Lab fact, and rows left open with the Lab unused.
```

## 日本語訳

front matter: name `wbh-lab`。description「Trial に Lab があるとき（`## Lab` 節が site と Find、Query、Trace、Observe の命令を名指ししているとき）、setup の記録ができた後、固定ソースの読みが、動いている site なら答えられる問いで止まるたびに使う。要求の値がどこに保存されるか、どんな形で戻ってくるか、要求がどの関数を走らせたか、ある role にページが何を見せるか。site の普通の使い方を通して marker を植え、どこに落ちたかを見つけ、それを運んだ要求を trace し、読み戻すページを observe し、答えを /workspace/research/lab-facts.md と、決着した行の下に記録する。最終報告の前にもう一度使い、Lab がまだ答えられる open の行をすべて同じ手順に通す。」

### wbh-lab v1

「この値はどこへ行くか」「この要求が来たら何が走るか」で止まったソースの読みは、Lab が要求 1 回で答える問いで止まっている。Lab の site は wbh-setup が作った、site が動かしている姿の plugin であり、普通の使い方で送った値は表、列、file のどれかに落ちるか、どこにも落ちない。Lab の Find 命令がそのどれかを言う。同じ要求を Trace で送れば、走った plugin の関数が file と行付きで順に並ぶ。このスキルは、研究 file の open の hop を 1 回の印付き要求に変える方法、Lab の答えを open だった行に読み戻す方法、どの agent も同じ問いを Lab に 2 度しないように使用を記録する方法を書く。どの行が大事か、落ちたことが何を意味するかは書かない。それは目的文、trust 境界、出力契約が言う。

**Inputs。** Trial の `## Lab` 節が、site の address、account と role、5 つの命令 Reset、Observe、Find、Query、Trace を、それぞれが取る body と共有する予算とともに名指ししている。最初の命令の前にその節を読み、body はそこに書いてあるとおりに送る。固定した plugin のソースは /workspace/main。/workspace/research は書き込み可で Trial の全 agent が共有する。地図は /workspace/research/recon-map.md（Entries 表、Stores and effects 節、JavaScript boundary）。setup の記録は /workspace/research/lab-setup.md（Objects 表、Settings changed 節、Content 節）。wbh-falsify を使ったときは、/workspace/research/walks の歩き file が entry を check か use まで読んだ hop を、/workspace/research/assumptions の仮定の表が Store 行と Transformation 行を enforced at 列付きで持つ。Trial に Prior research 節があるときは、/workspace/research/prior/stores.json に前の Trial の Lab がこの plugin で見つけた保存先がある。そこに載っている保存先に marker を植える前にそれを読む。Lab facts file /workspace/research/lab-facts.md がこのスキルの記録で、地図の隣に置く。

**手順 1: 問い。** open の行を 1 つ取る。値が store への書き込みに届いてそこで止まった歩きの行、enforced at が not found の Store 行か Transformation 行、次の hop をソースが示さない route、handler が値を保存するか描画するのに読み手が追えなかった地図の entry、欠けている hop が store か読み戻しかソースが名を示さない関数である Lead の下書き。問いを 1 文で書く。「値 X を role R として entry E に送ると、どこに保存され、どこで読み戻されるか」か「role R として entry E への要求はどの関数を走らせるか」の形。entry、role、値のどれかを名指せない問いはまだ Lab 向きではない。名指せるまでソースを読む。同じ entry と parameter について lab-facts.md と prior/stores.json を見る。すでに植えてある marker があれば、新しい命令なしで問いに答える。

**手順 2: marker を植える。** 問いに 1 つ marker を作る。Observe 命令の dialogMarker が受ける長さの数字列で、0 で始まらず、この Trial で新しいもの。要求が失敗しても marker が記録に残るように、先に lab-facts.md に marker、問い、entry、role、parameter の行を書く。それから、問いが名指す位置から、site の普通の使い方を通して値を送る。訪問者か低権限 account として、Objects 表がその entry について名指す公開ページから、そのページが見せるフォーム欄で。または地図が記録する entry 自身の要求で、問いの parameter の値を marker にして。管理者 account を使うのは、行の問いが管理者の書くものについてのときだけ。JavaScript が組み立てるフォームのページは、その role で Observe の fill と click の action で埋め、答えの status が行の最初の事実になる。同じ marker は 1 回だけ送る。2 回目の送信は新しい行。

**手順 3: 保存先を見つける。** marker で Find を送る。答えは marker を持つ行のある表と列を key の値付きで、wp-content 以下で marker を含む file を列挙する。それぞれを行の下に Store の事実として書く。表と列、または file の path と key の値。これが歩きの止まった store の producer 側で、行の「誰が書くか」の列は、送った role について事実を持つことになる。次に、その表と列に key の値で絞った SELECT 1 文を Query で送り、保存された形を読む。marker が送ったままか、serialize や JSON の値の中か、markup の中か、切り詰められたか、変わったか。保存された形を、marker の周りの正確な文字列とともに Store の事実の隣に書く。Find が報告しない marker は、要求の status とともに「この検索では見つからない」と書く。それは不在であり、ソースが理由を示すまで行は open のまま。

**手順 4: 要求を trace する。** 同じ要求を Trace で送る。entry の method と path、entry がログインを要るなら role の cookie、content type と marker を含む body を、`## Lab` 節の Trace 命令が取る形で。答えは要求が走らせた plugin の関数で、呼び出し順に depth、file、行が付く。歩きの行か route の hop の隣に並べる。trace にあって hop に無い関数は読むべき hop で、trace が示す file と行で開いて行に足す。hop が名指すのに trace に無い関数は、この要求とこの role では走らなかったので、その hop に「この role では届かない」と trace を理由にして印を付ける。trace は送ったとおりの 1 要求を示す。要求が通らなかった分岐はそこに無く、もう一方の分岐が何をするかはソースが決める。手順 3 の保存された形が送った値と違うなら、それを変えた entry と store の書き込みの間の関数は trace の中にある。Transformation 行にその関数を file と行付きで名指す。

**手順 5: 読み戻しを trace し observe する。** 地図の Stores and effects 節が store を読み戻すと言う場所ごとに、それを描画する要求を、地図が見ると言う role として Trace で送る。公開ページ、管理画面、feed、JavaScript が描画する response。読みと出力の間の関数が行の consumer 側で、行の下に file と行付きで書き、途中で保存値を escape、decode、書き換えする関数を名指すか、読みと出力の間にそれが現れないと書く。次に同じページに同じ role で Observe を送る。管理者が見るページは管理者として、公開ページは訪問者として。答えの status、dialog が開いたか、marker を dialogMarker にしてその文字列そのままの alert が開いたかを、観測として行の下に書き、行を報告する Finding か Lead の labObservations に、`## Lab` 節の言葉で書く。観測であって確認ではない。

**手順 6: 記録。** lab-facts.md は 1 つの表にする。列は marker、問い、entry、role、parameter、要求の status、見つかった保存先（table.column か path と key の値）、保存された形、書いた trace file、observe した読み戻しページとその status と dialog、決着させる行とその file。命令が返った瞬間に 1 行書く。最後にまとめて書かない。Trace の答えはそれぞれ /workspace/research/lab-traces/<entry の短い名>-<marker>.md に、送った要求と返った関数一覧のまま保存し、別の agent がもう一度送らずに trace を読めるようにする。歩き file、仮定の表、route の行の下に、日付、marker、lab-facts.md の行を付けた Lab 行を追記する。行自身の文は書き換えない。Lab が与えた事実が not found の語に置き換わるのは、trace が名指した関数の file と行をソースで開いて読んだときだけ。

**手順 7: 予算と reset。** Find、Query、Trace は 1 つの予算を共有し、Observe は自分の予算を持つ。答えはそれぞれ何回使ったかを言い、`## Lab` 節が上限を言う。共有の予算は、保存の問いには Find、Query、Trace の順で、関数の問いには Trace だけで使う。lab-facts.md にすでに marker のある問いは何も費やさない。並行して働く agent は命令のたびに lab-facts.md を読み、2 つの agent が同じ entry と parameter に marker を植えないようにする。reset は、wbh-setup が作った site の状態が失われたか plugin がそれ以上の要求を拒むときだけ。reset の後は、その前に植えた marker は site に無く、新しい marker を植える前に wbh-setup の手順 5 のとおり Objects 表を作り直す。

**手順 8: 引き継ぎ。** 単位を別の agent に渡すときは、地図の節と lab-setup.md の自分の行の隣に、その entry に属する lab-facts.md の行と lab-traces の file を名指す。それを読んだ子は、ソースを読む前に、自分の entry がどの store に書くか、どの marker がもう site にあるか、どのページがそれを描画するかを知っている。行の Lab 行が間違っていると気づいた agent は、新しい marker で命令をもう一度送り、日付付きの訂正を行の下に追記する。

**手順 9: 最終報告の前。** 最終報告の前に、Trial を調整する agent が研究 file の open の行、Lead の下書き、lab-facts.md を読み、open の hop が保存、読み戻し、関数の問いである行を手順 1 の形で列挙する。`## Lab` 節が言う共有の予算と observe の予算が尽きていない間は、そうした行のそれぞれを、報告を書く前に手順 2〜6 に通す。Lab が答えた後も open のままの行は答えを下に残し、その Lead はソースがまだ示さない hop を名指す。Lab の答え無しで残した行は、その Lead の labObservations に理由を書く。予算が尽きた、entry に外のサービスが要る、setup の記録にそのページが無い、site が要求を拒んだ（status 付き）。Closing 節に数を追記する。植えた marker、見つかった marker、見つからなかった marker、送った trace、observe した読み戻し、Lab の事実で決着した行、Lab を使わずに open で残した行。

## 出典対照表

要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 道具はあるが使われず、Root が早く閉じる。どの行に使うかを手順にする | 冒頭、description | bench h34（#791 / #726 への報告 2026-11-02: lookups 1〜10 / Trial、F 9 / L 12）。本番 2026-11-02 再開後の 17 Root（Root 11〜47 分、lookups 0〜3、F 0 / L 94）。所有者の問い「道具の使い方が書いてないだけ？」と「じゃあ進めてください」（2026-11-02） |
| 5 つの命令の名前、body、共有する予算、dialogMarker の桁 | Inputs、手順 2〜5・7 | `src/cli/wordpress.ts` `wordPressLabSection`（Reset / Observe / Find / Query / Trace の各段落。Find と Query と Trace は 1 つの予算、Observe は別。marker は「10〜15 桁、0 で始まらない」）。ADR 0049 本文と追記 1 |
| 観測であって確認ではない。labObservations に書く | 手順 5 | `## Lab` 節「The answer is an observation, not a confirmation; report what you observed in `labObservations`」。不変条件 3 |
| Find で保存先、Query で保存された形 | 手順 3 | 設計書 §B（「Lead の止まり方は『どこに保存され、どこで読まれるか』が大半」）。`lab-lookup.ts`（Find は表・列・key と wp-content の file、Query は SELECT 1 文で 200 行） |
| Trace を歩きの hop の隣に並べる。trace は送った 1 要求だけを示す | 手順 4 | `lab-trace.ts`（plugin 内の関数を呼び出し順に depth・file・行付き）。`## Lab` 節「A trace shows what ran for that one request as sent; it shows nothing about another request or another account」 |
| Store 行・Transformation 行・enforced at・歩きの行・route | Inputs、手順 1・3・4・6 | wbh-falsify v2 手順 2（歩き、Routes）、手順 3（Store / Transformation の行と enforced at）、手順 4（Lab があれば行の位置から試して trace file に書く） |
| 地図の Stores and effects と読み戻しの場所 | Inputs、手順 5 | wbh-recon v3 手順 5（store と、読み戻して描画する場所） |
| Objects 表の公開ページから、訪問者か低権限 account で送る。管理者は管理者の書くものだけ | 手順 2 | wbh-setup v1 手順 3・4・6（Objects 表、Content、公開ページを名指す）。`## Lab` 節「A setting you make as administrator is a configuration precondition」。AGENTS.md「contributor 以上と管理者が意図して付与する権限は trust 境界の内側」 |
| prior/stores.json を先に読む | Inputs、手順 1 | ADR 0048 の 2026-11-02 追記（`stores.json` は前 Trial の lookupLog から Harness が写した保存先の表）。`src/discovery/prior-research.ts` |
| 記録は命令が返った瞬間に書く。trace は file に保存して再送しない | 手順 6 | 目的文 v11 以降「Routes that exist only in an agent's context are lost work; write them down」。wbh-tools v1 手順 1（出力を保存し、後の agent は再実行しない） |
| 並行する agent は記録を読んでから命令する。予算の順序 | 手順 7 | `## Lab` 節（予算は答えに出る。制御口は 1 度に 1 命令、409 busy）。設計書 §B「find/sql を trace より先に」 |
| reset は setup を消すので作り直す | 手順 7 | wbh-setup v1 手順 5。`## Lab` 節「provisions it again from the same setup」 |
| 引き継ぎは記録の行を名指す | 手順 8 | wbh-recon v3 手順 8、wbh-tools v1 手順 6、wbh-setup v1 手順 6 |
| 最終報告の前に open の行を Lab に通し、Closing に数を書く | 手順 9 | wbh-recon v3 手順 9（Closing 節、研究 file で終わりを決める）。決定 E（目的文の行数の終了規則を消し、終わり方をスキルに置く。ADR 0049） |

## 書かなかったもの（規則どおり）

- どの行が大事か、何を報告するか、落ちた値が何を意味するか: 目的文、trust 境界、契約の側（ADR 0043「本文の規則」）。
- 対象固有の表名、option 名、URL、画面名: 不変条件 1 と AGENTS.md。表、列、file は種類の名前で言う。
- 予算の値、marker の桁数、Trace の上限行数: Harness が `## Lab` 節で伝える（ADR 0003 追記、ADR 0049）。本文は「`## Lab` 節が言う予算」としか言わない。
- Harness が lab-facts.md を読む、数える、判定する: 不変条件 3、所有者決定 2026-10-27「中身は AI、形は Harness」。lookupLog と stores.json は Harness が命令の往復から写すだけで、file の中身は読まない。
- 攻撃の送り方、再現手順、確認の判断: 不変条件 3。marker は普通の使い方で送る値であり、観測は確認ではない。
