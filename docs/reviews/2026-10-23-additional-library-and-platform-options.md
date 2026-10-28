# 追加で検討したライブラリ・基盤

2026-10-23。対象コードは cde675e。[前回の推奨](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-23-build-versus-buy-recommendation.md)に対し、11 候補を追加調査した。報告書のみを追加し、ソース・依存関係・設定は変更していない。

具体的な適用評価は、静的なコード管理、CLI、保存、人間のレビュー記録、閲覧に限る。実行基盤は一般的な帳票作成・承認待ちの比較であり、自律的な脆弱性探索・再現への統合設計や基盤選定ではない。

## 1. 結論

**今回の「変更を重ねて設計が崩れた／不要なものが残った」という悩みに、最も直接合う追加候補は dependency-cruiser と Knip である。** 前者は依存規則の維持、後者は未参照コードの発見を助ける。どちらも設計や機能の要否を代わりに決定するものではない。

Temporal の対案には **DBOS、Restate、Inngest、Trigger.dev** を加える価値がある。ただし、現在の入力検査・保存順序・履歴解釈の問題を直すための導入は勧めない。比較する順序と採用する順序は別である。

| 目的 | 優先して比較する候補 | 現段階の判断 |
| --- | --- | --- |
| 依存方向の崩れを防ぐ | dependency-cruiser | 既存の境界テストの解析部分を任せる候補 |
| 未参照コードを継続的に探す | Knip | 入口を確認したうえで、削除候補を出す道具として評価 |
| レビュー記録の組合せによる不整合を防ぐ | fast-check | 意味と不変条件を定めた後の限定評価 |
| エラーの扱いを明確にする | TypeScript の判別 union と neverthrow | ライブラリ導入より先に、失敗の分類を設計 |
| 一般的な長期処理の進行を外へ任せる | DBOS、Restate、Inngest | 必要性と運用対象を比較。採用判断は保留 |
| 一般的なバッチの実行環境まで外へ任せる | Trigger.dev Cloud | 実行場所を移す要件がある場合の候補 |

## 2. 開発・保守の道具：追加 7 候補

### dependency-cruiser — 優先して評価

import の依存方向、禁止する依存、循環依存を検査する。現在は [module-boundary.test.ts:30](/home/dev/wordpress-bounty-harness/tests/architecture/module-boundary.test.ts:30)が文字列を正規表現で読み、依存方向を検査している。依存の解析・解決を既存ツールに任せ、合意済みの module 間の規則だけを自作として残す候補になる。[公式ルール資料](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)

これは module の seam を維持するための検査で、module の depth を自動的に改善するものではない。規則の locality を保ち、同じ規則を複数の検査へ重複実装しないことが利点になる。型だけの依存も扱えるため、実行時の依存と区別する必要がある。[TypeScript 解析設定](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#tsprecompilationdeps)

一方、既存テストの [固有語の検査](/home/dev/wordpress-bounty-harness/tests/architecture/module-boundary.test.ts:48)は import 関係だけでは代替できない。既存テスト全体を削除する提案ではない。今回、循環依存の存在を診断したわけでもない。

### Knip — 削除候補の発見用に評価

設定した入口から参照されないファイル、export、依存パッケージを探す。既存の [noUnusedLocals / noUnusedParameters](/home/dev/wordpress-bounty-harness/tsconfig.json:10)より広い参照関係の棚卸しを補助する。[公式の検出原理と注意点](https://knip.dev/guides/handling-issues)

このリポジトリでは、[CLI の入口](/home/dev/wordpress-bounty-harness/package.json:6)がビルド後の dist を指し、[ビルド設定](/home/dev/wordpress-bounty-harness/tsconfig.build.json:4)でソースと出力を分けている。補助スクリプト、テスト、[md / json の列挙による配布](/home/dev/wordpress-bounty-harness/scripts/copy-assets.mjs:8)もある。入口と生成物の対応を確認してから結果を読む必要がある。[入口の説明](https://knip.dev/explanations/entry-files)、[スクリプト解析](https://knip.dev/features/script-parser)、[生成物の対応付け](https://knip.dev/features/source-mapping)

**「静的に未参照」と「利用者に不要」は違う。** Knip は利用頻度を測らず、呼び出せる機能の価値も判定しない。過去記録の読取りに必要な資産も、import グラフだけで削除しない。自動削除を勧めるものではなく、新たに未使用と確認できたコードも今回はない。

### fast-check — 記録の意味を整理した後に限定評価

入力を自動生成して性質を検査し、失敗例を小さくする JavaScript / TypeScript のテスト用ライブラリである。既存のテストランナーと併用できる。[公式概要](https://fast-check.dev/docs/introduction/)

現状の [レビューのテスト](/home/dev/wordpress-bounty-harness/tests/review/review.test.ts:567)には例を列挙した検査がある。レビュー記録の順序、現在有効な判断と履歴上の判断、入力不備で記録が増えないことなど、組合せが多い契約に適用する価値はある。ただし期待する性質が曖昧なら、有効なテストを生成できない。既存テストを一括で書き換える提案ではなく、欠陥検出の追加効果も未測定である。

### neverthrow — エラー契約を整理する際の候補

成功と失敗を型で表す Result / ResultAsync と、それを合成する処理を提供する。[公式 README](https://github.com/supermacro/neverthrow)

現在の [Review の競合](/home/dev/wordpress-bounty-harness/src/review/index.ts:493)は通常の Error になり、[CLI の最終処理](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1708)は使用方法の誤り等を除きメッセージと終了値 1 にまとめる。レビューの interface で「入力不備」「業務上の競合」「保存障害」を区別したいときの候補である。単純な TypeScript の判別 union でも足りるため、まずそれと比較する。エラーの種類と保存の順序は自作側の判断として残る。

### ts-pattern — 複雑な分岐だけに限定

型に対する分岐の網羅性検査を提供する。単純な分岐なら TypeScript 標準の never による検査でも対応できる。[公式 README](https://github.com/gvergnaud/ts-pattern)、[TypeScript の網羅性検査](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking)

先に [イベント定義](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:33)と [検索用列挙](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:665)の二重管理を解消する。その後も表示処理などに複雑な条件の組合せが残る場合に評価する。定義の重複は、このライブラリへの書換えだけでは解消しない。

### Pino — 人間操作の診断ログが必要なら評価

JSON ログ、共通属性、指定フィールドの秘匿を提供する。[公式 README](https://github.com/pinojs/pino)、[redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md)

現在の [CLI の例外表示](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1716)はメッセージだけである。人間の操作名、記録の識別子、失敗分類を後から対応付ける必要があれば候補になる。通常表示の adapter と診断用の adapter は目的を分ける。台帳の代替にはせず、何を記録してよいか、どこへ保存するかは自作側に残す。既存の保存順序の問題を解消する道具ではない。

### Effect — 全面導入は保留

型付きエラーや資源の寿命をまとめて扱う広い枠組みを持つ。[型付きエラーの資料](https://effect.website/docs/v3/error-management/expected-errors)、[Scope の資料](https://effect.website/docs/v3/resource-management/scope)

今回見た保存処理では、ファイルは既に [finally で閉じ](/home/dev/wordpress-bounty-harness/src/infrastructure/private-artifact-store.ts:438)、SQLite は [失敗時に rollback](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1054)している。資源管理全体を置き換える必要性の根拠は不足している。エラーの型だけが目的なら、判別 union や neverthrow の方が変更範囲を抑えて比較できる。Effect の資料には v4 の案内もあり、ここで参照した概念説明は v3 のもの。採用版や版間移行は未評価である。

## 3. 一般的な帳票・承認処理の実行基盤：追加 4 候補

この表は Temporal の比較対象を増やすためのもの。現行の探索・検証の構成へ対応付けたり、移行手順を示したりするものではない。

| 候補 | 任せられること | 利用者に残る運用 | 比較で重要な条件 |
| --- | --- | --- | --- |
| **DBOS** | アプリ内ライブラリによる処理進捗の保存、停止後の継続 | 自前運用ではアプリと Postgres。分散した復旧の調整も検討対象 | **TypeScript は Postgres 必須**。既存 SQLite に追加するだけの構成ではない |
| **Restate** | サービス間の処理の進行、待機、実行履歴 | 自前なら Restate 基盤とアプリ。Cloud でもアプリのホストは別途必要 | 単一バイナリで開始できるが、アプリ内の小さなライブラリ置換ではない |
| **Inngest** | 通常の関数コードの実行場所を維持しながら、進捗・待機・履歴を管理 | 関数コードのホスト。自己ホストなら Inngest 本体も運用 | 既定の自己ホスト構成は SQLite とメモリ内 Redis、その定期スナップショット。永続性の要件を別途確認する |
| **Trigger.dev** | タスクのビルド・配置・実行・ログなど。Cloud は実行環境も提供 | 自己ホストでは Webapp、Postgres、Redis、Supervisor、Runner 等 | **checkpoints / warm starts / autoscaling は公式比較表で Cloud 限定** |

DBOS の構成は [公式 architecture](https://docs.dbos.dev/architecture)、TypeScript の DB 条件は [公式 configuration](https://docs.dbos.dev/typescript/reference/configuration)による。Python の SQLite 対応とは分けて読む。DBOS Cloud はアプリのホスティングも提供するため、自前アプリ＋Postgresとは運用範囲が異なる。[DBOS Cloud](https://docs.dbos.dev/production/dbos-cloud/deploying-to-cloud/)

Restate の構成とホストの分担は [architecture](https://docs.restate.dev/references/architecture)と [hosting options](https://docs.restate.dev/hosting/overview)による。Inngest の通常の関数コードの実行場所は [platform overview](https://www.inngest.com/docs/platform-overview)、自己ホストの保存構成は [self-hosting](https://www.inngest.com/docs/self-hosting)による。Trigger.dev の実行モデルと機能差は [how it works](https://trigger.dev/docs/how-it-works)と [self-hosting overview](https://trigger.dev/docs/self-hosting/overview)による。

### 比較する順序

1. **DBOS を Temporal の対案に加える。** 一般的な業務処理に永続的な継続が必要な場合、ライブラリ＋Postgresという構成を比較できる。SQLite の維持が優先なら順位は下がる。
2. **Restate と Inngest は、実行制御を別の基盤に任せる方針の場合に比較する。** アプリの実行環境を残す場合の選択肢になる。自己ホスト可能というだけでは運用が軽いとは判断しない。
3. **Trigger.dev Cloud は、一般的なバッチの実行環境も任せたい場合に比較する。** 自己ホストを Cloud 同等の構成として見積もらない。

### どれを選んでも残る設計

- **長く待つ処理のコード更新。** DBOS は patch / versioning、Restate は実行を元の deployment に固定する方式を持つ。更新中の処理と旧版の扱いは残る。[DBOS upgrades](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)、[Restate versioning](https://docs.restate.dev/services/versioning)
- **外部書込みの整合性。** 処理の進捗保存と、外部 DB の書込みが一体になるとは限らない。同じ処理が繰り返された場合の意味はアプリが定める。[Restate and databases](https://docs.restate.dev/guides/databases)、[Inngest best practices](https://www.inngest.com/docs/durable-execution/best-practices)
- **業務台帳の正本。** 実行履歴と「誰が、どの版を承認したか」は目的が違う。DBOS の rewind や Restate の履歴保持期間を考えると、実行履歴をそのまま追記専用の業務台帳と扱わない方がよい、という設計上の判断になる。[DBOS management](https://docs.dbos.dev/typescript/tutorials/workflow-management)、[Restate retention](https://docs.restate.dev/services/configuration)

## 4. 前回の推奨から変わった点・変わらない点

**追加した推奨は、依存規則と未参照検出を既存ツールへ任せることの評価である。** これは設計の変更後に同じ問題が戻るのを防ぐ助けになる。コード行数の大幅削減を約束するものではない。

前回の A〜E、すなわち入力検査と保存の順序、閲覧と初期化の分離、イベント定義の一元化、現在状態と履歴の区別、コマンド別の入力条件という優先順位は変わらない。これらは module の interface に責任を集め、depth と locality を改善する仕事である。ライブラリを入れる前に、何の判断を一か所へ集めるかが必要になる。

比較の結果、すべてを追加する案は勧めない。既存機能と責務が重なる場合は、その重複を減らせるかで評価する。共通化の leverage は複数の実際の利用箇所で確認し、将来のためだけの adapter は増やさない。

## 5. 調査の限界

- ソースの静的な読取りと公式資料の調査を行った。今回追加した各ツールのインストール・実行、移行試作、テスト追加はしていない。
- 本番ランナー・本番 DB・非公開資料は操作も参照もしていない。
- Knip の検出数、依存の循環数、欠陥検出の増分、削減行数、性能、移行工数、サービス費用は未測定。導入効果として数値を推定しない。
- managed サービスの契約、データ配置、必要な保持期間、利用量に応じた費用、採用する SDK 版との互換性は未評価。
- 「候補として比較する価値」と「このリポジトリで効果を確認したこと」を区別した報告である。新たな削除対象や基盤移行を承認・決定した文書ではない。
