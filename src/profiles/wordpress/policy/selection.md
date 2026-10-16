# WordPress 対象選定方針

正本の設定は [selection.json](selection.json)。`loadWordPressSelectionPolicy()` で読み込む。

- 本番の `candidateSource` は WordPress.org の人気順・タグ順を列挙する。取得元、観測時刻、応答 digest を記録し、取得不能・期限切れの一覧からは候補を採らない。`candidateSlugs` と `pinnedVersions` は開発対象を手動固定する旧形式として残す。両形式は union で分ける。選定の適格性と順序は `select(policy)` が機械的に決め、人間の対象承認は置かない。
- 本番の install 下限は正本の `minimumActiveInstallations`。programme scope の報奨下限とは別に適用する。 上限は `maximumActiveInstallations`（既定 1,000,000、同数以上を `above-installation-ceiling` で落とす）。所有者が 2026-10-16 に「数十万規模を主にする」と決めたもので、上限超えを公開記録の件数で候補に残す例外は #295。WordPress core 版は `wordpressVersion` で固定し、選ばれた対象の Snapshot を作ってから台帳に記録する。
- 選ばないもの：WordPress.org 非掲載、観測不能、観測期限切れ、配布停止。配布停止は理由コード `distribution-closed` で区別する。
- `excludedAuthors` は、公式プログラムの対象外資産（Automattic、Facebook、Google、SiteGround、Yoast）の作者を除く。WooCommerce 名義の plugin は Automattic 資産なので `WooCommerce` も入れる（2026-10-17。本番 batch 5 で google-listings-and-ads と woocommerce-payments が選ばれた抜けの修正）。作者情報が取れない対象は適格にしない。
- `excludedSlugs` には、作者名だけでは所有関係を断定できないものと、ベンダー側のweb serviceが無いと動かないものを手で入れる。後者はメタデータから機械的に判定できないため、タグからは推定しない。
- `maximumTargets` は週の対象数。`select` が台帳の過去選定と Finding を除いた候補をスコア順に補充して返す。`revisitPolicy` は版上昇・prompt 版変更時の再訪を指定するが、未公開 Finding がある対象は再訪しない。次の campaign は最新の選定バッチに固定された対象と Snapshot を使う。
- `maximumObservationAgeDays` と `maximumUpdateAgeDays` は別々の鮮度制限。Wordfence programme 方針の観測も `current` である必要がある。
- `surfaceTagWeights` は、WordPress.org の公開タグを攻撃面の弱い代理指標として採点する。タグがなければ 0 点。公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030）。
- `highThreatTags`、`surfaceTagWeights`、`scoreWeights.surface / highThreat` は旧方針の互換のためだけに読める。現行方針には無く、順位は install 数と更新の新しさだけで決める（ADR 0032 Q5）。候補タグは Wordfence ミラーと WordPress.org のタグから機械的に出した族で、採点には使わない（ADR 0032 Q3、docs/reviews/2026-10-13-selection-data.md）。
- `scoreWeights` を変えると、install 数と更新の新しさの寄与が変わる。スコア内訳、方針 digest、観測 ref は `TargetSelection` に残る。
- `runBudget` は旧方針の互換のためだけに読める。本番の run 数は campaign 設定の `stopRules.maxRuns` が決める（ADR 0032 Q6）。選ばれた対象を指名したタグは `candidateTag` に残り、半年後にタグ別の有償率を測る材料になる。
