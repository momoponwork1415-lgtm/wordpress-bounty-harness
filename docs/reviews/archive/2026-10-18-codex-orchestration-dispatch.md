# Codex オーケストレーションセッションの依頼文（2026-10-18、課題配分型探索）

所有者が Codex に 1 回貼る。Codex は 1 セッションをオーケストレーターにし、[実装計画](2026-10-18-codex-plan-dispatch-architecture.md) の brief 1〜6 を sub-session（または直列）で消化し、各タスクを 1 PR にする。merge と Trial の計測は Codex がしない（Claude の委任セッションが数字を貼って merge する）。

既に開いている PR #316 #320 #321 #319 は所有者の label 待ちで、rebase は Claude 側がやる。このセッションは触らない。

## 貼る文（オーケストレーター）

```text
役割: リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness で、docs/reviews/2026-10-18-codex-plan-dispatch-architecture.md の brief 1〜6 を実装するオーケストレーター。タスクごとに sub-session を起動して任せ、自分は順番・依存・衝突・報告を管理する。sub-session が使えない環境なら自分で直列に進める。merge はしない。

最初に読む（sub-session にも必ず読ませる）: AGENTS.md、docs/DEVELOPMENT.md 第 2・3・5 節、docs/reviews/2026-10-18-source-only-dispatch-design.md、docs/reviews/2026-10-18-codex-plan-dispatch-architecture.md。file が無ければ所有者に聞いて止まる。prompt の .md（src/profiles/wordpress/prompts/）は brief 4 の担当以外は開かない。

作業の分割（計画の brief を PR 単位に割る。各 PR の追加差分は 500 行以内）:
  1a-0 / 1a-1 / 1a-2. Issue #328 の 2026-10-18 comment と計画の「Brief 1a-0 〜 1a-2」: unresolved 一覧、agent による索引補完（Harness 側）、目的文 index-completion-v1。1a の前に置く。1a-2 は prompt file なので 4b と同じ扱い（出典の 5 要素以外を書かない、PR 本文の先頭に明記）。
  1a. brief 1 の 1: task-plan.ts と test だけ（純関数、config と実行に触らない）。併合後の索引を入力にする。
  1b. brief 1 の 2〜3: dispatch mode の config、plannedTrials、台帳 field（runKind task、taskId など）、課題失敗の扱い、retry 1 回。
  1c. brief 1 の 3 の sandbox 部分: command 単位 timeout、solo の maxRequests、concurrency 上限 16。
  1d. brief 1 の 4: examples/campaign-dispatch.json と CLI の通し test。
  2a. brief 2 の 1: coverage-recorded と report の examined / unexamined の取り込み。
  2b. brief 2 の 2〜3: Finding signature と duplicateOf、queue の除外、funnel の slice。
  3.  brief 3（gapfill）。2 PR に割るなら task 生成と round 制御。
  4a. brief 4 の Harness 側 1〜6（refutation schema、outputKind、台帳 event、配線、refute CLI、test）。prompt file は入れない。
  4b. brief 4 の prompt file refute-v1.md と digest 登録だけ。出典対照表 7 行以外の要素を書かない。PR comment に対照表を貼り、PR 本文の先頭に「所有者の全文読了と owner-approved が必要」と書く。
  5.  brief 5（検証 consumer の分離）。
  6a〜6c. brief 6 の 1（台帳 index）、2（rfi 判定器）、3（履歴 prior、selection.json は owner-approved path なので Draft のまま）。brief 6 の 4（ADR 0033、SPEC）はやらない。

順番と並行:
  - 並行して良い組: {1a → 1b → 1c → 1d}、{4a → 4b}、{5}。この 3 列は別 sub-session で同時に進めて良い。
  - 2a は 1b と PR #320 が main に入ってから。2b は 2a の後。3 は 2b の後。6a〜6c は 1〜5 が全部 main に入ってから。
  - 1b、1d、5 は PR #321（feat/297-explore-only、discovery.lab と verify next）に依存する。#321 が main に入る前に始めるなら、branch は origin/feat/297-explore-only から切り、PR の base も feat/297-explore-only にする（#321 が merge されれば GitHub が base を main に変える）。4a は origin/main から切る。
  - 前の PR が main に入っていない状態で次の PR を始めるときは、前の branch から切って PR の base を前の branch にする（stacked）。origin/main に直接 rebase しない。

各タスクの進め方（sub-session への指示に含める）:
  1. branch 命名 codex/dispatch-<番号>-<短い語>（例 codex/dispatch-1a-task-plan）。worktree は /home/dev/wordpress-bounty-harness-codex-<番号>。作ったら pnpm install --frozen-lockfile --offline。
  2. 先に公開 interface から失敗する受入試験を 1 つ書き、最小実装で通す。
  3. pnpm check と pnpm build を通す。pre-push hook が test を回す。空の /tmp/.git が残っていると catalog の test が落ちるので、その場合は rmdir /tmp/.git。
  4. PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）を日本語で。測った数字には pnpm check の件数を貼る。Trial を回す必要がある gate（計画の「各 Phase の gate」）は Claude 側が回すので、「開発セットの数字待ち」と書いて Draft のままにする。
  5. commit は repo の identity で: git -c user.name=Codex -c user.email=codex@local.invalid commit。
  6. 終わったらオーケストレーターに「PR 番号 / branch / 変更 file 数 / 追加行 / pnpm check 件数 / Draft か / 止まった理由」を 1 行で返す。

逆圧: このセッションが出した open の PR（Draft 含む）が 3 本を超えている間は新しい PR を出さず、branch を push して待つ。#316 #320 #321 #319 は数に入れない。

書かないもの・触らないもの:
  - 不変条件（docs/SPEC.md 第 2 節）、判定器の成功条件（src/profiles/wordpress/verification/judges.ts の canary の仕組み。6b の rfi 追加は既存 lfi 判定器の写しに限る）、既定 prompt、台帳の既存 event の形。
  - owner-approved path（docs/adr/、docs/SPEC.md、trust-boundary-v1.md、policy/campaign.json、policy/programme-scope.md、programme-impacts.ts）と agent に渡る文章（prompt 本文、skill 本文、Harness 生成の節の雛形）。例外は 4b の refute-v1.md と、6c の selection.json（Draft のまま、理由を PR 本文に）。これら以外で変更が要ると分かったら理由を PR 本文に書いて止め、次へ進む。
  - ~/.local/state 以下、~/.config/wordpress-bounty-harness 以下、/home/dev/wordpress-bounty-harness-prod* 、Private Evidence、docker の起動、Trial や Lab の起動。計測は Claude 側がやる。
  - force push、#316 #320 #321 #319 の rebase や編集、PR の merge・close、ラベルの変更、Issue の close。
  - 協調 Trial（mode wp2shell）の挙動変更。dispatch は新しい mode として足す。

止まる条件（止まったらオーケストレーターが所有者向けの 1 行を残して次へ）:
  - 同じ PR で CI が 2 回連続で赤。
  - 受入条件が SPEC か設計案と矛盾する。
  - 500 行以内に収まらず、分割の案も立たない。
  - 依存する PR（#321 など）が 2 日以上 main に入らず、stacked にしても衝突が解けない。

報告: タスクが終わるごとに 1 行、全部終わったら「PR / branch / 変更 file 数 / 追加行 / pnpm check / Draft か / 止まった理由」の表を 1 つ出して終わる。途中で所有者に聞くのは「file が無い」「owner-approved path の変更が避けられない」の 2 つだけ。
```

## Claude 側の分担

- #316 → #320 → #321 → #319 の rebase と、所有者の label 後の merge。
- Draft PR の gate 計測（開発セット、`docs/evaluation/` に記録）と、数字の貼り付け、merge。
- Codex が止まった項目の整理と Issue 化。
- ADR 0033 と SPEC 第 6・7 節の下書き（所有者が owner-approved）。
