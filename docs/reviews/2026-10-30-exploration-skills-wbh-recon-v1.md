# 探索スキル wbh-recon v1 の全文・日本語訳・出典対照表（2026-10-30）

[Issue #682](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/682)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md)。agent に渡る文章の規則（DEVELOPMENT 第 5 節）に従い、全文、日本語訳、出典対照表を置く。本文は手順だけで、型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数は書いていない（test `tests/profiles/wordpress/skill-definitions.test.ts` で固定）。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-recon-v1/SKILL.md`
- registry: `src/profiles/wordpress/prompts/skills.ts` の `wbh-recon-v1`（name `wbh-recon`、status `current`）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-recon/SKILL.md`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-recon/SKILL.md`
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v1"] }`（`deep` / `wide` のみ）

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-recon
description: Use at the start of exploring a WordPress plugin's pinned source, before forming hypotheses or starting other agents, and again when an agent is handed a part of the plugin it has not read. Builds a map of the plugin's subsystems, request entries, authorization gates, shared helpers, data stores and the JavaScript boundary, and writes it to /workspace/research/recon-map.md for every agent in the Trial to read.
---

# wbh-recon v1

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

When work is split among agents, split it along the map: a subsystem with its entries, its shared helpers and its stores is one unit. Each agent receives the map's section for its unit, the Wrappers table, and the list of shared gate functions, and reads the map before the source. An agent that finishes writes what it read and what it left unread into its own research file and the Corrections section, so that the next agent on the same unit continues instead of restarting.
```

## 日本語訳

> **name:** wbh-recon
> **description:** WordPress プラグインの固定ソースを探索し始めるとき、仮説を立てたり他の agent を起こしたりする前に使う。agent が読んだことのない部分を渡されたときにも使う。プラグインの subsystem、要求の入口、認可の関門、共有 helper、データの保存先、JavaScript との境界の地図を作り、Trial 内の全 agent が読めるように /workspace/research/recon-map.md に書く。

### wbh-recon v1

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

**手順 8: 引き継ぎ.** 仕事を agent に分けるときは、地図に沿って分ける: subsystem 1 つと、その入口、共有 helper、保存先が 1 単位である。各 agent は、自分の単位の地図の節、wrapper 表、共有の関門関数の一覧を受け取り、ソースより先に地図を読む。終えた agent は、読んだものと未読のものを自分の研究 file と Corrections 節に書く。同じ単位の次の agent がやり直さずに続けられるようにするためである。

## 出典対照表

要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 地図（recon）を仮説より先に作る。問いを持って読むと問いが名指すものしか見つからない | 冒頭の段落 | Anthropic 参照 harness の recon 段（`harness/prompts/recon_prompt.py:25-33`、[2026-10-27 報告](2026-10-27-public-harness-repos-responsibility-split.md) 出典表）。Cloudflare skill の recon 4 体（`SKILL.md:119-134`）。Anthropic「型を列挙すると recall が下がる」（`docs/prompting.md:23-32`） |
| 固定ソースだけを読む、本体・library は記憶でなく供給ソース | 入力 | 目的文 v11「Read the supplied dependency source instead of recalling」（`wp2shell-bounty-v11.md`）。不変条件 1 |
| /workspace/research を共有の置き場にする | 入力、手順 7 | 目的文 v11「Every agent writes its findings to /workspace/research/<family>.md」。Cloudflare「親だけが共有 file を書く」（`SKILL.md:56-66`） |
| 読み込み順と loader から形を取る | 手順 1 | Anthropic recon「5〜15 の subsystem」（`recon_prompt.py:25-33`）。Mantis の構造索引（tree-sitter）が file を単位にする点の対照 |
| 機能で subsystem を 5〜15 に分ける、各領域の大きさ | 手順 2 | Anthropic recon「5〜15 の subsystem」。Shopify「区画の大きさ = context の 2〜3 割」（[2026-10-27 報告](2026-10-27-public-harness-repos-responsibility-split.md) §1） |
| 入口の列挙を本体の dispatch から始め、プラグイン固有の wrapper を loader からたどる | 手順 3 | [CVE ベンチの列挙再現率](2026-10-30-enumeration-recall-cve-bench.md): script が落とした類は wrapper 登録、本体へ値を渡す書き込み、JS 側の出口。AVDH の入口抽出（[2026-10-27 報告](2026-10-27-public-harness-repos-responsibility-split.md) §4 行 1） |
| 誰が届くか、関門がどこにあるか（wrapper か handler か）を読んだとおり記録する | 手順 4 | trust 境界宣言 v1（`prompts/trust-boundary-v1.md`）の攻撃者位置。段 1b `wbh-source-check` の 2 つの問いの前提（入力を握れるか、既定で届くか）。Cloudflare「信頼境界が何か、どの単位があるか」（`SKILL.md:56-66`） |
| 共有 helper、保存先、読み戻しの場所 | 手順 5 | [CVE ベンチ](2026-10-30-enumeration-recall-cve-bench.md) の「`$this->wpdb`、wrapper、本体へ値を渡す書き込み」。`core-fixed-list-v1.md`（ADR 0042 追記 1）が本体側を一覧にする設計 |
| JavaScript の境界 | 手順 6 | [CVE ベンチ](2026-10-30-enumeration-recall-cve-bench.md) の JS / Vue 側の出口が script から落ちた記録 |
| 地図の節の順と、file と行を付ける | 手順 7 | 契約 v4 が `sourceTrace` に file と行を求める形（`output-contract.ts`）。Cloudflare 親の `architecture.md` |
| 上書きせず Corrections に追記 | 手順 7 | Cloudflare「親だけが共有 file を書く、hunter は scratch に書く」（`SKILL.md:56-66`）。目的文 v11「Findings that exist only in an agent's context are lost work」 |
| subsystem 単位で配り、地図を先に読ませ、読んだ・未読を残して返る | 手順 8 | 目的文 v11「Each agent is given one piece of work and returns when that piece is done」「that agent reads the registry and the file before it continues」。Anthropic の round-robin（`harness/cli.py:560-566`）、Shopify の group |

## 書かなかったもの（規則どおり）

- 型の一覧、判断の基準、脆弱性の語: 契約 v5 / v17 の教訓（ADR 0038 追記 15、ADR 0039 追記 12）。
- 最低時間、子の数: Harness が Run parameters で強制する（ADR 0039 追記 3・4）。
- 対象固有の名前、再現の手順、公開履歴: 不変条件 1。
