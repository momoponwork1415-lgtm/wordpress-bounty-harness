# WordPress 対象選定方針

正本の設定は [selection.json](selection.json)。`loadWordPressSelectionPolicy()` で読み込む。

- 本番の `candidateSource` は WordPress.org の人気順・タグ順を列挙する。取得元、観測時刻、応答 digest を記録し、取得不能・期限切れの一覧からは候補を採らない。`candidateSlugs` と `pinnedVersions` は開発対象を手動固定する旧形式として残す。両形式は union で分ける。選定の適格性と順序は `select(policy)` が機械的に決め、人間の対象承認は置かない。
- 操作者が作った候補一覧は、自動選定方針の任意欄 `operatorCandidates` に `{ "slug": "synthetic-example", "version": "1.2.3", "evidenceDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }` の配列として足し、既存の `harness select --config <選定方針.json>` で取り込む（[#520 の限定承認](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/520#issuecomment-6468469367)）。例の digest は合成値で、実際には操作者が Git 外に保管した根拠の SHA-256 を指定する。
- 候補一覧は一覧取得が成功したときに通常の候補へ統合し、同じ slug は 1 回だけ観測する。候補一覧内で重複する slug と、slug・version・evidenceDigest 以外の欄は拒否する。本文や file path は受け付けず、根拠 digest の本文を選定器が開くこともない。
- 候補一覧の指定版は観測した stable と完全一致する必要があり、不一致なら `operator-candidate-version-mismatch` でその回の対象から除く（通常一覧にも同 slug がある場合を含む）。歴史版へ固定せず、別の版へ読み替えない。適格性・install 順・同版 1 Trial の条件は通常候補と同じで、候補一覧による優先枠は置かない。
- 候補一覧は方針 digest に束縛し、観測した候補の slug・指定版・根拠 digest は既存 `selection-report.json` の `inspections[].operatorCandidate` に残す。探索へ渡す `TargetSelection` に根拠参照や本文は含めない。種生成、sweep skill、機構文・修正差分本文の探索入力は未実装で、本取込みの範囲に含めない。
- 人気順と各タグの一覧は、インストール数が下限を割るページか API の最終ページまで読む。固定のページ数・候補数の上限は新設定から外す。取得失敗や API のページ上限で切れた母集団は `unavailable` とし、部分的な列で尽きたとは判定しない。
- 必須pluginは対象のメインPHPファイルの `Requires Plugins` ヘッダから取得する。同じ先頭8 KiBに `WC requires at least:` または `WC tested up to:` が値付きであれば、`woocommerce` を依存に足す（`Requires Plugins` と重複しても1件。WooCommerce自身は自分に依存しない）。ヘッダは必須と任意の連携を区別しないので、任意連携の対象にも WooCommerce が入る。ただし版の固定だけで依存を決める方針（`candidateSlugs` の方針と reverify。`dependencyVersionPolicy: pinned-only`）では、WC の版ヘッダだけから決めた `woocommerce` は任意の依存とする。`pluginDependencyPins` に版が無ければ Snapshot に入れず、依存の pinset に `skippedDependencies`（理由 `header-derived-unpinned`、宣言した slug）を残す。`Requires Plugins` や `pluginDependencySlugs` で名指しされた依存は、固定が無ければ `unpinned-required-plugin` で止める。どちらのヘッダにも現れない依存は選定方針の `pluginDependencySlugs` に対象slugごとに明示する。本番の自動選定では `pluginDependencySlugs` にslugを挙げ、freeze時点の公式stable版を固定する。現行 Unlimited Elements はヘッダが依存を宣言しないため、既定方針で Elementor を指定する。手動の開発・歴史的評価は `pluginDependencyPins` に版を指定する。過去の評価対象に用いた [Unlimited Elements 2.0.16 の Elementor 4.2.0 pin](../../../../docs/evaluation/public-source-pins.json) は現行版の既定値へ流用しない。取得失敗時に依存を省略して探索やLabを起動しない。依存の指定変更は選定方針digestを変え、Snapshotには取得した版とsource digestが残る。
- 本番はインストール数 10,000 以上、365 日以内に更新された対象を選ぶ。上限帯と cascade は使わない。インストール数の降順、同数なら更新日の降順に並べる（ADR 0037 の 2026-10-28 追記）。WordPress core 版は `wordpressVersion` で固定し、Snapshot を作ってから台帳に記録する。
- 選ばないもの：WordPress.org 非掲載、観測不能、観測期限切れ、配布停止。配布停止は理由コード `distribution-closed` で区別する。
- `excludedAuthors` は、公式プログラムの対象外資産（Automattic、Facebook、Google、SiteGround、Yoast）の作者を除く。WooCommerce 名義と MailPoet 名義の plugin は Automattic 資産なので `WooCommerce` と `MailPoet` も入れる（2026-10-17。本番 batch 5 で google-listings-and-ads と woocommerce-payments が選ばれた抜けの修正）。作者情報が取れない対象は適格にしない。
- `excludedSlugs` には、作者名だけでは所有関係を断定できないものと、ベンダー側のweb serviceが無いと動かないものを手で入れる。後者はメタデータから機械的に判定できないため、タグからは推定しない。
- `maximumTargets` は 1 バッチの上限。台帳の Trial が同じ版か上位の版を既に調べていれば外し、新版なら日数を待たずに戻す。未提出 Finding と旧世代の履歴では除外しない。探索が始まらなかった run と provider 上限からの再開は SPEC 第 6 節に従う。別ランナーが予約中の対象と同版の凍結失敗は従来どおり外す。次の campaign は最新の選定バッチに固定された対象と Snapshot を使う。
- `maximumObservationAgeDays` と `maximumUpdateAgeDays` は別々の鮮度制限。Wordfence programme 方針の観測も `current` である必要がある。
- 選定は Wordfence ミラーを開かず、履歴の採点と鮮度 gate を持たない。ミラーは `wbh-screen` と `wbh-dedupe` で使い続ける。重複は提出前に照合する。
- `cascade`、`maximumActiveInstallations`、`scoreWeights`、`history*`、`maximumHistoryAgeDays`、`revisitPolicy.minimumDaysSinceTrial` は新方針で拒否する。`revisitPolicy` は `version-increased` だけを受け付ける。旧 `target-selection.json` のスコア内訳、履歴、`cascadeStep`、`highThreatSurface`、`runBudget` は読めるまま残す。
- 選定記録はインストール数、更新日、`reason: initial | version-increased` と方針 digest・観測 ref を残す。理由は既存 `target-selected` の artifact digest から読める。既存イベントの型は変えない。
- 旧方針の `runBudget` も 2026-10-19 に削除した（古い `target-selection.json` の `runBudget` は読み続ける）。run 数は対象ごとに 1 Trial で、`campaign run --repeat` だけが増やす（ADR 0029）。選ばれた対象を指名したタグは `candidateTag` に残り、半年後にタグ別の有償率を測る材料になる。
