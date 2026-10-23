# 現行コードのスキル移管・削除候補

調査日: 2026-10-23。対象は `origin/main` の `174b703c939185bfd85b2308b482ab7a30804db1`（PR #479 後）。作業ツリーの追跡ファイルは同じ内容。

これは静的な呼出経路と責務の調査であり、本番での利用頻度の測定ではない。対象の実行、探索、検証は行っていない。実装は変更していない。本書は正本ではなく、SPEC・ADR の補助資料である。

## 結論と判断基準

残る移管候補は、前提の文章の解釈、対象別の設定選択、旧シナリオへの誘導である。重複の意味比較や報告文の執筆は既にスキル側にある。

分岐数だけを移管の基準にしない。

- 対象・設定・表現の追加ごとに例外を書く処理は、判断をスキルへ寄せる候補。
- ID、状態、上限、digest などの有限の契約を検査する処理は、分岐が多くてもコードに残す。
- 実装を廃止済みなのに選択肢だけ残った処理は、スキルへ移さず削除・簡素化する。
- スキル化しても毎回すべてのコードを書き直す必要はない。安定した機械処理は再利用する。

例えば 20 個の状態を処理する switch はコードに向く。一方、3 個しかなくても対象名や文章の言い回しで作業内容を選ぶ if は、対象が増えるたびに保守が増え得る。

## 優先する候補

以下のパスはリポジトリ相対。行番号は調査時点のもの。

| 優先度 | 現在の実装と根拠 | 推奨 | 残す責務・注意点 |
| --- | --- | --- | --- |
| 1 | `src/profiles/wordpress/lab/scenarios.ts:313` の `nextWordPressScenario`。前提文を 11 個の正規表現照合で読み、固定シナリオへ対応付ける。カタログには 13 種の版付き定義がある | 文章から作業を選ぶ責務はスキル側。旧選択器と、共有 Verifier 内の旧シナリオ誘導は廃止候補 | 単なるエラー理由の通知はコードに残す。`nextStep` という名前だけで一括削除しない |
| 1 | `src/profiles/wordpress/lab/wordpress-initialization.ts:267` から呼ぶプラグイン別の設定ファイル 8 本。`src/cli/wordpress-session.ts:110` の固有設定、`:115` の `scenarioId`、`:351` の対象固有説明文も同じ責務に依存 | 対象ごとに何を設定するかという判断を Harness に増やさない。固定シナリオと専用分岐は廃止候補 | 共通の環境初期化、実際の設定の記録、Snapshot との対応、隔離はコードに残す |
| 2 | `src/profiles/wordpress/verification/precondition-class.ts:20` の自然言語分類。定型文・管理者設定・通常利用を正規表現で区別し、`:57` からシナリオ選択器も呼ぶ | 意味解釈と制御が混在している設計見直し候補。ファイル全体をそのままスキルへ移す案は採らない | `src/profiles/wordpress/discovery/candidate-admission.ts:84` と共有 Verifier が使用。対象範囲の制限を AI の自己申告へ置き換えない。実装上の扱いは既存 #353 の残件 |
| 2 | `src/cli/wordpress-session.ts:209` は旧 `verifier` を必須とし、`:392` で旧経路を選べる。一方、実ホストの `src/cli/wordpress-host.ts:568` は必ずエラーを返す | 廃止済み実装を要求する共通の型と選択分岐の簡素化候補。スキル化の対象ではない | エラーを消して暗黙に別経路へ流す変更ではない。テスト用実装の利用が残るので、現在の参照を無視した一括削除はできない |
| 2 | `src/cli/wordpress-session.ts:73` は `discovery.lab: attached` を受理するが、実ホストの `src/cli/wordpress-host.ts:339` は初期化前に拒否 | 新規実行用の廃止済み設定選択肢を整理する候補 | 過去台帳の `attached` の読取は別の責務。旧記録の形式まで削除しない |
| 3 | `src/cli/index.ts:450` の旧 `incomplete(depth)` と `:451` の Lab 分類は常時表示。`:488` は旧比較 arm があれば表示 | 現行の既定表示を簡素化する候補。AI に移す必要はない | 過去の集計と履歴表示の価値は残る。表示を減らすことと計算・読取の削除を分ける |

候補 1〜3 は [ADR 0034](../adr/0034-harness-control-only-deletions.md) と [ADR 0035](../adr/0035-verification-as-a-skill.md) に既に記載された残件である。今回、新たな探索・再現方式は設計していない。

## 残る設定コードの量と依存

空行・コメントを含む物理行数を集計した。

| ファイル群 | 行数 |
| --- | ---: |
| `lab/scenarios.ts` | 397 |
| `lab/brizy-builder-page.ts` | 46 |
| `lab/brizy-file-attachment-form.ts` | 75 |
| `lab/relevanssi-search-index.ts` | 56 |
| `lab/simply-schedule-booking.ts` | 44 |
| `lab/user-registration-adapter.ts` | 26 |
| `lab/user-registration-membership-adapter.ts` | 58 |
| `lab/wp-members-adapter.ts` | 37 |
| `lab/wpdiscuz-adapter.ts` | 22 |
| 上記 9 本の合計 | 761 |

これは関連ファイルの規模であり、761 行を直ちに全部削除できるという見積もりではない。初期化・設定検査・テスト側にも関連コードがある一方、同じファイル群に履歴照合などの必要な責務も混じる。

- `scenarios.ts:224` は版と digest を確認する。定義の一部は設定スクリプトの digest に依存する。
- `scope-facts.ts:165` は Lab 記録のシナリオを照合している。これは既存記録の根拠にも関係する。
- `lab/provision-input.ts:72` は設定とシナリオの整合性を検査する。
- `lab/canary-placement.ts:6` もシナリオ側の関数を参照している。

したがって「旧 Verifier を削除したから、シナリオも未使用」とは言えない。呼出経路は残っている。

## コードに残す部分

| 機能 | 根拠 | 残す理由 |
| --- | --- | --- |
| 設定の形式・上限・組合せの検査 | `src/cli/wordpress-session.ts:118` | 設定値の案は変わっても、許容条件はコードが検査する |
| Snapshot と証拠の読込 | `src/snapshot/index.ts:157`、`src/infrastructure/private-artifact-store.ts:244` | 欠落、不整合、サイズ超過などを一貫して扱う |
| 読取専用の強制 | `src/infrastructure/private-artifact-store.ts:400` | スキルへの注意書きで代替しない |
| Provider のエラー区分への変換 | `src/discovery/claude-native-agent-runtime.ts:180` | 正規表現があっても有限の接続契約の処理。対象別の作業判断とは異なる |
| Finding のキーによる集約 | `src/ledger/finding-groups.ts:30` | 同じ入力から同じグループを作る計算 |
| 履歴検索 | `src/profiles/wordpress/wordfence-history/duplicate-lookup.ts:13` | 候補の抽出と鮮度検査。意味的な同一性の最終判断とは別 |
| 文案版・承認の対応付け | `src/review/index.ts:821`、`:1014`、`src/review/decision-history.ts:34` | 誤った版や別の Finding への承認流用を防ぐ |
| 台帳の集計と export | `src/ledger/index.ts:1085`、`src/review/export.ts:454` | 記録から確定した数値と材料を組み立てる |

隔離、権限制限、対象範囲、証拠に基づく判定の保証も引き続き Harness の責務である。長い関数を分ける内部整理と、スキルへの責務移管は別の判断になる。

## 既にスキル側のもの

公開情報との意味的な重複比較、提出先の提案、報告文の執筆は、それぞれ `.claude/skills/wbh-dedupe/`、`wbh-destination/`、`wbh-report/` にある。

`src/cli/index.ts:1466` の文案処理は、既に用意されたファイルを保存する。文章を書く実装ではない。これらを「今からスキル化すれば大きく削れるコード」と数えない。

## 削除状況

旧 `CodexVerifier` と専用テスト・実ホストの構築は PR #479 で削除済み。残る共有 `WordPressVerifier` は現行の受け渡しにも使われるため、名前だけで旧実装と判断しない。

シナリオ・分類・共有コードの残件は [Issue #353](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/353)。指定された移行の受入記録が揃ったとは扱わない。今回は候補の整理のみで、コード・設定・スキル本文・台帳は変更していない。
