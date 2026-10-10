---
status: accepted
supersedes: 0016 for the default discovery route; 0014 for continuation
---

# 主経路を二段構えにし、継続境界を Harness が持つ

## 決定

対象ごとに、同じ Target Snapshot を使う二段階の探索を主経路にする。

1. 一段目は入口索引を受け取る単独 agent の screening Trial を1回行う。壁時計の上限は30分。目的は入口の網羅と、source に根拠のある Finding / Lead の有無を記録すること。候補0件は脆弱性がない証拠ではなく `screened-no-candidate` として止め、対象を `unexplored` に分類して台帳に残す。再訪対象から除かない。
2. 一段目に受理された Finding または具体的 Lead がある対象だけ、同じ Snapshot で二段目の Root＋最大3 subagent の deep-dive Trial を行う。壁時計の上限は90分。一段目の Finding の claim、Lead の summary と missingEdge、未調査入口を「未解決の問い」として渡し、source から確認・反証する。recipe、payload、HTTP本文、評価対象の答えは渡さない。分担と仮説は Root が決める。
3. 報告時に入口索引に未処理の入口があり、経過 wall が下限30分未満なら、Harness は同じ使い捨てコンテナへ残り入口の続行を1回だけ差し込む。2回目の報告で Trial を終える。CLI の同一 thread 再開が実機で可能なら再開し、不可能なら前の報告と残り入口だけを渡す新 thread を同じコンテナで起動する。使用した方式、理由、残り時間、戻した入口数を台帳に残す。下限と wave 数を守らせる文言は新しい目的 prompt に置かない。

一段目・二段目の初期予算配分は7:3とし、段別の Trial、wall、usage、Finding、Lead、失敗理由、継続の増分を台帳から読む。3か月分の本番台帳を見て配分を見直す。provider limit、出力境界の保留、Labの失敗は候補0件として扱わない。入口索引は固定 source から作るカタログであり、攻撃経路や分担を指示しない。

## 理由

既存の短い協調 Trial は約4分で終わり、長い比較 arm は約38分と使用量が大きかった。一方、公開済みの既知経路でも Stored XSS 候補は安定して出ていない。まず入口を広く調べ、source に根拠のある候補だけ深掘りする。早期終了の判断を agent の時間指示に任せず、残り入口と wall を Harness が見て続行させる。

根拠: [完成度レビュー](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-harness-completeness-review.md) 第4・6節、[prompt 下書き](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/blob/cfef59e/docs/reviews/2026-10-11-two-stage-prompts-draft.md)。

## 採らなかった選択肢

- Root＋3を全対象で最初から回す: 短時間終了と高い使用量を区別できず、対象数を増やせない。
- 一段目の0件を陰性として対象を閉じる: 網羅不足や出力失敗を脆弱性なしと誤認する。
- prompt の30分指示だけで継続を管理する: 下限を守った保証と理由が台帳に残らない。

## 既存決定との関係と帰結

- [ADR 0016](0016-root-plus-three-first-vertical-slice.md) の Root＋最大3子、隔離、独立検証は二段目で維持する。一段目を主経路の入口に追加し、全対象を Root＋3 から始める既定を置き換える。
- [ADR 0014](0014-trial-local-lead-continuation.md) の旧単独Trialの1 hop Lead継続は互換読取だけに残す。新しい継続は同一Trialの coverage を補う1回の差し戻しであり、独立Trial数を増やさない。
- [ADR 0018](0018-hold-and-normalize-discovery-candidates.md) の保留候補と [ADR 0019](0019-harness-generated-output-contract.md) の出力契約生成を維持する。目的 prompt は新 ID と digest で追加し、旧版は再現用に残す。既定の切り替えは一段目実装時に行う。
- 段、停止理由、継続方式を追記専用台帳に記録する。旧 event は段なしとして読める。
