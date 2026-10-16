# 実験記録（世代横断、1 行 1 実験）

新しい実験を始める前にここを見る。同じ問いがあれば、その答えから始める。数字は原本の記録どおり。件別の plugin 名と報酬額は書かない。

| 日付 | 世代 | 問い | 結果 | 記録 |
| --- | --- | --- | --- | --- |
| 2026-07-24 | 07 | thin harness v0.3 の設計リスクは何か | 探索と検証の分離、Trial freeze、候補の和集合を提案 | [imported/07-satoki/codexidea-thin-harness-risk-audit-2026-07-24.md](imported/07-satoki/codexidea-thin-harness-risk-audit-2026-07-24.md) |
| 2026-07-25〜08-11 | 08 whitebox | `bounded-wp2shell/v1.7` で source-only 探索 → 人手検証 → 提出 | この期間に有償 9 件（累計の 7 割）。prompt は 12,116 B | [imported/08-whitebox/](imported/08-whitebox/)、[reviews/2026-10-13-prompt-source-comparison.md 第 6 節](../reviews/2026-10-13-prompt-source-comparison.md) |
| 2026-08-12 | 08 workspace | Codex が PoC 確認した 7 件を、同じ snapshot で GLM が source-only で先行検知できるか | 3/7 一致 + 1/7 部分一致（約 50%）。GLM 路線は 08-13 に破棄 | [imported/08-workspace/archives/glm-comparison-README.md](imported/08-workspace/archives/glm-comparison-README.md) |
| 2026-08-13 | 08 workspace | 提出 47 件の決着を説明する変数は何か | 自明な impact × 未認証 × 非 crowded。認可系 20 件は報酬の 1% 未満 | [imported/08-workspace/LEDGER-ANALYSES.md](imported/08-workspace/LEDGER-ANALYSES.md) |
| 2026-08-15〜16 | 08 workspace | 対象側のどのシグナルが有償率を予測するか | 6 シグナルすべて効かず。install 帯と再訪回数だけ有意 | 同上、[reviews/2026-10-13-selection-data.md](../reviews/2026-10-13-selection-data.md) |
| 2026-08-16〜17 | 08 workspace | Wordfence / Patchstack の対象範囲と報酬規則の転記 | 当時の公開 page を保存。reflected XSS はこの時点では in-scope | [imported/08-workspace/selection/](imported/08-workspace/selection/) |
| 2026-08-20 | 08 workspace | 選定 Gate 1〜6 で過去提出を再評価すると | 50 件中 45 件を落とし、累計報酬の 99.8% を残す（事後評価） | LEDGER-ANALYSES.md 行 2・8 |
| 2026-09-02 | 09 v1 | 公開 CVE で探索→検証→報告の一周が通るか | 一周は通る。sanitized 記録のみ | [imported/09-wordpress-harness/knowledge/public-cve-e2e-campaign-2026-09-02.md](imported/09-wordpress-harness/knowledge/public-cve-e2e-campaign-2026-09-02.md) |
| 2026-09-08 | 09 | provider-native Root / 子 agent で known-positive 4 件を回収できるか | 4/4 で candidate を回収、ATO 1 件は fresh Lab で runtime-confirmed | [imported/09-wordpress-harness/knowledge/public-known-positive-native-agent-evaluation-2026-09-08.md](imported/09-wordpress-harness/knowledge/public-known-positive-native-agent-evaluation-2026-09-08.md) |
| 2026-09-08 | 09 | Opus 5 と daybreak で 1 対象あたり何分・何ドル・候補何件か | r2 35 分 / 79 USD / 候補 8、r3 24 分 / 54.6 USD / 候補 12、source-validated 3。別対象は budget-exhausted ×3（各 62 分）候補 0 | `/mnt/d/wordfence/campaigns/2026-09-08-daybreak-opus-three/`（Git 外） |
| 2026-09-13 | 09 | 高 volume 研究者の workflow から何が分かるか | 公開 Finding 数は分かるが hit rate は分からない | [imported/09-wordpress-harness/knowledge/high-volume-wordpress-researcher-workflows-2026-09-13.md](imported/09-wordpress-harness/knowledge/high-volume-wordpress-researcher-workflows-2026-09-13.md) |
| 2026-09-13 | 09 | Patchstack と Wordfence のどちらが収益を予測しやすいか | Wordfence（finding 単位のドル建て） | [imported/09-wordpress-harness/knowledge/patchstack-vs-wordfence-rewards-2026-09-13.md](imported/09-wordpress-harness/knowledge/patchstack-vs-wordfence-rewards-2026-09-13.md) |
| 2026-09-16 | 09 | 安価な model で未知脆弱性を見つけた公開例はあるか | ある。ただし「弱い model を同じ prompt で 3 回」ではなく、広い並列 coverage と候補の検証が条件 | [imported/09-wordpress-harness/knowledge/cheap-model-prospective-vulnerability-discovery-2026-09-16.md](imported/09-wordpress-harness/knowledge/cheap-model-prospective-vulnerability-discovery-2026-09-16.md) |
| 2026-09-20 | 09 v7 | DeepSeek V4.1 Flash + wp2shell v7 で TranslatePress 3.2.5 の公開 CVE 8 件をどれだけ回収するか | 3 試行の和集合で 4/8 | [imported/09-wordpress-harness/knowledge/deepseek-wp2shell-v7-translatepress-known-cve-evaluation-2026-09-20.md](imported/09-wordpress-harness/knowledge/deepseek-wp2shell-v7-translatepress-known-cve-evaluation-2026-09-20.md) |
| 2026-09-02〜10-08 | 09 v1〜v9 | 未知の脆弱性を 1 件でも提出できるか | 0 件。提出は 09-02 以降止まる | [LESSONS.md](../LESSONS.md) 教訓 13、[reviews/2026-10-13-past-repos-lessons.md](../reviews/2026-10-13-past-repos-lessons.md) |
| 2026-10-11 | 10 | 開発セット TranslatePress 3.2.5 で何が確認できるか | ATO は runtime-confirmed、stored XSS は一度も確認されず、未知 0 | [reviews/2026-10-11-harness-completeness-review.md](../reviews/2026-10-11-harness-completeness-review.md) |
| 2026-10-12〜13 | 10 | 本番 4 周で人間レビューの件数と中身はどうなるか | 第 3 周の候補 8 件中 scope 内 3 件。本物らしい 2 件が判定器の watch 外で `not-observed` | [reviews/2026-10-13-human-review-contract-and-parallel.md](../reviews/2026-10-13-human-review-contract-and-parallel.md) |
| 2026-10-13 | 10 | install 下限と候補タグをデータで決めると | 下限 100,000、タグ 8 族。pool 442 plugin | [reviews/2026-10-13-selection-data.md](../reviews/2026-10-13-selection-data.md)、ADR 0032 |
| 2026-10-13 | 10 | #214 探索 v4 の同一公開済み開発対象で、Lab scenario の有無により縦断結果はどう変わるか | 3 Trial は全件完了。scenario なし2件は Finding 4 / Lead 4、検証4件とも `incomplete(precondition)`。scenario あり1件は Finding 1 / Lead 2、判定器で1件 `runtime-confirmed`。3件とも同一 Snapshotで、未知発見率は測れない | [reviews/2026-10-13-critical-high-v4-development-trials.md](../reviews/2026-10-13-critical-high-v4-development-trials.md) |

新しい行は PR で足す。「調べて報告」の成果物は [docs/reviews/](../reviews/) に置き、ここには 1 行だけ書く。
