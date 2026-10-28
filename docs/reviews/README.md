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

2026-10-21〜28 の報告と依頼文:

- [2026-10-23-additional-library-and-platform-options.md](2026-10-23-additional-library-and-platform-options.md): 追加で検討したライブラリ・基盤。
- [2026-10-23-architecture-adoption-priorities.md](2026-10-23-architecture-adoption-priorities.md): 技術採用と自作部分の整理：優先順位付きの推奨。
- [2026-10-23-build-versus-buy-recommendation.md](2026-10-23-build-versus-buy-recommendation.md): 既存技術へ任せる範囲と、設計を直す範囲の推奨。
- [2026-10-23-current-feature-inventory.md](2026-10-23-current-feature-inventory.md): 機能一覧と、Harness・スキル・人間の役割。
- [2026-10-23-discovery-efficiency-review.md](2026-10-23-discovery-efficiency-review.md): 探索を続けながら効率を改善するための調査。
- [2026-10-23-feature-disposition-recommendation.md](2026-10-23-feature-disposition-recommendation.md): 28 機能の採否と責務の推奨。
- [2026-10-23-feature-map-and-removal-options.md](2026-10-23-feature-map-and-removal-options.md): 機能一覧・コード量・削除を判断するための資料。
- [2026-10-23-feature-usage-and-design-audit.md](2026-10-23-feature-usage-and-design-audit.md): ハーネス全体の機能利用・削除候補・設計の棚卸し。
- [2026-10-23-hytale-game-bounty-harness.md](2026-10-23-hytale-game-bounty-harness.md): Hytale 型ゲームのバグバウンティと最小ハーネスの調査。
- [2026-10-23-library-and-platform-options.md](2026-10-23-library-and-platform-options.md): 既存ライブラリ・実行基盤を使う選択肢。
- [2026-10-23-public-vulnerability-harness-landscape.md](2026-10-23-public-vulnerability-harness-landscape.md): 公開 AI 脆弱性探索ハーネス・研究・実運用の横断調査。
- [2026-10-24-austin-ginder-deep-exploration-analysis.md](2026-10-24-austin-ginder-deep-exploration-analysis.md): Austin Ginder の「徹底探索」を一次資料から再構成する。
- [2026-10-24-hytale-learning-and-transfer.md](2026-10-24-hytale-learning-and-transfer.md): Hytale Java サーバー研究の学習順序と WordPress 経験の移転。
- [2026-10-24-recent-ai-security-discovery-architectures.md](2026-10-24-recent-ai-security-discovery-architectures.md): Intruder 以降の AI 脆弱性探索アーキテクチャ。
- [2026-10-24-validation-screening-patterns.md](2026-10-24-validation-screening-patterns.md): 公開ハーネスの候補選別と検証の分担。
- [2026-10-24-wordpress-concrete-hunting-methods.md](2026-10-24-wordpress-concrete-hunting-methods.md): WordPress プラグイン探索の具体的な公開手法。
- [2026-10-24-wp2shell-article-first-deep-exploration.md](2026-10-24-wp2shell-article-first-deep-exploration.md): WP2Shell 原記事から始める独立した深掘り探索案。
- [2026-10-25-discovery-prompt-decomposition.md](2026-10-25-discovery-prompt-decomposition.md): 探索プロンプトの分解と、Trial の中で誰が何をしたかを読む観測。
- [2026-10-25-post-discovery-skill-flow-review.md](2026-10-25-post-discovery-skill-flow-review.md): 探索後のスキルと検証経路の整理。
- [2026-10-26-discovery-prompts-japanese.md](2026-10-26-discovery-prompts-japanese.md): 探索プロンプト 2 種の日本語訳。
- [2026-10-28-before-after.svg](2026-10-28-before-after.svg): 探索と検証の構成の変更前後を示す図。
- [2026-10-28-codex-brief-cleanup.md](2026-10-28-codex-brief-cleanup.md): Codex への依頼文: 実装の前の整理。
- [2026-10-28-codex-brief-codex-one-shot.md](2026-10-28-codex-brief-codex-one-shot.md): Codex への依頼文: 区画分配型を本番で回せるようにする。
- [2026-10-28-codex-brief-partitioned.md](2026-10-28-codex-brief-partitioned.md): Codex への依頼: 区画分配型の探索（partitioned）を Claude runtime で本番に入れる。
- [2026-10-28-codex-one-prompt.md](2026-10-28-codex-one-prompt.md): Codex に貼る 1 本のプロンプト（オーケストレーター、2026-10-28）。
- [2026-10-28-codex-triage-and-verify.md](2026-10-28-codex-triage-and-verify.md): Codex への依頼: 振り分けと検証を列から回す（非機密参照）。
- [2026-10-28-harness-gap-analysis.md](2026-10-28-harness-gap-analysis.md): いまの Harness に足りないもの。
- [2026-10-28-problems-and-next-steps.md](2026-10-28-problems-and-next-steps.md): 全体の問題と、これからどうするか。
- [2026-10-28-target-system.svg](2026-10-28-target-system.svg): 現状とこれからの作業を示す全体図。
- [2026-10-21-monitor-report.md](2026-10-21-monitor-report.md): 監視報告。

この階の報告と図の追加索引（原題）:

- [2026-10-19-opus-runtime-plan.md](2026-10-19-opus-runtime-plan.md): Claude Opus の探索・検証 runtime を戻す計画
- [2026-10-19-wbh-verify-v3.md](2026-10-19-wbh-verify-v3.md): wbh-verify v3 の全文と出典対照（2026-10-19）
- [2026-10-20-design-issues-from-production-results.md](2026-10-20-design-issues-from-production-results.md): 本番の探索結果から読む設計課題（2026-10-20）
- [2026-10-20-discovery-child-model-assessment.md](2026-10-20-discovery-child-model-assessment.md): 探索の子エージェントに必要なモデル能力（2026-10-20）
- [2026-10-20-multi-agent-discovery-audit.md](2026-10-20-multi-agent-discovery-audit.md): Multi-Agent 探索アーキテクチャの監査と比較計画（2026-10-20）
- [2026-10-20-short-lived-discovery-agents.md](2026-10-20-short-lived-discovery-agents.md): 探索の子を短命の独立試行にするか（2026-10-20）
- [2026-10-20-wbh-verify-v4.md](2026-10-20-wbh-verify-v4.md): wbh-verify v4 の全文と出典対照（2026-10-20）
- [2026-10-21-monitor-brief.md](2026-10-21-monitor-brief.md): 監視セッションの依頼文（子モデル実験 ＋ 本番 runner、2026-10-21）
- [2026-10-21-public-harness-alignment.md](2026-10-21-public-harness-alignment.md): 公開ハーネスの共通点を設計に取り込む（2026-10-21）
- [2026-10-21-selection-to-discovery-check.md](2026-10-21-selection-to-discovery-check.md): 選定から探索までの安定性の確認（2026-10-21）
- [2026-10-21-wordfence-review-prescreen-skill.md](2026-10-21-wordfence-review-prescreen-skill.md): wbh-review 変更後の全文と日本語訳
- [2026-10-23-feature-boundaries-implementation.md](2026-10-23-feature-boundaries-implementation.md): 機能の責務整理と F14 の移行条件確認
- [2026-10-23-remaining-review-design-issues.md](2026-10-23-remaining-review-design-issues.md): リファクタリング後に残るレビュー・保存・CLIの設計課題
- [2026-10-23-review-storage-refactor.md](2026-10-23-review-storage-refactor.md): レビュー・保存・CLI・静的解析の責任整理
- [2026-10-23-skill-code-responsibility-audit.md](2026-10-23-skill-code-responsibility-audit.md): 現行コードのスキル移管・削除候補
- [2026-10-23-verification-status.md](2026-10-23-verification-status.md): 検証部分の現状（2026-10-23）
- [2026-10-23-wordfence-form-options.md](2026-10-23-wordfence-form-options.md): Wordfence 提出フォームの選択肢（2026-10-23）
- [2026-10-23-wordfence-mirror-screen-evidence.md](2026-10-23-wordfence-mirror-screen-evidence.md): Wordfence 公開履歴 mirror を段 1 の候補選別に使う範囲（2026-10-23）
- [2026-10-23-wordpress-normal-configuration-sources.md](2026-10-23-wordpress-normal-configuration-sources.md): WordPress.org で通常構成を確認する方法（2026-10-23）
- [2026-10-24-light-verification-and-report-flow.md](2026-10-24-light-verification-and-report-flow.md): 軽量な発火観測と Wordfence 報告への経路（2026-10-24 調査）
- [2026-10-24-precondition-park-false-positive.md](2026-10-24-precondition-park-false-positive.md): 検証前に誤って park された Finding の確認（2026-10-24）
- [2026-10-24-validation-status-model.md](2026-10-24-validation-status-model.md): 検証ステータスの再設計案（2026-10-24）
- [2026-10-24-verification-admission-gate.md](2026-10-24-verification-admission-gate.md): 管理者設定の文言で検証を止めていた経路（2026-10-24）
- [2026-10-24-verification-first-screen.md](2026-10-24-verification-first-screen.md): 検証前の選別を明示除外に絞る（2026-10-24）
- [2026-10-24-wbh-report-v7-source-map.md](2026-10-24-wbh-report-v7-source-map.md): `wbh-report` v7 全文・日本語訳・出典対照表（2026-10-24）
- [2026-10-24-wbh-verify-v8-review.md](2026-10-24-wbh-verify-v8-review.md): wbh-verify v8 本文確認（2026-10-24）
- [2026-10-24-wbh-verify-v9-review.md](2026-10-24-wbh-verify-v9-review.md): wbh-verify v9 本文確認（2026-10-24）
- [2026-10-24-wordpress-lab-self-request-dns.md](2026-10-24-wordpress-lab-self-request-dns.md): WordPress Lab の自己 HTTP 要求の DNS 失敗
- [2026-10-25-conversational-submission-session.md](2026-10-25-conversational-submission-session.md): 対話型の連続提出セッション（2026-10-25）
- [2026-10-25-exploration-architecture-redesign.md](2026-10-25-exploration-architecture-redesign.md): 探索アーキテクチャの再設計と改善計画（2026-10-25）
- [2026-10-25-wordfence-argus-and-prism.md](2026-10-25-wordfence-argus-and-prism.md): Wordfence Argus と PRISM の公開情報（2026-10-25 時点）
- [2026-10-25-wordfence-mirror-as-exploration-input.md](2026-10-25-wordfence-mirror-as-exploration-input.md): Wordfence mirror の公開事例を探索の入力にする（2026-10-25）
- [2026-10-25-wordfence-prism-argus-method-and-cases.md](2026-10-25-wordfence-prism-argus-method-and-cases.md): Wordfence PRISM / Argus の記事と事例から読む探索手法と、本リポジトリの設計をそこへ寄せる差分（2026-10-25）
- [2026-10-25-wordpress-bug-hunter-methods.md](2026-10-25-wordpress-bug-hunter-methods.md): WordPress プラグインの上位研究者は、どう脆弱性を見つけているか（公開資料の調査）
- [2026-10-25-wp2shell-bounty-v10-wide.md](2026-10-25-wp2shell-bounty-v10-wide.md): 下限なしの探索 prompt v10-wide（2026-10-25）
- [2026-10-25-wp2shell-bounty-v11-wide.md](2026-10-25-wp2shell-bounty-v11-wide.md): 種別ごとの専門エージェントで探す探索 prompt v11-wide（2026-10-25）
- [2026-10-25-wp2shell-bounty-v11.md](2026-10-25-wp2shell-bounty-v11.md): 探索 prompt v11: v10 から子の寿命と数値の文を外し、子の交代の段落を足す（2026-10-25、2026-10-26 改訂）
- [2026-10-25-wp2shell-bounty-v12-wide.md](2026-10-25-wp2shell-bounty-v12-wide.md): PRISM の記事と公開記録に寄せた探索 prompt v12-wide（2026-10-25）
- [2026-10-25-wp2shell-bounty-v13-wide.md](2026-10-25-wp2shell-bounty-v13-wide.md): 探索 prompt v13-wide: v12-wide から子の寿命と体数の文を外し、子の交代の段落を足す（2026-10-25、2026-10-26 改訂）
- [2026-10-26-codex-brief-prompt-v14-wide.md](2026-10-26-codex-brief-prompt-v14-wide.md): Codex brief: wp2shell-bounty-v14-wide (2026-10-26)
- [2026-10-26-system-audit.md](2026-10-26-system-audit.md): システム全体の監査: 評価指標、探索の深さ、要らない機能、正本とコードの食い違い（2026-10-26）
- [2026-10-26-system-history-and-metrics.md](2026-10-26-system-history-and-metrics.md): システムの変遷と、世代ごとに測れた数字・測れなかった数字（2026-10-26）
- [2026-10-26-v14-wide-japanese-by-codex.md](2026-10-26-v14-wide-japanese-by-codex.md): 日本語訳
- [2026-10-26-verification-flow-options.md](2026-10-26-verification-flow-options.md): 検証から提出までの流れ: 自動実行を基本にし、人間の確認を軽くする（2026-10-26）
- [2026-10-26-wbh-submit-normal-ui-evidence.md](2026-10-26-wbh-submit-normal-ui-evidence.md): 提出スキルの通常導線と操作証拠（2026-10-26）
- [2026-10-26-wp2shell-bounty-v14-wide-japanese.md](2026-10-26-wp2shell-bounty-v14-wide-japanese.md): wp2shell-bounty-v14-wide 日本語訳（読むための訳。エージェントには渡さない）
- [2026-10-26-wp2shell-bounty-v14-wide-source-table.md](2026-10-26-wp2shell-bounty-v14-wide-source-table.md): wp2shell-bounty-v14-wide の出典対照表（2026-10-26）
- [2026-10-26-wp2shell-bounty-v15-wide.md](2026-10-26-wp2shell-bounty-v15-wide.md): wp2shell-bounty-v15-wide の本文と出典対照表（2026-10-26）
- [2026-10-26-wp2shell-bounty-v16-wide-japanese.md](2026-10-26-wp2shell-bounty-v16-wide-japanese.md): wp2shell-bounty-v16-wide 日本語訳（読むための訳。エージェントには渡さない）
- [2026-10-26-wp2shell-bounty-v16-wide.md](2026-10-26-wp2shell-bounty-v16-wide.md): wp2shell-bounty-v16-wide の本文と出典対照表（2026-10-26）
- [2026-10-27-608-skill-reference-source-table.md](2026-10-27-608-skill-reference-source-table.md): #608 skill と OPERATIONS の古い参照 4 点の出典対照表（2026-10-27）
- [2026-10-27-decided-structure.svg](2026-10-27-decided-structure.svg): 決めた構造（2026-10-27）
- [2026-10-27-partitioned-exploration-overview.svg](2026-10-27-partitioned-exploration-overview.svg): 全体像: 外側の Harness と内側の Harness
- [2026-10-27-partitioned-exploration-target-flow.svg](2026-10-27-partitioned-exploration-target-flow.svg): プラグイン 1 本を調べる流れ（提案）
- [2026-10-27-wbh-source-check-source-table.md](2026-10-27-wbh-source-check-source-table.md): wbh-source-check v1 の出典対照表（2026-10-27）
- [2026-10-27-wp2shell-bounty-v17-wide-japanese.md](2026-10-27-wp2shell-bounty-v17-wide-japanese.md): wp2shell-bounty-v17-wide 日本語訳（読むための訳。エージェントには渡さない）
- [2026-10-27-wp2shell-bounty-v17-wide.md](2026-10-27-wp2shell-bounty-v17-wide.md): wp2shell-bounty-v17-wide の本文と出典対照表（2026-10-27）
- [2026-10-28-architecture-refactor-review.md](2026-10-28-architecture-refactor-review.md): 新設計を基準にした構造レビューと管理一覧テストの整理
- [2026-10-28-architecture.svg](2026-10-28-architecture.svg): 探索の仕組み（2026-10-28、承認用）— 中身は AI、形はハーネス
- [2026-10-28-wp2shell-bounty-v18-wide.md](2026-10-28-wp2shell-bounty-v18-wide.md): wp2shell-bounty-v18-wide の本文と出典対照表（2026-10-28）

## 現状と違う点（2026-10-19 時点）

- `2026-10-14-final-design.md`: 探索の Lab、即時の検証、`owner-approved` の付け手、Step 1 の「人手 0」の範囲は、2026-10-18〜19 の決定（ADR 0033〜0037、#238 の comment）で変わった。
- `2026-10-17-thorough-search-v6-plan.md`: 入口索引と coverage は ADR 0034 で削除した。
- prompt v4〜v7 の草案と対照表: 旧版の記録。新規探索は `deep` の `wp2shell-bounty-v11` と `wide` の `wp2shell-bounty-v14-wide` だけで、`wide` の比較候補 v15-wide は名指しで走る。v18-wide（[本文と数字](2026-10-28-wp2shell-bounty-v18-wide.md)）は 2026-10-28 の 20 Trial で採らず archived にした（[出典対照](2026-10-26-wp2shell-bounty-v14-wide-source-table.md)、ADR 0039 の 2026-10-27 追記 12。v16-wide と v17-wide は同日に archived にした（[v16-wide](2026-10-26-wp2shell-bounty-v16-wide.md)、[v17-wide](2026-10-27-wp2shell-bounty-v17-wide.md)）。v10、v12-wide、v13-wide は archived、v8 は ADR 0033 で入り、照合用に残す）。`wide` の比較候補 `wp2shell-bounty-v15-wide` は名指しのときだけ走る（[本文と出典対照](2026-10-26-wp2shell-bounty-v15-wide.md)、ADR 0039 の 2026-10-26 追記 8）。

## archive/

どこからも参照されていない報告は [archive/](archive/) に移した。ファイル名は変えていない。2026-10-08〜10 の旧文書（`DESIGN-EVIDENCE.md`、`PILOT-2026-10-10.md`）もここに置いた。LESSONS と ADR はこれらの報告から引いているので、出典として消さずに残す。

archive の中で現状と違う点:

- 2026-10-09 の 5 本: #77〜#87 の設計元。当時の未コミットの変更を現状として書いている。
- `2026-10-14-autonomous-verification-loop-design-proposal.md`: 検証は skill と handoff になった（ADR 0035）。
- `2026-10-16-selection-candidates-preview.md`: 選定の順位は ADR 0037 の採点と cascade に置き換わった。
- `2026-10-18-index-coverage-vs-owner-findings.md`: 入口索引と coverage は ADR 0034 で削除した。
- `2026-10-18-source-only-dispatch-design.md` ほか dispatch の報告 3 本: 課題配分は採らず、PR #357 で mode を削除した。
