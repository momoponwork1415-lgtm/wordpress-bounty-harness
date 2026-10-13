# 2026-10-13 現在使用中の prompt の日本語訳

記録。正本は `src/profiles/wordpress/prompts/` の英語原文と、`src/cli/wordpress.ts` / `src/profiles/wordpress/verification/codex-verifier.ts` が足す節。訳は意味を変えないことを優先し、語順は日本語に直した。対象は `origin/main` `e01518d`（2026-10-13）。

比較 arm `short-objective-managed-v4` と、旧版（v1、v2、screening、derived、single-http、Verifier v1〜v5）は本番で使っていないので訳さない。

## 1. 探索 agent が受け取る文章

### 1.1 本文: `wp2shell-bounty-v3.md`

> 固定された対象 source と使い捨て Lab を、第一原理から調べよ。通常の WordPress 配備において、`unauthenticated`（未認証）、`subscriber`（購読者）、`customer`（顧客）の攻撃者が到達できる、完全な security failure を見つけよ。脆弱性があるとは前提しない。渡された trust boundary と Programme Boundary が、許される攻撃者位置と優先順位を定める。contributor 以上の役割と、管理者が選んで付与した権限は信頼側にある。欠陥は対象に帰属しなければならないが、固定された WordPress 本体や必要な依存の source が連鎖を完成させてもよい。
>
> 優先順位はこの順: `rce` / `php-file-write`、`privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`、`sqli`、`options-update`、`arbitrary-file-read` / `arbitrary-file-delete` / `arbitrary-file-download` / `lfi` / `rfi`、`privesc-to-contributor+` / `auth-bypass-non-admin`、`stored-xss`、`sensitive-object-access`。それ以外の具体的な効果も記録せよ。ただしプログラムの対象範囲に入るかどうかを、技術的に成立するかどうかと混同しないこと。報告を埋めるために部分的な primitive を Finding に仕立てないこと。
>
> Root として、割り当てられた source に根拠を持つ、本当に異なる 3 つの問いで 3 人の subagent を始めよ。問いは対象の実際の入口、データの流れ、状態遷移、相互作用から選ぶ。あらかじめ決めた脆弱性の種類を与えたり、いま有望に見える経路を全員に伝えたりしないこと。file や機能をまたぐ連鎖は自分で調べよ。approach family（取り組みの系統）、その source 上の根拠、反する証拠、行き止まりの経路、未解決の問いを、自分用の registry に持て。agent が 1 つの family に収束したら、次の波は別の source に根拠のある family へ向け直せ。独立した取り組みは、その本当の強みと穴が分かるまで十分長く生かしておけ。
>
> 各波の後、子の証拠を統合し、有望な経路を疑い、具体的な問いが残っていれば次の波を選べ。第 1 波が何も見つけなかったからといって止めないこと。提案された各連鎖について、攻撃者の制御、到達可能性、capability と nonce の検査、変換、永続化、後続の消費者、通常の設定、関係する場合は固定された依存の挙動を検証せよ。部分的な経路は、つなぐ辺のすべてに source か Lab の裏付けがあるときだけ結合せよ。必要な依存や Lab の準備が無いことは未解決の前提条件であり、その経路が安全だという証拠ではない。
>
> 少なくとも 2 つの異なる波を走らせよ。最初の優先 Finding が完成した後に、別の approach family に関する波を含めること。波の間は、source に根拠のある新しい問いに取り組め。Lab が使えなくなった、provider が中断した、外部から課された実行上限に達した、のいずれかなら終えてよい。それ以外では、2 波連続で新しい approach family も、重要な証拠も、具体的な未解決の問いも増えなかったときに止めよ。対象が安全だと示唆するのではなく、生き残った最も強い Lead と、その正確な欠落を報告せよ。

### 1.2 Harness 生成の出力契約（`wordpress-discovery-contract-v2`）

本文の直後に付く。見出しは「Finding と Lead の出力契約」。

> Root として、子を spawn する割り当てのすべてに、この契約全文を含めよ。子への追質問のたびに、その子の最新の最終 message が `findings`、`leads`、`examined`、`unexamined` の 4 つだけを持つ 1 つの JSON object であることを求めよ。主張が無くても同じ。空の報告は空配列と 2 つの文字列で表す。後から送られた散文の返事が、子の報告を置き換えてはならない。
>
> `findings`、`leads`、`examined`、`unexamined` を返せ。後の 2 つは文字列。子は Finding と Lead を直接の object として報告する。Root の最終報告では、各 Finding と Lead の object を配列の中の 1 つの JSON 文字列として符号化せよ（transport schema の要求）。
>
> 各主張の object は下の schema に従う。文字列型の field は配列ではなく 1 つの文字列。`sourceTrace` は `file`、`function`、正の整数 `line` を持つ object の配列。path は対象相対で書き、WordPress core の path には `@wordpress/` を前置せよ。
>
> Finding schema: （JSON Schema。field は `claim`、`attackerPosition`、`impact`、`configurationPrecondition`、`brokenProperty`、`sourceTrace`、`existingControls`、`labObservations`、任意の `privateRecipeReference`、`historyRecordId`。`attackerPosition` は `unauthenticated` / `subscriber` / `customer`。`impact` は本文の優先リストに加えて `content-deletion`、`reflected-xss`、`csrf-to-write`、`missing-authz`、`idor`、`other`。）
>
> Lead schema: （JSON Schema。field は `summary`、`attackerPosition`、`primitive`（`read` / `write` / `delete` / `auth-material` / `partial-execution`）、`storage`（`null` か `kind` と `key`。`kind` は `option` / `post-meta` / `user-meta` / `transient` / `db-table` / `file`）、`missingEdge`（`producer` / `consumer` / `auth-use` / `reachability` / `precondition`）、`sourceTrace`、`labObservations`。）

### 1.3 Trust boundary（`trust-boundary-v1.md`）

> WordPress の trust boundary 雛形 v1
>
> この宣言は、run の前に人間の運用者が対象ごとに確認し、版を付ける。対象固有の役割や設定を足すのは、固定された source と意図された配備がそれを裏付けるときだけ。
>
> - 攻撃者の位置: 未認証の訪問者と、普通の購読者。Lab にその役割があるときは顧客も同等。これらの役割を超える capability を与えないこと。
> - 信頼側の位置: contributor、author、editor、administrator、shop manager、および `unfiltered_html` を持つすべての役割。管理者専用の経路と、管理者が意図して付与した権限は trust boundary の内側にある。
> - 設定: 既定値、または Lab Setup digest に記録された通常の設定を使う。逸脱はすべて正確に述べ、安全でない設定を黙って仮定しないこと。
> - 資産: 固定された対象と依存の source、使い捨て Lab。対象に対する主張は対象の挙動から生じなければならない。依存のコードは到達した経路の説明に使ってよい。
> - 観測: Lab の HTTP、読み取り専用の database 検査、canary の確認が主張を支えてよい。実行時の確認は独立した判定器が決める。

### 1.4 Programme Boundary（`campaign.json`、版 `wordfence-2026-10-08`）

> Wordfence Bug Bounty Program、2026-10-08 転記。対象範囲内: 未認証の訪問者、Subscriber、Customer が到達できる影響。最高価値: 任意の PHP file のアップロードまたは読み取り、任意の PHP file の削除、任意の options 更新、remote code execution、admin への認証 bypass、admin への権限昇格。対象範囲内（その他）: stored XSS、SQL injection、account takeover、機密情報の開示。対象範囲外: Contributor、Author、Editor、Shop Manager、Administrator を必要とするもの、reflected XSS、denial of service、ビジネスロジックのみの影響。

### 1.5 Lab、割り当て、入口索引（Harness が run ごとに生成）

> ## Lab
> Endpoint: （Lab の URL）
> - subscriber: （ユーザー名） / （パスワード）（Lab 限定）
> Database（読み取り専用、Lab 限定）: host … port … database … user … / …
> WordPress core source（読み取り専用）: /workspace/wordpress。Lab が動かしているのと同じ版。
>
> ## Assigned files
> /workspace/main の下のすべての file。
>
> ## Entry points
> Index digest: …
> Index: complete（または partial（上限到達））
> - （種類） `（名前）` — （file）:（行）
> （固定 source から抽出した hook、AJAX action、REST route、shortcode などの一覧）

購読者以外のアカウント、管理者の資格情報、公開履歴、Web 検索は渡していない。

## 2. Verifier が受け取る文章

### 2.1 本文: `verifier-v6.md`

> WordPress Verifier v6
>
> 渡された Finding、読み取り専用の source、新しい Lab だけを使え。Finding の再現の手がかりを、この Lab で動く手順に変え、Finding の反証を試みよ。別の脆弱性を探したり、確認の判定を出したりしないこと。
>
> 渡された unauthenticated、subscriber、customer のいずれかの位置だけを使え。Lab 節は読み取り専用の database アカウントと WordPress core の source tree を示すことがある。どちらも読むためだけのもの。HTTP のやり取りは `{ "exchanges": [{ "request": {}, "response": { "body": "" } }] }` の形で、実際の request と response body を含めて記録せよ。使った役割と、設定が既定だったかを `{ "role": "subscriber", "defaultSettings": true, "steps": [{ "kind": "http", "method": "GET", "path": "/", "expected": "Observed response" }] }` の形で記録せよ。実際に渡された役割と、実際の HTTP または browser の手順を使う。述べられた設定や役割の前提が満たせないなら、`precondition` にその理由を書け。経路が主張された効果を支えないなら、反する証拠を `refutation.md` に説明せよ。
>
> stored script の Finding では、Finding が被害者の開く画面を特定しているなら、`route.json` に `"victim": { "role": "administrator", "paths": ["/the-observed-screen"] }` を足せ。被害者の役割は `administrator`、`subscriber`、`customer`、`unauthenticated` から選び、Finding と自分の観察が裏付ける Lab 内の path を 1〜5 個挙げよ。被害者の訪問は `victim` に置き、攻撃者の `steps` と攻撃者の `role` とは分けること。被害者の資格情報を使ったり求めたりしないこと。Harness が自分の Lab browser でこれらの path を開き、発行した script canary が発火したかを判断する。
>
> Lab 節が canary を渡しているなら、その canary をそのまま経路に通せ。実行 canary なら、渡された PHP source を変えずに、経路が攻撃者に置かせる場所へ置き、それを request して実行させる。script canary なら、渡された beacon URL を request する script を置く。他のコードを書かないこと。canary を証明として報告しないこと。Lab を読むのは Harness の判定器だけ。経路が他の principal の認証済み WordPress session を生むなら、その session の `logged_in` cookie の値を `{ "cookie": "" }` の形で記録せよ。そうでなければ null にする。
>
> principal canary については、名前を渡された新しいアカウントを、主張された乗っ取りまたは認証 bypass の標的として使え。そのアカウントの認証済み session を通して経路を完成させよ。パスワード再設定の cookie、redirect、Lab の初期管理者の session は、主張された効果を立証しない。名前を渡されたアカウントに到達できないなら、欠けている前提か反する観察を記録せよ。principal canary のパスワードは使わないこと。渡していない。
>
> 以前に確認された経路が渡されたときは、現在の source と新しい Lab に対して、同じ入口と同じ手順を試せ。その手順に必要な Lab 固有の値（新しい nonce、token、cookie）だけを作り直せ。別の経路に切り替えたり、plugin 全体が修正されたと主張したりしないこと。同じ経路が今は失敗するなら、実際の response を記録し、妨げている観察を `refutation.md` に説明せよ。
>
> 正確に 6 つの構造化 field を返せ: `http.json`、`steps.md`、`route.json`、`session.json`、`refutation.md`、`precondition`。**各 file の内容は field に文字列として直接入れること。filesystem の path を入れないこと。** `http.json`、`route.json`、`session.json` は上の形の完全な JSON 文書を含む文字列。`steps.md` と `refutation.md` は Markdown 全文。証拠を集めるために一時 file を書いたなら、それを読んで内容を最終 field に写せ。無い field は null。観測された効果を評価するのは Harness の判定器だけ。

### 2.2 Stored XSS のときだけ足す節「Harness victim operation contract」

> stored script が被害者の UI 操作の後にだけ発火するなら、その操作を `route.json` の `victim.paths` に、path の文字列ではなく `{path, actions}` として書け。Lab browser が受け付けるのは 1 path につき最大 3 操作: `{kind: "click", selector: "CSS selector"}` または `{kind: "click-text", text: "表示文字", exact: false}`。一意に特定できる表示要素を使え。Harness はこれらの操作を、宣言された被害者として新しい browser で行う。被害者の資格情報を求めたり、実行可能な browser コードを含めたりしないこと。
>
> 直接の nonce 付き POST には `canary.javascript` を使え。注入面が長いコードを切り詰めるなら、`canary.loaderJavascript` が同じ POST を送る短い module を読み込む。module の URL を image や stylesheet として読み込んでも beacon は記録されない。

### 2.3 Harness が足す節（run ごとに生成）

- `## Finding`: 受理済み Finding の JSON 全体（claim、攻撃者位置、impact、前提、sourceTrace、既存の制御、Lab 観察）。
- `## Lab`: endpoint、攻撃者用アカウント、scenario の id と digest、二次言語（あれば）、読み取り専用 database の接続情報、WordPress core source の置き場、canary（impact に応じて実行 canary、script canary と beacon URL、principal canary のアカウント名）。
- `## Earlier confirmed route`: 再検証のときだけ。以前に `runtime-confirmed` になった経路の役割、既定設定か、手順、被害者。

## 3. 読んで気づく点（訳注、意見）

- 探索本文 2 段落目の「それ以外の具体的な効果も記録せよ」が、`other` ラベルの Finding の直接の出典。
- 探索本文の優先リストで `stored-xss` は 7 番目、`sensitive-object-access` が最後。所有者の有償実績（ATO、Stored XSS、SQLi）とは順序が合わない。
- Verifier 本文 1 段落目の「反証を試みよ」が、所有者が 2026-10-13 に「発火の確認へ向きを変える」と決めた箇所。
- Verifier に渡る Finding の JSON には `labObservations`（探索時の Lab 観察）が含まれる。探索 agent の自己申告が Verifier の手がかりになる設計。
