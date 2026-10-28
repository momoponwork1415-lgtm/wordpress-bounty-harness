# 既存ライブラリ・実行基盤を使う選択肢

2026-10-23。`cde675e` の一般的な CLI・保存・レビュー記録の実装と、製品の公式資料を照合した技術選定メモ。正本ではない。コード・依存関係・設定は変更していない。実行基盤の比較は一般的な責務の比較であり、探索・検証への統合設計や移行手順は作成していない。

## 判断

設計の改善は、既存コードのリファクタリングだけに限定する必要はない。汎用の仕組みを既存製品へ任せることや、機能自体を減らすことも選択肢になる。ただし、現在の問題には次の違いがある。

| 問題 | 解決の種類 |
| --- | --- |
| コマンドの解析・ヘルプなどの共通機構 | 標準機能やライブラリで置換できる可能性がある |
| 長時間処理の進捗保存・待機・障害後の継続 | Temporal のような実行基盤が扱う問題領域 |
| レビュー入力の検査と保存の順序、現在状態と履歴の意味 | アプリ側の責任分担・記録の意味を決め直す必要がある |
| 所有者が今後使わない機能 | 技術の置換より、機能の廃止が直接的 |

現在の削除見積もりは、これらの再設計・置換による削減量を含まない。現段階で特定製品による削減行数を示す根拠はない。

## Temporal は何をするものか

Temporal は、一連の処理の進捗を履歴に残し、停止をまたいで続ける実行基盤である。一般的には、帳票作成や人間の承認待ちを含む長い業務処理などで、進行管理をアプリだけで実装し続ける負担を減らすために検討する。履歴からの復元であり、動作中のプロセスのメモリをそのまま復元する仕組みではない。[公式概要](https://docs.temporal.io/temporal)、[Workflow Execution](https://docs.temporal.io/workflow-execution)

| Temporal 側の責任 | アプリ側に残る責任 |
| --- | --- |
| 実行履歴と進捗の復元 | 業務上の状態、成功条件、許可条件 |
| 永続的な待機・タイマー・処理間の連携 | 各処理の実装、入力検査、保存する内容 |
| 指定された再試行・タイムアウトの管理 | 何を再実行してよいか、重複しても結果を壊さない設計 |

外部処理が成功してから完了通知前に停止した場合、同じ処理が再実行され得る。たとえば二重課金を防ぐような設計は、導入だけで自動的に得られるものではない。[Activity Definition](https://docs.temporal.io/activity-definition)

また、Workflow の実装には履歴と整合する決定的な振る舞いが必要で、進行中の処理とコード変更の互換性も考える必要がある。頻繁な変更に伴う設計問題が消えるわけではない。[Workflow Definition](https://docs.temporal.io/workflow-definition)

本番では Temporal Cloud または自己ホストの基盤に加え、アプリの Worker を運用する。Cloud を使っても Worker は自分で動かす。自己ホストなら保存用 DB、監視、更新などの保守も引き受ける。小さなライブラリを追加する判断とは異なる。[本番構成](https://docs.temporal.io/production-deployment)、[自己ホストの運用](https://docs.temporal.io/self-hosted-guide/production-checklist)

現在の追記専用台帳は業務記録の正本であり、実行基盤の復元用履歴とは責務が異なる。Temporal の導入だけで台帳全体を削除できる、という評価はしていない。[ADR 0005](/home/dev/wordpress-bounty-harness/docs/adr/0005-single-append-only-ledger-gated-by-snapshot-digest.md)

## 他の選択肢との違い

| 選択肢 | 主に引き受けること | 残ること・今回の評価 |
| --- | --- | --- |
| [Temporal](https://docs.temporal.io/temporal) | 一連の処理を停止をまたいで続ける仕組み | 業務ルール、保存内容、実行側の運用。基盤変更としての比較対象であり、採用決定ではない |
| [BullMQ](https://docs.bullmq.io/) | ジョブの待ち行列と配送、遅延、再試行 | 業務全体の状態と記録の意味。キューの保存基盤の運用も必要。Temporal と同じ責務を丸ごと持つものではない |
| [XState](https://stately.ai/docs/xstate) | 状態とイベント、許される遷移を明示する | 保存先や書込み順序を別に設計する。状態の保存・復元機能はあるが、Temporal と同じ実行基盤ではない。[永続化の説明](https://stately.ai/docs/persistence) |
| [Commander](https://github.com/tj/commander.js#readme) | CLI のコマンド階層、引数、ヘルプ、基本的な入力条件 | コマンドが行う仕事自体は残る。今回の大きな設計問題の解決策としては優先度が低い |

これは全部を導入する提案ではない。似た責務の仕組みを重ねると、どれが状態を管理するのかをさらに理解しづらくする。

## 現物を確認して分かったこと

- CLI は既に [Node 標準の parseArgs](/home/dev/wordpress-bounty-harness/src/cli/index.ts:5) を使い、自作の [コマンド表の共通処理](/home/dev/wordpress-bounty-harness/src/cli/command-table.ts:1) は 79 行。CLI 全体約 8,000 行を Commander で置き換えられるわけではない。
- 入力検査には既に Zod がある。レビューの問題は、[CLI の付随記録](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1076) より [最終入力検査](/home/dev/wordpress-bounty-harness/src/review/index.ts:450) が後になる順序であり、検査ライブラリの不足ではない。
- 台帳は [Node 標準の node:sqlite](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1) を使う。`better-sqlite3` は公開履歴ミラーの 2 ファイルが使用。データベース機能そのものを自作しているわけではない。
- [状態を開く入口](/home/dev/wordpress-bounty-harness/src/cli/state.ts:19) は閲覧と初期化を混在させる。ORM を追加するだけで、この責任分担が自動的に決まることはない。
- [ADR 0008](/home/dev/wordpress-bounty-harness/docs/adr/0008-strict-typescript-modular-monolith-with-thin-cli.md) は CLI を薄い adapter としている。新しい製品を選ぶ以前に、既定の方針と現物の差を整理する余地がある。

## 評価の仕方

判断材料は削除行数だけではない。「自分で正しさを保つ必要がある仕組みが減るか」「設定・運用・移行の負担まで含めて小さくなるか」「残る module の interface が単純になるか」を見る。既存の仕組みの上に新しい層を足すだけなら、depth や locality の改善にはならない。

一般的な記録・レビュー部分については、入力検査と保存の責任を既存 module に集めること、現在状態と履歴の意味を明確にすることに根拠がある。Temporal は別枠の基盤選定として比較する価値があるが、この調査だけで全面移行を推奨する根拠は足りない。インストール、試作、実データ移行は行っていない。
