# 2026-10-13 過去 4 世代の harness から読み取った「作りたかったもの」と再発した失敗

調べて報告の成果物。正本ではない。対象は `/home/dev/bug-bountgy-harness`（2026-07）、`/home/dev/whitebox-harness`（2026-08-01〜09-11、`wp-bounty-harness-v1` と同一）、`/home/dev/wp-bounty-verification`（2026-08-11〜15）、`/home/dev/wordpress-harness`（2026-09-01〜10-08）。各 repo の `.private/` と提出済み報告は読んでいない。

## 1. 4 世代で変わらなかった骨格

| 工程 | 7 月 | 8 月 whitebox / wpb | 9 月 wordpress-harness | 今 |
| --- | --- | --- | --- | --- |
| 選定 | 手動 | rule で候補、人間が選ぶ | AI 提案、人間が一括承認 | 自動、人間なし |
| 探索 | Claude ＋ 運用規則 | WP2Shell 系（bounded v1.7、研究 file、飽和停止） | agent-led、Root ＋ 子 3、checkpoint から自動継続、条件付き 3 試行 | Root ＋ 子 3、1 Trial 60 分 |
| 候補の gate | 権限 gate（Subscriber 超は即停止） | 出力側 write gate、top-5 | `candidateAdmission` allowlist（攻撃者位置 × 影響）。外は Parked Lead | 全受理。`other` も Finding |
| 検証 | 手動 | V0〜V3 の skill、fresh Docker Lab、負の対照 | Root が recipe、人間が採用、gVisor で 1 回再生、`runtime-confirmed` だけ確認済み | Verifier agent ＋ 判定器 9 種 |
| 人間 | 全部 | 再現 wizard、提出 | 候補の採否、再現 script、提出先と文案の承認 | 提出前レビュー、承認 |
| 提出 | 人間 | 人間 | 人間 | 人間 |

「探索は AI、確認は独立した fresh session、提出は人間、外部送信は実装しない」は 4 世代とも同じ。これが所有者の一貫した要求。

## 2. 9 月版（wordpress-harness）が持っていて、今の版に無いもの

訂正（2026-10-13 夕）: 有償 7 件は wordpress-harness の prompt では発見されていない。発見時点の prompt は whitebox-harness `963d3bb` の `bounded-wp2shell/v1.7`（Custom Facebook Feed）と 7 月末の private contract（TranslatePress 3.2.6、Unlimited Elements）。根拠は [2026-10-13-prompt-source-comparison.md](2026-10-13-prompt-source-comparison.md) 第 0 節。以下は 9 月版の仕組みの比較で、「報酬が出た版」ではない。

1. **受理時の scope gate。** `candidateAdmission` の allowlist に合わない候補は run ごと不採用、対象外の手掛かりは Parked Programme Lead。今は全受理で、本番 14 Finding のうち 9 件が `other`。#185 がこれを戻す。
2. **条件付き追加 Trial。** 初回 Trial が候補を 1 件以上返した対象だけ、残り 2 Trial を独立に並列起動。TranslatePress 3.2.5 では独立 3 試行の和集合で既知 8 件中 4 件を再発見（`docs/knowledge/deepseek-wp2shell-v7-translatepress-known-cve-evaluation-2026-09-20.md`）。今は全対象 1 Trial。
3. **threatContext。** `ordinaryConfiguration`、`securityObjectives`、`integrations`、`highValueTransitions`、`uncertainties` を対象ごとに AI か人間が書いて探索に渡していた。今は無い。Lab に効くのは `integrations`（Q47）。
4. **人間の再現 skill。** `wordpress-human-verification` が Lab setup script を生成し、決定的な操作は人間が行う。今の `lab up --finding`（Q17）と `wbh-review`（Q18）に相当する。
5. **prompt の上限をテストで固定。** v5/v6 で 13.7 KB まで膨らみ、v7 で 6.9 KB に戻し、7,000 bytes 未満をテストで強制。v9 で再び 7.4 KB。

## 3. 4 世代で再発した失敗

| 失敗 | 8 月 | 9 月 | 今（10 月） |
| --- | --- | --- | --- |
| prompt の肥大 | 127 行 → 92 行に削る | 13.7 KB → 6.9 KB → 7.4 KB | 本文 ＋ schema 全文 ＋ 索引で数百行 |
| ADR の濫造 | 3 本すべて proposed のまま | 144 本、初日 108 本、3 日目に 92 本削除、検証方式を 5 回置き換え | 30 本 / 5 日、主経路 2 往復 |
| 先回り実装 | wpb: 先のフェーズ向け 7,300 行、3 回目の廃棄 | Finder / Depth / Wave / 戦略 portfolio を 0125 で一掃 | 判定器 9 種、修正版対照、公正さ装備 |
| 検証の滞留 | Lead 6 件が未検証で止まる。再現済み 30 件が人間に見えない | （継続は自動化、採否は人間に残る） | `incomplete` 14 件、reviewed 0 |
| 量だけ増える | Snapshot 483、選定 110、提出 1 | — | 15 対象、読む価値 1 件 |

所有者自身の記録に残る結論:
- 「時間をかけても成果は増えない。報酬が出た Lab は 2.1 時間、5 時間超は全部成果なし」（whitebox commit 7994bb3）。
- 「選別は prompt ではなく出力側の gate で行う」（whitebox commit cddce91）。100 行版は Lab あたり Lead 1.1、65 行版は 12.4。
- 「判断の要らない処理は skill にしない」（whitebox commit 6f2738d）。
- 「prompt の長さから診断品質は推定できない」（wordpress-harness `docs/knowledge/reference-harness-observability.md`）。
- 「高 volume の研究者は約 80% が誤検知でも、30 秒未満で捨てられることが成立条件」（同 `high-volume-wordpress-researcher-workflows-2026-09-13.md`）。
- 「barbell: 選定と検証を厚く、探索は触らない。scope preflight を探索直後に全 Lead へ」（wpb `gui-pivot-grilling-log.md`）。
- 「見込み薄の Lead は捨てずに grade 付きで出す。kill も 2 度確認」（whitebox commit 58775b8）。

## 4. 今日の決定との照合

一致しているもの: scope で先に絞る（#185）、人間に 1 画面で見せる（`review export`）、判断は skill で Harness は運び屋（Q13〜Q18）、wall を広げない（Q49）、判定器を増やさない、ADR を絞る（Q32、Q33）、凍結と PARKING（Q31）。

未決または逆方向のもの:
- 条件付き追加 Trial（第 2 節 2）は今日の計画に無い。
- 「長い探索 prompt でよい」は、所有者自身の 2 つの実測（65 行版の方が Lead が多い、7 KB 上限をテストで固定）と向きが逆。元記事の template 自体は約 3 KB で、v3 本文も約 3.5 KB。膨らむのは Harness が足す節。
- 9 月版の 3 つの skill（選定、source のみの検証、人間の再現）は、今回作る 3 つの skill の出発点として再利用できる。

## 5. 消し方

記録なので消すものはない。
