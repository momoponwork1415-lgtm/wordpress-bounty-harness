# Codex に貼る 1 本のプロンプト（簡潔版、2026-10-16）

所有者が Codex の 1 セッションに丸ごと貼る。詳しい受入条件は各 Issue 本文と PR のレビュー comment にあり、Codex はそれを読む。長い版は [オーケストレーター](2026-10-16-codex-orchestration-brief.md)、[PR 修正](2026-10-16-codex-briefs-262-265-268.md)、[Issue 別](2026-10-16-codex-briefs-issues.md)。食い違えば Issue 本文と PR comment が勝つ。

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。作業列を上から順に消化する。merge はしない。
先に読む: AGENTS.md、docs/DEVELOPMENT.md 第 5 節、docs/FACTORY.md 第 4 節。

作業列
A. PR 修正（既存 branch に main を merge してから。Draft のまま、comment に「指摘 n 件のうち m 件対応」）
   #262 → #265 → #268。終わったら #266 #267 #269 に main と修正後の #265 を merge して push。
   直す内容は各 PR の 2026-10-16 のレビュー comment に書いてある。
B. Issue（origin/main から branch codex/issue-<番号>-<語>。1 Issue 1 PR）
   #281 → #284 → #212 → #276 → #275 → #211 → #278 → #279 → #277（表とテストだけ）
   受入条件は Issue 本文。並行は 2 本まで。#275 と #276、#278 と #279 は並行しない。
C. 列が空いたら #282。

各タスクの型
- 先に失敗する受入試験を 1 つ、次に最小実装。pnpm check と pnpm build を通す。追加 500 行以内。
- PR 本文は 5 項目（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）、日本語。
- 配線や runtime を触る PR は Draft のまま「初回 3 Trial の数字待ち」と書く。数字は Claude が貼る。
- Issue に branch 名と PR 番号を 1 comment。

逆圧: open PR（Draft 含む）が 3 本を超えている間は新しい PR を出さず、branch を push して Issue に「PR 待ち」と comment し次へ。既存 PR の修正は数に入れない。

触らない: SPEC §2 の不変条件、judges.ts、prompt と skill の本文、docs/adr/、docs/SPEC.md、policy/、programme-impacts.ts、台帳の既存 event 型（新しい event 型も足さない）、~/.local/state、docker、Trial の起動、force push、merge、close、ラベル。
これらの変更が要ると分かったら Issue に理由を comment して止め、次へ。

止まる: 同じ PR で CI が 2 回連続で赤 / 受入条件が SPEC か最終設計と矛盾 / 500 行に収まらず分割案も無い。
報告: タスクごとに「Issue / PR / branch / 追加行 / pnpm check 件数 / 満たした受入条件 / 止まった理由」を 1 行。全部終わったら表を 1 つ。
```
