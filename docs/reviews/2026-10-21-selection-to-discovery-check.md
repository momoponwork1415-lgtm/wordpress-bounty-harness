# 選定から探索までの安定性の確認（2026-10-21）

所有者の指示（2026-10-21）: 選定から探索までが安定して動いているかを先に確かめ、問題が無ければ検証・triage の開発に進む。本報告は本番台帳（`~/.local/state/wordpress-bounty-harness/ledger.sqlite`、読み取り専用）と runner の log・status を 2026-10-18T16:00Z（本番 runner の再起動）から 2026-10-21 12:40 JST まで集計したもの。対象の名前と Finding の中身は書かない。正本ではない。

## 1. 結論

選定から探索までは安定している。止める理由になる課題は無い。残るのは provider 側の 2 点で、どちらも既に PR か Issue がある。

| 段 | 状態 | 根拠 |
| --- | --- | --- |
| 選定 | 安定 | 136 対象を選び、130 が Root run に到達。再選定は未探索の対象だけで、探索済みの対象の重複選定は 0。`holding-error` は 10-19 21:01Z が最後 |
| Snapshot | 安定（prod19 以降） | `freeze:deferred` 89 件は 10 対象の繰り返し。#417 を含む prod19（10-21 01:33Z）以降は新規 1 件だけ |
| 探索 | 安定 | 完了した Root の初回 segment は 116 本すべて wall 60 分以上。終了 event の無い run は 10-18 の 1 本だけ。子の報告失敗は Claude 3.7%、Codex 1.5% |
| runner | 安定 | 10-21 01:33Z の再起動以降、batch 2 つが正常に遷移。残骸コンテナ 0。手動 `select` で増えた未束縛の選定 batch は `holding-error` を起こさなかった |

## 2. 数字

### 選定（136 対象）

| 行き先 | 対象数 |
| --- | --- |
| Root run が completed | 116 |
| 走行中（10-21 12:40 JST） | 4 |
| provider の拒否で skip（再試行なし） | 9 |
| 現 batch で未着手 | 6 |
| `freeze:deferred` のみ | 0（deferred の 10 対象は別の版で探索済みか、#417 で再選定の対象外） |

`target-skipped` の内訳: `freeze:deferred` 89、`discovery:provider-refused` 23、`discovery:run-failed` 2。deferred 89 件のうち 10-20 06:30Z（#417 merge）以降が 36 件で、7 対象が 5 batch 連続で deferred になっていた。prod17 / prod18 は #417 を含まない build だった。prod19 以降の deferred は新規 1 対象 1 件。

### 探索（Root の初回 segment、runtime 別）

| 日 | runtime | Root | completed | provider-limited | 拒否 | その他 | 走行中 | completed の wall（分、最小 / 中央 / 最大） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10-18 | codex | 5 | 4 | 0 | 0 | 0 | 1（終了 event なし） | 61 / 61 / 61 |
| 10-19 | claude | 31 | 11 | 18 | 2 | 0 | 0 | 60 / 63 / 75 |
| 10-19 | codex | 54 | 28 | 15 | 6 | 5 | 0 | 60 / 61 / 64 |
| 10-20 | claude | 8 | 7 | 0 | 1 | 0 | 0 | 61 / 66 / 71 |
| 10-20 | codex | 64 | 46 | 9 | 9 | 0 | 0 | 60 / 61 / 63 |
| 10-21 | claude | 11 | 5 | 0 | 2 | 0 | 4 | 61 / 61 / 65 |
| 10-21 | codex | 3 | 0 | 3 | 0 | 0 | 0 | — |

- 10-19 の Claude の provider-limited 18 本は 4 並列の 429 試験。10-21 の Codex 3 本は quota 切れ。
- 拒否: Codex の `provider-cyber-policy` は Root 74 本中 12 本（16%）。Claude の `provider-refusal` は Root 55 本中 5 本（9%）、子 515 本中 15 本（3%）。拒否された 9 対象は skip されて終わり、もう一方の runtime では試していない。
- 子: Claude は Root あたり中央値 10 体（最大 28）、観測寿命中央値 3.2 分。Codex は中央値 4 体（最大 15）、53.5 分。`child-final-message-not-report` は Claude 19 / 515、Codex 4 / 275（10-18 以前の run では 55 / 267 だった）。
- 観測: Claude の completed Root で `filesRead = 0` は 10-19 に 13 本中 4 本、10-20 に 10 本中 1 本、10-21 は 5 本中 0 本。
- 候補: `finding-recorded` 69（parked 6、Programme 内の分類 4 種）、`lead-recorded` 714。runtime 別の件数 / completed Trial は Claude 25 / 23、Codex 42 / 78。件数だけで、重複と検証は未実施。
- host v7（Root Opus ＋ 子 Sonnet、10-21 01:36Z 以降）: Root 8 本中 completed 2、拒否 2（15 分と 18 分で終了）、走行中 4。子 46 本中 completed 44、拒否 2。
- `campaign-stopped` 46 件（provider-limit 45、operator 1）。provider 上限は batch 全体を止め、backoff の間はもう一方の runtime も待つ。

## 3. 課題

| # | 課題 | 影響 | 対応 |
| --- | --- | --- | --- |
| 1 | provider の拒否で対象が失われる。Codex 16%、Claude 9% の Root が拒否で終わり、9 対象は再試行なし | 対象の 7% を未探索のまま失う。両 runtime は別の対象を拒否するので、片方で拒否された対象をもう一方で試す余地がある | Issue #435（ready-for-human）。Harness の判断の要らない規則（拒否 → もう一方の runtime の列へ）として置けるが、Step 1 の凍結の例外になる |
| 2 | provider 上限で batch 全体が止まり、再開も自動でない | 10-21 は Codex の quota で Claude 側も 6 時間待ち、操作者が手で share を変えた | PR #419（runtime 別の停止）と #413（backoff 後の自動再開）。merge は門の判断待ち |
| 3 | `freeze:deferred` の繰り返しで選定枠を消費していた（7 対象 × 5 batch） | 本番 build が #417 を含まなかった期間（10-20〜10-21 01:33Z）だけ | prod19 で解消。次の 2 batch で再発 0 を確認する |
| 4 | 10-18 の Root 1 本に終了 event が無い | 台帳の衛生。`unsettled` に残り続ける | `campaign resume --run` で `interrupted` として封じる（ADR 0036 追記 3）。操作者の作業 |

探索の中身（どこを読むか、子の数、最終報告の形）には変更の必要を示す数字は無かった。Harness のコードを探索側で増やす理由も無い。

## 4. 次に進むところ

検証と triage。Harness 側はバグ修正と削除（#430〜#434、#424、#353）で、残りは skill の仕事。

- `wbh-verify`（handoff の再現。操作者は Codex）、`wbh-dedupe`（公開情報との照合）、`wbh-review`（review export から accept / reject / defer の提案）、`wbh-report`（報告書の下書き）は既にある。使って所要時間と詰まる場所を測るのが先で、skill 本文の改訂はその数字から決める（owner-approved は委任済み AI が付ける）。
- handoff 列は #434 で全 campaign の未結論 Finding に広がる。#425（Claude の Finding 23 件）と #352 の受け入れは Codex の quota が戻ってから。
