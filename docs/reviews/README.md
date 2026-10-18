# 報告の置き場

AI に「調べて報告」を依頼したときの成果物を日付付きで置く。正本（[SPEC.md](../SPEC.md) / [ADR](../adr/)）ではなく、食い違えば正本が勝つ。報告を読んで所有者が決めたことだけが、PR か ADR になる（[DEVELOPMENT.md](../DEVELOPMENT.md) 第4節）。

2026-10-09 の5本は、#77〜#87 の設計元になった報告で、当時の未コミット変更を現状として書いている。

## 現状と違う報告（2026-10-19 時点）

報告は書き換えない。読むときに次の差を当てる。

- `2026-10-14-final-design.md`: 探索の Lab、即時の検証、`owner-approved` の付け手、Step 1 の「人手 0」の範囲は 2026-10-18〜19 の決定（ADR 0033〜0037、#238 の comment）で変わった。
- `2026-10-14-autonomous-verification-loop-design-proposal.md`: 検証は skill と handoff（ADR 0035）になった。
- `2026-10-16-selection-candidates-preview.md`: 選定の順位は ADR 0037 の採点と cascade に置き換わった。
- `2026-10-17-thorough-search-v6-plan.md`、`2026-10-18-index-coverage-vs-owner-findings.md`: 入口索引と coverage は ADR 0034 で削除した。
- `2026-10-18-source-only-dispatch-design.md`、`2026-10-18-codex-plan-dispatch-architecture.md`、`2026-10-18-codex-orchestration-dispatch.md`、`2026-10-18-codex-review-fixes-dispatch.md`: 課題配分（dispatch）は採らず、PR #357 で mode を削除した。
- prompt v4〜v7 の草案・対照表（`2026-10-13-critical-high-prompt-v4-source-map.md`、`2026-10-16-wp2shell-bounty-v5-draft.md`、`2026-10-17-codex-brief-prompt-v6.md`、`2026-10-18-wp2shell-bounty-v7.md`）: 旧版の記録。新規探索は v8 だけ（ADR 0033）。
