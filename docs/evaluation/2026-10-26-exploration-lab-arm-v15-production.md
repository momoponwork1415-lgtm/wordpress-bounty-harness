# 探索 Lab の本番 arm（v15-wide、2026-10-26）

## 問いと位置づけ

[DEVELOPMENT §5](../DEVELOPMENT.md)（2026-10-26、PR #597）のとおり、探索 Lab の採否は本番で 1 arm を回して決める。開発セットの arm（[2026-10-26-exploration-lab-arm-v14.md](2026-10-26-exploration-lab-arm-v14.md)）では Lab が一度も使われなかった。原因は、`wide` の子に Lab の節が渡っていなかったことで（Issue #599）、所有者は「wide の目的文に 1 文足す」を選んだ。それが `wp2shell-bounty-v15-wide`（[docs/reviews/2026-10-26-wp2shell-bounty-v15-wide.md](../reviews/2026-10-26-wp2shell-bounty-v15-wide.md)）で、本番で v14（Lab なし）と並べて回した。

## 条件

- v15 runner: `continuous run --campaign-prefix prod-v15`、`promptId: wp2shell-bounty-v15-wide`、`discovery.lab: "attached"`、Claude runtime 1 並列、選定は v14 runner と同じ帯（`maximumTargets` 3）。build は `/home/dev/worktree/prod26`（commit `845ead7`、PR #606 の接頭辞ごとの鎖）。13:40Z 開始。
- v14 runner: 同じ build、`wp2shell-bounty-v14-wide`、`discovery.lab: "none"`、Claude 3 並列、13:39Z に再起動（`--resume`）。
- 両方とも子の上限 4、wall 上限 120 分。Lab の再供給は 2 回まで、観測コマンド 20 回まで、DB は読み取り専用。
- 止めた時刻: 14:25Z に `continuous stop --campaign-prefix prod-v15`、14:30:51Z に runner が `stopped reason=operator` で終わった。campaign 2 の 3 対象目は始めていない。
- 計測は台帳（`discovery-run-finished` の `wallTimeMs`、`observed.filesRead`、`labObserved.requests`、`candidate-normalized` / `lead-recorded` / `finding-recorded`）で読んだ。

## v15 arm の結果（6 Trial、有効 5）

| campaign | Snapshot | 結果 | Root wall | Root の filesRead | Root の Lab 要求 | 子の Lab 要求（合計） | 子 | Finding | Lead | held |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| prod-v15-20261026-1 | `a6d63b3f25` | completed | 3.6 分 | 0 | 16 | — | 4 | 0 | 0 | 0 |
| prod-v15-20261026-1 | `ae7cba2544` | completed | 5.4 分 | 0 | 1 | — | 4 | 0 | 0 | 0 |
| prod-v15-20261026-1 | `dcea5ed8c6` | provider-limited | 4.9 分 | 0 | 8 | — | 4 | 0 | 0 | 0 |
| prod-v15-20261026-1 | `dcea5ed8c6`（やり直し） | completed | 4.5 分 | 0 | 5 | — | 4 | 0 | 0 | 0 |
| prod-v15-20261026-2 | `99c91d1ce9` | completed | 3.8 分 | 0 | 11 | — | 4 | 0 | 0 | 0 |
| prod-v15-20261026-2 | `3be4b029e5` | completed | 5.3 分 | 0 | 0 | — | 4 | 0 | 0 | 0 |

- 子の Lab 要求は 6 Trial の合計で 12（run ごとの内訳は `observed.labRequests`）。Root の合計は 41。**Lab は使われた**が、Root は固定したソースを 1 つも読まず（`filesRead` 0）、子 24 体のうち 7 体が出力境界で落ちた（散文の後に JSON を書く型。PR #611 で救える型で、v15 側の落ち方は 7/24、v14 側は同日 17/173）。
- Finding、Lead、held はすべて 0。候補が 0 なのは、子の失敗で落ちたからではない。失敗した子の最終メッセージも Finding 0、Lead 0 だった（Issue #609 の調査で transcript を読んだ）。
- provider-limited 1 件（429）は、Claude の 4 Trial 同時（v14 の 3 + v15 の 1）で起きた。backoff 5 分の後、同じ Snapshot でやり直した。

## 同じ時間帯の v14（Lab なし）

| 窓 | Trial | completed | Root wall 中央値 | Root の filesRead 平均 | 子 | 子の失敗 | Finding | parked | Lead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 13:39Z 以降（v15 と同じ窓） | 9 | 9 | 4.9 分 | 1.0 | 38 | 4 | 0 | 0 | 39 |
| 2026-10-26 全日 | 37 | 37 | 9.9 分 | 7.2 | 173 | 17 | 9 | 6 | 164 |

- 同じ窓では v14 も Root の wall が短く（2.8〜27.9 分）、Finding は 0 で、Lead だけが 39 件出た。全日では 37 Trial で Finding 9（うち今日の 9 件は全部、攻撃者が外部サービスの応答を握らないと成立しない型。Issue #612）、parked 6、Lead 164。
- v15 の 6 Trial は Lead も 0 である。v14 は同じ窓の 9 Trial で Lead 39。Lead の有無が、この窓で最もはっきりした差である。

## 判断

- **探索 Lab は本番でも使わない。** v15 の有効 5 Trial で候補 0、Root の wall は全件 6 分未満、Root はソースを読まず、Lab への要求だけが出た。Lab を渡すと Root の時間が Lab の操作に回り、ソースを読む行動と Lead の報告が消えた。同じ窓の v14 は Lead 39。
- 所有者は 14:2xZ に「プロンプトは v14 に戻したほうが良さそう」と決め、5 Trial の決定規則（候補 0 のままなら止める）と同じ結論になった。v15 runner は止め、`continuous-prod-v15.*` を消した（PR #606 の退役手順）。本番は v14（Lab なし、Claude 3 並列）1 本に戻す。
- `wp2shell-bounty-v15-wide` は registry に `candidate` のまま残す。campaign が名指ししたときだけ動く。新しい campaign で名指ししない。
- Lab を使う案を次に出すなら、「Root がソースを読んだ後に Lab を触る」順序を目的文で作れるかを先に見る。Lab の有無だけで比べる arm はもう要らない。

## Git 外の原記録

- state: `/home/dev/.local/state/wordpress-bounty-harness`（本番）。runner の log は同じ場所の `continuous-20261026-claude-v15.out` と `continuous-20261026-claude-main.out`。
- campaign 設定: `~/.config/wordpress-bounty-harness/campaign-production-claude-v15-lab-20261026.json`、選定 `selection-production-claude-v15-lab-20261026.json`。
- campaign ID: `prod-v15-20261026-1`、`prod-v15-20261026-2`。比較は `prod-20261026-9` 〜 `prod-20261026-12`。
