# 技術採用と自作部分の整理：優先順位付きの推奨

2026-10-23、対象 cde675e。これまでの候補を統合した判断資料。ソース・依存関係・設定は変更していない。SPEC・ADR の改訂や採用の実施ではない。

具体的な置換対象は CLI、保存、閲覧、人間のレビュー記録、静的なコード管理である。実行基盤は一般的な帳票・承認処理として比較する。探索・再現の自動化を強める具体的な統合設計は含めない。

## 1. 推奨する構成

**実行時は Node 標準機能・SQLite・Zod を継続する。新規採用は、開発用の dependency-cruiser と Knip を段階的に進める。** それに先立ち、既存 Review / Ledger / CLI の責任分担を直す。

自作として残すのは、記録の意味、承認の対象、内容の同一性、過去形式との互換性である。引数解析、形式検査、SQL、ハッシュ計算、依存解析は既存技術に任せる。

新規 2 ツールは採用方針としての推奨であり、導入効果の確認済み判定ではない。現在の TypeScript / Node 構成との適合性と検出結果を確認してから、品質ゲートにする。Knip の結果を自動削除の承認にしない。

### CLI 自体は必要か

**CLI という操作方式は必須ではない。当面は必要な操作の薄い入口として残し、CLI の拡張には投資しない。** 人間レビューの操作先を別の UI にする選択が決まれば、CLI の表示・対話・引数処理は縮小または廃止できる。

ただし、現在の CLI 全体を不要と判定する根拠はない。次の依存を確認した。

| 確認した根拠 | 言えること／言えないこと |
| --- | --- |
| [package.json:6](/home/dev/wordpress-bounty-harness/package.json:6)の公開入口と [main.ts:6](/home/dev/wordpress-bounty-harness/src/cli/main.ts:6) | 現在の `harness` の入口は CLI |
| [レビュー手順:12](/home/dev/wordpress-bounty-harness/.claude/skills/wbh-review/SKILL.md:12)と [判断記録の手順:37](/home/dev/wordpress-bounty-harness/.claude/skills/wbh-review/SKILL.md:37) | 現行手順が CLI の出力・人間による記録に依存する。実行回数の証明ではない |
| [CI:32](/home/dev/wordpress-bounty-harness/.github/workflows/check.yml:32) | 配布した CLI の起動を検査する設定がある。全コマンドの必要性は示さない |
| [Review:190](/home/dev/wordpress-bounty-harness/src/review/index.ts:190)と [export:453](/home/dev/wordpress-bounty-harness/src/review/export.ts:453) | 保存・判断・データ生成は CLI とは別にも実装されている。CLI 形式に固定する必要はない |

追跡ソースの確認範囲では、人間レビューを同等に操作できる Web UI / HTTP API / MCP の公開入口は見つからなかった。補助スクリプトには別入口もあるが、レビュー全体の代替ではない。Git 外の起動設定・実行中プロセス・利用頻度は今回確認していない。

`src/cli/` は 7,998 行だが、引数解析や画面表示だけではない。状態の生成や処理の組立も含む。共通コマンド表は 79 行、`main.ts` は 68 行である。`index.ts` などにも表示・解析があるため、この 147 行が CLI 全体の量という意味でもない。

CLI を縮小する場合、[端末の対話:15](/home/dev/wordpress-bounty-harness/src/cli/main.ts:15)、[一覧表示:935](/home/dev/wordpress-bounty-harness/src/cli/index.ts:935)、[JSON 出力:1003](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1003)は操作方式に依存する。一方、[関連記録の順序:1076](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1076)は Review の責任として残す。フォルダごとの削除や、別ファイルへの移動を「8,000 行削減」と数えない。

したがって、先にレビューの処理を CLI から独立させる。そのうえでコマンドごとの必要性を判断する。別 UI の新設は、実際の使い勝手の要件が出た時点で比較し、今回の計画には追加しない。

## 2. 全候補の採否

| 候補 | 今の判断 | 引き受けてもらう責任／採用条件 |
| --- | --- | --- |
| Node `parseArgs` / `crypto` / `fs` | **継続採用** | 引数の字句解析、ハッシュ計算、通常のファイル操作 |
| SQLite / `node:sqlite` | **継続採用** | 台帳の保存・検索・制約。閲覧には既存の読取り専用接続を使う |
| Zod | **継続採用** | 入力・記録の形式検査。同じ契約を別々に定義しない |
| dependency-cruiser | **新規採用を推奨・開発用** | 依存方向・禁止 import・循環の検査。境界の規則は自作で定義 |
| Knip | **新規採用を推奨・開発用** | 未参照ファイル・export・依存の検出。入口・生成物の対応を確認して使う |
| fast-check | **条件付き採用** | レビュー記録の意味を定めた後、手書きの例だけでは確認しづらい組合せを補う |
| neverthrow | **条件付き採用** | まず既存 TypeScript で失敗の種類を整理。Result の合成が繰り返し必要なら検討 |
| ts-pattern | **条件付き採用** | 型定義を一元化した後も、複雑な条件の組合せが残る場合に限定 |
| Pino | **条件付き採用** | 人間操作の機械可読な診断ログが必要な場合。通常表示や台帳の代替にはしない |
| Commander | **当面不採用** | 現在の小さなコマンド共通処理を維持。ヘルプや階層化の自作負担が増えたら再評価 |
| XState | **当面不採用** | 現在状態と履歴の意味を先に整理。人間向け UI の状態表現が複雑になれば再評価 |
| Drizzle 等の ORM / Kysely 等のクエリビルダー | **当面不採用** | 現在の単一イベント表では置換の効果が限定的。関係表・検索・移行が保守負担になれば再評価 |
| Effect | **全面導入しない** | 型付きエラーだけのために処理全体の記述方式を変える根拠は不足 |
| BullMQ | **導入保留** | 独立した一般帳票などを別プロセスに配送する実要件ができた場合 |
| Temporal Cloud / 自己ホスト | **導入保留** | 一般的な長期業務処理の継続保証が必要になった場合。自己ホストは基盤運用も必要 |
| DBOS | **導入保留・Temporal の比較相手** | 一般業務の継続実行が必要で、TypeScript 版の Postgres 要件を受け入れる場合 |
| Restate / Inngest | **導入保留** | アプリの実行環境を維持し、進行管理を別基盤へ任せる方針になった場合 |
| Trigger.dev Cloud / 自己ホスト | **導入保留** | 一般バッチの実行環境まで任せる場合に Cloud を比較。自己ホストとの機能差も評価 |

既存の better-sqlite3 は公開履歴ミラー側で使用されている。台帳の `node:sqlite` と混同せず、今回の整理を理由に削除・統一しない。

技術仕様は [前回の採用比較](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-23-build-versus-buy-recommendation.md)と [追加 11 候補](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-23-additional-library-and-platform-options.md)の公式出典に基づく。dependency-cruiser の対象は [公式ルール資料](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)、Knip の入口・生成物の扱いは [公式 source mapping](https://knip.dev/features/source-mapping)でも確認した。Kysely は ORM ではなく [型付き SQL クエリビルダー](https://kysely.dev/)として区別する。

## 3. 設計変更と、置き換えるコードの優先順位

番号は推奨する着手順。1〜5 は既存技術を使った設計変更、6 はライブラリ置換、7 は検出の追加である。

### 1. 人間レビュー操作の検査・記録を Review に集める — Strong

**根拠:** [CLI:1076](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1076)で関連記録を書いた後、[CLI:1091](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1091)から判断を記録する。Review でも [メモ保存:439](/home/dev/wordpress-bounty-harness/src/review/index.ts:439)の後に [最終検査:450](/home/dev/wordpress-bounty-harness/src/review/index.ts:450)が来る。不正入力で部分的な記録が残る経路がある。実害の発生は未確認。

**変更:** CLI は入力・対話・表示を担当する。1 回のレビュー操作に含まれる全入力の検査と、関連記録の順序を既存 Review モジュールに集める。Zod は継続する。

**置換・移動:** CLI の複数の記録呼出を組み立てる部分を、Review 内の責任へ移す。記録機能自体は残す。ファイルを分割するだけで終えず、呼出側が保存順序を知る必要を減らす。

**完了条件:** 不正な理由・digest・記録者・メモで、台帳と新規保存物が増えない。正常時の関連記録の順序を保つ。入力検査後の I/O 障害は別問題であり、DB とファイルが一体のトランザクションになったとは扱わない。

### 2. 閲覧と初期化・書込みの入口を分ける — Strong

**根拠:** [CLI:1687](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1687)はコマンド解決前に状態を開く。[state.ts:27](/home/dev/wordpress-bounty-harness/src/cli/state.ts:27)がディレクトリを作り、[Ledger:771](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:771)が書込み可能な DB を開いてテーブルを作る。

**変更:** まずコマンドを確定し、必要な読取り・書込み能力だけを渡す。閲覧は保存先作成や DDL を伴わない入口にする。SQLite と現在の保存形式は維持する。最低対応版の Node にも [readOnly 接続](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html#new-databasesynclocation-options)がある。

**置換・移動:** 無条件の `openState` 呼出を見直す。初期化処理は必要な書込み側へ残す。Ledger の保存処理全体を ORM に交換する変更ではない。

**完了条件:** 不正コマンドや閲覧が新しい保存先を作らず、既存 DB の構造を変更しない。書込みを許されない保存先からも既存の記録を閲覧できる。

### 3. イベント種別の二重列挙をなくす — Strong

**根拠:** [イベント定義:141](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:141)にある種別が、[検索用の別列挙:665](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:665)にはない。型と実行時検査が食い違う。

**変更:** イベント契約を正本にし、記録可能な種別と検索で受理する種別を同じ定義から扱う。既存 Zod を使う。

**置換:** 検索スキーマ内の手書き `z.enum` の種別一覧を置換する。版付きイベントスキーマや検索処理自体は残す。

**完了条件:** 契約で定義した全種別を検索条件に使え、不明な種別を拒否する。過去のイベントを引き続き読める。

### 4. 現在状態と履歴の導出を整理する — Worth exploring

**根拠:** [Review:331](/home/dev/wordpress-bounty-harness/src/review/index.ts:331)は現在有効な判断を扱う。[export:676](/home/dev/wordpress-bounty-harness/src/review/export.ts:676)は履歴上の最後の判断を読む。両者には意図の異なる値がある。

**変更:** 現在有効な判断、最後の歴史的判断、現在値、累計を明示的に区別する。同じ意味の導出だけを Review / Ledger に集め、表示側は必要な意味を選ぶ。

**置換・整理:** export やレポート側で同じ意味を再計算している箇所があれば置換する。現在と履歴の出力を一律に揃えず、既存の export 契約を黙って変更しない。新しい集計 DB は作らない。

**完了条件:** 過去判断の表示と現在判断の失効を、合成した記録で両方確認できる。同じ名前・同じ意味の指標は表示先によらず一致する。

### 5. コマンド別の入力契約を明確にする — Worth exploring

**根拠:** [command-table.ts:49](/home/dev/wordpress-bounty-harness/src/cli/command-table.ts:49)は全コマンドの引数を合成する。[CLI:1700](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1700)はコマンド別の検査なしに型変換して渡す。

**変更:** `parseArgs` は字句解析として残す。各コマンドが受理する引数と組合せを、状態を開く前に確定する。入力契約はコマンド宣言と離して重複保守しない。

**置換・整理:** 型変換に頼る受渡しと、全フラグを受理可能とする経路を整理する。[共通処理 79 行](/home/dev/wordpress-bounty-harness/src/cli/command-table.ts:1)を理由に Commander を追加しない。将来 Commander を選ぶ場合も置換対象は引数解析・ヘルプ等であり、CLI 全体約 8,000 行ではない。

**完了条件:** 別コマンド用の引数や不正な組合せを、書込み前に拒否する。正常な呼出・終了コード・ヘルプの互換性を確認する。

### 6. 依存解析を dependency-cruiser に任せる — Worth exploring

**根拠:** [module-boundary.test.ts:30](/home/dev/wordpress-bounty-harness/tests/architecture/module-boundary.test.ts:30)では import 文字列の抽出と参照先判定を自作している。

**変更・置換:** この解析部分を dependency-cruiser と宣言した規則へ置換する。規則は既存 ADR の依存方向を維持するものとし、新しいモジュール分割を先回りして作らない。

**残すもの:** [固有語の検査:48](/home/dev/wordpress-bounty-harness/tests/architecture/module-boundary.test.ts:48)と、そのためにも使うファイル読取り処理は残る。依存図だけでは固有語の検査を代替できない。

**完了条件:** 現在の構成を正しく解析し、既存の禁止依存を検出できる。型だけの依存と実行時依存を区別する。実際に循環があるという診断はまだしていない。

### 7. 未参照の検出を Knip に任せる — Worth exploring

**変更:** [CLI の dist 入口](/home/dev/wordpress-bounty-harness/package.json:6)、ビルド設定、補助スクリプト、テスト、[列挙で配布する資産](/home/dev/wordpress-bounty-harness/scripts/copy-assets.mjs:8)を確認し、検出結果を棚卸しに使う。

**置換対象:** 本体コードを直接置換するものではない。手作業で繰り返していた参照関係の調査を補助する。未使用変数の TypeScript 検査も維持する。

**完了条件:** 既知の入口と必要な資産を見落とさず、検出結果を説明できる。「未参照」「テストからのみ参照」「到達可能だが利用実績なし」「機能として不要」を別々に扱う。後二つは Knip だけでは判定できない。

## 4. 自作として残すもの

| 自作で維持する契約 | 既存技術に任せる処理 | 根拠 |
| --- | --- | --- |
| 何を同一内容とみなすか、digest の対象となる byte 形式 | ハッシュ計算は Node crypto | [content-digest.ts:3](/home/dev/wordpress-bounty-harness/src/infrastructure/content-digest.ts:3)、[canonical-json.ts:5](/home/dev/wordpress-bounty-harness/src/infrastructure/canonical-json.ts:5) |
| 追記専用、同じ identity の同一内容は既存扱い、異なる内容は競合 | SQLite の制約・SQL・トランザクション | [Ledger:797](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:797) |
| 保存物の識別、manifest、解決時の整合性、過去形式 | 通常のファイル操作は Node fs | [PrivateArtifactStore:185](/home/dev/wordpress-bounty-harness/src/infrastructure/private-artifact-store.ts:185) |
| 人間の判断がどの記録に対して有効か、過去判断をどう読むか | Zod 検査、SQL による読取り | [Review:331](/home/dev/wordpress-bounty-harness/src/review/index.ts:331)、[旧記録 reader:164](/home/dev/wordpress-bounty-harness/src/review/records.ts:164) |
| 正確な候補・文案版・送信先・記録者と承認の結び付き | 形式検査と保存 | [承認契約:60](/home/dev/wordpress-bounty-harness/src/review/records.ts:60)、[対象照合:806](/home/dev/wordpress-bounty-harness/src/review/index.ts:806) |
| モジュールが何に依存してよいか | 依存解析は dependency-cruiser | [ADR 0011](/home/dev/wordpress-bounty-harness/docs/adr/0011-target-specific-code-lives-in-a-profile.md) |

独自契約を残すことと、今の配置や実装を全部残すことは違う。たとえば Review の契約は残し、CLI に分散した記録順序の判断を戻す。既存の canonical JSON を交換すると保存済み digest が変わり得るため、似た機能のライブラリへの単純置換は勧めない。

## 5. 設計の到達点と評価方法

CLI は入力・表示の adapter、Review は人間のレビュー操作、Ledger は記録の保存と読取りの意味を受け持つ。既存モジュールの interface に順序や検査を集め、呼出側が知るべき規則を減らす。新たな汎用の基盤を重ねる計画ではない。

設計語彙では、既存の seam で責任を閉じ、depth と locality を改善する。共通の読取りは同じ意味を必要とする利用箇所にだけ leverage をもたらすようにする。モジュールを小さく分割すること自体を成果にしない。

優先順位 1〜5 は [薄い CLI の ADR 0008](/home/dev/wordpress-bounty-harness/docs/adr/0008-strict-typescript-modular-monolith-with-thin-cli.md)と [単一台帳の ADR 0005](/home/dev/wordpress-bounty-harness/docs/adr/0005-single-append-only-ledger-gated-by-snapshot-digest.md)に沿う責任整理である。記録形式や業務上の意味を変える必要が出た場合は、別の設計判断として扱う。

Temporal 等を保留する理由は、現在確認した問題が入力検査・保存順序・履歴解釈だからである。一般業務で長い待機・継続の保証が必要になった段階では、Temporal と DBOS をまず比較する。DBOS の TypeScript 版は [Postgres を要求する](https://docs.dbos.dev/typescript/reference/configuration)。Restate / Inngest / Trigger.dev は実行場所と運用の分担が異なる比較相手であり、台帳の意味を代わりに定義するものではない。

成果は、不正入力で記録が残らないこと、閲覧で書込み権限を要しないこと、イベント追加時の定義箇所が減ること、同じ意味の表示が食い違わないこと、未参照コードを説明できることによって測る。

## 6. 未確認事項

- 追加ツールは未導入・未実行。互換性、誤検出、実行時間は未確認。
- ソース読取りと公式資料の確認のみ。アプリ・テスト・本番ランナーは動かしていない。
- 行数の純減、移行工数、製品費用は未算定。責任移動をコード削除と数えない。
- 以前の削除候補の見積もりと、この設計変更の効果を足し合わせない。
- この採否は、実装全体約 44,000 行が必要または適切に設計されているという保証ではない。
