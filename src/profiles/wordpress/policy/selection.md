# WordPress 対象選定方針

正本の設定は [selection.json](selection.json)。`loadWordPressSelectionPolicy()` で読み込む。

- `candidateSlugs` は今回観測する WordPress.org 掲載対象の候補集合。最初の縦断スライスでは手動 pin で設定できる。`pinnedVersions`（任意、slug → 版）を書くと、その候補は観測した最新版ではなく指定版で選ばれる。pin した slug は `candidateSlugs` に含める。pin は方針 digest に入る。選定の適格性と順序は `select(policy)` が機械的に決め、人間の対象承認は置かない。
- `minimumActiveInstallations` の既定は 500。対象種別ごとの厳密な閾値は後段の programme scope 評価で適用する。WordPress.org 非掲載、配布停止、観測不能、観測期限切れは選ばない。
- `excludedAuthors` は公式プログラムの対象外資産の作者を除く。名前だけで所有関係を断定できない場合は `excludedSlugs` に追加する。作者情報が取れない対象は適格にしない。
- `maximumObservationAgeDays` と `maximumUpdateAgeDays` は別々の鮮度制限。Wordfence programme 方針の観測も `current` である必要がある。
- `surfaceTagWeights` は WordPress.org メタデータの公開タグを攻撃面の弱い代理指標として採点する。タグがなければ 0 点とする。既知脆弱性の件数や内容は選定・採点に使わない。
- `scoreWeights` を変更すると install 数、更新の新しさ、公開タグの寄与が変わる。スコア内訳、方針 digest、観測 ref は `TargetSelection` に残る。
