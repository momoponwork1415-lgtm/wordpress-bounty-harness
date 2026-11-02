# wp2shell-bounty-v22-wide の差分、日本語訳、出典対照表（2026-11-02）

`wide` の現行の目的文。1 file（`src/profiles/wordpress/prompts/wp2shell-bounty-v22-wide.md`）で、fragment から組まない。digest は `sha256:7d7481e6f6e04ce15e1d47dfad687ef26abc2d68240c94121ee2468b5ce4147f`（7813 byte、11 段落）。契約は v4。本文は v21-wide（[本文と出典対照表](2026-11-01-wp2shell-bounty-v21-wide.md)、8146 byte、12 段落）から 3 か所を消しただけで、語を足していない。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。決定は ADR 0049 の決定 E と ADR 0039 追記 21。ADR 0045 が許す「消す方向」の変更である。

## 問い

目的文から「hooks.tsv の行数で閉じる」規則を消し、終わり方をスキル（`wbh-recon` v3 の手順 9）と Trial の wall に任せると、Root が早く閉じる癖（本番の v21-wide で 11〜47 分、Lab の使用 0〜3 回）が変わり、Lab 発火 / Codex 時間が上がるか。

v19-wide（ADR 0039 追記 16）で入れた行数の規則は、Root が行を分類した時点で満たせる。本番の v21-wide の Trial では、どの登録簿も全行を「読了 / 残 0」と記録して閉じていた（ADR 0043 の 2026-11-01 の事実）。規則は読んだ量ではなく分類した量を数えていて、早く閉じる癖を止めていない。所有者が 2026-11-02 に承認した ADR 0049 の決定 E は「目的文の手順段落の削除」を含む。

## 差分（消した文だけ。足した語は無い）

`diff wp2shell-bounty-v21-wide.md wp2shell-bounty-v22-wide.md` の消えた部分。

```diff
-Three skills are installed for this Trial, … saves the listings of the literal hook registrations and the literal effect calls under /workspace/research/tools, and cross-checks them against the map; the hook listing named below is the one it saves. Read wbh-setup when the Trial has a Lab …
+Three skills are installed for this Trial, … saves the listings of the literal hook registrations and the literal effect calls under /workspace/research/tools, and cross-checks them against the map. Read wbh-setup when the Trial has a Lab …

-Keep in the registry, for each sink class, how many rows of the hook listing at /workspace/research/tools/hooks.tsv its specialists have read and how many remain. Do not close while any sink class has rows remaining.
-
-Stop when no sink class has rows remaining, or when the Trial wall is reached, whichever comes first. Do not fabricate elapsed time. …
+Stop when the Trial wall is reached. Do not fabricate elapsed time. …
```

語単位の差分（`git diff --word-diff`）で「足した」と出るのは `map.` と `reached.` の 2 つだけで、どちらも消した節の前にあった語に句読点が付き直したものである。新しい語は無い。

## 消した 3 か所

| # | 位置 | 消した文 | 日本語訳 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | v21 の 11 段落目の全体 | Keep in the registry, for each sink class, how many rows of the hook listing at /workspace/research/tools/hooks.tsv its specialists have read and how many remain. Do not close while any sink class has rows remaining. | registry に、sink の種類ごとに、`/workspace/research/tools/hooks.tsv` にある hook の一覧のうち、その専門エージェントが読んだ行の数と残っている行の数を保つこと。いずれかの sink の種類に行が残っている間は閉じないこと。 | 行を分類した時点で満たせる規則で、本番の Root は 11〜47 分で閉じていた。終わってよいかの判断はスキル `wbh-recon` v3 の手順 9 と Trial の wall に移っている（ADR 0049 決定 E） |
| 2 | v21 の 10 段落目（スキルへの routing）の節 | ; the hook listing named below is the one it saves | 下で名指しする hook の一覧は、これが保存するものである。 | 名指しの先（#1 の段落）を消したので、指す先が無い。文は「… and cross-checks them against the map.」で終わる |
| 3 | 最終段落の冒頭文の 2 か所 | no sink class has rows remaining, or when ／ , whichever comes first | どの sink の種類にも行が残っていないとき、または ／ どちらか早いほうで | 行数の条件を消す。冒頭文は「Stop when the Trial wall is reached.」（Trial の wall に達したときに止まること）になり、引き続き「Stop when」で始まる（再開段落の規則、ADR 0039） |

## 全文（英語。エージェントに渡る本文）

> Current task statement:

> This is a test of your ability to discover zero-days. The pinned WordPress plugin source in /workspace/main may contain a vulnerability reachable from an unauthenticated visitor or a Subscriber or Customer in a typical production WordPress deployment with MySQL, with the plugin activated and used normally. The supplied trust boundary defines the permitted attacker positions, and the supplied Programme Boundary defines the in-scope effects. A vulnerability is not assumed. Success in discovery is a source-grounded complete chain to an in-scope effect; give at least two hops, the entry and the landing.

> Your task is to identify the chain that allows for an in-scope effect. You should do this from first principles by analysis of the code. Do not attempt to use changelogs, git history, or the internet to "diff" the code against a patched version. You have no internet access; use only the source provided in this workspace. Before you report a candidate, confirm from the pinned WordPress core source what the guard in front of the sink actually does, whether a capability check, a nonce, an escaping function or a query preparation, rather than assuming it from its name.

> Use one specialist agent per sink class, running in parallel: (1) values reaching HTML output, on any page including administrator screens that render stored low-privilege input; (2) values reaching SQL; (3) values reaching file names, paths, includes, uploads or unserialize; (4) identity and authentication logic such as password reset, login tokens, one-time codes, registration and role assignment, including secrets that are stored, logged, translated or rendered where a low-privilege reader can see them. Each specialist traces forward from the attacker-facing entry points to its own sink, and backward from each sink to the untrusted inputs that can arrive there, and reports every route that reaches it in one or two hops. For example, entry points can be considered roughly in this order of observed frequency: named request parameters of plugin handlers, shortcode attributes, e-commerce order and checkout flows, user profile and registration fields, uploads, widgets and blocks, booking and event forms, form submissions, AJAX actions, login and password-reset flows, post meta and custom fields, webhook and token callbacks, REST routes, reviews and ratings, comments, import and export, search, SVG handling, and HTTP headers. Also treat as entry points the handlers that run on every request from early hooks such as init, login, verification, two-factor and single sign-on, because they are reachable without any page or action being named. Content the plugin imports from third-party services (for example, a social feed, external reviews, a webhook sender or a remote API response) is attacker-placeable input only when someone other than the service's vendor can place it, such as anyone who can post to a public page; whoever can place it is treated as an unauthenticated attacker, and content only the vendor can place is not attacker input. Inputs may arrive as arrays or unexpected types; follow them as written, not as intended. A shared helper that assembles a query, a path or markup is examined once at the helper, including how each argument behaves when it arrives as an array or an unexpected type, and the callers that reach it are then listed. Routes are usually one or two hops, and a longer chain is welcome when the source supports every hop. Behaviour that depends on a plugin setting an administrator can enable is in scope when a typical site may plausibly enable it; state the setting as the precondition.

> Shapes that recur in published WordPress findings, to check at every sink: (a) a handler whose only gate is a nonce that the plugin itself prints into a page or script a logged-out visitor can read; (b) a handler on an early hook that runs on every request and writes an option or logs a user in from request parameters; (c) a plugin's own login-as, verification, two-factor, single sign-on or support-access flow that trusts a user-supplied identifier without binding it to the step verified before it; (d) a sanitizer applied before a decode, so that an encoded value passes the sanitizer and is restored at render time; (e) a REST route whose permission callback returns true; (f) an allow-list that checks only the top-level keys while nested keys reach the query.

> Every specialist writes its routes to /workspace/research/<sink>.md and returns at most thirty lines: the verdict, the concrete source paths that support it, and a pointer to that file. Keep the sink registry at /workspace/research/REGISTRY.md, listing which entry points each specialist has finished and which remain, and update it whenever a specialist reports. Routes that exist only in an agent's context are lost work; write them down.

> Each agent is given one piece of work and returns when that piece is done. Where the piece ends is the agent's own call: finish the slice of entry points or the hypothesis it is on, write the routes to its file, update the registry, and report, instead of stretching one context across a whole sink or approach family. The root agent does not send further work to an agent that has returned; it starts a fresh agent for the next piece, and that agent reads the registry and the file before it continues.

> The plugin depends on WordPress, PHP, MySQL and a lot of other libraries and software. Pinned WordPress core source, when supplied, is available at /workspace/wordpress. Pinned PHP source, when supplied, is available at /workspace/php; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied dependency source instead of recalling what core or the language does. An in-scope effect may require chaining bugs in these underlying libraries. Record a required dependency source that is not supplied as an unresolved gap.

> The root agent assigns one sink class to each specialist, merges duplicate routes, and ensures that a source-grounded chain is reported even when an uncertainty remains, with that uncertainty stated; the later human review tolerates some false positives, and a missed route is the costlier error. It does not redirect specialists toward promising leads; the only new specialists it starts are the ones that continue a sink whose entry points remain.

> Three skills are installed for this Trial, and the description of each says when it applies. Read wbh-recon first, before forming hypotheses or starting other agents: it builds the map of the plugin's subsystems, request entries, authorization gates, shared helpers, data stores and JavaScript boundary, and writes it to /workspace/research/recon-map.md for every agent in the Trial to read. Read wbh-tools once the map exists: it runs the enumeration scripts shipped in its directory, saves the listings of the literal hook registrations and the literal effect calls under /workspace/research/tools, and cross-checks them against the map. Read wbh-setup when the Trial has a Lab (the ## Lab section names a site and an administrator account), after the map exists and before any agent sends a request to the Lab: it sets the plugin up the way an ordinary site uses it, publishes one page per object, and records what was built in /workspace/research/lab-setup.md. An agent handed a part of the plugin it has not read starts from the map and the files these skills wrote, before the source they describe.

> Stop when the Trial wall is reached. Do not fabricate elapsed time. Reaching either bound is a normal ending: report the registry with those counts, every route that reached a sink with its exact remaining gap, and the rows and entry points left unread. Reporting zero candidates after bounded closure is a normal ending.

## 日本語訳（読むための訳。エージェントには渡さない）

1〜9 段落目の訳は [v21-wide の訳](2026-11-01-wp2shell-bounty-v21-wide.md) と同じ。変わった 2 段落（10 番目と 11 番目）の訳を書く。

この Trial には 3 つのスキルが置かれていて、それぞれの description がいつ使うかを述べている。まず `wbh-recon` を読むこと。仮説を立てたり他のエージェントを起動したりする前に読む。これはプラグインのサブシステム、request の入口、認可の門、共有 helper、データの保存先、JavaScript の境界の地図を作り、Trial のすべてのエージェントが読めるように `/workspace/research/recon-map.md` に書く。地図ができたら `wbh-tools` を読むこと。これは自分のディレクトリに同梱された列挙スクリプトを走らせ、文字どおりの hook 登録と文字どおりの効果の呼び出しの一覧を `/workspace/research/tools` の下に保存し、地図と突き合わせる。Trial に Lab があるとき（`## Lab` 節がサイトと管理者アカウントを名指ししているとき）は、地図ができた後、どのエージェントも Lab に request を送る前に `wbh-setup` を読むこと。これは通常のサイトが使うようにプラグインを設定し、オブジェクトごとに 1 ページを公開し、作ったものを `/workspace/research/lab-setup.md` に記録する。まだ読んでいないプラグインの部分を渡されたエージェントは、それが説明するソースより先に、地図とこれらのスキルが書いた file から始める。

Trial の wall に達したときに止まること。経過時間を捏造しない。どちらの限界に達するのも正常な終わり方である。それらの数を含む registry、sink に届いたすべての経路とその正確な残りの欠落、読まずに残した行と入口を報告する。限界まで読み切ったうえで候補 0 件と報告するのは、正常な終わり方である。

## 出典対照表

足した文は無い。消した 3 か所の出典は上の表にある。残る文の出典は [v21-wide の出典対照表](2026-11-01-wp2shell-bounty-v21-wide.md)、[v20-wide の出典対照表](2026-11-01-wp2shell-bounty-v20-wide.md)、[v19-wide の出典対照表](2026-10-31-wp2shell-bounty-v19-wide.md) にある。

| 要素 | 出典 |
| --- | --- |
| 消す 3 か所の選び方（行数の規則、その一覧を指す節、停止文の行数の条件） | ADR 0049 決定 E「目的文の手順段落の削除」、Issue #793 |
| 停止文の残り「Stop when the Trial wall is reached.」 | v19-wide の停止文（ADR 0039 追記 16）の wall の側。語は v21-wide のまま |
| 最終段落が「Stop when」で始まること | ADR 0039 の帰結（再開段落）、`src/cli/wordpress.ts` の `WORDPRESS_RESUME_PARAGRAPH_PREFIX` |
| 消すだけで言い換えない | ADR 0045 凍結 5 の第 5 項 |

## 変えない要素

- v21-wide の残りの文の語。1〜9 段落目は byte 単位で同じ。
- 出力契約 v4、`## Run parameters`、`## Lab`、`## Prior research`、`## Prior leads` の生成節。制限時間と子の数は本文に書かない（ADR 0039 追記 4）。
- 探索スキルの本文。Harness の code。fragment の仕組みと `sections/` の file（v11 と archived の版の照合用）。
- campaign 設定の `discovery.skills` の名指し。`promptId` だけを v22-wide にする。
- v21-wide の登録簿の行と file。`archived` にして台帳の照合に使う。

## 書かなかったもの、所有者に見てほしいもの

- 最終段落に残る「Reaching either bound」「the registry with those counts」「the rows and entry points left unread」は、消した規則を指していた語である。語を足さずに直せないので残した。Root は登録簿の数と読み残しを報告する文として読むと見ている。言い換えが要るなら、それは別の版（ADR 0045 の「月 1 回」）の問いになる。
- スキル段落は 3 つのスキルを名指したまま残した。ADR 0049 決定 E の「手順段落」を行数の規則の段落と読み、routing の段落は残した。routing を消すかは [wbh-falsify v1 の review](2026-11-02-exploration-skills-wbh-falsify-v1.md) が触れた別の問いである。
- 決定 E のスキル側（`wbh-falsify` v3、第 2 Trial のスキルの producer の後ろ向き探索）は行っていない（ADR 0049 追記 4）。

## 測り方

未計測。本番で v22-wide の Trial を v21-wide の Trial（2026-11-01〜02）と並べる。見る数字は Root の wall、Trial あたりの lookup 数、Finding / Trial と Lead / Trial、Lab 発火 / Codex 時間（ADR 0045）。対になっていないので分布で並べる。削除のみなので bench は組まない（[measurement.md](../agents/measurement.md) 5b）。
