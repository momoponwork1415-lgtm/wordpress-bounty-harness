# いまの Harness が各段で何を出すか、と primitive を組み合わせる構成（2026-10-27）

「調べて報告」の記録。正本ではない。所有者の問い（2026-10-27）は 2 つ。「個々の処理でどういう JSON と記録が出るのか」と「Lead を primitive として記録し、組み合わせて重大な脆弱性につなげる形にしたら、どういうアーキテクチャになるか。Harness と AI の塩梅はどこか」。

出典は `src/`（prod27 = main 4e66350 以降）、本番の台帳（`ledger.sqlite`、2026-10-27 09:30Z の写し）、Private Evidence の実物 1 件の形。中身（主張の文、経路）は書かない。

## 1. 段ごとの処理と記録

列は「誰が」「何をする」「台帳に残る event（`artifacts`・`campaignId`・`occurredAt`・`snapshotDigest` 以外の欄）」「Private Evidence に残る物」。台帳は追記専用で digest 参照しか持たず、本文は `private-evidence/<digest>/content/` にある（`manifest.json` が digest とバイト数を持つ）。

| # | 段 | 誰が | 何をする | 台帳 event | Private Evidence |
|---|---|---|---|---|---|
| 1 | 選定 | Harness | wp.org の人気一覧を帯（100k〜1M、50k、1M+、30k）で見て、履歴（Wordfence mirror の件数は助言）と除外を当て、5 件以上を batch に凍結 | `selection-batch-bound {policyDigest, selectionBatchId, selectionIds}`、`target-selected {selectionId}`、`target-skipped {reason}` | 選定方針の写し |
| 2 | Snapshot | Harness | 対象・WordPress 本体・PHP・`Requires Plugins` と方針の依存を版と digest で固定 | `snapshot-frozen {sourceDigest, dependencyDigests}` | `work/snapshots/<digest>.json`、`work/sources/<digest>/` |
| 3 | 起動 | Harness | gVisor に読み取り専用ソースと broker を付け、目的文（断片の合成）＋ Harness 生成の節（trust 境界、Programme Boundary、Run parameters、出力契約）を渡す。Root 1 体、子は上限まで | `discovery-run-started {runId, trialId, runKind root/child, parentRunId, configuration{promptVariant, promptDigest, contractDigest, sectionDigests, runtime, model, maxChildren, wallMinutes, mode}, labAttached}` | 渡した本文の digest 一覧 |
| 4 | 探索 | AI（Root と子） | 読む・たどる・書く。Root は sink 種別ごとに子を起こし、子の報告を束ねて最終報告 | `discovery-run-finished {agentRole, outcome, wallTimeMs, childThreadsObserved/Admitted, observed{filesRead, uniqueFilesRead, toolCalls}, usage, brokerMetrics, diagnosticArtifactDigest, researchArtifact}`、`child-report-recovered`、`discovery-concluded {stoppedBy}` | `diagnostic-<digest>/content/diagnostic.json`（会話の全記録）、research notes、子の最終報告 |
| 5 | 正規化 | Harness | 子と Root の JSON を schema に当てる。直せる崩れは直して記録、直せないものは保留 | `candidate-normalized {candidateKind, candidateIndex, changes}`、`candidate-held {issueCodes, issuePaths, primitive, missingEdge}` | 候補の原文 |
| 6 | 受理 | Harness | Finding は impact が境界内なら受理、10 種は park。Lead は全件受理。Finding は plugin 側の `file:function` の列で群にする | `finding-recorded {findingId, category, preconditionClass, group{id, keys}}`、`finding-parked {reason, declaredPrecondition}`、`lead-recorded {leadId, primitive, missingEdge, storageKind}`、`finding-precondition-classified` | `<digest>/content/finding.json`（下の 2 節）、Lead の JSON |
| 7 | 段 1 | AI skill `wbh-screen` | 規則の写しに照らして 提出可 / 不可 | 無し（記録は skill の報告） | `screen-*.md` |
| 8 | 段 1b | AI skill `wbh-source-check` | 固定ソースだけ読んで、入力支配と到達性の 2 問に yes/no/unknown | `review-decided {decision reject, reason source-check-input / -reach, by ai}` | `source-check-report-*.md`、結果 JSON |
| 9 | 検証 | Harness + AI skill `wbh-verify` | Harness が Lab を立て canary を播く。skill が前提を作り `setup-done`。以後の要求を Harness が捕捉し、`observation-ready` で人間が見る | `lab-provisioned {labId, purpose, setupDigest, status}`、`verifier-run-finished {findingId, terminal}`、`verification-finished {result{status, reason}, labSetupDigest, labStateDiff, attempt, retryOf}`、`manual-observation-lab-ready` | handoff dir の 6 file（`steps.md`、`refutation.md` ほか）、捕捉した HTTP、画面 |
| 10 | 人間 | 所有者 | Lab で要求 1 本を送って自分のブラウザで見る | `review observe … --result match`、`human-effort-recorded {action, minutes}`、`scope-assessed {status}` | 観測の記録 |
| 11 | 判断と提出 | AI skill → 所有者 | `wbh-dedupe`（既知照合）、`wbh-destination`、`wbh-report`（下書き）、`wbh-submit` | `review-decided {decision, verificationId}`、`review draft`、`review authorize`、`review submitted` | 下書きと添付 |

数字で見える事実（2026-10-27）: 6 までは無人で回っている。7〜11 は skill があるが、10-26 以降の Finding には当てていなかった（今日 75 件を段 1b で reject）。

## 2. Finding と Lead の記録の形

`finding.json` の欄（v5 契約で足した 3 欄は 10-27 から渡さない）:

- `claim`、`attackerPosition`（unauthenticated / subscriber / customer）、`impact`（分類）、`configurationPrecondition`、`brokenProperty`、`existingControls`、`labObservations`、`sourceTrace[{file, function, line}]`、`recipeRef`、`discoveryRunId`、`snapshotDigest`、任意で `configurationClass` / `attackerInputPath` / `exploitTiming`

Lead の欄（`src/profiles/wordpress/discovery/lead.ts`）:

- `summary`、`attackerPosition`
- `primitive`: `read` / `write` / `delete` / `auth-material` / `partial-execution`
- `storage`: `{kind: option / post-meta / user-meta / transient / db-table / file, key}` か null
- `missingEdge`: `producer`（入力側の経路が無い）/ `consumer`（届く先が無い）/ `auth-use`（得た認証材料の使い道が無い）/ `reachability`（届く条件が無い）/ `precondition`（前提が作れない）
- `sourceTrace`、`labObservations`

つまり **Lead は既に「何を獲得したか（primitive）」と「何が欠けているか（missingEdge）」で記録されている**。所有者の言う形はもう台帳にある。足りないのは、この primitive を次の周に渡して組み合わせる処理と、群の重複排除を Lead にも当てることの 2 つである。本番の Lead 668 件（10-26〜27）の最多は `partial-execution` + `producer` 欠けで 110 件、次が `partial-execution` + `producer` + `db-table` で 53 件。「書き込める場所は見つかったが、攻撃者がそこへ値を置く経路が無い」が大半で、組み合わせの材料になる。

## 3. 組み合わせたときのアーキテクチャ

### 3.1 形

```
Harness: 列挙 → 区画 → 1 区画 1 体 ──→ 正規化・群 ──→ 2 周目の入力（同じ対象の primitive 一覧） → 組み合わせ役 1 体 ──→ 正規化・群 → 段 1b → Lab
AI     :                     読む・たどる・書く                                                     primitive を読んで 1 本につなぐ
```

- **1 周目（分担）**: Harness が対象の入口と出口を列挙し（機械的に拾える登録と呼び出し ＋ profile の WordPress 本体の固定一覧）、sink 種別で区画に切り、1 区画を 1 体に渡す。Root は無い。各体は自分の区画の中で入力側の列挙を足し、Finding か Lead（primitive）を書く。Harness は「渡した行」と「AI が足した行」を分けて記録する。
- **束ね**: Harness が群のキーで Finding をまとめ、Lead にも同じキーを当てる。
- **2 周目（組み合わせ）**: Harness が同じ対象の Lead を全件そろえ（重複をまとめ、primitive と欠けている辺と storage で並べた一覧にする）、組むかどうかは決めずに 1 体に渡す。1 体が一覧を読んで自分で組を選び、1 本の経路になれば Finding、ならなければ Lead のまま、組んだ Lead の番号と理由を書く。周回数と件数の上限は設定で固定（PRISM 型なら 1、Argus 型なら Lead が尽きるまで）。Harness が型合わせで候補を作る案は、判断の先取りになり規則が増えるので採らない（所有者の指摘、2026-10-27）。
- **検証役の分離**: Lab を使う判断を探索の文章に頼らず、Finding ごとに Harness が Lab 付きの 1 体を起こす（いまの handoff の形を探索中にも使う）。

### 3.2 塩梅の規則

両側に寄りすぎないための線は 1 本で引ける。**「入力が同じなら出力が同じ処理」は Harness、「読んで決める処理」は AI。** 具体的には:

| Harness（決定論） | AI（判断） |
|---|---|
| 入口・出口の機械的な列挙、本体の固定一覧 | 区画の中で入力側を足す、動的な callback を解く |
| 区画の切り方、体数、周回数、制限時間 | 区画の中の読み順、仮説 |
| 群のキー、重複排除、Lead の全件を並べた一覧（床） | どの Lead を組むか、組が 1 本の経路になるかの判断 |
| Lab の供給、canary、要求の捕捉、観測の記録 | 前提の作り方、攻撃者位置での手順 |
| 出口の park（境界外の impact）、段 1b の reject の記録 | 段 1b の 2 問への答え |
| 台帳と Private Evidence | 報告の文 |

「外から確認しづらい」を避ける仕組みは、AI の判断に必ず機械的な記録を添えること。1 周目なら「渡した行と足した行」、2 周目なら「読ませた Lead の一覧と、組んだ Lead と、つながらなかった理由」、検証なら「捕捉した要求と観測」。これで AI が何をしたかは台帳から読め、AI が何を考えたかは diagnostic から読める。

### 3.3 過去の失敗との違い

2026-10-11〜18 の索引・dispatch・coverage は、Harness が「探索の手がかり」を Root 1 体に足した。今回は列挙を「区画と体数を決める台」に使い、各体には自分の区画しか渡さない。Root が無いので「書いてあるのに守られない」が起きない。2 周目で Harness が渡すのは Lead の一覧だけで、どれを組むかは AI が決める。ただし効くかは測ってから決める（同じ 20 対象、k=2、群の数で現行と比較）。

## 4. 順番

1. 契約 v4 で v14 の水準が戻るかを 20 Trial 見る（進行中）。
2. 1 周目の区画分配を Claude Code runtime の上で 1 PR。Root 抜き。現行と並べて測る。
3. Lead に群を当てる（小さい PR）。
4. 2 周目の組み合わせを 1 周だけ足し、Lead が Finding に変わる率を測る。
5. 検証役の分離。
