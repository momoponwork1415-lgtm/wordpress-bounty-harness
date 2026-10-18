# 旧 Trial 履歴のメタデータ限定照合（2026-10-14）

調べて報告。正本ではない。Issue #215、Draft PR #216、Issue #227 の既往判定に使う旧記録を、ファイル構造、SQLite schema、event 種別、開始時刻の有無、件数だけで照合した。候補、PoC、payload、報告、証拠、実行 transcript の本文は読んでいない。対象名は本書に載せない。

## 結論

最初の集計で識別できた **530 slug のうち、497 slug に探索 Trial 開始の根拠があり、33 slug は保留**であった。これは旧記録全体の確定母数ではない。追加の全数スキーマ走査で、深さ 7 の履歴 DB から、最初の旧 DB 集計 443 slug に含まれない開始根拠を **29 slug** 確認した。queue 由来の 54 slug との重複を照合できていないため、497 からの実増分は **0〜29 slug**、33 slug の保留への影響も未確定である。最初の 33 の内訳は、旧 queue に launcher の開始時刻だけが残る 8 slug と、選定または campaign 準備だけが確認できる 25 slug である。

開始根拠 497 は、旧 campaign DB の `native-run.started` または `native-run.recorded.receipt.startedAt` と、旧 queue の `done` / `capped` を slug で重複排除したもの。`done` は当時の実装が run の `leads.json` と成功終了を確認した状態、`capped` は launcher の wall 上限に達した状態である。単なる `campaign.defined`、`target-research-campaign-selected`、`campaign.run-started`、queue の `started_at` だけでは実際の agent Trial 開始を断定しない。

## 調査範囲と件数

| 格納先 | 調査した範囲 | 開始判定に使える記録 |
| --- | --- | --- |
| `/home/dev/wordpress-harness/.private` | 深さ 6 までの SQLite 933 本を schema 分類。`agent_led_research_events` 682 DB、`research_events` 151 DB、`target_research_history_events` 70 DB。兼用 DB があるため列の合計は DB 総数ではない | `native-run.started` 630 event、`native-run.recorded` 1,255 event は全件 receipt に `startedAt` がある。重複排除で 443 slug。`research_events` の `campaign.attempt-started` は 309 event / 8 slug で、8 slug はすべて前者と重複 |
| `/mnt/d/wordfence/campaigns` | SQLite 38 本の schema を分類。13 本が `agent_led_research_events`、残りは human OS / provider 内部 DB | run receipt に開始時刻がある 3 slug。3 slug はすべて上記旧 private DB と重複 |
| `/home/dev/wp-bounty-workspace/queue/queue.json` | `discovery-queue/v1` の 172 entry / 153 slug。状態、開始時刻、件数のみを読んだ | `done` / `capped` 131 slug のうち 54 slug が旧 DB の開始根拠に加わる。queue が `failed` / `queued` に戻り、launcher 開始時刻だけが残る 8 slug は保留 |
| `/home/dev/wp-bounty-assurance/campaigns` | `RUN.json` 65 本の schema と有効 JSON 件数だけを確認 | 有効 38 本のキーは profile、prompt digest、Target Snapshot ID / digest。開始時刻がなく、今回の 530 に算入していない |

旧 private DB の `campaign.defined` は 678 event / 444 slug で、そのうち 443 slug に `native-run.started` または開始時刻付き receipt がある。`native-run.admission-failed` は 4 event であり、それ単独では開始としない。旧 `research_events` には `campaign.prepared` 151 event、`campaign.run-started` 126 event、`campaign.attempt-started` 309 event がある。`campaign.run-started` は下位の Finder attempt の開始と分ける。`target_research_history_events` には `target-research-campaign-selected` 80 event / 65 slug と `target-research-campaign-recorded` 218 event があり、選定・campaign 進行の記録を直接 Trial 開始とは扱わない。

## 保留と未確認範囲

- 追加調査では深さ 7 の `.sqlite` 723 本、深さ 8 の `.sqlite` 6,641 本、深さ 9 以降の `.sqlite` / `.db` 238 本、深さ 7 の `.db` 6,588 本、計 **14,190 本**の SQLite schema を読み取り専用で全数照合し、接続エラーは 0 件だった。深さ 7 の `.sqlite` 86 本に旧 Trial 履歴テーブルがあり、ほかの範囲では該当がなかった。86 本のうち 16 本の `agent_led_research_events` は `native-run.started` 16 event / 16 slug で全て最初の旧 DB 集計と重複した。70 本の `research_events` は `campaign.attempt-started` 221 event / 60 slug で、29 slug が最初の旧 DB 集計に含まれなかった。DB ごとに読み取り transaction を使ったが、全 DB を同時点で固定した snapshot ではない。走査中の書き込みは排除できない。
- 追加の29 slugと旧 queue 由来の54 slugの突合には、queue JSON の本文を読む必要があった。自動承認審査が候補・payload 本文の読取りを懸念して拒否したため、これを迂回せず保留した。従って旧記録の開始済み総数、保留集合、完全 coverage は未確定である。
- 旧 assurance の `RUN.json` は 65 本中 27 本が有効な JSON として読めず、残り 38 本にも開始時刻はない。既知事例の評価 attempt と本番探索を混同しないため、別の開始証拠との結合までは保留する。
- `/mnt/d/wordfence/history` の提出台帳は、既存棚卸しによると提出と探索 run を結ぶ ID、model、prompt digest を持たない。提出件数を Trial 開始件数へ変換できない。`/home/dev/wp-bounty-workspace/intelligence/history.sqlite` は公開 Wordfence 履歴ミラーであり、内部 Trial 履歴ではない。
- Draft PR #216 の既知 22 state から復元した 141 件の `discovery-run-started` は今回の旧ソースとは別集計である。slug の重複照合前に 497 と 141 を足さない。
- 旧 queue の実 run tree `/home/dev/wp-bounty-labs` には今回照合できる run metadata が残っていない。`failed` / `queued` の launcher 開始時刻だけでは、agent が探索を始めたか確定できない。

## #216 / #227 への取り込み契約案

1. Git 外に source ごとの coverage manifest を置き、格納先、snapshot / digest、対象階層、読み取った schema、件数、未確認範囲を記録する。旧 SQLite は一貫した読み取り snapshot から取り込む。台帳には秘密本文を置かず digest 参照だけを残す。
2. slug は `wporg:<slug>` と WordPress Snapshot の `pluginSlug` を同じ正規形へ変換する。run ID / event digest / source digest を根拠参照として保持し、同じ event や DB 複製の再取り込みを冪等にする。版、Snapshot、prompt、campaign、state が違っても同じ slug の既往を解除しない。
3. `proven-started`、`hold-ambiguous`、`selection-only` を区別する。`native-run.started` と開始時刻付き receipt、Finder の `campaign.attempt-started`、旧 queue の `done` / `capped` は開始根拠。queue の launcher 時刻のみ、破損した manifest、結合できない event は保留。選定・準備のみは開始根拠ではないが、他の旧 source の照合と coverage 完了までは初回在庫に入れない。
4. 自動初回在庫の dispatch 直前に、現行全 state と旧 source の coverage が完了していること、slug に開始根拠も保留もないことを確認する。coverage 不足や新しい未照合 source が見つかった場合は fail closed とし、未探索と推定しない。初回の確証が得られた選定のみの slug は保留を解除できる。既往がある slug の追加独立 Trial は #215 の対象・目的・回数に結び付いた事前承認へ回す。

この調査はメタデータの静的読取のみで、import 実装、実機 Trial、`pnpm check` は行っていない。
