---
status: proposed (owner-approved ラベルで accepted にする)
date: 2026-10-13
amends: 0030（タグ単位の履歴利用）, 0022（自動再試行の範囲）, 0002（追加探索の判断点）, 0029（開発セットの反復）
---

# 2026-10-13 のグリルで所有者が決めた制約と、出典不明の制約の扱い

## 背景

[docs/reviews/2026-10-13-design-features-constraints.md](../reviews/2026-10-13-design-features-constraints.md) で、制約のうち所有者の決定と文書で確認できるものは 5 群だけで、数値の大半は AI の既定値だと分かった。所有者は 2026-10-13 に 26 問のグリルに答え、「Q3 と Q4 は data で決める。他は推奨どおり」とした。この ADR はその答えの正本で、以後は変えた行だけ更新する。

## 決定

### 対象範囲と分類

| # | 項目 | 決定 |
| --- | --- | --- |
| Q1 | `content-deletion` | #185 の除外から外す。判定器は作らず `incomplete(no-judge)` で人間レビューへ |
| Q2 | Reflected XSS | Wordfence は対象外。Patchstack 向けにも出さない。半年後に見直す |
| Q13 | Trail of Bits の文言 | 採らない（CC BY-SA 4.0） |

### 選定

| # | 項目 | 決定 |
| --- | --- | --- |
| Q3 | 候補タグ | 所有者が列挙しない。Wordfence ミラーと WordPress.org のタグから「低権限・報奨対象の記録 / plugin」を機械的に出し、上位の族を既定にする（[2026-10-13-selection-data.md](../reviews/2026-10-13-selection-data.md) 第 3 節）。タグの出典を `target-selected` に残し、半年後に有償率で測る |
| Q4 | install 下限 | 100,000。公式の帯別平均と所有者の 2026-08 実績（Gate 1）による |
| Q5 | High Threat タグ 21 個と重み、攻撃面タグ重み | 削除。順位は installs と鮮度だけ |
| Q6 | runBudget 20 / 40、#189 の自動 +2 Trial | 削除。同じ plugin slug の独立した2回目以降の探索 Trial は、初回の Finding・Lead・検証結果と `incomplete` の理由を見て所有者が事前承認する。初回結果から自動で +2 Trial を起動しない |
| Q9 | 採点式 log10(1+installs)×10 + 鮮度×5 | 維持 |
| 確認 | 除外作者 5 社 | 維持（Wordfence 公式） |

Q6 は所有者の 2026-10-13 の追加判断で上書きした。対象の同一性は WordPress plugin slug で判断し、版・Target Snapshot digest・campaign ID・state・Lab 設定・prompt 版を変えても同じ slug の既往探索 Trial があれば2回目以降に当たる。異なる plugin slug の初回 Trial は機械選定でまとめて進める。人間がその結果の Finding・Lead・検証結果と `incomplete` の理由をまとめてレビューし、追加探索する slug を選ぶ。初回が正常な候補0件でも `incomplete` でも、新たな独立探索 Trial を始めるには対象・目的・費用を示し、**1 Trial ごとに**事前承認を得る。開始済み Trial の再開と、既存 Finding の独立検証・再検証は追加探索 Trial に数えない。CLI はホスト共通の Trial registry に既知の state 台帳を取り込み、同じ slug の追加 Trial ごとに対象・Snapshot・prompt・campaign・ordinal に結び付いた承認を開始直前に消費する。最初に既知の全 state を列挙する責任は運用者にあり、inventory から漏れた過去の state の探索は自動発見できない。slug を復元できない記録は取り込みを拒否し、初回と断定して探索を始めない。

この決定より前に開始した Trial は履歴として測定に残す。決定後に始める追加 Trial には新しい承認を要し、過去の測定を承認済みと読み替えない。

この判断は ADR 0002 の提出前レビュー・外部行動承認に、追加探索の費用を決める事前判断点を加える。未検証候補の提出採否を前倒しするものではなく、ADR 0006 の初回対象選定の自動化は維持する。ADR 0029 の対象ごと1 Trialという既定と3 Trial測定の区別は維持し、同一slugの無承認の反復を開発上の必要件数で正当化しない。

### Lab と runtime

| # | 項目 | 決定 |
| --- | --- | --- |
| Q7 | 重大 option 7 個の固定監視 | #186 の実行前後の差分観測器で option 全体を見る。固定 7 個は「重大」ラベルだけ |
| 確認 | core 版 / sandbox CPU / 並列 | 7.1.3 / 6 / 3（Opus 併用時 2） |
| Q8 | 根拠の無い小さな数値（Verifier wall 30 分、Finding 文字数、Snapshot 取り込み上限、Lab timeout、broker 上限） | AI の既定値として維持。変えるときは計測を付ける。台帳 read 1,000 件だけは頁送りに直す |

### prompt

| # | 項目 | 決定 |
| --- | --- | --- |
| Q10 | 探索 v4 の骨格 | whitebox `bounded-wp2shell/v1.7` を骨格にし、class 列挙は Harness 生成の節へ移して本文 7,000 bytes 以内 |
| Q11 | class 列挙の内容 | v1.7 の 3 群（accepted / weaker / dropped） |
| Q12 | v3 固有の要素 | 「それ以外の具体的効果も記録」は外す。順位は v1.7 の 3 群。停止条件は「2 波連続で増分なし」。子は 3 |
| Q14 | Verifier v7 | 探索と別に対照表を作る（Anthropic の検証 4 手順、Visa の oracle 判定、現行 v6 の 6 field） |
| 確認 | Verifier の向き | 反証ではなく発火の確認 |

### 2026-10-13 追加判断: 探索する影響

所有者は実対象Trialの候補を見て、今後は自ら提示したCritical／Highの例に相当する**効果**を探索目的にすると決めた。未認証またはsubscriber／customerからのコード実行、任意ファイルの読み取り・削除、コード実行に至るアップロード、SQL injection、Stored XSS、重大なデータの読み取り・改変に加え、未認証からの権限昇格と管理者への認証回避、subscriber／customerから管理者への権限昇格が対象である。`options-update` と `sensitive-object-access` を分類名だけで一律に除外する案は採らない。重大な効果への具体的経路があるFindingは、検証が`incomplete`でも通常レビューへ進め、影響と提出価値は人間が判断する。`runtime-confirmed`は従来どおりHarnessの判定器だけが出す。これはWordfence / Patchstackの公式Programme Boundaryを書き換える判断ではない。

目的文は新しい`wp2shell-bounty-v4`として版とdigestを固定し、v3本文とdigestを履歴照合用に残す。Finding / Lead契約はHarness生成の節に置き続ける（ADR 0019）。新しい目的に誘導しても低価値候補が出なくなる保証はないため、分類による一律のparkはせず、Programme Boundary内のFindingは従来どおり判定器の結果によらずレビューへ届ける。`incomplete`を脆弱性の不存在や低重大度の証明にはしない。実測と今回の9件の扱いは[日付付きレビュー](../reviews/2026-10-13-owner-impact-priority.md)に記録する。

### 知識と運用

| # | 項目 | 決定 |
| --- | --- | --- |
| Q15 / Q20 / Q21 | 知識の集約 | `docs/knowledge/` に索引と provenance 付きの写し。案件固有の値と件別の成績は Git 外、集計と schema だけ入れる |
| Q16 | 実験の重複防止 | Issue と PR の template に「`docs/knowledge/experiments.md` を検索した」を 1 行 |
| Q17 | 記録の形 | この ADR 1 本。以後は変えた行だけ更新 |
| Q18 | cron 2 本 | 止める（whitebox の queue tick、wordpress-harness の quota tick） |
| Q19 | Wordfence ミラー | 本リポの `profiles/wordpress/wordfence-history` に移し、`wp-bounty-workspace` から独立させる |
| Q22 | 追跡性 | `review-decided` に所要時間、提出記録から run / prompt digest を辿れる参照を足す（#186） |
| Q23 | ディスク | 第 4 周の後に Docker を prune。ディレクトリは Q19 / Q20 の後に消す |
| Q24 | 未 push の worktree | 中身を確認し、要るものだけ push |
| Q25 | 提出パッケージ | 37 件で回った 4 ファイル構成と human_only 9 項目を #188 の契約にする。Fill-Only 拡張と guard-lock は skill の assets |
| Q26 | Patchstack の形式 | 保留 |
| Q27 | CLI の位置づけ | CLI は AI（skill と Harness の自動処理）が呼ぶ機械向けの interface とし、所有者は Claude Code の skill から操作する。CLI の機能は増やさず、人間向けの表示や対話は skill に置く。既存の多機能は削除せず拡張を止め、整理は Step 2（所有者 2026-10-13） |

## ADR 0030 への修正

0030 の「公開履歴の件数・内容は選定候補の列挙・除外・採点に使わない」は plugin 単位の規則として維持する。タグ単位の yield（タグに属する plugin 群の低権限・報奨対象の記録数 / plugin 数）は候補タグの列挙にだけ使い、個々の plugin の順位・除外・採点には使わない。

## ADR 0022 への修正

自動再試行は recipe 2 回、observation 1 回、precondition は再試行しない（#107）。provision の再試行は行わない。

## 採らなかった選択肢

- 制約ごとに ADR を書く: 週 1 本の規則に収まらない。
- 所有者がタグを手で列挙する: 所有者が 2026-10-13 に退けた。
