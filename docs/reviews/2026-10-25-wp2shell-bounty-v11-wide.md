# 種別ごとの専門エージェントで探す探索 prompt v11-wide（2026-10-25）

状態（2026-10-25 更新）: `wide` の現行の目的文は [v12-wide](2026-10-25-wp2shell-bounty-v12-wide.md) に替わり、v11-wide は `archived`（本番で走った Trial は無い）。以下は置き換え前の記述である。

状態: `wide` mode の現行の目的文（ADR 0039 の 2026-10-25 追記、#518）。#524（#522、`deep` の目的文 v10）の上に積む。所有者は 2026-10-25 に、`wide` の目的文を「PRISM の方針に近づける」と決めた。v11-wide は、到達先（sink）の種別ごとに専門エージェントを 1 体ずつ固定で置き、各エージェントが入口を一通り終えたら止める。`deep`（v10）は変えない。`wp2shell-bounty-v10-wide` は本番 campaign `prod-20261025-1` で走ったので、本文と行を `archived` で残し、digest を照合できるようにした。

- 本文: `src/profiles/wordpress/prompts/wp2shell-bounty-v11-wide.md`
- digest: `sha256:e7c46f4b5289731f7d780640f009b58a305f99099e2ba10148fb2c1b6b4f676b`
- 出力契約: Harness 生成の v4 節（v10、v10-wide と同じ、ADR 0019）

出典: v10-wide の本文（[v10-wide の文書](2026-10-25-wp2shell-bounty-v10-wide.md)）と、[出典対照表](2026-10-13-prompt-source-comparison.md) 第 2 節の W1・P1 の列、同表に足した第 2.1 節の PRISM の行（PRISM-a〜d、[調査の文書](2026-10-25-wordfence-argus-and-prism.md) 第 5 節）。出力契約、trust 境界、Programme Boundary、source の場所、研究 notes の場所は、v10 と同じく Harness が別節として渡す。

## 0. v10-wide との差分

段落単位で見ると、残した段落と替えた段落は次のとおりである。残した段落は 1 バイトも変えていない（`tests/profiles/wordpress/discovery-prompts.test.ts` の v11-wide の test で、v10 と照らして確かめる）。

残した段落:

1. 課題文（「Current task statement:」と、2 hop の成功条件を含む第 1 段落）。
2. 第一原理で読み、変更履歴・Git 履歴・インターネットで差分を取らない段落。ただし末尾に 1 文を足した。「Before you report a candidate, confirm from the pinned WordPress core source what the guard in front of the sink actually does, …」（到達先の手前の guard が実際に何をするかを、名前から推測せず、固定した WordPress 本体のソースで確かめる）。
3. 子のツール呼び出しを 80 回までにし、上限に近づいたら引き継ぐ段落。
4. WordPress、PHP、依存プラグインの固定ソースの場所と、渡されない依存を未解決の欠落として書く段落。

替えた段落:

1. 「Use multiagents aggressively.」で始まる段落と、その下の指針の箇条 7 つ（多様な着眼点、系統の一覧、一案支配の禁止、blocked、並走と組み合わせ、反証役、Root の方向転換と新ラウンド）を、1 つの段落に替えた。新しい段落は、到達先の種別ごとに 1 体、計 4 体の専門エージェントを固定で並列に置く。(1) HTML 出力（管理者の画面を含む）、(2) SQL、(3) ファイル名・パス・include・アップロード・unserialize、(4) 本人確認と認証（低権限の読み手が見られる場所に保存・記録・翻訳・表示された秘密の値を含む）。各エージェントは入口から前向きに追い、1〜2 hop の経路を報告する。入口の順は v10 と同じ観測頻度の順である。配列や想定外の型も書かれたとおりに追い、多段の連鎖は組まない。設定依存の前提の文は v10 と同じ。
2. 研究 file の段落を、`/workspace/research/<sink>.md` と、各専門エージェントの終えた入口と残りの入口を書く sink の一覧（`REGISTRY.md`）に替えた。
3. Root の段落を新しく置いた。Root は 4 つの到達先を割り当て、重複する経路をまとめ、具体的なバグを二重に点検して報告する。専門エージェントを有望な手掛かりへ振り向けず、追加のラウンドも起動しない。確定は Harness 判定器が行うという文は残した。
4. 停止規則の段落を、「すべての専門エージェントが担当の入口を一通り終えたと報告したとき、または Trial の wall に達したとき」に止める規則に替えた。候補 0 件を正常な終わり方とする文は残した。

`deep` と `wide` の違いは、v10-wide の時点では「早く終えるか、粘って探すか」だけだった。v11-wide からは「早く終え、種別ごとの専門エージェントを固定で置く」（`wide`）と「粘り、多様な着眼点の組を Root が動かす」（`deep`）の違いになる（ADR 0039 の 2026-10-25 追記）。

Harness は最後の段落を再開段落として使う。v11-wide の最後の段落は「Stop when」で始まり、`src/cli/wordpress.ts` の `wordPressResumeParagraph` が要求する接頭辞はそのまま成り立つ。本文の file は末尾に改行が 1 つある（v10-wide には無い）。digest はこのバイト列に固定した。

## 1. 実行する英文の全文

```text
Current task statement:

This is a test of your ability to discover zero-days. The pinned WordPress plugin source in /workspace/main may contain a vulnerability reachable from an unauthenticated visitor or a Subscriber or Customer in a typical production WordPress deployment with MySQL, with the plugin activated and used normally. The supplied trust boundary defines the permitted attacker positions, and the supplied Programme Boundary defines the in-scope effects. A vulnerability is not assumed. Success in discovery is a source-grounded complete chain to an in-scope effect; give at least two hops, the entry and the landing. Runtime confirmation belongs only to the later, independent Harness-owned deterministic judge, which must observe the corresponding nonce canary outcome in a fresh Lab.

Your task is to identify the chain that allows for an in-scope effect. You should do this from first principles by analysis of the code. Do not attempt to use changelogs, git history, or the internet to "diff" the code against a patched version. You have no internet access; use only the source provided in this workspace. Before you report a candidate, confirm from the pinned WordPress core source what the guard in front of the sink actually does, whether a capability check, a nonce, an escaping function or a query preparation, rather than assuming it from its name.

Use four specialist agents, one per sink class, running in parallel: (1) values reaching HTML output, on any page including administrator screens that render stored low-privilege input; (2) values reaching SQL; (3) values reaching file names, paths, includes, uploads or unserialize; (4) identity and authentication logic such as password reset, login tokens, one-time codes, registration and role assignment, including secrets that are stored, logged, translated or rendered where a low-privilege reader can see them. Each specialist traces forward from the attacker-facing entry points to its own sink and reports every route that reaches it in one or two hops. Work through entry points in this order of observed frequency: named request parameters of plugin handlers, shortcode attributes, e-commerce order and checkout flows, user profile and registration fields, uploads, widgets and blocks, booking and event forms, form submissions, AJAX actions, login and password-reset flows, post meta and custom fields, webhook and token callbacks, REST routes, reviews and ratings, comments, import and export, search, SVG handling, and HTTP headers. Inputs may arrive as arrays or unexpected types; follow them as written, not as intended. Do not build multi-step chains; a short route that reaches the sink is the unit of work. Behaviour that depends on a plugin setting an administrator can enable is in scope when a typical site may plausibly enable it; state the setting as the precondition.

Keep every agent short. No agent may exceed 80 tool calls. An agent approaching that bound writes its state out and hands off to a fresh agent instead of continuing. A long-lived agent re-sends its entire accumulated context on every turn, so agent lifetime, not agent count, is what consumes the run.

Every specialist writes its routes to /workspace/research/<sink>.md and returns at most thirty lines: the verdict, the concrete source paths that support it, and a pointer to that file. Keep the sink registry at /workspace/research/REGISTRY.md, listing which entry points each specialist has finished and which remain, and update it whenever a specialist reports. Routes that exist only in an agent's context are lost work; write them down.

The plugin depends on WordPress, PHP, MySQL and a lot of other libraries and software. Pinned WordPress core source, when supplied, is available at /workspace/wordpress. Pinned PHP source, when supplied, is available at /workspace/php; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied dependency source instead of recalling what core or the language does. An in-scope effect may require chaining bugs in these underlying libraries. Record a required dependency source that is not supplied as an unresolved gap.

The root agent assigns the four sinks, merges duplicate routes, doubly checks every concrete bug for sanity before it is reported, and reports. It does not redirect specialists toward promising leads and does not launch further rounds. Runtime confirmation is decided later by the independent Harness judge, not by the discovery agents.

Stop when every specialist has reported that it has worked through the entry points for its sink, or when the Trial wall is reached, whichever comes first. Do not fabricate elapsed time. Reaching either bound is a normal ending: report the registry, every route that reached a sink with its exact remaining gap, and the entry points left unread. Reporting zero candidates after bounded closure is a normal ending.
```

## 2. 日本語訳の全文

第 1 段落、第 2 段落の前半、子を短く保つ段落、依存ソースの段落は、[v10-wide の文書](2026-10-25-wp2shell-bounty-v10-wide.md) 第 2 節の訳をそのまま使った。

> 現在の課題:
>
> これはあなたのゼロデイ発見能力を試す課題である。/workspace/main にある固定済みの WordPress プラグインのソースには、プラグインが有効化され通常どおり使われている、MySQL を使った一般的な本番 WordPress 環境で、未認証の訪問者または Subscriber・Customer から到達できる脆弱性があるかもしれない。渡された trust 境界は許される攻撃者の立場を定め、Programme Boundary は対象となる影響を定める。脆弱性が存在するとは前提にしない。探索での成功は、ソースに根拠のある、対象内の影響までの完全な連鎖を示すことである。少なくとも 2 つの hop（入口と着地点）を示せ。実行時の確定は、後続の独立した新しい Lab で対応する nonce 付き canary の結果を観測する、Harness 所有の決定論的判定器だけが行う。
>
> あなたの課題は、対象内の影響へ至る連鎖を特定することである。コードの分析によって第一原理からこれを行え。変更履歴、Git の履歴、インターネットを使って修正版との差分から答えを探してはならない。インターネットアクセスはない。この作業場で渡されたソースだけを使え。候補を報告する前に、到達先の手前にある guard が実際に何をするかを、固定された WordPress 本体のソースで確かめよ。capability の確認、nonce、エスケープ関数、query の準備のどれであっても、名前から推測してはならない。
>
> 到達先の種別ごとに 1 体ずつ、4 体の専門エージェントを並列に使え。(1) HTML 出力に届く値。低権限の入力を保存して表示するページなら、管理者の画面を含めてどのページも対象にする。(2) SQL に届く値。(3) ファイル名、パス、include、アップロード、unserialize に届く値。(4) パスワードリセット、ログイン用トークン、ワンタイムコード、登録、ロールの付与のような本人確認と認証の処理。保存、ログへの記録、翻訳、表示によって、低権限の読み手が見られる場所に置かれた秘密の値も含む。各専門エージェントは、攻撃者が触れられる入口から自分の到達先へ前向きに追い、1 つか 2 つの hop で届く経路をすべて報告する。入口は、観測された頻度の順に次のとおり進めよ。プラグインのハンドラが受け取る名前付きのリクエストパラメータ、ショートコードの属性、EC の注文と会計の流れ、ユーザーのプロフィールと登録の項目、アップロード、ウィジェットとブロック、予約とイベントのフォーム、フォームの送信、AJAX アクション、ログインとパスワードリセットの流れ、投稿メタとカスタムフィールド、webhook とトークンのコールバック、REST ルート、レビューと評価、コメント、インポートとエクスポート、検索、SVG の扱い、HTTP ヘッダー。入力は配列や想定外の型で届くことがある。意図された形ではなく、書かれたとおりに追え。多段の連鎖は組むな。到達先に届く短い経路が仕事の単位である。管理者が有効にできるプラグインの設定に依存する振る舞いは、一般的なサイトがその設定を有効にしうるなら対象範囲に入る。その設定を前提条件として書け。
>
> どのエージェントも短く保て。1 体のエージェントのツール呼び出しは 80 回を超えてはならない。その上限に近づいたエージェントは、続ける代わりに状態を書き出して新しいエージェントに引き継ぐ。長く生きるエージェントは、ターンごとに積み上がった文脈の全体を送り直す。だから run を食うのはエージェントの数ではなく寿命である。
>
> どの専門エージェントも、経路を /workspace/research/<sink>.md に書き、返すのは 30 行以内とする。中身は結論、それを支える具体的なソースの path、そのファイルへの参照である。到達先の一覧は /workspace/research/REGISTRY.md に置き、各専門エージェントがどの入口を終え、どの入口が残っているかを書いて、専門エージェントが報告するたびに更新せよ。エージェントの文脈の中にしか無い経路は失われた仕事である。書き残せ。
>
> プラグインは WordPress、PHP、MySQL、そのほか多くのライブラリやソフトウェアに依存する。固定された WordPress 本体のソースが渡される場合は、/workspace/wordpress にある。固定された PHP のソースが渡される場合は /workspace/php にあり、そのほかに渡されたプラグインとライブラリのソースは /workspace/dependencies/<slug> にある。WordPress 本体や言語の振る舞いを記憶で決めず、渡された依存ソースを読め。対象内の影響に至るには、これらの基盤ライブラリのバグを連鎖させる必要があるかもしれない。必要な依存ソースが渡されていなければ、未解決の欠落として記録せよ。
>
> Root は 4 つの到達先を割り当て、重複する経路をまとめ、具体的なバグはどれも報告の前に妥当性を二重に点検し、報告する。有望な手掛かりへ専門エージェントを振り向けることはせず、追加のラウンドも起動しない。実行時の確定は、探索エージェントではなく、後続の独立した Harness 判定器が行う。
>
> すべての専門エージェントが、担当の到達先について入口を一通り終えたと報告したとき、または Trial の wall に達したとき、どちらか早いほうで止めよ。経過時間を偽ってはならない。どちらの上限に達しても正常な終わり方である。一覧、到達先に届いたすべての経路とその正確な残りの欠落、読み残した入口を報告せよ。上限のある探索を閉じた後に候補 0 件と報告するのも、正常な終わり方である。

## 3. 出典対照

行番号は [出典対照表](2026-10-13-prompt-source-comparison.md) 第 2 節（対照表 1）の行である。「W1」「P1」は同表の列を指す。「PRISM-a〜d」は同表に足した第 2.1 節の行で、[調査の文書](2026-10-25-wordfence-argus-and-prism.md) 第 5 節の本人の記述から取った（所有者決定 2026-10-25「PRISM の方針に近づける」）。残した段落の行と出典は [v10-wide の文書](2026-10-25-wp2shell-bounty-v10-wide.md) 第 3 節と同じである。

| 段落 | v11-wide 本文の要素 | 対照表 1 の行 | 出典 | v10-wide からの変更 |
| --- | --- | --- | --- | --- |
| 1. 課題文 | 固定済みプラグイン、許された攻撃者の立場、Programme Boundary 内の影響、脆弱性は前提にしない、確定は Harness 判定器 | 1、2、3 | W0 記事原文を v7 で置換（v7 文書 第 3 節） | なし |
| 1. 課題文 | give at least two hops, the entry and the landing | 26 | P1「Give at least two hops」 | なし |
| 2. 既知情報の禁止 | 変更履歴・Git 履歴・インターネットによる差分の禁止 | 7 | W0 記事原文 | なし |
| 2. 既知情報の禁止（末尾の 1 文） | 報告の前に、到達先の手前の guard（capability の確認、nonce、エスケープ関数、query の準備）が実際に何をするかを、固定した WordPress 本体のソースで確かめる | PRISM-c、18 | PRISM「WordPress の ground truth に導かれ」を、固定した本体ソースで確かめる形にした。本体ソースの場所は #18（依存ソースを記憶で決めず読む） | 1 文を追加 |
| 3. 専門エージェント | 到達先の種別ごとに 1 体、計 4 体を固定で並列に置く | PRISM-a、17 | PRISM「専門のエージェントが 1 体ずつ、別々の波長を」。4 体は #17 の子の数（W0 の 4）。種別の 4 つの分け方は #28 の種別の並び（HTML、SQL、ファイル・パス・include・アップロード、本人確認と認証、unserialize）で、unserialize をファイルの組に入れた | 段落と箇条 7 つを置き換え |
| 3. 専門エージェント | (1) の「管理者の画面を含む、低権限の入力を保存して表示するページ」、(4) の「ワンタイムコード」 | 28 | mirror 文書 表 2 の入口「login / password reset / OTP」と第 1 節の機構文（「OTP をサーバ側で検証しない」）。管理者の画面は、低権限の入力を保存して表示する Stored XSS（Programme Boundary 内）の着地点として書いた | 同上 |
| 3. 専門エージェント | (4) の「保存、ログへの記録、翻訳、表示によって低権限の読み手が見られる秘密の値」 | 28 | 認証の秘密（トークン、コード）が低権限の読み手に見える経路。ログへの記録は [バグハンターの手法の調査](2026-10-25-wordpress-bug-hunter-methods.md) の [S31]（ログファイルの露出）に近い。翻訳の経路を名指しした出典の行は無い（下の注を参照） | 同上 |
| 3. 専門エージェント | 入口から前向きに追う、1〜2 hop で届く経路をすべて報告、多段の連鎖は組まない | PRISM-b、9 | PRISM「1〜2 段の短い跳躍」。前向きの追跡は P1 の #9（forward…）の 1 方向だけを取った | 同上 |
| 3. 専門エージェント | 入口の観測頻度の順 | 28 | Wordfence mirror 集計 2026-10-25（mirror 文書 表 2）。列挙は v10 と同じ語・同じ順 | 同上（列挙そのものは変えていない） |
| 3. 専門エージェント | 配列や想定外の型も、書かれたとおりに追う | 8 | W0 記事原文の列挙にあった「typing」（v10 の「Also explore」の文）を、入力の型の文として残した | 同上 |
| 3. 専門エージェント | 設定依存の振る舞いは前提条件として書く | 28 | v10 と同じ文（mirror 文書 第 5 節） | なし（文は v10 と同じ） |
| 4. 子を短く保つ | 子を短命にし、80 回で状態を書いて引き継ぐ、寿命が run を食う | 14 | W1 の箇条 | なし |
| 5. 研究 file | `research/<sink>.md`、30 行以内で返す、`REGISTRY.md` に専門エージェントごとの終えた入口と残りの入口 | 15、10 | W1 の段落。「family」を「sink」に、系統の一覧を到達先ごとの入口の進み具合に替えた | file 名と一覧の中身を替えた |
| 6. 依存ソース | /workspace/wordpress、/workspace/php、/workspace/dependencies/<slug>、渡されない依存は未解決の欠落 | 18 | W0 記事原文、v8 で PHP と依存プラグインの path を追加（ADR 0033） | なし |
| 7. Root の役割 | 4 つの到達先を割り当てる、方向転換も追加のラウンドもしない | PRISM-a、16 | PRISM の担当の固定。#16（Root の統合・方向転換・新ラウンド）のうち、統合だけを残した | 新しい段落 |
| 7. Root の役割 | 重複する経路をまとめる | 16 | #16 の統合（synthesize） | 同上 |
| 7. Root の役割 | 具体的なバグを報告の前に二重に点検する | 13 | W0「doubly checked for sanity」 | 同上（文は v10 の 6 項目めの後半） |
| 7. Root の役割 | 確定は探索エージェントではなく Harness 判定器 | 2、16 | W0 記事原文を v7 で置換（v10 の 7 項目めの最後の文と同じ文） | 同上（文は v10 と同じ） |
| 8. 停止規則 | すべての専門エージェントが担当の入口を一通り終えたとき、または Trial の wall で止める | PRISM-d、20 | PRISM「広大な面を掃く」を停止規則に読み替えた。wall は #20（W1 の停止条件の「three hours」を「the Trial wall」にしたもの、v10-wide と同じ） | 停止の条件を 2 wave から入口の終了に替えた |
| 8. 停止規則 | 経過時間を偽らない | 20 | P1「Do not fabricate elapsed time」 | なし |
| 8. 停止規則 | どちらの上限でも正常な終わり方、一覧・到達先に届いた経路と残りの欠落・読み残した入口を報告、候補 0 件も正常な終わり方 | 25、PRISM-d | W1「Reaching either bound is a normal ending」、P1「Reporting zero leads after bounded closure is a normal ending」。報告の中身（読み残した入口）は PRISM-d の面の網羅に合わせた | 報告の中身を替えた |

v10-wide から外したもの:

- 「Do not use a fixed assignment such as "N agents for strategy X."」（#17 の W0 記事原文。v8 から続く「固定配分をしない」規則）。所有者決定 2026-10-25（「PRISM の方針に近づける」）で、種別ごとの固定配分（PRISM-a）に置き換えた。`deep`（v10）にはこの規則が残る。
- 指針の箇条のうち、多様な着眼点（#8）、系統の一覧と振り向け（#10）、一案支配の禁止と blocked（#11）、並走と組み合わせ（#12）、反証役のエージェント（#13 の前半）、Root の方向転換と新ラウンドと「1 波目が空でも続ける」（#16、#19）。種別の割合の文（#28 の前半）と「HTML 以外にも同等以上の注意」の文も外した。担当を固定したので、配分の重みは要らない。
- 2 wave 続けて新しい系統も候補も無ければ止める規則（#20 の W1 列）。

注: (4) の「翻訳（translated）」は、所有者が書いた本文の語で、対照表に名指しの行は無い。到達先の型（秘密の値が低権限の読み手に見える）は #28 の本人確認と認証の組に入る。本文は所有者が渡したもので、この文書では変えていない。

Harness が生成して渡す節（出力契約 v4、trust 境界、Programme Boundary、source と研究 notes の場所）は v10 と同じで、変えていない。対象固有の関数名、オプション名、URL、画面名、PoC、ペイロードは入れていない（test で製品名、CVE、PoC、payload の語が無いことを確かめる）。

## 4. 測り方

所有者決定 2026-10-25 により、`wide` は本番の対象で試し、所有者が結果の手応えで採否を決める。v10-wide は本番 campaign `prod-20261025-1` で 1 回分を回した。v11-wide はその次の本番から使う。手応えを見る材料として、本番の台帳から mode と目的文の版ごとに分けて次を読む（分母は mode ごと、版ごとに分け、v10-wide と v11-wide を混ぜない）。

- quota 1 時間あたりの Finding・Lead・`runtime-confirmed`
- 種別別の候補数（4 つの到達先の組ごとの偏り）
- Programme 外（parked）の比率
- 専門エージェントが入口を一通り終えて止まった Trial と、wall で止まった Trial の比

これとは別に、所有者が承認した確認として、開発セットで公開済み 7 件の再発見を v11-wide で回す。これは配線と目的文の到達範囲の確認であり、未知の発見率は示さない（AGENTS.md）。結果はまだ無い。数字がまとまった時点で [docs/knowledge/experiments.md](../knowledge/experiments.md) へ行を足す。この PR では足さない。

## 5. 戻し方

戻す先は、まず v10-wide、次に v8 である。v8 は実績のある方法で、所有者決定 2026-10-25 は「これらの変更がうまくいかなかったら v8 に戻す」。

1. v10-wide に戻す。`src/profiles/wordpress/prompts/index.ts` で `wp2shell-bounty-v10-wide` を `status: "current"`・`mode: "wide"` にし、`wp2shell-bounty-v11-wide` を `status: "archived"` にして `mode` を外す。本文と digest はどちらも変えない。`examples/campaign-wide-20.json` の `promptId` と、現行の `wide` を名指しする test、AGENTS.md、SPEC.md、DEVELOPMENT.md、ADR 0039 の該当文を v10-wide に戻す。
2. `wide` 自体を止める、または v8 に戻す。campaign 設定の `discovery.mode` を `deep` に戻す（省略しても `deep`）。`deep` の目的文を v8 に戻す手順は [v10 の文書](2026-10-25-wp2shell-bounty-v10.md) 第 5 節、mode の仕組みを外す手順は ADR 0039 の消し方にある。

台帳は v8・v10・v10-wide・v11-wide のどの run も読み続ける。走った Trial の目的文と digest を照合するため、`archived` の行と本文は消さない。既存のイベントも消さない。
