# docs/knowledge — 過去 4 世代の知識の置き場

正本ではない。食い違えば [SPEC.md](../SPEC.md) と [ADR](../adr/) が勝つ。目的は 1 つで、**新しい問いを立てる前に、同じ問いに過去の世代が出した答えをここで探せる**ようにすること。実験記録は [experiments.md](experiments.md) に 1 行ずつ、取り込んだ原本は `imported/<世代>/` に置く。

## 世代と置き場

| 世代 | 期間 | 原本（Git 外） | ここにあるもの |
| --- | --- | --- | --- |
| 07 Satoki 系 thin harness | 2026-07 | `/home/dev/harness/game-bugbounty`、`/home/dev/legacy-codex-satoki-*` | 方法論 1 本、risk audit 1 本 |
| 08 whitebox-harness | 2026-07-25〜08-11（有償 9 件） | `/home/dev/whitebox-harness`（git） | 実績のある prompt `bounded-wp2shell/v1.7`、root 用 DISCOVERY、skill 3 本 |
| 08 wp-bounty-workspace | 2026-08 | `/home/dev/wp-bounty-workspace`、`/mnt/d/wordfence` | 却下理由の分類 R1〜R10、報告書・PoC の house style、Wordfence / Patchstack の対象範囲の転記、フォーム選択肢、台帳分析の集計 |
| 09 wordpress-harness v1〜v9 | 2026-09〜10-08（未知の発見 0） | `/home/dev/wordpress-harness`（git） | 調査 note 12 本、prompt v7 / v9 |
| wp2shell | 2026-08 | `/home/dev/wp2shell/toolkit` | 公開原文に基づく prompt template 3 本 |
| 10 この repo | 2026-10-05〜 | — | [docs/reviews/](../reviews/)、[LESSONS.md](../LESSONS.md) |

提出履歴そのもの（件別の plugin、版、報酬額）、報告本文、PoC、evidence は **Git に入れない**（SPEC.md 第 2 節 8）。集計は [reviews/2026-10-13-prompt-source-comparison.md 第 6 節](../reviews/2026-10-13-prompt-source-comparison.md) と [imported/08-workspace/LEDGER-ANALYSES.md](imported/08-workspace/LEDGER-ANALYSES.md)。

## 取り込みの規則

1. 先頭に `<!-- provenance: 元 path, mtime, 取り込み日, 世代 -->` を付ける。原本を書き換えない。要約や訂正は別 file か [experiments.md](experiments.md) に書く。
2. 件別の plugin 名・版・分類・報酬額、所有者の提出文面、Wordfence が引用した source 行、payload、再現手順は取り込み時に落とし、`[... は Git 外: 元 path の該当節]` と置く。
3. 公開済み CVE の評価記録は、CVE id と結果（回収した / しなかった）だけを残す。
4. `imported/` の prompt と skill は過去の記録で、Harness は読まない。現行 prompt は `src/profiles/wordpress/prompts/`、変更は所有者の全文確認が要る（[DEVELOPMENT.md 第 5 節](../DEVELOPMENT.md)）。
5. prettier は `**/*.md` を見ないので整形は原本のまま。CI の `private-guard` が path と大きさを見る。

## 先に読む 5 本

1. [imported/08-workspace/history/rejection-reasons-verbatim.md](imported/08-workspace/history/rejection-reasons-verbatim.md) — Wordfence が却下に使う 10 の理由。Programme Boundary と Lead 落としの根拠。
2. [imported/08-workspace/LEDGER-ANALYSES.md](imported/08-workspace/LEDGER-ANALYSES.md) — 所有者の台帳分析の結論 11 件と、現行方針での扱い。
3. [imported/08-whitebox/bounded-wp2shell-v1.7-PROMPT.md](imported/08-whitebox/bounded-wp2shell-v1.7-PROMPT.md) — 有償 9 件を出した期間の prompt。v4 の骨格（#189）。
4. [imported/08-workspace/history/wordfence-description-template.PROPOSED.md](imported/08-workspace/history/wordfence-description-template.PROPOSED.md) と [wordfence-poc-template.PROPOSED.md](imported/08-workspace/history/wordfence-poc-template.PROPOSED.md) — 報告書と PoC の house style。#188 の skill の材料。
5. [imported/09-wordpress-harness/knowledge/wp2shell-current-research-gap.md](imported/09-wordpress-harness/knowledge/wp2shell-current-research-gap.md) — v7 が wp2shell 原文から何を削り、何が足りなかったか。
