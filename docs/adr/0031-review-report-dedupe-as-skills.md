---
status: accepted
date: 2026-10-13
supersedes: 0028 (withdrawn); SPEC 第 8 節のうち review モジュールの責務範囲
---

# 人間レビュー・報告書・重複照合は Claude Code の skill に置き、Harness は自律ループ・決定論の観測・提出状況の台帳に限る

## 決定

- Harness が持つのは、選定 → Snapshot 固定 → Lab 供給 → 探索 → 検証 → 台帳の自律ループ、決定論の観測（判定器、実行前後の差分）、提出状況の記録（`review decide / draft / authorize / submitted / outcome`）だけにする。
- 候補を読んで判断する、重複を公開情報で照合する、報告書を書く、の 3 つは repo の `.claude/skills/` にある skill（`wbh-review`、`wbh-dedupe`、`wbh-report`）が担い、所有者が Claude Code 上で対話的に使う。skill は台帳の内部 schema を読まず、`review export --finding <id>` が出す 1 件分の束（Finding、HTTP 捕捉、反証 memo、実行前後の差分、版の変化、インストール数、Private Evidence への path）だけを読む。
- skill が Harness に書くのは上の 5 コマンド経由だけ。文案は skill が書き、その digest と承認の結び付き（不変条件 7）は Harness が記録する。
- Harness から skill を自動で呼ぶのは、重複照合を人間が 10 件回して出力が安定した後に、`verification-finished` の直後 1 箇所だけとする。結果は `possible-match / no-match / unavailable` の 3 値で、探索には渡さない（不変条件 1）。
- 既存の `review scope` と `review dedupe` のコードは削除せず拡張を止める（整理は Step 1 の後）。

## 理由

- 本番 3 周で人間が開いた Finding は 0 件で、review CLI の機能数は多いが使われていない。所有者は 2026-10-13 に「人間レビューは許容する。問題は件数。判断が要る工程は skill、決定論の部分とループは Harness」と決めた。
- 2026-08 の whitebox-harness と wpb は同じ結論（判断は fresh session の skill、Harness は運び屋）に到達している（[docs/LESSONS.md](../LESSONS.md) 4、5）。
- 判定器を分類ごとに揃える代わりに、Programme Boundary 内の Finding を判定結果に関係なく人間へ届ける（#185）。偽陰性は報酬を失うので、判定器が確認できない候補を落とさない。

## 採らなかった選択肢

- LLM が証拠を読んで `runtime-confirmed` を出す: 同じ Verifier が成立した書き込みを「反証」として書いた例があり、不変条件 3 を維持する。
- review CLI を拡張して 1 画面の材料を出す: skill の方が所有者の操作に合い、Harness の表面を増やさない。
- review CLI の削除: 整理は Step 1 の後と所有者が決めている。

## 影響

- SPEC 第 8 節の review モジュールの責務を「状態の記録と export」に縮め、判断の工程は skill と書く。
- 0028 は withdrawn。人間の作業時間の記録は `review decide` の event で足りる。
