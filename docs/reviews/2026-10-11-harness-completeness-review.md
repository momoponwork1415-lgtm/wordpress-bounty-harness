# 2026-10-11 バグバウンティ用脆弱性発見Harnessとしての完成度レビュー

問い: 「このHarnessはバグバウンティ（Wordfence / Patchstack）で報奨を得る装置としてどこまで完成しているか。何を直せば収益に近づくか」。

調べ方: `origin/main`（`fd33ec6`）を対象に、SPEC / ADR / PILOT / BENCHMARK を読み、探索・Lab＋検証・選定〜レビュー配線の3領域をコードで監査した。主張はすべて `file:line` で確認した。実機（runsc、Codex、Playwright）は動かしていない。正本ではない報告であり、ここから所有者が選んだものだけがIssue / PR / ADRになる。

## 1. 結論

**配線は通ったが、収益装置としては未完成。** 「探索 → 独立Verifier → nonce判定器 → 修正版で負の対照 → 台帳」の縦断スライスは公開済み事例（TranslatePress 3.3.1 / 3.2.6のアカウント乗っ取り）で実機通過した。一方、未知脆弱性の `runtime-confirmed` は0件、提出0件、報奨0ドルで、収益の式のどの項も実測がない。

段階別の見立て:

| 段階 | 状態 | 根拠 |
| --- | --- | --- |
| 隔離・記録の土台（gVisor Lab、broker、Snapshot digest、追記台帳、Private Evidence） | ほぼ完成。runc / hostへのfallbackなし | `lab/index.ts:601-617` preflight、`codex-gvisor-sandbox.ts:258-273`、`ledger/index.ts:688-723` digest gating |
| 探索（Root＋3） | 動くが、発見率は未証明。既知事例の再発見は1分類（ATO）のみ、Stored XSSは未再発見 | BENCHMARK §6–7、PILOT |
| 検証・判定器 | 8分類に判定器あり。ただしStored XSSは構造上confirmedに到達できないバグがある（第3節） | `judges.ts:774-818`、`reproduction-package.ts:94-98` |
| 選定 | 候補の列挙がなく、方針の `candidateSlugs` 空。pilot用scriptが唯一の生成器で、公開履歴が多い対象ほど高く評価する | `wordpress-selection.ts:276`、`selection.json:5`、`prepare-pilot-selection.mjs:158-163` |
| 重複照合・文案・提出 | Wordfence mirror照合のみ。英語レポートJSON生成なし。文案は人間が書いた文を登録するだけ | `duplicate-lookup.ts`、`review/index.ts:583-616` |
| 評価 | funnelとusageは台帳から出る。ドル換算は不可（`costUsd: unavailable`） | `ledger/index.ts:852-`、`campaign.ts:837,895` |
| 品質ゲート | `pnpm check` 通過（63ファイル、405テスト） | 本日実行 |

収益換算（所有者の目標 月1,000ドル以上）: Wordfenceの平均報奨は約220ドル（DESIGN-EVIDENCE §10）なので月5件前後の受理が要る。重複・対象外で落ちる分を見ると、**週1件以上の未知の `runtime-confirmed`** が最低ライン。現状は約10 Trialで0件。

## 2. 実測の現状（台帳・文書から）

| 実行 | 対象 | Finding | runtime-confirmed | 備考 |
| --- | --- | ---: | ---: | --- |
| 3対象pilot（2026-10-10） | Forminator 1.58.0、DnD Multiple File Upload CF7 1.4.0、WP Statistics 14.16.15 | 2 | 0 | 2件とも `incomplete(no-judge)`。16 run中7 runがschema失敗（6件は後で復旧） |
| TP 3.3.1 ゲート | 既知ATO | 3 | 2 | 修正版3.3.2で `contradicted`。ゲート通過 |
| TP 3.2.6 v3 / v4 / v4+comment | 既知Stored XSS | 3 / 1 / 4 | 0 / 1(ATO) / 0 | XSS候補0。v4のwallは約4分 |
| TP 3.2.6 wp2shell v1 / v2 c1 / v2 c2 / v2+comment | 同上 | 0 / 0 / 0 / 3 | 0 | v1はschema棄却3件、c1は413、c2は `file_change` 棄却。v2+commentでXSS候補1件（公開事例と重なる可能性）だが検証 `incomplete` |

費用: 短いv4は1 Trial入力約5.2M token（cache 95%）、出力約26k。長いv2は入力約85–93M（cache 98%）、出力約235k。固定購読のためドル換算なし。

直近12件のFindingのうち10件が `incomplete`（no-judge、Lab前提不足）。**失われているのは探索候補ではなく検証段階の転換率**。

## 3. 直すべき欠陥（確認済みのバグ。ADR不要、PRで直せる）

### 3.1 Stored XSSは判定器が鳴っても `incomplete(evidence)` になる

- 再現パッケージの描画器は、routeに `browser` 手順があると `screenshot` 証拠を要求して例外を投げる（`src/profiles/wordpress/verification/reproduction-package.ts:94-98`）。
- 判定器が出す証拠一覧は `http` と `canary` だけで、`screenshot` を作る箇所は `src/` に存在しない（`judges.ts:283-294`、grep結果）。
- `publishReproductionPackage` は例外を `incomplete(evidence)` に変換する（`src/verification/reproduction-package.ts:117-118`）。
- Stored XSS判定器は被害者ページを `browser` 手順から取るので、Verifierはbrowser手順を書くよう誘導される（`judges.ts:724-727`）。
- テストは `screen.png` を手で足しているため検出されない（`tests/verification/reproduction-package.test.ts:83-87`）。

影響: Wordfenceで件数の多いStored XSSが構造的に提出候補にならない。BENCHMARKのXSS 0件のうち、どこまでがこのバグかは不明（判定器に到達する前に `incomplete` になった件が多い）。

直し方: Lab observerのPlaywright訪問でscreenshotを撮って証拠に加える、または描画器の要求を「browser手順ありのときはbeacon観測記録で代替可」に緩める。前者が提出資料としても正しい。

### 3.2 beaconは「GETが届いた」だけで、JS実行も被害者の別人性も確認していない

- 受信側は `/b/<nonce>` へのGETを無条件に記録する（`lab/index.ts:67-72`）。`<img src>` やCSS `url()` のHTML injectionでも鳴る。
- `victim.role` が `subscriber` / `customer` のとき、観測に使うアカウントは攻撃者自身のもの（`lab/index.ts:1562-1567`）。自己XSSが `runtime-confirmed` になる。scope評価はこの条件を見ていない（`scope-policy.ts:150-209`）。

直し方: beaconはJSからのみ到達できる形にする（例: `fetch` で特定headerを付ける、またはnonceをJS内で計算させる）。被害者roleが攻撃者と同一アカウントのときは `victimRole` を `self` と記録し、scope評価で `out` にする。

### 3.3 HTTP捕捉を迂回すると判定器が自己申告の `http.json` に落ちる

- 捕捉が空のとき `agent-authored` にfallbackする（`judges.ts:177-180`）。拒否するのは `sensitive-object-access` だけ（`judges.ts:371-374`）。
- VerifierはWordPressコンテナと同じ内部ネットワークにいるので、`--add-host` のrecorder IPではなく実IPへ直接送れば捕捉が空になる。
- `attackerRole` 以外の条件（`defaultSettings`、`magicQuotes`）はVerifierの自己申告（`judges.ts:551-573`）。

直し方: 捕捉が空のときは `incomplete(evidence)` にする（ADR 0015の趣旨に合う）。WordPressコンテナ側で recorder 以外からの接続を拒む（iptablesか、WP側を別サブネットに置く）。

### 3.4 子スレッド4つ目でRootの報告が丸ごと消える

- unique child threadが3を超えるとrun全体を `incomplete(policy: child-count-exceeded)` にする（`codex-native-agent-runtime.ts:1194-1201`）。
- 一方 `wp2shell-bounty-v2` はRootに「複数wave」「最初のFinding後に別familyへ」を求める。Codex CLIがwave間でスレッドを再利用するかは未確認で、再利用しなければ長いpromptほどRoot報告を失う。
- Codex側には `agents.max_threads=3` を渡しているので同時数の上限は既にある（`:964`）。

直し方: 超過をrunの無効化ではなく「超過分の子の成果を記録しない」に変え、台帳に `childThreadsObserved` を残す。

### 3.5 その他、設計と実装の食い違い

- ADR 0022（理由別の自動再試行）は未実装。`attempt` / `retryOf` が `src/` に無く、再検証は `--retry-incomplete` かLab Setup digest変化時のみ（`cli/pipeline.ts:294-331`）。Issue #107で進行中。
- ADR 0019（schema生成の出力契約）は `short-objective-managed-v5` にしか適用されない（`prompts/index.ts:20-22`）。既定のv4と比較用v2は本文の約60%が手書き契約のまま。
- SPEC §4の `readiness(campaign)` は存在しない。
- IMPLEMENTATION-PLANの「550テスト」は古い（実際は405）。
- RO DBユーザーは供給時点の表にだけSELECTを持つので、後で作られる `wbh_canary` 表は読めない（意図どおりだが、SQLi判定の「canary行の読み出し」は応答経由しか成立しない。文書化が要る）。

## 4. 発見率を上げる改善（探索と検証の転換率）

優先順は「収益への効き × 実装の軽さ」。

### 4.1 入口索引を既定で渡す（最も安い手）

Harnessは `wp_ajax_nopriv_` / `wp_ajax_` / `admin_post_*` / REST route / shortcode / request hookの登録箇所を列挙できる（`profiles/wordpress/discovery/entry-points.ts:20-27, 149-186`）。しかし `assignment` か `continuation` を設定したときだけ作られ（`cli/wordpress.ts:460-467`）、既定promptには「All files under /workspace/main」としか渡らない（`:519-526`）。

WordPressプラグインの報奨対象の大半は「外部から届くhandlerのcapability / nonce検査の欠落」であり、入口の一覧は仮説ではなく事実（索引）なので、SPEC第6節の「固定された攻撃経路を与えない」に反しない。分担はRootに任せたまま、索引だけを既定で添える。

測り方: 開発セット（TP 3.2.6 / 3.3.1）でv4に索引あり／なし各3 Trial。uniqueFilesRead、wall、Finding、`runtime-confirmed`。

### 4.2 短いpromptは4分で終わる。終わる理由を先に測る

v4のwallは約4分、v2は約38分で非cache入力約5倍、出力約10倍（BENCHMARK §7）。どちらが当たるかは未決。ただし「Rootが満足して終わる」ことを制御する手段がHarness側にない（30分下限はpromptの指示だけ）。

案: Harnessが継続境界を持つ。Rootの最終JSONを受けたら、`unexamined` が空でなく、かつwallが下限未満なら、同じコンテナに「unexaminedのうち索引上の入口を含むものを続けろ」と1回だけ再投入する（Trial内の継続、ADR 0014の延長）。測るのは「再投入で増えた候補の `runtime-confirmed` 率」。

### 4.3 Labの前提不足が `incomplete` の主因。シナリオを「Findingから逆算」する

`incomplete(precondition)` の例: 翻訳辞書が空、machine translationが無効、管理者画面の操作が再現できない。シナリオcatalogueは2件（`lab/scenarios.ts:6-27`）。

案: Verifierの `incomplete(precondition)` の次の手を集計し、頻出する前提（「対象pluginの主要機能を1回使った状態」）をplugin非依存の汎用シナリオとして足す。例: 公開フォーム1件に投稿1件、公開投稿への翻訳/メタ1件、WooCommerce有効時の商品1件。加えて、Verifierのコンテナにbrowserがない（`containers/development-set/codex/Dockerfile`）ため管理者操作を伴う前提は再現できない。Verifier用imageにPlaywrightを入れるか、Lab observerに「管理者として指定URLを開いて指定フォームを送る」手順型の操作を追加する。

### 4.4 Root＋3の費用対効果を1回測る

Root＋3はCodex CLIの `multi_agent` に委ねており、Harness側の分担・共有registry・wave制御はない。4 agentが1 CPU（`--cpus=1`）を共有する。ADR 0016は「まず縦断を通す」ための選択で、単独agent×4 Trial（pass@4）との比較はしていない。

測り方: 同じ対象・model・総予算で「Root＋3 ×1」と「単独 ×4」を各3組。分母は `runtime-confirmed` と非cache入力token。

### 4.5 promptの小さな修正（ADR不要）

- `labObservations` を必須非空にしている（`finding.ts:78`）ため、観測していない内容を埋める圧力がある。「観測していなければ `none`」を許す。
- 出力契約を本文から外し、v4をv5の形（契約はHarness生成）に揃える。比較armも同じ構成にしないとprompt比較に契約差が混ざる。
- `other` / `missing-authz` / `idor` / `reflected-xss` / `csrf-to-write` はSPEC上「記録のみ」だが、Findingとして同じ重みで出力される。報告の水増しを防ぐため「到達先のないauthzは Lead として出す」と1行足す。

## 5. 収益に直結する運用の欠け（本番ループ）

| 欠け | 現状 | 影響 | 直し方の案 |
| --- | --- | --- | --- |
| 候補の列挙 | `select` は `candidateSlugs` からしか選ばない。生成器は `prepare-pilot-selection.mjs` のみで、公開履歴が多い対象ほど高評価（`:158-163`） | 他の研究者も見ている対象に集中し、重複率が上がる | 履歴は「低権限・高影響の履歴がある」二値にし、直近90日の公開件数が多い対象は減点。探索済み対象を台帳から読んで除く |
| 依存plugin | Snapshotの依存はWordPress coreの1つだけ（`snapshot-source.ts:17`） | WooCommerce前提の高install対象を扱えない | 依存を配列にし、Labの `wp plugin install` に通す。2つ目の依存が要るまで汎用化しない方針と矛盾しない |
| 重複照合 | Wordfence mirrorのみ。更新scriptはこのリポジトリ外。Patchstack / WPScan未実装 | 提出前ゲートが手作業 | #96 |
| 文案生成 | `review draft --file` は人間の文を登録するだけ | 1件ごとに人間が英語レポートを書く | #95。再現パッケージ（manual.md、reproduce.py、evidence.json）から定型JSONを出すのは短い作業 |
| 自動再試行 | ADR 0022未実装 | `incomplete(recipe/observation)` が人間へ流れる | #107 |
| 費用 | `costUsd: unavailable`。購読の使用量上限（5時間窓）と並列Trialの関係も未確認 | 「1 confirmedあたりの費用」が出ない | 公開単価表で参考換算を出し `estimated` と明示する |
| 実Labの統合テスト | runsc、Playwright selector、beacon router、`tail -c` 捕捉、WP-CLI出力解析はすべてfake runnerでしか試していない | 1か所壊れると全件 `incomplete(observation/provision)` になり、テストは緑のまま | 週1回の実機smoke（既知ATOのrecipe再実行）をCIとは別の手順に置く |

## 6. 設計として問い直す価値があるもの（ADRで決める）

1. **contributor以上を完全に信頼側に置く**（`trust-boundary-v1.md:6`）。Wordfenceはcontributor / authorを中間権限として対象外だが、Patchstackはcontributorをx0.75で受理する。収益優先なら「contributorはPatchstack向けに記録する」選択もある。どちらでもよいが、現状はtemplateの1行で決まっているのでADRにする。
2. **深さ優先か広さ優先か**。現設計は1対象に高額な協調Trialを1回。Wordfenceの上位研究者は月6〜14件で、報奨の中心は「ありふれた欠落」。対象数を増やす安い一次スクリーニング（入口索引＋単独agent短時間）を前段に置き、候補が出た対象だけ協調Trialに回す二段構えは、SPEC第10節の「安い手法の陰性は深い探索の陰性を意味しない」と両立する。
3. **既知事例の再発見で何を証明するか**。TP 3.2.6のStored XSSは短いpromptでは一度も候補にならず、長いpromptで1回候補になった。これ以上3.2.6に時間を使うより、最新版の実対象で「候補→confirmed」の転換率を上げる方が目標に近い。

## 7. 推奨する次の3つの「今週の問い」

1. **Stored XSSの判定がconfirmedまで届くか**（第3.1〜3.2）。screenshotの生成、beaconのJS限定、自己XSSの除外を1 PRで。測る数字: TP 3.2.6の既知XSS経路を人間が書いたrecipeでVerifierに通し、`runtime-confirmed` になるか。これはpromptの問題と切り離した判定器のテスト。
2. **入口索引を既定で渡すと候補が増えるか**（第4.1）。索引あり／なし各3 Trial。
3. **検証の `incomplete` 理由の分布と、前提シナリオ2〜3件の追加で何件がconfirmedに転じるか**（第4.3）。

この3つが通るまで、選定・重複・文案（第5節）は後回しでよい。候補がconfirmedにならない間は提出物が無いので、後段を作っても収益は変わらない。

## 8. 今回確認していないこと

- 実機でのrunsc / Codex / Playwrightの挙動。Codex CLIがwave間で子スレッドを再利用するか。
- Private Evidenceに残る候補の中身（Git外。今回は文書と台帳の数字だけを使った）。
- Wordfence / Patchstackの最新の受理条件（SPEC 8aは2026-10-08観測）。

## 9. 過去レビュー（2026-10-09）で未解決のまま残っている項目

Patchstack / WPScan照合と自動レポート生成（意図的に後回し）、選定スコアの改善、購読の5時間窓と並列Trialの関係、Verifierコンテナからの RO DB接続確認、XSS見落としの主因の切り分け。

## 10. 起こしたIssue（2026-10-11）

| 節 | Issue |
| --- | --- |
| 3.1 Stored XSSのscreenshot | #118 |
| 3.2 beaconと自己XSS | #119 |
| 3.3 捕捉迂回と自己申告 | #120 |
| 3.4 子スレッド超過 | #121 |
| 3.5 ADR 0019の既定適用 | #122 |
| 4.1 入口索引を既定で渡す | #123 |
| 4.3 Verifierのブラウザ | #124 |
| 4.3 汎用Labシナリオ | #125 |
| 5 実Labの週次smoke | #126 |
| 6 本人発見7件の再発見 | #127 |
| 4.4 Root＋3と単独×4の比較 | #128 |

既存Issueで扱うもの: 再試行方針 #107、文案生成 #95、重複照合 #96、選定 #97、通し運用 #98。
