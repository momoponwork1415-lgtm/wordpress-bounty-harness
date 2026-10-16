# Codex オーケストレーションセッションの依頼文（2026-10-16）

所有者が Codex に 1 回貼る。Codex は 1 セッションで下の列を順に消化し、各タスクを 1 PR（または既存 PR の修正）にする。個々のタスクの依頼文は次の 2 file にあり、このセッションはそれを読んで使う。

- PR 修正 3 本: [2026-10-16-codex-briefs-262-265-268.md](2026-10-16-codex-briefs-262-265-268.md)
- Issue 9 本: [2026-10-16-codex-briefs-issues.md](2026-10-16-codex-briefs-issues.md)（#281 #284 #276 #275 #278 #279 #277）と、本 file 末尾の #212 #211

期限は 2026-10-20。merge は Codex がしない（Claude の委任セッションが数字を貼って merge する）。

## 貼る文（オーケストレーター）

```text
役割: リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness の作業列を 1 つずつ消化するオーケストレーター。各タスクは別 branch・別 PR。merge はしない。

最初に読む: AGENTS.md、docs/DEVELOPMENT.md 第 3・5 節、docs/FACTORY.md、docs/TEST-STRATEGY.md、docs/reviews/2026-10-14-final-design.md 第 1・8・13 節。依頼文は docs/reviews/2026-10-16-codex-briefs-262-265-268.md、docs/reviews/2026-10-16-codex-briefs-issues.md、docs/reviews/2026-10-16-codex-orchestration-brief.md の末尾。file が無ければ所有者に聞いて止まる。

作業列（この順。前のタスクの PR を出してから次へ）:
  A. 既存 PR の修正: PR #262 → PR #265 → PR #268。終わったら PR #266 #267 #269 に origin/main と修正後の #265 を merge して push する（内容は変えない）。
  B. 新規 Issue: #281 → #284 → #212 → #276 → #275 → #211 → #278 → #279 → #277（matrix のみ）。
  C. 列が空いたら #282（Unlimited Elements の Snapshot 接続）。依頼文が無いので Issue 本文の受入条件だけで進め、Draft で止める。

各タスクの進め方:
  1. 新規は origin/main から branch（命名 codex/issue-<番号>-<短い語>）。既存 PR の修正はその PR の head を使い、origin/main を merge してから作業する。
  2. 先に公開 interface から失敗する受入試験を 1 つ書き、最小実装で通す。
  3. pnpm check と pnpm build を通す。追加差分は 500 行以内（超えるなら 2 PR に割り、2 本目は列の末尾に回す）。
  4. PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）を日本語で。測った数字には pnpm check の件数を貼る。配線・runtime の変更は「初回 3 Trial の数字待ち」と書いて Draft のままにする。
  5. Issue に「branch 名、PR 番号、受入条件のうち満たした番号」を 1 comment 残す。

逆圧（docs/DEVELOPMENT.md 第 5 節）: open の PR（Draft 含む）が 3 本を超えている間は新しい PR を出さない。その場合は branch を push し、Issue に「PR 待ち、branch <名>」と comment して次のタスクへ進む。既存 PR の修正（A）は新しい PR ではないので数に入れない。open PR が 3 本以下になったら、push 済み branch から順に PR を出す。

書かないもの・触らないもの:
  - 不変条件（docs/SPEC.md 第 2 節）、判定器の成功条件（src/profiles/wordpress/verification/judges.ts）、既定 prompt、台帳の既存 event 型。新しい台帳 event 型、第 2 の journal、owner lease、host 共通 claim、crash reconciliation、P6 定数、install 下限は書かない。
  - owner-approved path（docs/adr/、docs/SPEC.md、trust-boundary-v1.md、policy/campaign.json、policy/programme-scope.md、programme-impacts.ts、judges.ts）と、agent に渡る文章（prompt 本文、.claude/skills/ の skill 本文、Harness 生成の節の雛形）。タスクがこれらの変更を要すると分かったら、その理由を Issue に comment して止め、次のタスクへ進む。
  - ~/.local/state 以下、Private Evidence、docker、Trial の起動、Lab の操作。計測は Claude 側がやる。
  - force push、他人の branch の rebase、PR の merge・close、ラベルの変更、Issue の close。

止まる条件（止まったら Issue に理由を comment し、次のタスクへ）:
  - 同じ PR で CI が 2 回連続で赤。
  - 受入条件が SPEC か最終設計と矛盾する。
  - 500 行以内に収まらず、2 分割の案も立たない。

報告: 各タスクの終わりに「Issue / PR / branch / 変更 file 数 / 追加行 / pnpm check 件数 / 満たした受入条件 / 止まった理由」を 1 行。列が全部終わったら、その表を 1 つ出して終わる。
```

## 追加の依頼文（本 file だけにあるもの）

### #212 探索 run の開始・終了時刻と UTC 日別使用量を実際の時刻に合わせる

```text
Issue #212 を解く。対象は src/discovery/campaign.ts の executePlanned（開始時に base.occurredAt を 1 回だけ生成し、Root の finished と子 run の回収に同じ base を再利用している）、src/discovery/recover-agent-reports.ts（子の start / finish に同じ時刻を使う）、src/ledger/index.ts の usage 集計（finished event の occurredAt の UTC 日を鍵にする）。

1. Root と子の discovery-run-started / discovery-run-finished が、それぞれ実際の開始・終了時刻を occurredAt に持つようにする。clock() を event ごとに呼ぶ。identity と既存 event の形は変えない。
2. 子 run の start は native receipt の開始時刻、finish は終了時刻に合わせる。receipt に無い場合は回収時刻を使い、その旨を event の既存欄で読めるなら残す（新しい欄を足す必要があるときは理由を PR 本文に書く）。
3. ledger usage は finished の occurredAt の UTC 日で集計する現行仕様のまま、1 の修正で実終了日に乗ることを確認する。
4. テスト: 制御時計で (a) 正の wall の Root run の start < finish、(b) UTC 23:50 開始・翌 00:10 終了の Root と子 run で ledger usage の run 数と token が翌日に計上される、(c) completed / failed / provider-limited の 3 経路で finish の時刻が start と異なる。
5. docs/OPERATIONS.md 第 4 節に「2026-10-16 以前の run は start と finish の occurredAt が同値で、日跨ぎ run の使用量は開始日に計上されている。既存 event は書き換えない」と 1 行足す。
追加 150 行以内。実 Lab の計測（新しい run での start / finish / usage）は Claude 側が貼る。
```

### #211 Verifier の任意セッション欄の空値で非セッション検証が recipe 未完了にならないようにする

```text
Issue #211 を解く。対象は src/profiles/wordpress/verification/codex-verifier.ts の、Verifier 最終レポートの任意セッション欄に対する内側 schema。

1. セッション欄の「厳密に値なし」だけを意味する形を 1 か所の関数で定義し、セッション不在として扱う。値なしと認めるのは、外側 null、入れ子の null（文字列化した "null" を含む）、全項目が null の object の 3 形だけ。空文字、余分な項目、形式不正の非空値は従来どおり incomplete(recipe)。
2. 非セッション型の Finding では、値なし表現が判定器の実行と Harness 捕捉・canary 観測を妨げない。
3. セッション証明が必要な Finding では、値なし表現や自己申告だけで陽性にならない。Lab が別主体の有効なセッションを確認する既存条件（#65）は変えない。
4. 元レポートは従来どおり Private Evidence に残す（正規化前の bytes を失わない）。
5. テスト: 外側 null / 入れ子 null / "null" 文字列 / 全項目 null / 有効な値 / 空文字 / 余分な項目 / 不正な非空値 の 8 入力 × セッション要否 2 通り。
6. Verifier prompt（verifier-v7）本文は変えない。変えないと解けないと分かったら、理由を Issue に comment して止める（agent に渡る文章は owner-approved が要る）。
追加 150 行以内。実 Lab で recipe 失敗が形式差だけで再発しないことの計測は Claude 側が貼る。
```
