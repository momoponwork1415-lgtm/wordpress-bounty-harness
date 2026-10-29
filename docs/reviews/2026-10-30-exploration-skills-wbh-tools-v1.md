# 探索スキル wbh-tools v1 の全文・日本語訳・出典対照表（2026-10-30）

[Issue #687](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/687)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-10-30 追記 1。agent に渡る文章の規則（DEVELOPMENT 第 5 節）に従い、全文、日本語訳、出典対照表を置く。本文は手順だけで、型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数は書いていない（test `tests/profiles/wordpress/skill-definitions.test.ts` で固定）。

このスキルは、区画分配型（ADR 0042）が使っていた列挙 script 2 本と本体機能の固定参照 1 本を、Root 配分型の協調 Trial で agent が自分で使うものとして運ぶ。Harness は file を digest で固定して sandbox の CLI home に置くだけで、script を実行せず、出力も読まない。出力は HINT であり、Finding でも判定でもない。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-tools-v1/SKILL.md`
- 支援 file（同じ directory、registry に digest を固定）:
  - `enumerate-hooks-v1.sh`: 本体が request をプラグインのコードへ解決する登録（hook、shortcode、REST、block、widget、rewrite、cron、setting、CLI）の文字どおりの出現を列挙する
  - `enumerate-sinks-v2.sh`: プラグインのコードが値を本体へ渡して効果になる呼び出し（出力、query、file、unserialize、書き込み、送信）の文字どおりの出現を、関数単位にまとめて列挙する
  - `core-fixed-list-v1.md`: 本体側で値が効果になる場所と、request がプラグインのコードに解決される場所の固定一覧。どのプラグインにも同じで、プラグインの名前を含まない
- registry: `src/profiles/wordpress/prompts/skills.ts` の `wbh-tools-v1`（name `wbh-tools`、status `current`、`files` 3 本）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-tools/`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-tools/`。`.sh` は実行可（0500）、他は読み取り専用（0400）
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v1", "wbh-tools-v1"] }`（`deep` / `wide` のみ）

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-tools
description: Use after the recon map exists, or whenever an agent needs a list of the literal hook registrations and the literal effect calls across the pinned plugin source. Runs the two enumeration scripts shipped in this skill's directory, saves their output under /workspace/research/tools for every agent in the Trial, reads the fixed reference of core features, and cross-checks all three against /workspace/research/recon-map.md. The lists are hints to read from, not findings.
---

# wbh-tools v1

Reading a plugin by hand finds what the reader happens to open. A mechanical listing of where core resolves requests into plugin code, and where plugin code hands a value to core for an effect, finds the same kinds of places in every file at once, including files nobody opened. The listing is cheap and blind: it matches text, so it misses everything the plugin reaches through its own wrapper, a variable, or a bundled framework. This skill describes how to run the listing once per Trial, how to keep its output where every agent can read it, and how to turn the gaps between the listing and the map into work rather than into false confidence. It does not say what the listed places mean. The objective and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main; pinned WordPress core, when supplied, is at /workspace/wordpress, and other supplied plugin and library source is under /workspace/dependencies/<slug>. The research directory /workspace/research is writable and shared by every agent in the Trial. The directory that holds this SKILL.md also holds three files: enumerate-hooks-v1.sh, enumerate-sinks-v2.sh and core-fixed-list-v1.md. The scripts take the source root as their first argument and print tab-separated lines of kind, file, line and the matched text, with paths relative to that root. The reference is the same for every plugin and names none.

## Step 1: run the scripts once and keep the output

Run each script with sh, with /workspace/main as the argument, and save the output to /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv. Do this once per Trial; later agents read the saved files instead of running the scripts again. A script that exits without output or with an error is itself a fact to record: write what happened to /workspace/research/tools/README.md and continue by hand. If a dependency plugin or a library under /workspace/dependencies is part of the surface you are reading, run the scripts a second time against that directory and save the output under its own name beside the first.

## Step 2: read the fixed reference as a checklist

Read core-fixed-list-v1.md. It lists the core features that act on a value a plugin hands them, and the core features that resolve a request into plugin code, each with the core functions involved. Use it as a checklist of effect kinds and dispatch kinds to look for in this plugin, not as a list of what is wrong. The counts in its last columns describe the history mirror as a whole and say nothing about this plugin; do not let them order your reading of this plugin.

## Step 3: cross-check the hooks list against the map

Open /workspace/research/recon-map.md. For each request entry the map records, find its line in hooks.tsv. An entry the map has and the list lacks is behind a wrapper, a variable name or a framework dispatcher; record the wrapper and the rule in the map's Corrections section if it is not already there. A line the list has and the map lacks is an entry the map missed; read it and add it to the map's subsystem and entry tables with its handler and parameters. Treat the registrations the list cannot see, which the reference names below its tables, as a separate pass: search for the plugin's own names for them, by following the loader and wrapper rules the map records.

## Step 4: cross-check the sinks list against the map

For each subsystem in the map, read the sinks.tsv lines under its files and compare them with the stores and effects the map records in its shared helpers section. A call the list shows and the map lacks is an effect the map missed; add it. An effect the map records that the list does not show is reached through a plugin-defined method, a variable function name or a bundled framework; record the wrapper by file and line so a later reader can search for it by its own name. Output lines are grouped by function with the first match and a count of the rest; a function with a large count is a template or a renderer, and the map should say which values flow into it rather than listing every line.

## Step 5: record what the lists missed

Write a short section to /workspace/research/tools/README.md that says which script outputs exist, which directories they cover, and which wrappers and dispatchers the map records that the scripts cannot see. Later agents read this before they trust a search of the lists as complete. A match in either list is a place to read, not a conclusion; a line's absence is a reason to search for the plugin's own name for the same mechanism, not evidence that it does not exist.

## Step 6: hand-over

When handing a subsystem to another agent, name the saved output files and the lines in them that belong to that subsystem, together with the map's section for it, instead of asking the other agent to run the scripts again. A child that reads only its lines of hooks.tsv and sinks.tsv, the matching part of the map, and the Corrections section starts with the same picture its parent had.
```

## 日本語訳

front matter: name `wbh-tools`。description「recon の地図ができた後、または固定したプラグインソース全体にわたる hook 登録と効果呼び出しの文字どおりの一覧が要るときに使う。このスキルの directory にある列挙 script 2 本を走らせ、出力を Trial の全 agent のために /workspace/research/tools に保存し、本体機能の固定参照を読み、3 つを /workspace/research/recon-map.md と突き合わせる。一覧は読む場所の HINT であり、finding ではない。」

### wbh-tools v1

人手でプラグインを読むと、読み手がたまたま開いたものだけが見つかる。本体が request をプラグインのコードへ解決する場所と、プラグインのコードが値を本体へ渡して効果になる場所を機械的に列挙すると、誰も開かなかった file も含めて、同じ種類の場所が全 file で一度に見つかる。列挙は安くて盲目である。文字を照合するので、プラグインが自前の wrapper、変数、同梱 framework を通して到達するものはすべて落とす。このスキルは、列挙を Trial ごとに 1 回走らせる方法、出力を全 agent が読める場所に置く方法、列挙と地図の差を誤った確信ではなく作業に変える方法を書く。列挙した場所が何を意味するかは書かない。それは目的文と出力契約が言う。

**Inputs。** 固定したプラグインソースは /workspace/main、供給された本体は /workspace/wordpress、他のプラグインと library は /workspace/dependencies/<slug>。/workspace/research は書き込み可で、Trial の全 agent が共有する。この SKILL.md の directory には enumerate-hooks-v1.sh、enumerate-sinks-v2.sh、core-fixed-list-v1.md の 3 file がある。script は第 1 引数にソースの root を取り、kind、file、line、一致した文の tab 区切りを root からの相対 path で出す。参照はどのプラグインにも同じで、プラグインの名前を含まない。

**手順 1: script を 1 回走らせ、出力を残す。** 各 script を sh で /workspace/main を引数に走らせ、出力を /workspace/research/tools/hooks.tsv と sinks.tsv に保存する。Trial で 1 回だけ行い、後の agent は保存した file を読む。出力が無い、または error で終わった script はそれ自体が記録すべき事実で、/workspace/research/tools/README.md に書いて人手で続ける。/workspace/dependencies の依存や library が読む面に入るなら、その directory に対してもう 1 回走らせ、別名で横に保存する。

**手順 2: 固定参照を checklist として読む。** core-fixed-list-v1.md は、プラグインが渡した値に本体が作用する機能と、request をプラグインのコードに解決する機能を、関係する本体関数とともに並べる。このプラグインで探す効果の種類と dispatch の種類の checklist として使い、何が悪いかの一覧としては使わない。末尾 2 列の数は履歴 mirror 全体の話で、このプラグインについては何も言わない。その数でこのプラグインを読む順を決めない。

**手順 3: hooks の一覧を地図と突き合わせる。** /workspace/research/recon-map.md を開く。地図にある各入口について hooks.tsv の行を探す。地図にあって一覧に無い入口は wrapper、変数名、framework の dispatcher の裏にある。地図の Corrections 節に wrapper と規則が無ければ記録する。一覧にあって地図に無い行は地図が落とした入口で、読んで handler と parameter とともに地図の subsystem と入口の表に足す。一覧が見られない登録（参照の表の下に書いてあるもの）は別の pass とし、地図が記録した loader と wrapper の規則をたどってプラグイン自身の名前で探す。

**手順 4: sinks の一覧を地図と突き合わせる。** 地図の各 subsystem について、その file の sinks.tsv の行を読み、地図の共有 helper 節にある保存先と効果と比べる。一覧にあって地図に無い呼び出しは地図が落とした効果で、足す。地図にあって一覧に無い効果は、プラグイン定義の method、変数関数名、同梱 framework を通しており、後の読み手が自分の名前で探せるよう wrapper を file と行で記録する。出力行は関数ごとに最初の一致と残りの数でまとまる。数が大きい関数は template か renderer で、地図は全行を並べるのでなく、どの値がそこへ流れるかを言う。

**手順 5: 一覧が落としたものを記録する。** /workspace/research/tools/README.md に、どの script 出力があるか、どの directory を覆うか、地図が記録した wrapper と dispatcher のうち script が見られないものは何かを短く書く。後の agent は一覧の検索を網羅と信じる前にこれを読む。一覧の一致は読む場所であって結論ではない。行が無いことは、同じ仕組みをプラグイン自身の名前で探す理由であって、無いことの証拠ではない。

**手順 6: 引き継ぎ。** subsystem を別の agent に渡すときは、script を走らせ直させるのでなく、保存した出力 file とその subsystem に属する行、地図の該当節を名指す。自分の行の hooks.tsv と sinks.tsv、地図の該当部分、Corrections 節だけを読んだ子は、親と同じ絵から始められる。

## 出典対照表

要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 機械的な列挙は全 file を一度に見るが、wrapper・変数・framework の裏を落とす | 冒頭の段落、手順 3・4 | [CVE ベンチの列挙再現率](2026-10-30-enumeration-recall-cve-bench.md): script が落とした類は wrapper 登録、本体へ値を渡す書き込み、JS 側の出口。script 自身の注記「Only literal registrations match … must be added by hand」（`enumerate-hooks-v1.sh`、`enumerate-sinks-v2.sh` 冒頭） |
| 出力は HINT で、Finding でも判定でもない。Harness は script を実行せず出力も読まない | 冒頭の段落、手順 5 | 所有者決定 2026-10-27「中身は AI、形は Harness。script は AI の道具」。不変条件 3（Harness は判定器を持たない）。ADR 0042 の列挙を「HINT」として渡す設計（ADR 0042 追記 1） |
| 固定ソースと /workspace/research の置き場 | Inputs | 目的文 v11「Read the supplied dependency source instead of recalling」「Every agent writes its findings to /workspace/research/<family>.md」。`sandbox-layout.ts` の mount path |
| script の引数と出力形式 | Inputs | script 冒頭の注記（第 1 引数 = root、既定 /workspace/main、tab 区切り kind/file/line/text） |
| Trial で 1 回走らせ、保存した file を後の agent が読む | 手順 1、手順 6 | Cloudflare「親だけが共有 file を書く、hunter は scratch に書く」（`SKILL.md:56-66`、[2026-10-27 報告](2026-10-27-public-harness-repos-responsibility-split.md)）。目的文 v11「Findings that exist only in an agent's context are lost work」 |
| 走らない script は記録して人手で続ける | 手順 1 | 不変条件 4 の考え方（環境の失敗は結果にしない）を agent 側に写したもの。ADR 0042 の列挙 pipeline が形 error を差し戻した経験（#674） |
| 依存と library にも走らせる | 手順 1 | SPEC 第 6 節「探索ではすべてのソースを読み取り専用で渡し」。wbh-recon v1 Inputs |
| 固定参照は checklist で、何が悪いかの一覧ではない。mirror の数はこのプラグインについて何も言わない | 手順 2 | `core-fixed-list-v1.md` 自身の冒頭 2 段落（「it is not a list of what is wrong, and it names no plugin」「they say nothing about this plugin」）。ADR 0012（公開履歴はカタログ情報に限る） |
| 地図との突き合わせ: あって無い、無くてある、の 2 方向 | 手順 3・4 | wbh-recon v1 手順 3「A search for core function names alone misses everything behind a wrapper; a search for the wrapper's name finds the rest」。Anthropic「型を列挙すると recall が下がる」の対照として、列挙を型でなく場所の HINT に限る（`docs/prompting.md:23-32`） |
| 一覧が見られない登録を別 pass にする | 手順 3 | `core-fixed-list-v1.md` の「Not counted, still dispatch」段落 |
| 関数単位のまとめと、数が大きい関数の扱い | 手順 4 | `enumerate-sinks-v2.sh` の出力形（関数ごとに最初の一致 + extra 数、#658 fix） |
| Corrections に追記し上書きしない | 手順 3 | wbh-recon v1 手順 7（Corrections 節） |
| 引き継ぎは保存した出力の行と地図の節を名指す | 手順 6 | 目的文 v11「Each agent is given one piece of work and returns when that piece is done」。wbh-recon v1 手順 8 |

## 書かなかったもの（規則どおり）

- 型の一覧、判断の基準、脆弱性の語: 契約 v5 / v17 の教訓（ADR 0038 追記 15、ADR 0039 追記 12）。本文は「効果」「入口」「保存先」としか言わない。種類の名前は支援 file の側にある。
- script の出力を Harness が集める、数える、閾値を置く: 不変条件 3 と所有者決定 2026-10-27。出力は /workspace/research にだけ残り、research artifact として全件保存される。
- 最低時間、子の数: Harness が Run parameters で強制する（ADR 0039 追記 3・4）。
- 対象固有の名前、再現の手順、公開履歴の個別記録: 不変条件 1。`core-fixed-list-v1.md` の数は mirror 全体の集計で、対象ごとの記録ではない。
