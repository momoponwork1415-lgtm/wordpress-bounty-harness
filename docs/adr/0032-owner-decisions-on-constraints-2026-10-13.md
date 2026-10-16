---
status: accepted (2026-10-14、所有者の決定で確定)
date: 2026-10-13
amends: 0030（タグ単位の履歴利用）, 0022（自動再試行の範囲）
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
| Q6 | runBudget 20 / 40 | 削除。#189 の自動 +2 Trial も削除。同じ plugin slug の 2 回目以降の独立 Trial は 1 Trial ごとに所有者が事前承認する。承認の形式は所有者が 2 回目を求めるときに決める（2026-10-14） |
| Q9 | 採点式 log10(1+installs)×10 + 鮮度×5 | 維持 |
| 確認 | 除外作者 5 社 | 維持（Wordfence 公式） |

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

自動再試行は実装どおり recipe 2 回、observation 2 回、provision 1 回、precondition は scenario ID が変わったときだけ（2026-10-14、所有者が実装を正本と決めた。#107、#209）。Verifier の provider 上限は 1 回（ADR 0022 の 2026-10-14 追記）。

## 2026-10-16 追加判断: 既定 prompt を v5 にする

所有者は 2026-10-16 に、v4 索引あり 5 run と索引なし 8 run で本体のコメント本文経由の Stored XSS（公開記録 3 件）が一度も候補にならないこと（#291）を見て、探索 prompt を `wp2shell-bounty-v5` に改め、既定にすると決めた。v5 は所有者が日本語訳を全文読んで確認した本文で、digest は `sha256:59c6bd1bb5fd5ef7618ce180de7f2d90af68fa4bcba26f90aa31aa3679d80cda`。出典対照表は docs/reviews/2026-10-16-wp2shell-bounty-v5-draft.md。

v5 で変えたもの: 受け入れる種類の順位と「落とす種類」の一覧を prompt から外し、対象内かどうかは Harness が付ける Programme Boundary の節に任せる。false negative を false positive より嫌うと 1 文で書く。WordPress 本体が受け取って保存する内容（コメント、登録項目など）を攻撃者が制御するデータとして名指しし、書く側・保存・読む側の 3 点を検査させる。stop 条件を「source に根ざした frontier が残る限り続け、registry を見直してから止める」に強める（wordpress-harness v8 由来）。最低時間は置かない（ADR 0029 のまま）。

変えないもの: Root＋最大 3 子、wall 60 分、入口索引の既定、Finding / Lead 契約の Harness 生成（ADR 0019）、公開記録を渡さない（ADR 0012）、対象固有の名前を入れない。v4 本文と digest は履歴照合用に残す。

同日の運用判断（2026-10-16）: Lab で前提を満たせない対象（外部 API に依存する Smash Balloon 系など）も探索対象から外さず、Finding が出れば検証が `incomplete(precondition)` でも人間レビューに回してよい（#283 の「カタログから外す」を取り消す）。検証は最悪、人手か Claude Code との対話で行う。Lab scenario の拡充（#213、#244）は探索の後に置く。

選定の帯（2026-10-16、ADR 0030 への修正）: 既定の母集団は 10 万以上 100 万未満のインストール帯とし、帯の中ではインストール数で順位を付けない。100 万以上は「直近 1 年に公開記録が一定件数以上」という根拠を満たすときだけ候補に残し、根拠を選定記録に書く。公開記録は slug 単位の件数だけを gate に使い、score と探索には渡さない（ADR 0012）。実装は #295。

採らなかった選択肢: Harness 製の入口索引に出力側 sink を足す（索引あり・なしで差が出なかったので主因でない）。AI が前段で索引を作る（ADR 0029 で外した段付き構造の再導入）。wordpress-harness v8 全文への差し替え（v7 系で有償実績が無い）。

## 採らなかった選択肢

- 制約ごとに ADR を書く: 週 1 本の規則に収まらない。
- 所有者がタグを手で列挙する: 所有者が 2026-10-13 に退けた。

## 2026-10-14 の所有者決定（最終設計 docs/reviews/2026-10-14-final-design.md 第 14 節）

| # | 項目 | 決定 |
| --- | --- | --- |
| 1 | 最終設計の採用 | 採用。Step 1 の期日は「runner 起動＋8 日」 |
| 2 | Trial に数えない run | Root が source を 1 件も読まず、子を起動せず、broker 転送 1 以下で終わった run は Trial に数えない（SPEC §6、ADR 0029） |
| 3 | 旧世代の既往照合 | 旧研究 DB と旧 `--state` 台帳から Git 外 JSON（started / ambiguous / reconsider）を 1 回作る。AI が作る。無ければ runner は起動しない |
| 4 | ラベルと凍結 | P0 / P9 / P10 / P12 は所有者本人が `owner-approved`。DEVELOPMENT §2 の ADR 凍結を ADR 0016 / 0020 / 0022 / 0026 / 0029 / 0032 の該当行に限って解除 |
| 5 | 再試行回数 | 実装どおり（上記） |
| 6 | 手動再現 | 判定器が確認し最新版の reverify が緑の Finding は証拠を読むだけでよい。`no-judge` は手で再現する（2026-10-11 の「全件必須」を変更。SPEC §8 / §12、ADR 0016 は P12 で書き換え） |
| 7 | `no-judge` の提出 | 人間再現が `match` なら scope / draft が受理する口を作る（P12） |
| 8 | #220 の受入条件 2 | 「拒否は記録して次対象へ進む」に改定。拒否が続いた週の Step 1 判定は「拒否を除く対象で回り切った」と読む |
| 9 | A/B 事前登録（#201） | Step 1 の間は中止 |
| 10 | Q2（Reflected XSS） | 半年後の見直しのまま |
