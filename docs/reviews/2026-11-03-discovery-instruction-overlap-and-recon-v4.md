# 探索指示の重複監査と wbh-recon v4（2026-11-03）

[ADR 0043 追記 10](../adr/0043-exploration-skills-in-the-sandbox.md)、[ADR 0045 追記 4](../adr/0045-frozen-core-and-three-exploration-forces.md)、Issue #807。対象は v22-wide の目的文、recon / tools / setup / lab の 4 スキル、Harness が生成する節、探索 runtime の投入経路。行番号はこのレビューを作った時点の作業ツリーに対応する。今回変更する agent 向け本文は recon-v4 のみである。

## 指示の所有者と重複

| 指示の意味 | 場所と重複・衝突 | 正本 | 対応 |
| --- | --- | --- | --- |
| 子の割当 | [v22:7,17](../../src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md) は sink 別。[recon-v3:48](../../src/profiles/wordpress/prompts/skills/wbh-recon-v3/SKILL.md) は subsystem 別に分ける。tools:36、setup:36、lab:44 の引継ぎも subsystem / unit と呼ぶ。 | 目的文が割当、スキルが記録の受け渡し。 | **今回:** recon-v4:48 から subsystem 分担命令を削り、割当済みの子へ関連行を渡す。 |
| 子の最終報告 | [v22:11](../../src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md) は30行以内の verdict・path・pointer。[生成契約:35–40](../../src/profiles/wordpress/discovery/output-contract.ts) は厳密な4キー JSON。自由形式の返答と解釈され得る。 | 生成された出力契約。 | **後続:** 版付き目的文の制約内で返却形式の重複を削る。v4 に JSON 契約を複写しない。 |
| スキルの数と使う時点 | [v22:19](../../src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md) は「Three skills」と固定し、3技能の手順を要約。4本を stage した Trial では事実と違う。[Lab 生成節:787–790](../../src/cli/wordpress.ts) は stage した lab skill を条件付きで名指す。 | `discovery.skills` が存在、各 SKILL.md が手順。 | **後続:** 目的文の固定個数と要約を整理する。リポジトリの `policy/campaign.json` は skills を指定しておらず、全 Trial に4本があるわけではない。 |
| 終了と残件 | [v22:21](../../src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md) は wall と報告、[recon-v3:50–58](../../src/profiles/wordpress/prompts/skills/wbh-recon-v3/SKILL.md) はソースの再読、[lab-v1:46–48](../../src/profiles/wordpress/prompts/skills/wbh-lab-v1/SKILL.md) は Lab に答えられる行を処理。順序が明示されない。 | recon が終了を調整し、lab が Lab の質問を担当。 | **今回:** recon-v4:52–60 に独立点検と lab 手順の順序を入れ、Closing は一つ。 |
| 地図と列挙 | [recon:22–42](../../src/profiles/wordpress/prompts/skills/wbh-recon-v3/SKILL.md) は入口・保存先・描画先を意味付けし、[tools:14–32](../../src/profiles/wordpress/prompts/skills/wbh-tools-v1/SKILL.md) は literal な登録・効果を列挙して地図と照合。wrapper の記録が重なる。 | recon は意味の地図、tools は機械列挙と照合。 | **維持:** 列挙を地図の代わりにしない。独立点検では両者を固定ソースと比べる。 |
| 通常のサイト状態と観測 | [setup:14–32](../../src/profiles/wordpress/prompts/skills/wbh-setup-v1/SKILL.md) は通常利用の object と公開ページを作り、[lab:18–40](../../src/profiles/wordpress/prompts/skills/wbh-lab-v1/SKILL.md) はその状態で marker を送って保存・読み戻しを観測する。 | setup が環境を作り、lab が開いた行を測る。 | **維持:** 作成と測定の別手順。 |
| 実行値・前回の研究・報告 schema | [Run parameters](../../src/discovery/run-parameters.ts) は wall と子の上限、[Lab 節](../../src/cli/wordpress.ts) は command と予算、[Prior research](../../src/discovery/prior-research.ts) は前版 file と版、[出力契約](../../src/profiles/wordpress/discovery/output-contract.ts) は schema。スキルにもそれらの参照がある。 | 生成節が Trial の事実と契約、スキルが使い方。 | **維持:** v4 に数値、command body、Finding 型を写さない。 |

### 「system prompt」の区別

リポジトリ独自の system prompt は見つからない。[`wordPressDiscoveryPromptText`](../../src/cli/wordpress.ts) は目的文、出力契約、Run parameters、Prior research、trust 境界、Programme Boundary、Lab を一つの投入文に連結する（658–683 行）。Codex runtime はこれを [CLI の stdin](../../src/discovery/codex-native-agent-runtime.ts) に渡し（1770 行）、Claude runtime は [SDK の `query({ prompt })`](../../src/discovery/claude-runner.ts) に渡す（143–156 行）。SKILL.md は別途 stage される。v22 は目的文であり、生成節は Trial 固有の説明と契約である。CLI / SDK 内部の system 指示の本文は、このリポジトリからは点検できない。

## v4 の置き場と測定

- file: `src/profiles/wordpress/prompts/skills/wbh-recon-v4/SKILL.md`（支援 file なし）
- digest: `sha256:9a3b70432ff343cc6bc07f0a9ad52f636c4b629ffae8e65b4dc578d69d4fc75d`
- registry: `wbh-recon-v4`（name `wbh-recon`、status `current`）。v3 は過去 Trial 照合用に `archived`。
- 適用: campaign の `discovery.skills` が v4 を名指すときだけ stage。既存の Trial は変えない。
- 採否: [ADR 0045:27–35](../adr/0045-frozen-core-and-three-exploration-forces.md) の本番の Codex 1 時間あたりの Lab 発火と Wordfence の結果。新たに開いた経路数は診断値で、網羅や Finding 確定の根拠ではない。

## 全文（英語、SKILL.md の正確な本文）

```markdown
---
name: wbh-recon
description: Use when the Trial objective assigns sink specialists, at the start of exploring a WordPress plugin's pinned source before forming hypotheses or starting other agents, and again when an agent is handed a part of the plugin it has not read. Builds a map of the plugin's subsystems, request entries, authorization gates, shared helpers, data stores and the JavaScript boundary, and writes it to /workspace/research/recon-map.md for every agent in the Trial to read. Use it once more before the final report, to decide from the research files whether the work is finished.
---

# wbh-recon v4

A map of the plugin comes before any hypothesis. Reading the code with a question already in mind finds only what the question names; reading it to describe how it is built shows the parts the question would have skipped. This skill describes how to build that map from the pinned source alone and how to write it so that other agents can start from it instead of re-reading the plugin. It does not say what to look for afterwards. The objective and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial; the map lives there.

## Step 1: shape

Read the main plugin file and whatever it loads, in load order, before anything else. Record how code reaches memory: an autoloader and its class-to-file rule, explicit require lists, a bundled framework's module loader, feature directories loaded on a condition such as another plugin being active or a setting being on. Record the top-level directories and what each holds, the namespaces or class prefixes, bundled libraries under vendor or similar, and where the shipped JavaScript and templates live. Note the size of each area in files, so a later split can be sized.

## Step 2: subsystems

Group the code into subsystems by the feature the user of the site sees, not by directory alone: the settings area, each public-facing feature, integrations with other plugins or external services, background jobs, import and export, upgrades and migrations. Five to fifteen groups is the usual range; a plugin that does one thing may have three. For each subsystem write its files, its main classes or function groups, and one sentence on what it does. A file that serves several subsystems is a shared helper and goes in Step 5.

## Step 3: request entries

For each subsystem list every place a request from outside the plugin's own code starts running it. Begin from how WordPress itself dispatches: action and filter hooks, AJAX handlers, REST routes, shortcodes and blocks, admin pages and their form handlers, scheduled events, rewrite rules and query variables, template redirects, files that can be requested directly, and callbacks that another plugin or an external service invokes. Then read how this plugin registers them. Many plugins wrap core registration in their own layer: a routes table, a controller base class, a module loader, an attribute or array of handlers, a hook manager. Find each wrapper by following the loader from Step 1, and record the rule that maps a wrapper entry to the core mechanism it ends in, with the file and line of the wrapper. A search for core function names alone misses everything behind a wrapper; a search for the wrapper's name finds the rest.

For each entry record the file and line of the registration, the mechanism, the handler it resolves to, and the parameters the handler reads.

## Step 4: who reaches an entry, and the gate

For each entry record who can reach it before any code of the handler runs: anyone, a logged-in account of a low role, or a higher role only, as the registration mechanism decides. Then record what the code checks on the way in: capability checks, nonce or token checks, login checks, ownership checks, and where each check sits. A check in a shared registration wrapper covers every entry behind the wrapper; a check inside one handler covers that handler only; a wrapper that leaves the check to the handler covers nothing by itself. Name the shared gate functions, the entries that pass through them, and the entries that do not. State what you read, not what the plugin's comments or option names claim.

## Step 5: shared helpers, stores and effects

List the helper layer the subsystems share: database access classes and query builders around the core database object, settings and option wrappers, file and upload helpers, template and rendering helpers, HTTP client wrappers, serialization helpers, and the plugin's own escaping or validation functions. For each helper record what it wraps in core or in a library, and which subsystems call it. Then list what the plugin stores and where: options, post and user meta, custom tables with their schema, transients, files under the uploads directory, and data sent to or fetched from external services. Record where stored values are read back out and rendered: admin screens, public templates, email, feeds, and responses that JavaScript renders.

## Step 6: the JavaScript boundary

Record how the shipped JavaScript talks to PHP and what it renders: data localized into the page, REST and AJAX calls and the handlers they reach, and views built in the browser from those responses, including any framework templates. A value that leaves PHP as data and is placed into the page by JavaScript has its last step in the JavaScript file, so the map names that file beside the PHP handler. Minified bundles with a readable source alongside are mapped from the source; a bundle with no source is noted as unread.

## Step 7: write the map

Write /workspace/research/recon-map.md with these sections, in this order: Shape; Subsystems; Entries, one table per subsystem with columns registration, mechanism, handler, parameters, who reaches it, gate; Wrappers, a table mapping each plugin-specific registration form to the core mechanism; Shared helpers; Stores and effects; JavaScript boundary; Unread, the files and bundles not yet read with a reason; Open questions, things the source did not settle. Every row carries a file and line. Keep claims to what the source shows; mark anything inferred as inferred.

Other agents overwrite nothing in this file. An agent that reads a part the map marked unread, or finds the map wrong, appends a dated correction under a Corrections section at the end with the file and line that shows it.

## Step 8: hand-over

When the objective assigns work among agents, give each agent the map rows and source files relevant to its assignment, the Wrappers table, and the list of shared gate functions. Each agent reads the map before the source. Start each child without the parent's conversation when the spawn tool offers that choice (a fresh history, not a fork of the parent's), and put the assigned map rows, the rows of the saved research files it needs and its task into the child's first message; a child that begins from the files sees the same picture its parent had without carrying the parent's reading. An agent that finishes writes what it read and what it left unread into its own research file and the Corrections section, so that the next agent on the same assignment continues instead of restarting.

## Step 9: closing

The Trial ends when the research files show that nothing readable is left open, not when the rows of a listing have been counted. Before the final report, the agent that coordinates the Trial follows these steps against the pinned source and /workspace/research. Repeat the sequence when new paths are opened, until the records support closing or the Trial wall arrives.

1. Independently of the specialists who wrote the route files, compare the pinned source around request registrations, storage read-back sites, shared effect helpers and their callers, and shipped browser renderers with the map, any literal listings from wbh-tools, the route files and the unfinished work in the registry the objective asks for. Open the source at each apparent omission. For a source path missing from those records, append a correction to the map and unfinished work to the registry, each with its file and line, what the records omitted and the sink assignment it belongs to. If the sink is not yet clear, record that uncertainty. A specialist continuing that sink reads the path from the source. The comparison alone does not settle it.
2. When wbh-lab is installed and the Trial has a Lab, start a Closing section marked in progress in the registry, then pass the Lab-answerable open rows, including those opened in the comparison, through that skill's before-final-report step. Keep the Lab counts it appends to that section when the section is finalized.
3. Every entry in the map, every row of the hook listing when one was produced, and every path opened by Step 1 is in one of two states: its handler or path has been read to the point where the request is stopped by a check or reaches its effect, with the file and line of that point recorded; or it is listed as unread with a reason. A row classified from its registration or from the handler's name alone is still open. An unassigned path is also open.
4. Every route that a specialist wrote down as reaching a store, an output or an effect with a gap remaining has been read a second time by an agent other than the one that wrote it. That agent starts from the route's file and line and the written gap, with the task of settling the gap from the supplied source either way, and records the result under the route: settled, with the file and line that shows it, or not settleable from the supplied source, with the missing piece named. A gap written down and left is open.
5. Each item under Unread and under Open questions has been read, or carries a reason that still holds.

When a comparison opens no further path and Steps 2 through 5 are complete, create or finalize the Closing section in the registry the objective asks for, with the counts: paths newly opened by the independent comparison, entries read to their check or effect, entries unread with a reason, routes with a gap settled, routes not settleable from the supplied source, and the elapsed time. Then give the final report. When the Trial wall arrives first, create or finalize the same section with the counts as they stand and state that the wall ended the work.
```

## 日本語訳（全文）

> **name:** wbh-recon
>
> **description:** Trial の目的文が sink 専門家を割り当てる場合、WordPress プラグインの固定ソースを探索し始めるときに、仮説を立てたり他の agent を起こしたりする前に使う。agent が読んだことのない部分を渡されたときにも使う。プラグインの subsystem、要求の入口、認可の関門、共有 helper、データの保存先、JavaScript との境界の地図を作り、Trial 内の全 agent が読めるよう /workspace/research/recon-map.md に書く。最終報告の前にもう一度使い、研究 file から仕事が終わっているかを判断する。

### wbh-recon v4

プラグインの地図は、どの仮説よりも先に作る。問いを持ってコードを読むと、その問いが名指すものしか見つからない。どう作られているかを記述するために読むと、問いが飛ばしたはずの部分が見える。このスキルは、固定ソースだけからその地図を作る方法と、他の agent がプラグインを読み直さずに地図から始められる書き方を述べる。その後に何を探すかは述べない。それは目的文と出力契約が述べる。

**入力.** 固定したプラグインのソースは /workspace/main にある。固定した WordPress 本体のソースは、供給されていれば /workspace/wordpress に、他のプラグインやライブラリのソースは /workspace/dependencies/<slug> の下にある。本体、framework、library が何をするかは、記憶ではなく供給されたソースを読む。研究ディレクトリ /workspace/research は書き込み可で、Trial 内の全 agent が共有する。地図はそこに置く。

**手順 1: 形.** 何よりも先に、メインのプラグイン file と、それが読み込むものを読み込み順に読む。コードがどうやってメモリに載るかを記録する: autoloader とその class から file への規則、明示の require の列、同梱 framework の module loader、別プラグインの有効化や設定の on を条件に読まれる機能ディレクトリ。最上位のディレクトリとその中身、namespace や class の接頭辞、vendor などの同梱 library、出荷される JavaScript と template の場所を記録する。後で分割の大きさを決められるよう、各領域の file 数を書く。

**手順 2: subsystem.** コードを、ディレクトリだけでなく、サイトの利用者が見る機能でまとめる: 設定の領域、公開側の各機能、他プラグインや外部サービスとの連携、background job、import / export、upgrade と migration。5〜15 個が普通で、1 つのことしかしないプラグインは 3 個かもしれない。各 subsystem について、file、主な class か関数群、何をするかを 1 文で書く。複数の subsystem に仕える file は共有 helper で、手順 5 に入る。

**手順 3: 要求の入口.** 各 subsystem について、プラグイン自身のコードの外から来た要求がそれを動かし始める場所をすべて列挙する。WordPress 自身の dispatch から始める: action と filter の hook、AJAX handler、REST route、shortcode と block、管理画面とその form handler、scheduled event、rewrite 規則と query 変数、template redirect、直接要求できる file、他プラグインや外部サービスが呼ぶ callback。次に、このプラグインがそれらをどう登録しているかを読む。多くのプラグインは本体の登録を自前の層で包む: route の表、controller の基底 class、module loader、handler の属性や配列、hook manager。手順 1 の loader をたどって各 wrapper を見つけ、wrapper の項目がどの本体の仕組みに行き着くかの規則を、wrapper の file と行とともに記録する。本体の関数名だけで検索すると wrapper の裏にあるものを全部見落とす。wrapper の名前で検索すると残りが見つかる。

各入口について、登録の file と行、仕組み、解決される handler、handler が読む parameter を記録する。

**手順 4: 誰が入口に届くか、そして関門.** 各入口について、handler のコードが動く前に誰が届けるかを、登録の仕組みが決めるとおりに記録する: 誰でも、低い role のログイン済み account、高い role だけ。次に、入り口でコードが何を検査するかを記録する: capability の検査、nonce や token の検査、ログインの検査、所有の検査、そして各検査がどこにあるか。共有の登録 wrapper にある検査はその wrapper の裏の全入口を覆う。1 つの handler の中の検査はその handler だけを覆う。検査を handler に任せる wrapper はそれ自体では何も覆わない。共有の関門関数、それを通る入口、通らない入口を名指しする。プラグインのコメントや option 名が主張することではなく、読んだことを書く。

**手順 5: 共有 helper、保存先、効果.** subsystem が共有する helper 層を列挙する: 本体の database object を包む database access class と query builder、設定と option の wrapper、file と upload の helper、template と rendering の helper、HTTP client の wrapper、serialization の helper、プラグイン自前の escape や validation の関数。各 helper について、本体か library の何を包むか、どの subsystem が呼ぶかを記録する。次に、プラグインが何をどこに保存するかを列挙する: option、post と user の meta、schema 付きの custom table、transient、uploads ディレクトリ下の file、外部サービスへ送る・から取るデータ。保存した値がどこで読み戻されて描画されるかを記録する: 管理画面、公開 template、email、feed、JavaScript が描画する応答。

**手順 6: JavaScript の境界.** 出荷される JavaScript が PHP とどう話し、何を描画するかを記録する: page に localize されるデータ、REST と AJAX の呼び出しと届く handler、それらの応答から browser 内で組み立てられる view（framework の template を含む）。PHP をデータとして出て JavaScript が page に置く値は、最後の一歩が JavaScript の file にあるので、地図はその file を PHP の handler の横に書く。minify された bundle に読める source が添えてあれば source から地図にする。source の無い bundle は未読として書く。

**手順 7: 地図を書く.** /workspace/research/recon-map.md に、次の節をこの順で書く: 形; subsystem; 入口（subsystem ごとに 1 表、列は 登録、仕組み、handler、parameter、誰が届くか、関門）; wrapper（プラグイン固有の登録形式と本体の仕組みの対応表）; 共有 helper; 保存先と効果; JavaScript の境界; 未読（まだ読んでいない file と bundle、理由付き）; 未解決（ソースが決めなかったこと）。すべての行に file と行番号を付ける。主張はソースが示すことに留め、推測は推測と印を付ける。

他の agent はこの file の何も上書きしない。地図が未読と書いた部分を読んだ agent、地図の誤りを見つけた agent は、末尾の Corrections 節に、それを示す file と行とともに日付付きの訂正を追記する。

**手順 8: 引き継ぎ.** 目的文が agent 間で仕事を割り当てるときは、各 agent に、割り当てに関係する地図の行とソース file、Wrappers 表、共有の関門関数の一覧を渡す。各 agent はソースより先に地図を読む。spawn の道具がその選択を許すなら、子は親の会話を引き継がずに始める（親の履歴の fork ではなく、新しい履歴で）。割当済みの地図の行、必要な保存済み研究 file の行、task を子の最初の message に入れる。file から始める子は、親が読んだ履歴を抱えずに同じ状況を理解できる。終えた agent は、読んだものと未読のものを自分の研究 file と Corrections 節に書き、同じ割当を次に受ける agent がやり直さずに続けられるようにする。

**手順 9: 終了.** Trial は、研究 file が「読めるものは何も開いたまま残っていない」と示したときに終わり、一覧の行を数えた時点では終わらない。最終報告の前に、Trial を取りまとめる agent は固定ソースと /workspace/research に対して以下を順に行う。新しい経路が開いたら、記録上終了できるか Trial の wall に達するまで繰り返す。

1. 経路 file を書いた専門家から独立して、要求の登録、保存値の読み戻し箇所、共有の効果 helper とその呼出元、出荷されるブラウザ側の描画箇所の周辺の固定ソースを、地図、wbh-tools の literal な一覧（あれば）、経路 file、目的文が求める登録簿の未完の仕事と突き合わせる。漏れに見える箇所のソースを開く。これらの記録に無いソース上の経路を見つけたら、地図には訂正、登録簿には未完の仕事を追記する。それぞれに file・行、記録から漏れていた内容、担当する sink を書く。sink がまだ分からなければ、その不確かさを書く。その sink を続ける専門家が、ソースからその経路を読む。比較だけでは決着しない。
2. wbh-lab がインストールされ Trial に Lab がある場合、登録簿に進行中と印を付けた Closing 節を作り、比較で新たに開いた行を含めて Lab で答えられる未完行を、そのスキルの「最終報告前」の手順に通す。その手順が Closing 節に追記した Lab の件数を、節の確定時にも残す。
3. 地図の全 entry、hook 一覧を作った場合はその全行、手順 1 で開いた全経路は、次のどちらかの状態にある: 要求が check で止まるか効果に届く点まで handler または経路を読み、その点の file と行を記録した; または、理由付きで未読として挙げた。登録や handler の名前だけから分類した行は、まだ開いている。担当未定の経路も開いたままである。
4. 専門家が保存先・出力・効果に届いたが隙間が残ると書いた各経路を、書いた agent とは別の agent が 2 回目に読む。その agent は経路の file・行と書かれた隙間から始め、供給されたソースからどちらかに決着させ、経路の下に結果を書く: 決着した（それを示す file と行付き）、または供給されたソースでは決着できない（足りないものを名指す）。書いたままの隙間は開いている。
5. Unread と Open questions の各項目が、読まれたか、まだ成り立つ理由を持っている。

比較で新しい経路が開かず、手順 2〜5 が完了したら、目的文が求める登録簿の Closing 節を作るか確定し、次の件数を書く: 独立した比較で新たに開いた経路、check か効果まで読んだ entry、理由付きで未読の entry、隙間が決着した経路、供給ソースでは決着できない経路、経過時間。その後に最終報告する。Trial の wall が先に来たら、同じ節をその時点の件数で作るか確定し、wall が仕事を終えたと述べる。

## 出典対照表

| v4 の指示 | 本文の位置 | 出典と理由 |
| --- | --- | --- |
| 地図を先に作り、入口、関門、helper、保存先、ブラウザ描画を記録 | description、手順 1〜7 | v1 から維持。[v1 の出典対照表](2026-10-30-exploration-skills-wbh-recon-v1.md)、[ADR 0043:11,19–31](../adr/0043-exploration-skills-in-the-sandbox.md)。既存 CVE 19 件の script 比較では入口 17、出口 12、両方 11 件。落ちた形は wrapper、本体への書き込み、JS / Vue 出口など（[ベンチ記録:44–53](2026-10-30-enumeration-recall-cve-bench.md)）。 |
| sink 専門家への割当を変えず、関係する地図の行を渡す | description、手順 8 | [v22:7,17](../../src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md) が sink 別に分配。v3 手順 8 の subsystem 別分配と衝突したため、分配の所有者を目的文へ戻した。新しい子の履歴と file による引継ぎの根拠は [v2 の出典対照表](2026-11-01-exploration-skills-wbh-recon-v2.md)。 |
| 担当者と独立に固定ソースを開いて漏れを研究 file に戻し、既存担当へ渡す | 手順 9 の 1 | 所有者の 2026-11-03 の WordPress 特化 audit skill、小さな追加、指示の重複整理という決定（[ADR 0043 追記 10](../adr/0043-exploration-skills-in-the-sandbox.md)、[ADR 0045 追記 4](../adr/0045-frozen-core-and-three-exploration-forces.md)）。bench h30 の当たり 69 件は handler 内で直接 sink、外れ 45 件は遠い描画先 14、HTML 書換 12、論理 11、保存→再利用 6、連結 SQL の Lead 止まり 2（[ADR 0043 追記 5](../adr/0043-exploration-skills-in-the-sandbox.md)）。この分布は点検先を決める根拠で、回収率向上の保証ではない。 |
| Lab で答えられる行を lab の既存手順に通し、Closing を一つにする | 手順 9 の 2 | [wbh-lab-v1 手順 9](../../src/profiles/wordpress/prompts/skills/wbh-lab-v1/SKILL.md)、[ADR 0043 追記 7](../adr/0043-exploration-skills-in-the-sandbox.md)。Lab の command と予算は [生成節](../../src/cli/wordpress.ts) が持ち、v4 は再掲しない。 |
| handler の読了点、別 agent の 2 回目の読み、未読理由、Closing の件数 | 手順 9 の 3〜5 と末尾 | [recon-v3 の手順 9 と出典対照表](2026-11-01-exploration-skills-wbh-recon-v3.md)。本番 v21 の 10 Trial は hooks.tsv の全行を分類して 9〜54 分で閉じ、Finding 6 件に対し Lead 40 件だった（[ADR 0043 追記 4](../adr/0043-exploration-skills-in-the-sandbox.md)）。 |
| Harness に網羅判定や確定をさせず、数値をスキルへ複写しない | 全体 | [ADR 0043:27–37](../adr/0043-exploration-skills-in-the-sandbox.md)、[ADR 0045:23–35](../adr/0045-frozen-core-and-three-exploration-forces.md)、[SPEC 第 2・6 節](../SPEC.md)。確定は人間の review Lab 記録だけ。採否は本番の Lab 発火 / Codex 時間と Wordfence の結果。 |

## 書かなかったもの

- SQLi と stored XSS の新しい判定語・型一覧。目的文と Programme Boundary が対象を決め、スキルは固定ソースの独立点検を説明する。複数段の権限昇格や RCE の探索手順も加えていない。
- Harness の新しい索引、dispatch、coverage 判定、Lab 操作方式。記録から次の仮説につなぐのは agent の仕事である。
- 前版 Finding / Lead の入力拡張。`## Prior research` は前版 file がある場合の事実を述べる既存の生成節で、この変更では扱わない。
