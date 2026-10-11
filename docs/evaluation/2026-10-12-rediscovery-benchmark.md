# 公開済み事例の再発見評価（2026-10-12）

## 測定の位置づけ

この評価は固定した公開 source に対する探索配線、通常利用 Lab、分類別の検証能力を測る。既知事例を再発見できても、未知の脆弱性の発見率は示さない。公開記録の本文・原因・PoC は探索入力へ渡さず、探索後の記録照合だけに使う。既定 `wp2shell-bounty-v2`、履歴なし、対象版ごとに最大 1 Trial とし、条件不成立時に Trial を追加しない。

Git 外の manifest は [`rediscovery-catalog-pins.json`](rediscovery-catalog-pins.json) の digest で固定した。7つの対象版に8件の公開記録があり、修正版 ZIP 7件は取得時の bytes と digest を Git 外で固定し、ZIP の完全性を確認した。TranslatePress 3.2.6 の2記録は同じ source Trial を共有し、記録との一致を別々に評価する。

## 通常利用の前提確認

| 対象版 | 対象固有の Lab setup あり | 状態・停止段階 | 観測 |
| --- | --- | --- | --- |
| Relevanssi 4.28.3 | あり：通常のコメント索引 | ready | 探索・検証 Lab とも、承認済みコメントの固有語を公開検索すると該当投稿を返した。 |
| Simply Schedule Appointments 1.6.10.0 | あり：通常の予約種別と公開ページ | ready | 公開ページ、予約 iframe、内部予約アプリが応答した。 |
| Brizy 2.8.11 | あり：通常の公開ビルダーページ | ready | gVisor Lab で無害なテキスト要素を保存し、匿名の公開ページに Brizy 本文とテキストが表示された。 |
| TranslatePress 3.3.1 | あり：二次言語と翻訳データ | 測定待ち | 既存の対象固有 setup と他対象を同じ条件として比較しない。 |
| TranslatePress 3.2.6：記録A | あり：二次言語と承認済みコメント | 測定待ち | 記録Bとは同じ対象版、照合は別。 |
| TranslatePress 3.2.6：記録B | あり：二次言語と承認済みコメント | 測定待ち | 記録Aとは同じ対象版、照合は別。 |
| Smash Balloon 4.13.0 | あり：外部 Facebook feed | incomplete（Lab 前提） | 隔離 Lab は起動し、新規 DB の接続済み source・feed・cache は各0件。内部ネットワークから外部 API へ到達できなかった。 |
| Unlimited Elements 2.0.16 | あり：Elementor 依存 | incomplete（source 取得） | 固定した SVN export を現行 ZIP 専用取得器へ渡せず、Elementor 依存も Snapshot にない。 |

Smash Balloon と Unlimited Elements は条件が成立するまで provider Trial を起動しない。各 case の停止段階と理由コードは `evaluation-case-blocked` として別々の台帳に追記した。これらの incomplete は脆弱性の不存在や判定器の陰性を意味しない。

## Trial と判定

各 campaign の Root・子エージェントの source 読取数、候補が出た段階、Verifier の理由コード、修正版対照、人間が個別に開いた Finding 数を `scripts/report-rediscovery-cases.mjs` で台帳から集計する。集計の `publicRecordMatch: unassessed` は特定の公開記録との経路一致を証明しない。公開記録との一致は探索後に別途照合し、一致しない確認を再発見に数えない。

| 対象版 | Trial / completed | Finding / Lead | Root wall 中央値 | source 読取下限（全 agent） | 判定・未完了理由 | 修正版対照 | 公開記録との一致 | 人間が開いた Finding |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Relevanssi 4.28.3 | 進行中 | 未確定 | 未確定 | 未確定 | 未確定 | 未実施 | 未照合 | 0 |
| Simply Schedule Appointments 1.6.10.0 | 進行中 | 未確定 | 未確定 | 未確定 | 未確定 | 未実施 | 未照合 | 0 |
| Brizy 2.8.11 | 未実施 | — | — | — | Trial 待ち | — | — | 0 |
| TranslatePress 3.3.1 | 未実施 | — | — | — | 未測定 | — | — | 0 |
| TranslatePress 3.2.6：記録A | 未実施 | — | — | — | 未測定 | — | — | 0 |
| TranslatePress 3.2.6：記録B | 未実施 | — | — | — | 未測定 | — | — | 0 |
| Smash Balloon 4.13.0 | 0 / 0 | 0 / 0 | — | — | incomplete（外部接続不可） | — | — | 0 |
| Unlimited Elements 2.0.16 | 0 / 0 | 0 / 0 | — | — | incomplete（固定 source 取得・依存 Snapshot 不在） | — | — | 0 |

Simply Schedule Appointments は対象記録の公開日が使用 model の cutoff より前であり、contamination の可能性がある区間として他の事例と分けて扱う。Stored XSS と SQLi の非 TranslatePress 事例で、それぞれ `runtime-confirmed` または #141 の reproduced と修正版の負の対照を得る受入条件は、現時点で未達である。
