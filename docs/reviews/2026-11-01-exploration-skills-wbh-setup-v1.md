# 探索スキル wbh-setup v1 の全文・日本語訳・出典対照表（2026-11-01）

[Issue #749](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/749)、[ADR 0043](../adr/0043-exploration-skills-in-the-sandbox.md) の 2026-11-01 追記 2、[ADR 0044](../adr/0044-prior-leads-input.md) の 2026-11-01 追記 2。提案と事実は [2026-11-01-lab-normal-use-setup-proposal.md](2026-11-01-lab-normal-use-setup-proposal.md)（所有者 ok、2026-11-01）。agent に渡る文章の規則（DEVELOPMENT 第 5 節）に従い、全文、日本語訳、出典対照表を置く。本文は手順だけで、型の一覧、判断の基準、対象固有の名前、再現の手順、Harness が強制する数は書いていない（test `tests/profiles/wordpress/skill-definitions.test.ts` で固定）。

このスキルは、Lab 付きの Trial で、plugin を「有効化しただけ」の site から「普通の site が使っている」状態へ agent 自身が持っていく手順である。Harness は Lab の初期化（core install、plugin の有効化、基準、account、初期記事）を変えず、シナリオも plugin 別アダプタも持たない（#353）。readme.txt は固定ソースの zip に入っているので、新しい入力は渡さない（不変条件 1）。

## 置き場と digest

- file: `src/profiles/wordpress/prompts/skills/wbh-setup-v1/SKILL.md`（支援 file なし）
- digest: `sha256:91f28b330b3d24950844a3ac5257d26635dc7a79926ef7c244e18eb3e79bd02c`
- registry: `src/profiles/wordpress/prompts/skills.ts` の `wbh-setup-v1`（name `wbh-setup`、status `current`）
- sandbox での置き場: Codex `CODEX_HOME/skills/wbh-setup/`、Claude `CLAUDE_CONFIG_DIR/skills/wbh-setup/`
- 有効化: campaign 設定 `"discovery": { "lab": "attached", "skills": ["wbh-recon-v1", "wbh-tools-v1", "wbh-setup-v1"] }`。Lab の無い Trial では `## Lab` 節が無いので使われない

## 全文（英語、staging される byte そのもの）

```markdown
---
name: wbh-setup
description: Use when the Trial has a Lab (the ## Lab section names a site and an administrator account), after the recon map exists and before any agent sends requests to the Lab. Reads the plugin's readme.txt and the recon map to list the features a site owner uses and the objects they create to use them, sets the plugin up in the Lab the way an ordinary site would, publishes one page per object, and records what was built in /workspace/research/lab-setup.md for every agent in the Trial.
---

# wbh-setup v1

A plugin that is only activated shows almost none of itself to a visitor. Its forms, galleries, tables, listings and the pages that hold them exist only after a site owner creates them, and a request that reaches a handler often reads an object the owner made first. A Lab in that state answers every request the same way, and an agent that tries the Lab against it learns nothing about the plugin as sites run it. This skill describes how to bring the Lab to the state of an ordinary site that uses the plugin, from the sources the Trial already has, and how to record that state so that every agent reads the same site and a reset rebuilds it. It does not say what to try against the site afterwards. The objective and the output contract say that.

## Inputs

The Trial's `## Lab` section names the site address, the administrator account and the low-privilege accounts, and the reset and observe commands with their budgets. The pinned plugin source is at /workspace/main, and the plugin's own readme.txt is in it: its Description, Installation, FAQ and Screenshots sections are the text the plugin's directory page shows, so no other source of that text is needed. The recon map is at /workspace/research/recon-map.md. The research directory /workspace/research is writable and shared by every agent in the Trial; the setup record lives there. The administrator account is for building the site; anything built with it that an ordinary site would not have is a precondition to state, not a fact about the plugin.

## Step 1: list the features and the objects behind them

Read readme.txt first: Description for what the plugin does for a site, Installation for the steps a site owner takes after activation, FAQ for the settings and objects it assumes, Screenshots captions for the screens the owner uses. Then read the map's Subsystems and Entries sections and the admin pages, shortcodes, blocks, widgets and routes they record. Write the list of features a visitor or a logged-in member of the site would see or use, and for each one the object the owner creates to make it exist: a form, a gallery, a table, a slider, a listing, an event, a booking resource, a membership level, a product, a feed source, a map, a popup, a template. A feature the readme describes but the map does not place is a reason to read the source again; a subsystem the map records but the readme never mentions is still a feature, and goes on the list. Mark features that need an external account or an outside service as such; they are not built here.

## Step 2: finish the plugin's own first-run flow with defaults

Log in as the administrator and open the plugin's menu. If the plugin shows an onboarding or setup wizard, a notice asking for a first step, or an import of sample content, complete it choosing the default or recommended option each time, and skip steps that connect to an outside service or ask for a key. Leave settings at their default values; turn on the features from Step 1 only where the plugin ships them off and its readme presents them as ordinary use. Do not change settings a typical site would leave alone. Every setting changed from its default is written down in Step 4, and a Finding or Lead whose route depends on it states it in `configurationPrecondition`.

## Step 3: create one of each object and publish it

For each object in the Step 1 list, create one instance through the plugin's own admin screens or its own REST routes as the administrator, with the content a demonstration site would carry: a few fields, a title, an image from the media library where the object takes one. Keep the plugin's defaults for every field it fills in itself. Then publish one page per object that holds it, through the plugin's shortcode or block as its readme or screens show, and give the page a title that names the object. Where the plugin adds its own public pages or archives on activation, record their addresses instead of making pages. Where a feature works on ordinary content, make the content it works on: a post with the plugin's block, a comment thread, a product in the cart, a profile with the plugin's fields. Where the ordinary flow has a visitor or a low-privilege member create data, create one item that way, logged in as the Lab's low-privilege account or not logged in, using the published page: one form submission, one comment, one booking, one registration. Every object and every piece of content has an author or an owner, as it would on a real site. Stop building an object when it needs an outside service, a paid add-on or a dependency the Lab does not have, and record what stopped it.

## Step 4: write the setup record

Write /workspace/research/lab-setup.md with these sections, in this order: Features, the Step 1 list with the readme section or map row each came from; Settings changed, every setting changed from its default with the screen it was changed on and the value, or the word "none" when nothing changed; Objects, a table with columns object, how it was created, its admin address, the published page that holds it and the page's address; Content, the items created as a visitor or a low-privilege member and which account made each; Not built, the features and objects from Step 1 that were not built and why; Verified, the published pages opened once with the Lab's observe command as a visitor, with the HTTP status each returned. Every address is a path on the Lab site. Other agents append under a Changes section at the end, dated, when they add to the site; they do not rewrite the sections above.

## Step 5: rebuild after a reset

A reset removes the whole site and provisions it again from the Harness's setup, which does not include anything this skill built. After a reset, repeat Steps 2 and 3 from the record, in the order of the Objects table, and append to the Changes section that the site was rebuilt and whether anything differed. An agent that needs a clean site weighs that cost against the reset budget the `## Lab` section states.

## Step 6: hand-over

When handing a subsystem to another agent, name the Objects rows and the published pages that belong to it, together with the Settings changed section, instead of describing the site in prose. A child that reads its rows of lab-setup.md and the matching section of the map knows which pages to open and which account to use before it sends its first request. An agent that finds the record wrong, or finds an object missing, fixes the site and appends the correction with the date.
```

## 日本語訳

front matter: name `wbh-setup`。description「Trial に Lab があるとき（`## Lab` 節が site と管理者 account を名指ししているとき）、recon の地図ができた後、どの agent も Lab に要求を送る前に使う。plugin の readme.txt と recon の地図を読んで、site の持ち主が使う機能と、それを使うために作る object を挙げ、普通の site がするように plugin を Lab で設定し、object ごとに 1 ページを公開し、作ったものを Trial の全 agent のために /workspace/research/lab-setup.md に記録する。」

### wbh-setup v1

有効化しただけの plugin は、訪問者にほとんど何も見せない。フォーム、ギャラリー、表、一覧と、それを載せるページは、site の持ち主が作って初めて存在し、handler に届く要求は、持ち主が先に作った object を読むことが多い。その状態の Lab はどの要求にも同じ答えを返し、そこで Lab を試す agent は、site が動かしている姿の plugin について何も学ばない。このスキルは、Trial がすでに持っている情報から、plugin を使っている普通の site の状態へ Lab を持っていく方法と、全 agent が同じ site を読み、reset の後に作り直せるようにその状態を記録する方法を書く。その後で site に何を試すかは書かない。それは目的文と出力契約が言う。

**Inputs。** Trial の `## Lab` 節が、site の address、管理者 account と低権限 account、reset と observe の命令とその予算を名指ししている。固定した plugin のソースは /workspace/main にあり、plugin 自身の readme.txt はその中にある。Description、Installation、FAQ、Screenshots の節は plugin の directory page が表示する文そのものなので、その文の別の出所は要らない。recon の地図は /workspace/research/recon-map.md。/workspace/research は書き込み可で Trial の全 agent が共有し、setup の記録はそこに置く。管理者 account は site を作るためのもので、それで作ったもののうち普通の site に無いものは、述べるべき前提であって、plugin についての事実ではない。

**手順 1: 機能と、その裏にある object を挙げる。** まず readme.txt を読む。Description は plugin が site に何をするか、Installation は有効化の後に持ち主が踏む手順、FAQ は前提にしている設定と object、Screenshots の caption は持ち主が使う画面。次に地図の Subsystems と Entries の節と、そこに記録された管理画面、shortcode、block、widget、route を読む。訪問者か site のログイン会員が見る・使う機能の一覧を書き、機能ごとに、持ち主がそれを存在させるために作る object を書く。フォーム、ギャラリー、表、スライダー、一覧、イベント、予約枠、会員レベル、商品、feed の source、地図、popup、template。readme にあって地図に置き場の無い機能はソースを読み直す理由で、地図にあって readme が触れない subsystem もやはり機能であり、一覧に入れる。外部の account や外のサービスが要る機能はそう印を付ける。ここでは作らない。

**手順 2: plugin 自身の初回の流れを既定値で終える。** 管理者でログインし、plugin のメニューを開く。onboarding や setup の wizard、最初の一歩を促す notice、sample content の import が出るなら、毎回既定か推奨の選択肢を選んで完了し、外のサービスへ接続する段や key を求める段は飛ばす。設定は既定値のままにする。手順 1 の機能のうち plugin が off で出荷し、readme が普通の使い方として示すものだけを on にする。典型的な site が触らない設定は変えない。既定から変えた設定はすべて手順 4 に書き、その設定に依存する route の Finding / Lead は `configurationPrecondition` にそれを述べる。

**手順 3: object を 1 つずつ作って公開する。** 手順 1 の各 object について、管理者として plugin 自身の管理画面か自身の REST route で 1 つ作る。中身はデモ site が持つ程度: 欄をいくつか、題名、object が受けるなら media library の画像 1 枚。plugin が自分で埋める欄は plugin の既定のまま。次に、object を載せるページを object ごとに 1 枚、readme か画面が示すとおりに plugin の shortcode か block で公開し、object の名前を題名にする。plugin が有効化時に自分の公開ページや archive を足すなら、ページを作る代わりにその address を記録する。機能が普通の content に働くなら、その content を作る: plugin の block を置いた記事、コメントの連なり、cart に入れた商品、plugin の欄を持つ profile。普通の流れで訪問者か低権限の会員が data を作るなら、公開したページを使って、Lab の低権限 account でログインするか未ログインで、その形で 1 件作る: フォーム送信 1 件、コメント 1 件、予約 1 件、登録 1 件。どの object も content も、実際の site と同じく作者か持ち主を持つ。外のサービス、有料 add-on、Lab に無い依存が要る object はそこで止め、何が止めたかを記録する。

**手順 4: setup の記録を書く。** /workspace/research/lab-setup.md に次の節をこの順で書く。Features: 手順 1 の一覧と、各項目の出所の readme の節か地図の行。Settings changed: 既定から変えた設定すべてと、変えた画面と値。何も変えなければ「none」。Objects: object、作り方、管理側の address、載せた公開ページ、そのページの address の表。Content: 訪問者か低権限の会員として作った項目と、どの account が作ったか。Not built: 手順 1 のうち作らなかった機能と object と理由。Verified: 公開ページを Lab の observe 命令で訪問者として 1 回ずつ開いた結果の HTTP status。address はすべて Lab の site 上の path。他の agent は site に足したとき末尾の Changes 節に日付付きで追記し、上の節を書き換えない。

**手順 5: reset の後に作り直す。** reset は site 全体を消し、Harness の setup から立て直す。その setup にはこのスキルが作ったものは入っていない。reset の後は、記録から手順 2 と 3 を Objects 表の順に繰り返し、site を作り直したことと違いがあったかを Changes 節に追記する。きれいな site が要る agent は、その手間を `## Lab` 節にある reset の予算と天秤にかける。

**手順 6: 引き継ぎ。** subsystem を別の agent に渡すときは、site を文章で説明するのでなく、その subsystem に属する Objects の行と公開ページ、Settings changed の節を名指す。自分の行の lab-setup.md と地図の該当節を読んだ子は、最初の要求を送る前に、どのページを開きどの account を使うかを知っている。記録が間違っている、object が無いと気づいた agent は site を直し、日付付きで訂正を追記する。

## 出典対照表

要素は出典にあるものだけで、足していない。

| 要素 | 本文の場所 | 出典 |
| --- | --- | --- |
| 有効化しただけの Lab では plugin の姿が見えず、通常利用を作る | 冒頭の段落 | 所有者の指示 2026-11-01「プラグインを単純に有効化するだけではなく … 通常利用とか、その辺調べて、一通り作る」。提案 §1.1（`wordpress-initialization.ts` は有効化で止まる）、§1.3（Lab 付き 6 run の要求 41、observe 0） |
| readme.txt を情報源にし、wp.org の page は取りに行かない | Inputs、手順 1 | 所有者の指示「readme.txt というより wp.org などから」に対し、提案 §1.4: readme.txt は zip ごと固定ソースに入り wp.org の page と同じ内容。不変条件 1（探索に渡すのは固定ソースとカタログ情報だけ）。sandbox に internet は無い（ADR 0003 追記「Lab の HTTP と制御口だけ」） |
| `## Lab` 節の account、reset、observe、予算 | Inputs、手順 4・5 | `src/cli/wordpress.ts` `wordPressLabSection`（管理者と低権限 account、`POST /reset` は同じ setup から立て直す、`POST /observe` は role と path で 1 ページ開き HTTP status を返す、予算は答えに出る）。ADR 0003 2026-10-25 追記 |
| 管理者で作った設定は `configurationPrecondition` に述べる | Inputs、手順 2 | `## Lab` 節「A setting you make as administrator is a configuration precondition; state it in `configurationPrecondition`」。所有者決定 2026-10-26「探索は広く出し、落とすのはレビュー側」 |
| 地図の Subsystems / Entries から管理画面、shortcode、block、route を読む | 手順 1 | wbh-recon v1 手順 2（subsystem は site の利用者から見える機能で分ける）、手順 3（shortcode、block、admin page、REST を入口として記録）、手順 7（節の名前） |
| 外のサービスが要る機能は作らない | 手順 1・2・3 | 所有者の指示 2026-11-01「外部サービスとの連携が必要なものは … 今までと変わらずソースだけの探索にして、有望なら人間が後から」。ADR 0046 |
| 既定値のまま、典型的な site が触らない設定は変えない | 手順 2 | Programme Boundary（campaign 設定）「A plugin setting an administrator can enable is not an exclusion when a typical site may plausibly enable it; the Finding must state the setting as the precondition」。契約の `configurationClass` の文「An administrator uses a feature as intended, in a way a typical site may plausibly use it」（`finding.ts`） |
| object を 1 つずつ作り、shortcode か block でページに置く。訪問者や低権限者の data を 1 件作る | 手順 3 | 所有者の指示「フォーム設定の通常利用 … 一通り作る」。提案 §2.2 手順 3（所有者 ok）。ADR 0035「前提は Lab の通常機能の設定で満たせる」 |
| どの object も content も作者か持ち主を持つ | 手順 3 | #718（作者無しの初期記事が実 site に無い状態を作った教訓。`wordpress-initialization.ts` の `seedInitialPosts` 注記） |
| 記録 file の置き場と、他 agent は追記のみ | 手順 4・6 | 目的文 v11「Routes that exist only in an agent's context are lost work; write them down」（`persistence/research-v11`）。wbh-recon v1 手順 7（Corrections に追記、上書きしない）。research directory は Trial ごとに封印される（`codex-gvisor-sandbox.ts` `research-directory-archive`） |
| 公開ページを observe で開いて status を記録する | 手順 4 | `## Lab` 節の observe の答え（path の HTTP status）。設計書 2026-11-01「スキル 1 本に単体テスト 1 つ: そのスキルの成果物だけで採点できる形」 |
| reset は Harness の setup にだけ戻るので作り直す | 手順 5 | ADR 0003 2026-10-25 追記「Harness が WordPress・DB・site volume を作り直し、同じ setup から初期化する」。`## Lab` 節「provisions it again from the same setup」 |
| 引き継ぎは記録の行を名指す | 手順 6 | wbh-recon v1 手順 8、wbh-tools v1 手順 6 |

## 書かなかったもの（規則どおり）

- 何を試すか、型の一覧、判断の基準: 目的文と契約の側にある（ADR 0043「本文の規則」、契約 v5 の教訓 ADR 0038 追記 15）。本文は「site を普通の状態にする」までで止まる。
- 対象固有の plugin 名、画面名、option 名: 不変条件 1 と AGENTS.md「プロンプトとシナリオに対象固有の関数名、オプション名、URL、画面名を入れない」。object の例（フォーム、ギャラリー…）は種類の名前で、plugin の名前ではない。
- Harness が記録を読む、数える、判定する: 不変条件 3、所有者決定 2026-10-27「中身は AI、形は Harness」。`lab-setup.md` は research artifact として封印されるだけで、Harness は中身を読まない。
- 制限時間、子の数、reset と observe の回数の値: Harness が Run parameters と `## Lab` 節で伝える（ADR 0039 追記 3・4、ADR 0003 追記）。本文は「`## Lab` 節にある予算」としか言わない。
- 検証スキル `wbh-verify` の前提作りの変更: 別の問い。この PR では変えない（提案 §2.2 手順 5 は次の Issue）。
