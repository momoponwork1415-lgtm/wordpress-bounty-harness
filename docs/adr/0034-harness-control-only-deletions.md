---
status: accepted
date: 2026-10-18
amends: 0029（入口索引と coverage の行）, 0012（本番で公開履歴カタログを渡す行）, 0026（scenario catalogue の行は #352 で改訂）
---

# Harness は制御だけを持つ: 探索入力の索引・coverage・公開履歴 catalog の削除

## 背景

所有者は 2026-10-18 に Harness と AI の責務を固定した（[AGENTS.md「Harness と AI の責務（所有者決定 2026-10-18）」](../../AGENTS.md)、#349、[LESSONS 14](../LESSONS.md)）。過去 4 世代と本 repo の 2026-10 は、探索や検証の「やり方」を Harness の code に入れて Harness が肥大し、報酬が止まるという同じ失敗を繰り返した。決定の要点は 3 つ。

- Harness は制御だけを持つ。判断の要らない処理だけを code にする。
- 探索と検証の中身は prompt と skill が持つ。どこを読むか、何を索引にするか、どの順で仮説を立てるかは agent の仕事。
- 削除。「入口・保存先索引の探索入力、task-plan と dispatch、coverage と `incomplete(depth)`、Verifier 指示の連鎖、precondition 文から scenario を選ぶ正規表現、plugin 別 Lab adapter と scenario は境界の外側にあるので、skill 化と同時に削除する。使わない設定にして残す中間状態は置かない。」

この ADR は Issue #353 作業 2 の第 2 項を実行した記録である。第 1 項（dispatch / assignment / ablation / 比較 arm の mode）は #351、第 4 項（Verifier 指示の連鎖と scenario / adapter）は #352 と同時に行う。

## 決定

### この PR で削除するもの

探索の入力を Harness が加工していた 3 系統を、生成側だけ削除する。

1. **入口索引と保存先索引**（ADR 0029 の「固定 source から生成した入口索引を既定でカタログとして渡す」）。`src/profiles/wordpress/discovery/entry-points.ts`（`enumerateWordPressEntryPoints`、`renderWordPressEntryIndex`）、`storage-index.ts`（`buildWordPressSourceIndex`）、`unresolved.ts`（未解決登録の走査、#328 / #332）、`scripts/report-index-unresolved.mjs`。campaign 設定の `entryIndex` key、`CampaignInput v1` と `PlannedDiscoveryRun.configuration` の `entryIndex`、prompt 表の `entryIndexCoverage` 列、`wordPressDiscoveryContractPlan` の索引引数。既定は v8（ADR 0033）で既に索引なしだった。
2. **coverage と `incomplete(depth)`**（ADR 0029 2026-10-17 改訂）。`coverage.ts`（`wordpressCoverageRecordSchema`、`assessWordPressCoverage`、`wordpressSourceFileSets`）、出力契約 v3（`wordPressDiscoveryOutputContractV3`）、campaign 設定の `coverage.maxUnvisitedRatio`、`runDiscoveryCampaign` の `assessCoverage`、transport run の `coverageSchema` と Root 用 JSON schema への `coverage` 必須化、`executeTrial` が `coverage.json` を Private Evidence に置いて `failed(depth)` を書く経路、`ReportFailure.reason` の `"depth"`。
3. **公開履歴 catalog の生成**（ADR 0012 の本番経路。ablation の history 軸でしか使っていなかった）。`src/discovery/campaign.ts` の `catalog` mode、`CatalogRecord`、`createHistoryCatalog`、`validateEvaluationCampaignInput` / `validateProductionCampaignInput`、`src/profiles/wordpress/wordfence-history/index.ts` の `extractCampaignHistory`、Codex stdin に catalog を付け足す分岐。`CampaignInput v1` の `history` は `{ mode: "none" }` だけになる。

削除した module の test 5 file（`discovery-entry-points`、`discovery-storage-index`、`discovery-unresolved`、`campaign-history`、`wordfence-campaign-history`）も消す。campaign 設定は strictObject なので、`entryIndex` と `coverage` を書いた設定 file は parse で弾く。使わない設定として残す中間状態は置かない。

### #352 と同時に削除するもの（この PR では触らない）

Verifier 指示の連鎖（`wordpress-verifier.ts` の nextStep）、`scenarios.ts` の scenario 定義と precondition 文から scenario を選ぶ `nextWordPressScenario`、plugin 別 Lab adapter、`wordpress-initialization.ts` の scenario 分岐、campaign 設定の `lab.scenarioId`。先に消すと検証が止まる（Issue #353）。archive prompt と選定の legacy field、`lab.customerRole` などの棚卸し保留行も別 PR（#353 作業 2 第 3 項）。

### 残すもの（AGENTS.md「Harness は制御だけを持つ」）

選定、Snapshot と digest、gVisor と broker、prompt と source を渡して走らせること、wall と子の数、出力の全件保存と schema による正規化、Programme Boundary 外の出口での park、Finding 単位の Lab 供給と canary の播種、判定器、台帳と Private Evidence、review の記録。この PR で具体的に残した読取経路は次のとおり。

- 台帳 schema の読取: `discovery-run-started.history.mode = "catalog"`、`configuration.entryIndex`、`configuration.assignment.indexDigest`、`discovery-run-finished.reason = "depth"`、`artifacts[].kind = "coverage"`、`continuation.reason = "coverage-incomplete"`。`ledger funnel` の `incomplete(depth)` 件数は旧 event から数え続ける。回帰 test は `tests/ledger/ledger.test.ts` の「still reads old entry-index runs with catalog history, coverage artifacts and incomplete(depth)」。
- Root 報告 schema の `coverage` 任意項目（旧 v5 / v6 の報告を読み直すため。要求はしない）、添付 kind `coverage`（Private Evidence の旧 `coverage.json`）。
- Wordfence 履歴 mirror の `inspectHistoryMirror`、`findDuplicates`、`createWordfenceDuplicateLookup`（`history status`、review、`wbh-dedupe` が使う）。
- `bundledCatalogDigest`（Codex CLI 同梱の model catalog。公開履歴 catalog とは別物）。

## 理由

- 索引は「どこを読むか」を Harness が決めて agent に渡す舵取りであり、所有者決定の境界の外側にある。v5 比較（[2026-10-16](../evaluation/2026-10-16-prompt-v5-comparison.md)）で索引あり・なしに差は出ず、v7 以降は渡していない。
- coverage と `incomplete(depth)` は agent の自己申告（coverage record）を Harness が根拠にする code で、「移す合図」に該当する。深さは Harness が観測する読取 file、wall、token、子の活動で事後に見る（ADR 0033）。
- 公開履歴 catalog は ADR 0013 の history 軸 ablation でしか使われず、本番の `wp2shell` mode は常に `none` を渡していた。不変条件 1 は catalog を「渡してよい」と書くだけで、渡すことを求めていない。

## 帰結

- 旧 Trial の `contractDigest`（契約 v3）、索引 digest、coverage record は台帳と Private Evidence から読めるが、同じ本文を再生成する code は無い。照合が要るときは下の archive から戻す。
- `CampaignInput v1` の形は `history: { mode: "none" }` 固定、`entryIndex` 無しになる。既存 Trial の記録は台帳側 schema で読むので変換は要らない。
- SPEC §4 の source 補助行、§5 の `CampaignInput v1`、§6 の記録項目、§9 の Trial 台帳項目、§13 用語集の公開履歴 / `historyCutoff`、ADR 0029 の索引行は、この決定に合わせて「旧 Trial の記録を読むための記述」に改めた。不変条件（SPEC §2）は変えない。
- 行数: src + scripts −1,428 / +28、tests −936 / +98（削除 PR の計測。docs は別）。

## 消し方

この PR の merge commit を `git revert` する。削除前の main は `7e65e71`（PR #372 merge 後）で、reviewing session が `archive/pre-adr-0034` tag をそこに置く。索引や coverage を戻すときはその tag から branch を切り、この ADR を superseded にして AGENTS.md の責務節を改める。
