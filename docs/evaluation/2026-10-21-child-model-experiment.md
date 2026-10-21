# 子モデル実験: Root Opus 固定で子を Sonnet / Haiku に変える（2026-10-21）

Issue #418、PR #427（merge 済み 4a339e9）の計測。所有者の決定（2026-10-20〜21）: 子 Opus の arm は回さない。対象は dev set ではなく、直近の本番で Finding が出た plugin のうち、前提が少なく Programme Boundary 内の影響がある 7 件。判定器の結果は選定基準から外す。各 arm 内は 3 本並列。

## 構成

| 項目 | 値 |
| --- | --- |
| build | PR #427 の head fc58137（`/home/dev/wbh-418`） |
| prompt | `wp2shell-bounty-v8`（digest は台帳の `discovery-run-started.configuration.promptDigest`） |
| Lab | なし（`discovery.lab: none`） |
| wall / 下限 | 120 分 / 60 分 |
| 子 | 最大 4 同時 |
| arm os | profile `claude-opus-root-sonnet-child-high`（Root `claude-opus-5-5` high、子 `claude-sonnet-5-5` high） |
| arm oh | profile `claude-opus-root-haiku-child-high`（Root `claude-opus-5-5` high、子 `claude-haiku-5-5` high） |
| state | `~/.local/state/wordpress-bounty-harness-child-model-20261021/<case>-<arm>/`（Git 外） |
| campaign ID | `cm-<case>-<arm>-1021-r1` |
| 実行 | 2026-10-21 02:46〜08:42 JST。os を先に 7 本、次に oh を 7 本。3 本ずつ並列 |

## 結果

表は監視セッションの最終表（2026-10-21 08:48 JST）。Finding / parked / Lead の件数は開発 session が台帳から再集計して一致を確かめた。

| case | arm | 結果 | Root wall | 子 | Finding | parked | Lead | 非 cache in / out | 停止理由 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mw-wp-form 5.1.8 | os | completed | 71 分 | 11 | 0 | 0 | 4 | 814 / 494,586 | 最終報告 |
| kirki 6.4.0 | os | completed | 73 分 | 16 | 13 | 0 | 16 | 1,760 / 591,667 | 最終報告 |
| click-to-chat-for-whatsapp 4.45 | os | completed | 61 分 | 18 | 0 | 0 | 7 | 802 / 237,745 | 最終報告 |
| wpvivid-backuprestore 0.9.136 | os | completed | 62 分 | 13 | 0 | 0 | 23 | 1,138 / 470,354 | 最終報告 |
| check-email 2.0.16 | os | completed | 68 分 | 16 | 8 | 0 | 10 | 1,244 / 592,878 | 最終報告 |
| forminator 1.58.2 | os | completed | 67 分 | 18 | 4 | 1 | 34 | 2,738 / 862,802 | 最終報告 |
| wp-seopress 10.3 | os | incomplete(provider-refusal) | 63 分 | 18 | 0 | 0 | 6 | 1,246 / 365,975 | Claude の拒否 |
| mw-wp-form 5.1.8 | oh | incomplete(provider-refusal) | 15 分 | 4 | 0 | 0 | 8 | 308 / 350,599 | Claude の拒否（60 分未達） |
| kirki 6.4.0 | oh | completed | 72 分 | 15 | 0 | 0 | 37 | 2,428 / 1,502,664 | 最終報告 |
| click-to-chat-for-whatsapp 4.45 | oh | completed | 66 分 | 15 | 0 | 0 | 17 | 1,434 / 925,101 | 最終報告 |
| wpvivid-backuprestore 0.9.136 | oh | completed | 62 分 | 14 | 11 | 0 | 31 | 1,586 / 1,152,529 | 最終報告 |
| check-email 2.0.16 | oh | completed | 98 分 | 10 | 2 | 1 | 39 | 1,516 / 1,167,001 | 最終報告 |
| forminator 1.58.2 | oh | completed | 66 分 | 17 | 8 | 0 | 40 | 3,034 / 1,528,938 | 最終報告 |
| wp-seopress 10.3 | oh | completed | 70 分 | 20 | 0 | 0 | 18 | 2,476 / 1,271,912 | 最終報告 |

| arm | completed | Finding | Lead | 出力 token |
| --- | --- | --- | --- | --- |
| os（子 Sonnet） | 6 / 7 | 25 | 100 | 3.62M |
| oh（子 Haiku） | 6 / 7 | 21 | 190 | 7.90M |

## 読み方

- 子を替えても Root は 60 分の下限を守って最終報告まで届いた（拒否で止まった 2 本を除く）。子の Finding は Root の報告と独立に保存された（ADR 0029 の配線確認）。
- 同じ対象でも arm で Finding の出方が逆になる例があった（kirki は os 13 / oh 0、wpvivid は os 0 / oh 11）。1 Trial ずつなので run 間変動と区別できない。
- 子 Haiku は Lead が約 2 倍、出力 token が約 2.2 倍で、Finding は少し減った。子 Sonnet は既存の Opus / Opus 本番 Trial と同程度の件数で、token は少ない。
- 既存の本番 Trial（子 Opus）との比較は、検証経路の違いを含むので件数の並記にとどめる。確認済みの差は handoff 検証を通した後に見る。`runtime-confirmed` が出ても公開記録との経路一致は人間の照合なので、表には書かない。
- 中身の重複排除と検証は未実施。Finding の本文は Private Evidence にあり、ここには書かない。

## 決定

所有者（2026-10-21）: 子は Sonnet でよい。本番の host 設定 v7 は Root Opus ＋ 子 Sonnet の profile に切り替えた（2026-10-21 10:36 JST）。Codex 側の子モデル変更（Luna）は Codex の quota が戻ってから別の問いとして扱う。
