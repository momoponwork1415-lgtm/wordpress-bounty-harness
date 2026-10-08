# WordPress 対象選定方針

正本の設定は [selection.json](selection.json)。`loadWordPressSelectionPolicy()` で読み込む。

- `candidateSlugs` は今回観測する WordPress.org 掲載対象の候補集合。最初の縦断スライスでは手動 pin で設定できる。`pinnedVersions`（任意、slug → 版）を書くと、その候補は観測した最新版ではなく指定版で選ばれる。pin した slug は `candidateSlugs` に含める。pin は方針 digest に入る。選定の適格性と順序は `select(policy)` が機械的に決め、人間の対象承認は置かない。
- `minimumActiveInstallations` の既定は 500。対象種別ごとの厳密な閾値は、後段の programme scope 評価で適用する。
- 選ばないもの：WordPress.org 非掲載、観測不能、観測期限切れ、配布停止。配布停止は理由コード `distribution-closed` で区別する。
- `excludedAuthors` は、公式プログラムの対象外資産（Automattic、Facebook、Google、SiteGround、Yoast）の作者を除く。作者情報が取れない対象は適格にしない。
- `excludedSlugs` には、作者名だけでは所有関係を断定できないものと、ベンダー側のweb serviceが無いと動かないものを手で入れる。後者はメタデータから機械的に判定できないため、タグからは推定しない。
- `maximumTargets` は週の対象数。`select` が、スコア順の上位からこの数だけ返す。
- `maximumObservationAgeDays` と `maximumUpdateAgeDays` は別々の鮮度制限。Wordfence programme 方針の観測も `current` である必要がある。
- `surfaceTagWeights` は、WordPress.org の公開タグを攻撃面の弱い代理指標として採点する。タグがなければ 0 点。既知脆弱性の件数や内容は、選定にも採点にも使わない。重複リスクで重み付けもしない（重複かどうかは提出時に人間が照合する）。
- `highThreatTags` のいずれかを持つ対象は High Threat の攻撃面（未認証で届くファイル操作、option更新、認証処理）を持つとみなす。`scoreWeights.highThreat` を1回だけ加点し、`highThreatSurface` に記録する。Wordfence では、これらの種別が25件以上で報奨対象になる。
- `scoreWeights` を変えると、install 数、更新の新しさ、公開タグ、High Threat の寄与が変わる。スコア内訳、方針 digest、観測 ref は `TargetSelection` に残る。
- `runBudget` は対象ごとの discovery run の上限。High Threat の攻撃面を持つ対象は `highThreat`、それ以外は `default` を使う。campaign 設定の `stopRules.maxRuns` は安全上の上限で、実際の上限は2つの小さいほう。
