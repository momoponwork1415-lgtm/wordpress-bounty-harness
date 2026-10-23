# レビュー・保存・CLI・静的解析の責任整理

2026-10-23。PRの基点は `main` の `5e4de0e0887fa5b7e18d3dd61ce213079f9f5f38`、ブランチは `codex/review-storage-refactor`。前回の採用比較で推奨した7項目を実装した記録。SPEC・ADRの代替ではない。

変更は専用worktree `/home/dev/.codex/worktrees/review-storage-refactor/wordpress-bounty-harness` で実施した。本番の台帳・Private Evidence・ランナーへの接続や実行は行っていない。マージと本番反映は今回の依頼の対象外。

当初の基点 `cde675e` は未マージの別PRを含んでいたため、PR作成前に最新mainへ合わせた。mainに追加された、人間の最終査読・承認者の指定・AI暫定文案の既定値を保持した。人間の所要時間や再現結果を伴う操作では、Reviewも記録者を検査する。

## 実装した7項目

| 項目 | 実装と効果 | 主な変更先 |
| --- | --- | --- |
| 1. 人間レビュー操作の集約 | `Review.recordDecision` が判断・重複照合メモ・人間の再現記録・所要時間を先に検査する。CLIが複数の保存APIの順序を組み立てる必要をなくした。既存の `decide` も保存前に検査する | `src/review/index.ts`、`src/cli/index.ts` |
| 2. 閲覧と初期化の分離 | コマンドと入力を確定してから状態を開く。閲覧専用コマンドはSQLiteのreadOnly接続を使い、保存先やテーブルを作らない。readOnlyのLedgerは追記を拒否する | `src/cli/state.ts`、`src/ledger/index.ts` |
| 3. イベント種別の一元化 | 検索条件の種別を `ledgerEventV1Schema` から導出し、手書きの別一覧を削除した | `src/ledger/index.ts` |
| 4. 現在と履歴の区別 | 判断履歴を読む処理を共通化し、現在有効な判断の条件を明示した。queueでの失効とexportの最後の歴史的判断を維持した | `src/review/decision-history.ts`、`src/review/export.ts` |
| 5. コマンド別の入力契約 | 各コマンドの宣言からNode `parseArgs` で再検査し、他コマンドのフラグ・必須欠落・空文字・余分な位置引数・不正な組合せを状態作成前に拒否する | `src/cli/index.ts` |
| 6. 依存解析の置換 | importを抽出する独自の正規表現をdependency-cruiserへ置換。禁止依存はエラー、実行時循環は診断。固有語検査は維持した | `.dependency-cruiser.json`、`tests/architecture/module-boundary.test.ts` |
| 7. 未参照の診断 | Knipの通常／productionコマンドを追加。CLI・別プロセスの入口・補助スクリプト・テスト・distとsourceの対応を設定した | `knip.jsonc`、`package.json` |

CLIは現在の操作入口として残す。引数・対話・表示をCLIに置き、レビューの記録順序をReviewへ移した。Temporalなどの実行基盤、条件付き採用だったライブラリは前回の保留判断を維持する。

## 互換性と制限

- 正常なレビュー操作の関連イベント順は、人間の再現記録 → その所要時間 → 判断 → 読む所要時間のまま。保存形式・digestの計算方法・過去イベントは変更していない。
- 閲覧専用は `review`、`review parked/export/dedupe/held`、`ledger funnel/stops/resumes/usage/runtime`、`history status`、`continuous status`。既存DBを読む。DBが存在しなければエラーを返し、自動初期化しない。変更操作も併せ持つコマンドのアクセス方式は別である。
- 不正なCLI入力の拒否を早めた。設定ファイルや保存済み記録との照合など、入力だけでは判断できない検査は各モジュールに残る。
- 全入力を検査してから保存するが、DBとPrivate Evidenceを一体のトランザクションにはしていない。検査後のI/O障害や競合では部分的な記録が残り得る。
- 現在有効な判断の定義は、最新の検証イベントより後に追記された判断という従来の規則。exportは失効した判断も最後の履歴として表示する。
- dependency-cruiser 18.7.0はTypeScript 7のcompiler APIに未対応だった。ビルド用TS7.0.2を維持し、解析器にだけTS6.0.3を間接依存として固定した。全TSファイルが解析されたかテストし、0件解析の成功を防ぐ。

静的解析の運用・互換性・限界は [static-analysis.md](../agents/static-analysis.md) に記載した。

## 検証

Node 22.22.2、pnpm 10.33.0で確認した。

- `env -u WBH_REAL_LAB_IMAGES pnpm check`：成功。型検査・整形検査・全テストの品質ゲートを実行した。
- 最新mainとの統合後は、テストファイル124件成功・1件skip、テスト1,188件成功・1件skip。テスト実行部分は17.40秒。
- skipは実Lab用イメージの明示設定を必要とする既存の統合テスト。今回その環境を設定せず、実Labや本番を起動していない。
- `pnpm build`、`git diff --check`：成功。
- 回帰テストは合成台帳とテキストartifactで実施。不正な判断理由・digest・記録者・メモで保存物が増えないこと、正常時の記録順、閲覧でDBのbytes・mtime・schemaが変わらないことを確認した。
- 依存解析は合成コードで型import・再export・dynamic importの禁止を検出し、実行時循環と型のみ／型混在の循環を区別した。
- CLIの追加回帰テストは56件。AIの判断への人間工数・再現の付与と、承認者未指定も状態作成前に拒否する。Reviewにも同じ記録者の条件を確認する試験を追加した。

## Knipの棚卸し結果

| 観測対象 | 通常 | production |
| --- | ---: | ---: |
| 未参照export | 73 | 122 |
| 未参照の公開型 | 89 | 102 |
| 重複export | 1 | 1 |
| 未参照ファイル | 0 | 0 |
| 未参照依存・未宣言依存・未解決import | 0 | 0 |

両モードとも診断があるため終了コードは1。Knipは `pnpm check` とは別の診断コマンドとして実行する。exportの未参照は関数本体が不要という意味ではなく、機能の利用頻度も示さない。候補は削除せず残した。

## コード量

最新mainからの `src/` の差分は追加513行・削除222行、**純増291行**。新規 `decision-history.ts` を含み、テスト・設定・lockfile・文書は含めない。CLIの `index.ts` は1,734行から1,903行。レビューの保存呼出しは減ったが、状態を開く前の入力契約と検査が増えたためである。

今回の効果は、書込み前の検査、閲覧の非破壊性、定義の一元化、責任の移動、参照関係の検出で評価する。機能の削除による行数削減は今回行っていない。

残る設計上の問題は [追加評価](2026-10-23-remaining-review-design-issues.md) にまとめた。
