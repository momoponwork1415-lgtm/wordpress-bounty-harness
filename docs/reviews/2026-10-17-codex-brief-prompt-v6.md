# Codex brief: 探索 prompt v6 と Programme Boundary 文の組み立て（2026-10-17）

所有者が Codex に貼る用。前提は [2026-10-17-thorough-search-v6-plan.md](2026-10-17-thorough-search-v6-plan.md)。Codex は本文を新しく考えず、下に指定した既存の行を写して並べる。出典に無い要素は足さない（DEVELOPMENT.md 第 5 節）。

---

## 貼り付け用

あなたは `wordpress-bounty-harness` の worktree にいる。`docs/reviews/2026-10-17-thorough-search-v6-plan.md` の第 3〜5 節を先に読む。次の 4 つを 1 本の branch に作る。本番 runner と `~/.local/state/` には触れない。

### 1. `src/profiles/wordpress/prompts/wp2shell-bounty-v6.md`

次の順に既存文を写して 1 本の英文にする。段落の間は空行 1 つ。語を変えない。

1. `src/profiles/wordpress/prompts/wp2shell-bounty-v5.md` の全文。見出し行の `v5` は `v6` にする。
2. v5 の「Attacker-controlled data is …」の段の直後に、`src/profiles/wordpress/prompts/wp2shell-whitebox-v1.7.md` の第 19 行（Deletion of posts … で始まる段）と第 21 行（Four of those classes have a weaker form … で始まる段）をこの順で入れる。第 21 行のうち arbitrary options update を扱う最後の 2 文は、計画文書第 4 節 #5 の備考どおり、採否が「採る」のときだけ残す。
3. その直後に v1.7 の第 23 行（**Dropped classes.** で始まる段）を入れる。計画文書第 3 節で Programme Boundary 文に移した種類と重複しても、この段ではそのまま残す（agent に「そこに agent を使わない」と伝えるのが目的）。
4. v5 の「Continue while a concrete source-bound frontier …」の段の直前に、次の内容の段を 1 つ足す。これは計画文書第 4 節 #8 の新規要素で、出典は所有者の指示（2026-10-17）と ADR 0029 の入口索引。文は次の 3 点だけを言う: (a) Harness が渡す入口索引の各項目を、registry で `observed` か `blocked` のどちらかにしてから Root は閉じる、(b) 索引は所在のカタログであり、経路や子の分担を指示しない（ADR 0029 の既存文言）、(c) 索引が `incomplete` と記されているときは、その事実を registry に書いて終了条件から外す。
5. v5 の「The root repeatedly synthesizes …」の箇条書きの末尾に、v1.7 第 43 行の 1 文「A fully-supported weaker route beats an unsupported stronger one: never promote a route by asserting a hop the source does not show.」を加える。v5 に既にある「Never promote a route by asserting a hop the source does not show.」と重なるので、v5 側の文を置き換える形にする。
6. 最低時間（v1.7 第 53 行）は入れない。

### 2. `src/profiles/wordpress/prompts/index.ts`

`WORDPRESS_DISCOVERY_PROMPT_IDS` と `WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS` と `loadWordPressDiscoveryAsset` の switch に `wp2shell-bounty-v6` を追加する。v5 は残す。既定（campaign.json の `promptId`）は変えない。

### 3. `src/profiles/wordpress/policy/campaign.json`

`programmeBoundary.version` を `wordfence-2026-10-17` にし、`text` を計画文書第 3 節の変更点どおりに書き直す。元になる文言は `src/profiles/wordpress/policy/programme-scope.md` の Wordfence 節（「分類と閾値」と「明示的に対象外の種別」）から取る。旧文は `docs/knowledge/` に `programme-boundary-wordfence-2026-10-08.md` として残す。`src/profiles/wordpress/discovery/programme-impacts.ts` の除外一覧と矛盾しないことをテストで確認する（既存の `programme-impacts` テストに version 文字列の一致を 1 件足す）。

### 4. `docs/adr/0029-single-wp2shell-cooperative-trial.md`

末尾に「## 2026-10-17 改訂」の節を追記する。内容は計画文書第 5 節の 5 項目。既存本文は変えない。`runWallTimeMinutes` を 120 にするのは campaign.json ではなく、測定用の config（`examples/` に `campaign-v6-measure.json` を置く）だけにする。

### 出力

- `pnpm check` を通す。
- PR 本文は日本語で 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）。「測った数字」は「未測定。計画文書第 6 節の arm B・C を merge 前に AI が走らせる」と書く。
- PR 本文に v6 の全文と日本語訳、新しい Programme Boundary 文と日本語訳を貼る。
- ラベルは付けない。所有者が全文を読んで `owner-approved` を付ける。

---

## 所有者向けの注意

- 本文は所有者が全文を読む。Codex が出典に無い文を足していないか、第 4 節の行と突き合わせる。
- campaign.json と ADR が含まれるので、`owner-approved` は所有者本人が付ける（DEVELOPMENT.md 第 5 節）。
- merge 前に AI が計画文書第 6 節の測定を走らせ、数字を PR comment と docs/evaluation に置く。
