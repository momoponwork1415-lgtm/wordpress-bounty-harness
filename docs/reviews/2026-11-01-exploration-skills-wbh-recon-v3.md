# 探索スキル wbh-recon v3 の全文・日本語訳・出典対照表（2026-11-01）

[Issue #714](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/714)、[Issue #686](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/686)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-01 追記 4。v2 との差は description の末尾の 1 文と手順 9「closing」だけで、他は byte 単位で同じ。手順 1〜8 の日本語訳と出典対照表は [2026-11-01-exploration-skills-wbh-recon-v2.md](2026-11-01-exploration-skills-wbh-recon-v2.md) と [2026-10-30-exploration-skills-wbh-recon-v1.md](2026-10-30-exploration-skills-wbh-recon-v1.md) のとおり。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-recon-v3/SKILL.md`（支援 file なし）
- digest: `sha256:5563a8df752e112ea0bed7329bf1755b2cde9d4210e41b6802fb07270a2b6970`
- registry: `wbh-recon-v3`（name `wbh-recon`、status `current`）。`wbh-recon-v1` と `wbh-recon-v2` は `archived`
- 有効化: campaign 設定 `"discovery": { "skills": ["wbh-recon-v3", "wbh-tools-v1", "wbh-setup-v1"] }`

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-recon
description: Use at the start of exploring a WordPress plugin's pinned source, before forming hypotheses or starting other agents, and again when an agent is handed a part of the plugin it has not read. Builds a map of the plugin's subsystems, request entries, authorization gates, shared helpers, data stores and the JavaScript boundary, and writes it to /workspace/research/recon-map.md for every agent in the Trial to read. Use it once more before the final report, to decide from the research files whether the work is finished.
---

# wbh-recon v3

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

When work is split among agents, split it along the map: a subsystem with its entries, its shared helpers and its stores is one unit. Each agent receives the map's section for its unit, the Wrappers table, and the list of shared gate functions, and reads the map before the source. Start each child without the parent's conversation when the spawn tool offers that choice (a fresh history, not a fork of the parent's), and put the unit's map section, the rows of the saved research files it needs and its task into the child's first message; a child that begins from the files sees the same picture its parent had without carrying the parent's reading. An agent that finishes writes what it read and what it left unread into its own research file and the Corrections section, so that the next agent on the same unit continues instead of restarting.

## Step 9: closing

The Trial ends when the research files show that nothing readable is left open, not when the rows of a listing have been counted. Before the final report, the agent that coordinates the Trial checks three things against /workspace/research and continues the work wherever one of them fails.

1. Every entry in the map and every row of the hook listing is in one of two states: its handler has been read to the point where the request is stopped by a check or reaches its effect, with the file and line of that point recorded; or it is listed as unread with a reason. A row classified from its registration or from the handler's name alone is still open.
2. Every route that a specialist wrote down as reaching a store, an output or an effect with a gap remaining has been read a second time by an agent other than the one that wrote it. That agent starts from the route's file and line and the written gap, with the task of settling the gap from the supplied source either way, and records the result under the route: settled, with the file and line that shows it, or not settleable from the supplied source, with the missing piece named. A gap written down and left is open.
3. Each item under Unread and under Open questions has been read, or carries a reason that still holds.

When all three hold, append a Closing section to the registry the objective asks for, with the counts: entries read to their check or effect, entries unread with a reason, routes with a gap settled, routes not settleable from the supplied source, and the elapsed time. Then give the final report. When the Trial wall arrives first, append the same section with the counts as they stand and state that the wall ended the work.
```

## 日本語訳（v2 からの差分だけ）

> **description の末尾に足した 1 文:** 最終報告の前にもう一度使い、研究 file から仕事が終わっているかを判断する。

**手順 9: 終了.** Trial は、研究 file が「読めるものは何も開いたまま残っていない」と示したときに終わる。一覧の行を数え終えたときではない。最終報告の前に、Trial を取りまとめる agent は /workspace/research に対して次の 3 つを確かめ、どれかが満たされていなければそこで仕事を続ける。

1. 地図の全 entry と hook 一覧の全行が、次の 2 つの状態のどちらかにある: handler を、要求が check で止められる点か効果に届く点まで読み、その点の file と行を記録した; または、理由付きで未読として挙げた。登録だけ、または handler の名前だけから分類した行は、まだ開いている。
2. 専門の agent が「保存先・出力・効果に届いたが隙間が残る」と書いた経路のそれぞれを、書いた agent とは別の agent が 2 回目に読んだ。その agent は経路の file と行と書かれた隙間から始め、供給されたソースからどちらかに決着させることを task とし、結果を経路の下に記録する: 決着した（それを示す file と行付き）、または供給されたソースでは決着できない（足りないものの名前付き）。書いて放置した隙間は開いている。
3. Unread と Open questions の各項目が、読まれたか、まだ成り立つ理由を持っている。

3 つが揃ったら、目的文が求める登録簿の末尾に Closing 節を足し、件数を書く: check か効果まで読んだ entry、理由付きで未読の entry、隙間が決着した経路、供給ソースでは決着できない経路、経過時間。その後に最終報告をする。Trial の wall が先に来たら、同じ節をその時点の件数で書き、wall が仕事を終えたと述べる。

## 出典対照表（v2 からの差分だけ。他の行は v1 / v2 の表のとおり）

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 行を数え終えても終わらない。登録・名前だけの分類は開いたまま | 手順 9 冒頭と 1 | 本番 v21 の 10 Trial（2026-11-01）: 全 Trial の REGISTRY.md が hooks.tsv 全行を「読了 / 残 0」と記録して 9〜54 分で閉じた。子は 1 体 3〜4 分。#714 の停止文は守られていて、行の分類で満たせる（ADR 0043 追記 4） |
| 隙間のある経路は別の agent が読み直し、決着か「供給ソースでは決着できない」を書く | 手順 9 の 2 | #686 提案 2「候補はそれぞれ別の子が読み直し、開いた仮説が無くなったら終える」。10 Trial で Lead 40 件に対し Finding 6 件、Lead を詰める段が無い（ADR 0044 背景） |
| Unread と Open questions の各項目 | 手順 9 の 3 | v1 手順 7 が地図に置いた 2 節。54 分の Trial でも Unread に「handler 本体は判断していない」が残っていた |
| Closing 節の件数と wall の扱い | 手順 9 末尾 | #686 提案 2「終えた理由は /workspace/research に残し、Harness は観測だけ記録する」。wall は Harness が強制する唯一の上限（AGENTS.md「Harness と AI の責務」） |
| description の 1 文 | frontmatter | 目的文 v21 の routing 段落は「wbh-recon を最初に読む」としか言わないので、最終報告の前にも読む合図を description に置く（目的文は変えない。ADR 0045 第 5 項） |

## 書かなかったもの（規則どおり）

- 時間の下限、子の数、読む file 数の目標: Harness が `## Run parameters` で伝える wall のほかに数字を置かない。
- 判定の基準、型の一覧、対象固有の名前: v1 / v2 と同じ。
- Lab の使い方: 手順 9 は研究 file だけで判断する。Lab のある Trial の前提作りは `wbh-setup` のまま。
