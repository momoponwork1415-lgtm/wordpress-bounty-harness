# 既存技術へ任せる範囲と、設計を直す範囲の推奨

2026-10-23。調査対象は cde675e。ソース・依存関係・設定は変更していない。この文書は判断用の報告であり、SPEC や ADR の改訂ではない。

具体的な提案は CLI、保存、集計、人間のレビュー記録に限定する。Temporal 等は一般的な帳票・承認処理の基盤として比較した。自律的な脆弱性探索・再現を強化する統合設計は含まない。そのため、実装全体 44,374 行の置換可能性を判定した資料ではない。

## 1. おすすめ

**この範囲では、新しい基盤の追加より、既存の Node 標準機能・SQLite・Zod を使う責任分担を直すことを勧める。** 自作として残すのは記録の意味、同一性、承認の条件、過去形式との互換性である。汎用の入力解析・検査・DB・ハッシュ計算は既存実装へ任せる。

Temporal は長時間処理の進行管理を外へ任せる選択肢になる。ただし、今回確認した入力検査・保存順序・履歴解釈の問題を解消するための導入は勧めない。一般的な帳票・人間承認の用途でも、継続実行の要件と運用責任が確定してから再評価する。

この判断は、今後もすべての仕組みを自作するという意味ではない。任せる責任が明確な場合に置換し、既存処理を残したまま同じ責任の基盤を重ねないという方針である。

## 2. 何を任せ、何を残すか

| 責務 | 任せる先・推奨 | 自作として残すもの | コード上の根拠 |
| --- | --- | --- | --- |
| CLI の字句解析 | 現行の Node parseArgs を継続 | コマンドごとの受理条件、対話、表示。保存の業務順序は CLI から外す | [引数解析](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1681)、[共通表 79 行](/home/dev/wordpress-bounty-harness/src/cli/command-table.ts:1) |
| 入力・記録の形式検査 | 現行の Zod を継続し、定義を再利用 | 何を有効とするか、いつ検査するか、旧形式の読み方 | [レビュー記録スキーマ](/home/dev/wordpress-bounty-harness/src/review/records.ts:105)、[イベント契約](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:33) |
| DB の保存・検索・読取り権限 | 現行 SQLite と node:sqlite を継続 | 追記専用、同一記録の再投入、異なる内容の競合、証拠参照の意味 | [DB 構造](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:774)、[重複・競合](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:797) |
| ハッシュ計算・通常のファイル操作 | 現行 Node crypto / fs を継続 | digest の対象になる byte 形式、保存内容の識別、整合性、旧形式互換 | [ハッシュ計算](/home/dev/wordpress-bounty-harness/src/infrastructure/content-digest.ts:1)、[保存形式](/home/dev/wordpress-bounty-harness/src/infrastructure/canonical-json.ts:5) |
| 人間のレビュー判断と関連記録 | 既存 Review の内部へ責任を集める | 判断の対象、文案版・送信先と承認の結び付き、記録の順序 | [判断](/home/dev/wordpress-bounty-harness/src/review/index.ts:405)、[承認](/home/dev/wordpress-bounty-harness/src/review/index.ts:796) |
| 現在状態・履歴・集計 | 明示的な TypeScript の読取り処理として整理 | 現在有効な判断と過去の判断、累計と現在値の区別 | [現在判断](/home/dev/wordpress-bounty-harness/src/review/index.ts:331)、[履歴表示](/home/dev/wordpress-bounty-harness/src/review/export.ts:676) |
| 一般的な帳票・承認処理の永続的な進行管理 | 現時点では基盤を追加しない。必要時に Temporal / BullMQ を比較 | 処理の意味、許可、業務記録、再実行時の整合性 | 製品比較は次節。現行用途での移行検証は未実施 |

Ledger は 1,905 行だが、イベント契約が約 482 行を占める。DB 構造はイベント表 1 つと索引である。ORM に移すだけで大部分を消せる構造ではない。台帳は Node 標準の node:sqlite を使用し、better-sqlite3 は公開履歴ミラー側で使用している。

## 3. 技術の比較と採否

以下の採否は、上記の CLI・保存・人間レビューと一般的な帳票処理に対する判断である。

| 選択肢 | 得られるもの | 増える負担・残る責任 | 今の判断 | 再評価する条件 |
| --- | --- | --- | --- | --- |
| Node 標準＋SQLite＋Zod | 既存契約を保ちながら、入力検査・保存・閲覧を整理できる | アプリ固有の記録と状態の意味は自分で定義 | **継続を推奨** | 複数ホストからの保存、書込み競合、複雑な関係表など、現方式の制約が実測される |
| Commander | コマンド階層、コマンド別の引数、ヘルプ、基本的な入力条件 | 宣言と業務処理は残る。既存の引数・終了コード・利用手順の移行確認 | **採用保留** | 必要なヘルプ・ネスト・補完のために独自 CLI 機構を増やし始める |
| XState | 状態・イベント・許可する遷移を明示し実行する | 保存の時点・保存先・旧状態互換・副作用との整合性 | **採用保留** | 人間向け UI の階層・並行状態が増え、状態機械の方が関係者に理解・検査しやすいと確認できる |
| Drizzle 等の ORM | 表・列・検索の型、スキーマ・移行の管理 | イベント JSON の意味、追記専用制約、証拠整合性、集計定義は残る | **現在の台帳には導入しない** | 複数の関係表や頻繁な DB 構造変更が主要な保守負担になる |
| BullMQ | ジョブ配送、待ち行列、遅延、再試行、親子ジョブの依存関係 | DB・Worker 運用、ジョブの重複対策、業務全体の記録 | **現在の記録整理には導入しない** | 独立した帳票作成などを受付と分離し、別プロセスへ配送する実要件がある |
| Temporal Cloud | 一連の処理の進捗保存、長い待機、停止をまたぐ継続。Temporal 側の基盤運用 | アプリの Worker、業務記録、重複対策、Workflow の版管理、費用・データ配置の判断 | **条件付きの比較候補** | 一般的な承認・帳票処理の継続を業務上保証する必要があり、任せる責任と残す責任が明確になる |
| Temporal 自己ホスト | 同じ実行モデルを自分の運用環境に置ける | 上記に加え Temporal 本体・DB・監視・更新・可用性の運用 | **保守負担削減の初手には勧めない** | 自己ホストが必須で、その運用を引き受ける理由・体制がある |

Commander の機能は [公式 README](https://github.com/tj/commander.js#readme)、XState の役割は [公式概要](https://stately.ai/docs/xstate)、永続化の責任は [公式説明](https://stately.ai/docs/persistence) による。XState の調査時の文書には v6 alpha 表示がある。採用時には安定版と対応する資料を別途固定する。

Drizzle が提供する表・スキーマの管理は [公式資料](https://orm.drizzle.team/docs/sql-schema-declaration) による。BullMQ は単発ジョブだけでなく [Flows](https://docs.bullmq.io/guide/flows/) を持つ。現行資料には既定の Redis に加えて [PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) もあるため、Redis 必須とは扱わない。

## 4. Temporal の評価で分けること

Temporal の復元対象は Workflow の進捗である。プロセスやファイル・外部 DB の状態全体を元に戻す仕組みではない。[Workflow Execution](https://docs.temporal.io/workflow-execution)

外部処理が成功しても、その完了報告前に停止すれば再実行され得る。同じ操作を繰り返しても二重反映しない設計は、利用側に残る。[Activity Definition](https://docs.temporal.io/activity-definition)

進行中の処理が実装変更をまたぐため、履歴と整合する振る舞いと版管理が必要になる。「頻繁に変えたので複雑になった」という問題が、導入だけでなくなるわけではない。[Workflow Definition](https://docs.temporal.io/workflow-definition)

Cloud でもアプリの Worker は利用側が運用する。自己ホストでは基盤と DB も運用対象になる。[本番構成](https://docs.temporal.io/production-deployment)、[自己ホストの保守](https://docs.temporal.io/self-hosted-guide/production-checklist)

業務台帳と実行履歴は別の責任である。現在の「誰が、どの版を、どの送信先に対して承認したか」や保存内容の digest は、自作の契約として残す。Temporal 導入によって台帳全体を捨てる提案はしない。基盤の内部履歴が増えること自体を ADR 違反とは断定しないが、同じ業務記録の正本を二つにしない責任分担が必要になる。[ADR 0005](/home/dev/wordpress-bounty-harness/docs/adr/0005-single-append-only-ledger-gated-by-snapshot-digest.md)

## 5. 設計を直す具体的な順番

### A. レビューの入力検査を、すべての記録より前に置く — Strong

**現状:** [CLI の付随記録](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1076)が、[Review の最終検査](/home/dev/wordpress-bounty-harness/src/review/index.ts:450)より先に走る。Review 内の [照合メモ保存](/home/dev/wordpress-bounty-harness/src/review/index.ts:439)も検査より前である。不正入力で一部の記録だけ残る経路がある。実害の発生は未確認。

**推奨:** CLI adapter は入力と表示を受け持つ。1 回のレビュー操作としての検査・関連記録の順序は、既存 Review module の interface 内へ集める。Zod を追加するのではなく、使う場所を正す。既存 seam で責任が閉じ、depth と locality が改善する。

**受入条件:** 理由、digest、記録者、メモなどが不正なら、台帳も新規の非公開資料も増えない。正常時の記録順序は維持する。入力検査後の I/O 障害で何が残るかは別の問題として明記する。DB とファイル保存全体の原子性が得られたとは主張しない。

### B. 閲覧と初期化・書込みの入口を分ける — Strong

**現状:** [コマンド解決前](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1687)に状態を開き、[ディレクトリ](/home/dev/wordpress-bounty-harness/src/cli/state.ts:27)と [テーブル](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:771)を作る。閲覧だけでも同じ入口を通る。

**推奨:** コマンドを確定してから必要な能力だけを渡す。閲覧は初期化を伴わない入口にし、書込みは別の入口にする。Ledger module の interface の副作用を明確にする。実際の読取り専用接続は Node の既存機能に任せる。最低対応版 Node 22.13.0 にも [readOnly がある](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html#new-databasesynclocation-options)。

**受入条件:** 不正コマンドや閲覧で存在しない保存先を作らない。既存 DB のスキーマを変更しない。読取り専用の保存先でも閲覧できる。正常な書込み操作は従来の契約を維持する。

### C. イベント種別を一つの定義から扱う — Strong

**現状:** [イベント定義](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:141)にはある種別が、[検索用の手書き列挙](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:665)にはない。型では指定できても実行時に拒否する。

**推奨:** イベント契約を正本にし、検索用の受理種別を別に保守しない。既存 Zod の定義を活用する。新しいスキーマ基盤や ORM は不要。同じ記録知識が一つの module に集まり、locality が改善する。

**受入条件:** 定義した全種別が検索用の検査も通り、不明な種別は拒否する。旧イベントの読取りを維持する。

### D. 現在状態・履歴・集計の意味を整理する — Worth exploring

**現状:** [レビュー列](/home/dev/wordpress-bounty-harness/src/review/index.ts:331)は現在有効な判断を返す。[export](/home/dev/wordpress-bounty-harness/src/review/export.ts:676)は最後の歴史的判断を返す。この違いは維持すべき意味であり、両者の出力を同じにすれば直る問題ではない。

また [Ledger の保留数](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1494)は後の正規化で解除するが、[レポートの集合](/home/dev/wordpress-bounty-harness/scripts/report-rediscovery-cases.mjs:60)は解除しない。現在値と累計なら名前を区別し、同じ意味なら計算を共有する。

**推奨:** 現在判断、履歴上の判断、照合記録を区別する。既存の Review / Ledger module に各意味の導出を集め、表示側は必要な意味を選ぶ。新しい汎用イベント基盤や第二の集計 DB は作らない。意味が同じ読者にだけ leverage を生む共通化にする。

**受入条件:** 合成した過去記録から、現在判断の失効と過去判断の表示を両方確認できる。現在保留中と過去保留件数を区別できる。意味が同じレポート間では値が一致する。公開済みの export の意味は黙って変えない。

### E. コマンドごとの引数契約を明確にする — Worth exploring

**現状:** [共通表](/home/dev/wordpress-bounty-harness/src/cli/command-table.ts:49)は全コマンドの引数を合成し、[dispatch](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1700)はコマンド別の検査をせずに型を変換して渡す。別コマンド向けの既知引数が受理され得る構造である。

**推奨:** 現行の小さな共通処理を維持し、各コマンドで何を受理するかを明示する。Commander は、この先に独自の CLI 機能を増やす必要が出た場合の adapter 候補とする。

**受入条件:** 無関係な引数と不正な組合せを状態の書込み前に拒否する。ヘルプ・終了コード・既存の正常な呼出との互換性を確認する。

## 6. 自作として残す理由

自作部分はすべて悪いわけではない。現在の [digest による識別](/home/dev/wordpress-bounty-harness/src/infrastructure/content-digest.ts:4)は、ハッシュの実装を Node に任せ、アプリの識別規則だけを定義している。この分け方を維持する。

[canonical JSON](/home/dev/wordpress-bounty-harness/src/infrastructure/canonical-json.ts:5)には過去の保存形式が二つあり、既存 ID がそれに依存する。似た名前のライブラリへ差し替えて byte 列が変わると、保存済み参照の意味を変えてしまう。ライブラリ化による省力化より、互換性の責任が大きい。

[PrivateArtifactStore](/home/dev/wordpress-bounty-harness/src/infrastructure/private-artifact-store.ts:185)は、通常のファイル保存に加えて、内容の識別、manifest、整合性、競合を扱う。この契約は残す。物理保存先の交換が必要になった場合も、契約ごと削除する根拠にはならない。

同様に、人間の判断がどの版に対して有効か、承認した文案版と送信先は何か、という意味はアプリが定義する。Temporal、XState、ORM のいずれも、その正しさを代わりに決めるものではない。

## 7. 実施を判断する単位と未確認事項

おすすめの順は A → B → C → D → E。まず入力と記録の整合性を直し、次に閲覧の副作用を外し、その後に重複した知識を整理する。それぞれ独立して差分と結果を確認できる単位にする。巨大ファイルを分割しただけの変更を完了とはしない。

A〜E は既存 [ADR 0008 の薄い CLI](/home/dev/wordpress-bounty-harness/docs/adr/0008-strict-typescript-modular-monolith-with-thin-cli.md) と [ADR 0005 の単一台帳](/home/dev/wordpress-bounty-harness/docs/adr/0005-single-append-only-ledger-gated-by-snapshot-digest.md) に沿う。業務上の意味や正本の変更が必要になった場合は、その時点で別の設計判断として明示する。今回、ADR や SPEC は変更しない。

効果は行数だけで測らない。不正入力での部分記録がなくなるか、閲覧で書込み能力を要しなくなるか、イベント追加で直す列挙が一つになるか、同じ指標が表示先で食い違わないかを確認する。

- ソース・テスト・関連 ADR と公式資料を読んだ。コード・依存関係・設定は変更していない。ランナーは操作せず、本番 DB・非公開資料も参照していない。
- 調査対象ファイルの読取りは行ったが、テスト実行、移行試作、性能測定は行っていない。
- 製品の特徴からの採否判断であり、このリポジトリでの移行成功を確認した結果ではない。
- 行数の純減、移行工数、運用費用は未算定。以前の削除候補の約 1,500〜1,900 行と、今回の設計変更の効果を足し合わせない。
- 全体の自律的な探索・再現の実行基盤を選定した資料ではない。この範囲の結論を、その部分の採否に拡張しない。
