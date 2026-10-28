# Codex に貼る 1 本のプロンプト（オーケストレーター、2026-10-28）

所有者が Codex の 1 セッションに丸ごと貼る。オーケストレーターが sub-agent に作業を配り、整理 → 実装 → 本番切り替え → 検証の自動化まで進める。詳しい受入条件は各 Issue 本文と comment にあり、食い違えば Issue が勝つ。前の版は [2026-10-16-codex-one-prompt.md](2026-10-16-codex-one-prompt.md)。

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。あなたはオーケストレーター。作業は sub-agent に配り、自分は読む・配る・確かめる・記録するだけ。
先に読む: AGENTS.md、docs/DEVELOPMENT.md 第 5 節、docs/FACTORY.md 第 4 節、docs/agents/issue-tracker.md、docs/agents/pr-review-merge.md、docs/adr/0042、docs/reviews/2026-10-28-problems-and-next-steps.md。

段 0: 整理（#654）。これが終わるまで段 1 に入らない。
  A 文書の PR 1 本 → B Issue の close と付け替え（gh）→ C worktree と branch。受入条件は #654 本文。消す前に tip の sha を #654 に comment。
  本番ランナー（/home/dev/worktree/prod26 で動く continuous run）には触らない。

段 1: 区画分配型を Codex で本番に乗せる。
  #647（道具 v2 と上限。小）→ #646（Codex の一発 run。中）。同じ file（src/cli/wordpress-session.ts）を触るので直列。
  両方 merge 後: #633 の 2026-10-28 の comment のとおり、campaign-production-codex-partitioned-<日付>.json を作り（enumerator.runtime と tracer.runtime を codex、tracer.maxParallel 4、mode partitioned）、新しい continuous run を起動する。
  v14-wide の prod ランナーは止めず maxConcurrentTargets を 5 → 1 にして再起動する（比較の腕）。
  最初の 10 Trial で provider-limited の追跡役が 0 なら maxParallel を 8 に上げる。20 対象分の funnel を #633 に貼る。

段 2: 検証の自動化。#650 → #651 → #652（直列。#646 の後）。
段 3: 並行で進めてよいもの（同じ file を触る組は直列。並行は 2 本まで）。
  #533（選定。#649 の受入条件を統合済み）→ #520、#653（群の鍵）、#601（還流）、#576、#605、#637、#640、#644、#588。

各タスクの型
- origin/main から branch codex/issue-<番号>-<語>。1 Issue 1 PR。先に失敗する受入試験 1 つ、次に最小実装。pnpm check と pnpm build を通す。
- PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）、日本語。箇条 1 つに 1 文。
- Issue に branch 名と PR 番号を 1 comment。進行中の状態は Git ではなく Issue の comment に書く。

レビューと merge（所有者の委任、2026-10-28）
- PR ごとに、作った sub-agent とは別の sub-agent が diff だけを読んでレビューする（Issue の受入条件との対応、SPEC §2 の不変条件、AGENTS.md の責務の線）。指摘は PR comment に番号付きで書き、作った側が直す。
- CI が緑で、レビューの指摘が全部閉じたら、オーケストレーターが squash merge し、worktree と branch を消す。
- agent に渡る文章（prompt、skill、Harness が生成する節）、docs/adr、docs/SPEC.md、policy/ を触る PR は、レビュー sub-agent が「Issue にある要素だけで、要素を足していない」と確認した上で owner-approved ラベルを付けてから merge し、PR comment に「所有者の委任（2026-10-18、2026-10-28）により AI が確認」と書く。確認できなければ merge せず所有者に聞く。
- 本文の変更を Issue が許していないのに必要になったら、止めて Issue に理由を comment し、次へ。

逆圧: open PR が 3 本を超えている間は新しい PR を出さず、branch を push して Issue に「PR 待ち」と comment し次へ。

触らない: SPEC §2 の不変条件、台帳の既存 event 型（新しい型は Issue が明示するときだけ）、~/.local/state の記録、prod26 の checkout、force push、Issue 本文の書き換え（comment だけ）。

止まる: 同じ PR で CI が 2 回連続で赤 / 受入条件が SPEC か ADR 0042 と矛盾 / 本番ランナーの起動で provider-limited が 3 Trial 連続 / 所有者の判断が要る（#428、#435、#519、#523、GitHub の設定変更）。止まったら理由を該当 Issue に comment し、他のタスクを続ける。

報告: タスクごとに「Issue / PR / branch / 追加行 / pnpm check 件数 / 満たした受入条件 / 止まった理由」を 1 行。段が終わるごとに表を 1 つ。段 1 の起動後は、24 時間ごとに #633 に Trial 数・群・段 1b 通過・provider-limited・unfinished を 1 行で書く。
```
