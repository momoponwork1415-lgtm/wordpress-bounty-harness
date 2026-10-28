# 報告の置き場

AI に「調べて報告」を頼んだときの成果物を、日付付きで置く。報告は正本ではない。正本は [SPEC.md](../SPEC.md) と [ADR](../adr/) で、食い違えば正本が勝つ。報告を読んで所有者が決めたことだけが、PR か ADR になる（[DEVELOPMENT.md](../DEVELOPMENT.md) 第 4 節）。

報告は後から書き換えない。古くなった点は、下の一覧で 1 行ずつ補う。

## この階にある報告

正本と運用文書（AGENTS、SPEC、ADR、`docs/` 直下、`docs/agents/`、`docs/evaluation/`、`docs/knowledge/`、skill、コード）から参照されている報告と、それらの報告が参照している報告だけを置く。

設計と方針の出典:

- [2026-10-11-harness-completeness-review.md](2026-10-11-harness-completeness-review.md): 報奨を得る装置としての完成度を、探索・検証・選定の 3 領域で監査した。
- [2026-10-11-thorough-design-review.md](2026-10-11-thorough-design-review.md): 不変条件が守られているかと、削るべき構造を 4 本の監査で調べた。
- [2026-10-11-comparison-with-public-harnesses.md](2026-10-11-comparison-with-public-harnesses.md): 公開ハーネスと比べた作り込みの過不足。
- [2026-10-11-issue-119-real-lab-dependency.md](2026-10-11-issue-119-real-lab-dependency.md): #119 の実機受入条件と、被害者側の操作の依存。
- [2026-10-11-overall-design-v1.md](2026-10-11-overall-design-v1.md): WP2Shell 方式へ戻すと決めた日の全体仕様の下書き。
- [2026-10-11-return-to-wp2shell-route.md](2026-10-11-return-to-wp2shell-route.md): 探索の主経路を WP2Shell 方式へ戻すための報告。
- [2026-10-11-two-stage-prompts-draft.md](2026-10-11-two-stage-prompts-draft.md): 二段構え探索の prompt 下書き。採らなかった案の記録。
- [2026-10-12-consolidation-and-production-first.md](2026-10-12-consolidation-and-production-first.md): 文書と Issue の整理案と、本番 1 周を先に回す計画。
- [2026-10-13-design-features-constraints.md](2026-10-13-design-features-constraints.md): 機能一覧と、制約ごとの出典。
- [2026-10-13-past-repos-lessons.md](2026-10-13-past-repos-lessons.md): 過去 4 世代の教訓の長い版。[LESSONS.md](../LESSONS.md) の出典。
- [2026-10-13-human-review-contract-and-parallel.md](2026-10-13-human-review-contract-and-parallel.md): 本番 4 周から読んだ、人間レビューの契約と並列化。
- [2026-10-13-selection-data.md](2026-10-13-selection-data.md): 選定に使う install 帯とタグの集計。
- [2026-10-14-final-design.md](2026-10-14-final-design.md): 2026-10-14 時点の最終設計（実装仕様版）。
- [2026-10-14-overbuild-and-gaps-review.md](2026-10-14-overbuild-and-gaps-review.md): 作り込み過ぎと不足の棚卸し。
- [2026-10-15-software-factory-and-meta-harness.md](2026-10-15-software-factory-and-meta-harness.md): software factory と meta-harness の考え方の取り入れ方。
- [2026-10-18-operating-policy-gap-report.md](2026-10-18-operating-policy-gap-report.md): 2026-10-18 の運用方針と現状の対照。
- [2026-10-19-selection-statistics.md](2026-10-19-selection-statistics.md): 公開統計から決めた選定の基準。
- [2026-10-27-partitioned-exploration-design.md](2026-10-27-partitioned-exploration-design.md): 区画分配型の探索の設計。役、責務の線（中身は AI、形は Harness）、設定と台帳、測り方、段階。図は同日付の [overview](2026-10-27-partitioned-exploration-overview.svg)、[target-flow](2026-10-27-partitioned-exploration-target-flow.svg)、[decided-structure](2026-10-27-decided-structure.svg)。[ADR 0042](../adr/0042-partitioned-exploration-stage-1-shape.md) の出典。
- [2026-10-28-adopted-design-for-approval.md](2026-10-28-adopted-design-for-approval.md): 区画分配型の探索の承認用の要約。部分ごとの採否と出典、所有者の決定、問答で決めた 15 点（§6）。図は [architecture](2026-10-28-architecture.svg)。ADR 0042 追記 1 の出典。
- [2026-10-28-core-feature-abuse-precedents.md](2026-10-28-core-feature-abuse-precedents.md): 本体の機能の悪用の先例を Wordfence mirror で数えた導出。`core-fixed-list-v1.md` の件数の出典（ADR 0042 追記 1）。
- [2026-10-27-pipeline-records-and-primitive-architecture.md](2026-10-27-pipeline-records-and-primitive-architecture.md): いまの 11 段で出る JSON と記録、Finding / Lead の欄、primitive を組み合わせる構成。
- [2026-10-27-established-harness-responsibility-split.md](2026-10-27-established-harness-responsibility-split.md): 4 社の記事から読んだ Harness と AI の分け方。同日午後に repo 比較で訂正した。
- [2026-10-27-public-harness-repos-responsibility-split.md](2026-10-27-public-harness-repos-responsibility-split.md): 公開 repo 3 本（Anthropic / Google Mantis / Cloudflare）を行で読んだ分け方と、Shopify / AVDH の記事、過去 6 本の調査との関係。

探索 prompt の出典と実測:

- [2026-10-13-prompt-source-comparison.md](2026-10-13-prompt-source-comparison.md): prompt v4 の出典対照表。
- [2026-10-13-source-prompts-ja.md](2026-10-13-source-prompts-ja.md): 出典 prompt（WP2Shell 記事、旧 harness）の日本語訳。
- [2026-10-13-prompts-in-use-ja.md](2026-10-13-prompts-in-use-ja.md): 2026-10-13 に使っていた prompt の日本語訳。
- [2026-10-13-critical-high-v4-development-trials.md](2026-10-13-critical-high-v4-development-trials.md): prompt v4 の開発 Trial の実測。
- [2026-10-16-wp2shell-bounty-v5-draft.md](2026-10-16-wp2shell-bounty-v5-draft.md): prompt v5 の草案。
- [2026-10-17-thorough-search-v6-plan.md](2026-10-17-thorough-search-v6-plan.md): prompt v6 に向けた網羅性の見直し計画。
- [2026-10-18-wp2shell-bounty-v7.md](2026-10-18-wp2shell-bounty-v7.md): prompt v7 の採用本文。
- [2026-10-18-v8-r2-public-record-comparison.md](2026-10-18-v8-r2-public-record-comparison.md): v8 r2 の Trial と公開記録の照合。
- [2026-10-25-wp2shell-bounty-v10.md](2026-10-25-wp2shell-bounty-v10.md): prompt v10 の本文、日本語訳、v8 との差分と出典対照。

Codex への依頼文:

- [2026-10-16-codex-one-prompt.md](2026-10-16-codex-one-prompt.md): Codex の 1 セッションに貼る簡潔版。
- [2026-10-16-codex-monitor-brief.md](2026-10-16-codex-monitor-brief.md): 監視だけを行う Codex セッションの依頼文。
- [2026-10-16-codex-orchestration-brief.md](2026-10-16-codex-orchestration-brief.md): Codex のオーケストレーションの依頼文（長い版）。
- [2026-10-16-codex-briefs-262-265-268.md](2026-10-16-codex-briefs-262-265-268.md): PR 3 本の修正の依頼文。
- [2026-10-16-codex-briefs-issues.md](2026-10-16-codex-briefs-issues.md): Issue 6 本の依頼文。

## 現状と違う点（2026-10-19 時点）

- `2026-10-14-final-design.md`: 探索の Lab、即時の検証、`owner-approved` の付け手、Step 1 の「人手 0」の範囲は、2026-10-18〜19 の決定（ADR 0033〜0037、#238 の comment）で変わった。
- `2026-10-17-thorough-search-v6-plan.md`: 入口索引と coverage は ADR 0034 で削除した。
- prompt v4〜v7 の草案と対照表: 旧版の記録。新規探索は `deep` の `wp2shell-bounty-v11` と `wide` の `wp2shell-bounty-v14-wide` だけで、`wide` の比較候補 v15-wide と v18-wide（[v18-wide](2026-10-28-wp2shell-bounty-v18-wide.md)）は名指しで走る（[出典対照](2026-10-26-wp2shell-bounty-v14-wide-source-table.md)、ADR 0039 の 2026-10-27 追記 12。v16-wide と v17-wide は同日に archived にした（[v16-wide](2026-10-26-wp2shell-bounty-v16-wide.md)、[v17-wide](2026-10-27-wp2shell-bounty-v17-wide.md)）。v10、v12-wide、v13-wide は archived、v8 は ADR 0033 で入り、照合用に残す）。`wide` の比較候補 `wp2shell-bounty-v15-wide` は名指しのときだけ走る（[本文と出典対照](2026-10-26-wp2shell-bounty-v15-wide.md)、ADR 0039 の 2026-10-26 追記 8）。

## archive/

どこからも参照されていない報告は [archive/](archive/) に移した。ファイル名は変えていない。2026-10-08〜10 の旧文書（`DESIGN-EVIDENCE.md`、`PILOT-2026-10-10.md`）もここに置いた。LESSONS と ADR はこれらの報告から引いているので、出典として消さずに残す。

archive の中で現状と違う点:

- 2026-10-09 の 5 本: #77〜#87 の設計元。当時の未コミットの変更を現状として書いている。
- `2026-10-14-autonomous-verification-loop-design-proposal.md`: 検証は skill と handoff になった（ADR 0035）。
- `2026-10-16-selection-candidates-preview.md`: 選定の順位は ADR 0037 の採点と cascade に置き換わった。
- `2026-10-18-index-coverage-vs-owner-findings.md`: 入口索引と coverage は ADR 0034 で削除した。
- `2026-10-18-source-only-dispatch-design.md` ほか dispatch の報告 3 本: 課題配分は採らず、PR #357 で mode を削除した。
