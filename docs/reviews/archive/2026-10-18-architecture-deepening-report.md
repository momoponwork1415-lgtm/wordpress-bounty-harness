# 2026-10-18 アーキテクチャ深化（deepening）候補の報告

これは報告であり正本ではない。正本は [SPEC.md](../../SPEC.md) と [adr/](../../adr/)。所有者が候補を選ぶための一覧で、実装も grilling も行っていない。図付きの版は同名の [HTML](2026-10-18-architecture-deepening-report.html)。

- 走査: origin/main `fcde290`、`src/` 122 file 37,032 行、`tests/` 94 file 32,612 行。skill は `mattpocock-skills/improve-codebase-architecture`（語彙は `codebase-design`: module / interface / implementation / depth / seam / adapter / leverage / locality）。
- 触らないものとして固定: 8 不変条件、`profiles/wordpress/verification/judges.ts` の成功条件、`prompts/*.md` 本文、既存台帳 event の形、`policy/`。すべての候補はこれらを変えない。
- 順位は価値 / リスク。候補 1〜4 が Strong、5〜8 が Worth exploring、9 が Speculative（PARKING の再開条件が先）。

## 候補一覧（順位順）

### 1. Ledger に `readAll(query)` を持たせ、35 箇所の 1000 件ページング loop を吸収する — Strong

- module: `src/ledger/index.ts`（interface は append / read / usage / stops / funnel）。
- 現状: `read({limit: 1000, afterSequence})` の loop が 14 file 35 箇所に再実装され、`cli/pipeline.ts`・`cli/continuous.ts`・`review/export.ts` が各自 private `readAll` を持つ。
- 提案: `Ledger.readAll(query)`（または iterator）を 1 本足し、loop と 3 helper を消す。append も event の形も触らない。
- test: `tests/ledger/ledger.test.ts`（16 件）に readAll 1 件追加。消費側 test は無変更で通ることが条件。
- 不変条件リスク: なし（読み取りのみ）。
- 規模: 1 file +15 行、14 file 約 −120 行。
- PARKING 吸収: なし。

### 2. WordPress campaign session: config・policy・boundaries を 1 回で開く — Strong

- module: `src/cli/wordpress.ts`（1,733 行、直近 10 日で 34 commit の最頻変更 file）、`src/cli/wordpress-host.ts` の `hostStatus`。
- 現状: `loadConfig` → `options.boundaries(config, state)` → `new Verification(...)` の並びを CliProfile の 8 method がそれぞれ書く（loadConfig 8 回、boundaries 8 回、Verification 3 回）。WordPress 版・prompt 変種の整合性 check が `loadSelectInput` と `runWordPressCampaign` に同文で 2 回。`hostStatus` は同じ config と selection を schema なしで `JSON.parse` し `runWallTimeMinutes` / `maximumTargets` を取る（重複 config 読みの 3 つ目）。
- 提案: `openWordPressCampaignSession(configPath, state, overrides)` を 1 本置き、config・policy・整合性・boundaries・Verification・`setupFor`・`reconstructionFor`・host 事実をその implementation に沈める。method は session を受けて本体だけを書く。
- test: `tests/cli/cli.test.ts`（66 件）は `runCli` と fake boundaries 越しなので無変更。session 単体 test を 5 件ほど新設（整合性 check の失敗 2 件を含む）。
- 不変条件リスク: なし。
- 規模: 3 file、約 +150 / −250 行。
- PARKING 吸収: 直接なし。候補 3・4 の前提。

### 3. prompt registry を 1 枚の表にし、4 つの ID 一覧と contract 対応表を吸収する — Strong

- module: `src/profiles/wordpress/prompts/index.ts`、`src/cli/wordpress.ts` の campaign config schema と `planWordPressDiscovery` の `outputContractFor / coverageFor / objectiveOnly`。
- 現状: 「どの prompt が、どの output contract（v1 / v2 / v3）を受け、どの mode で起動でき、既定か比較 arm か履歴照合用か」が、`WORDPRESS_DISCOVERY_PROMPT_IDS`（18）、`WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS`（7）、switch 19 case、schema の promptId enum ×2、preprocess の mode 推定（6 比較）、contract 分岐の 6 箇所に文字列列挙で散る。1 prompt を足すと 6 箇所。
- 提案: `prompts/registry.ts` に 1 行 1 prompt（id・file・contract・coverage・objectiveOnly・modes・status: default / arm / history-only / archived）を置き、ID 一覧・runnable enum・contract 選択・mode 推定を導出する。`.md` 本文と digest は触らない。archived 行は ledger の `promptVariant` 照合のため読み取り専用で残す。
- test: `tests/profiles/wordpress/discovery-prompts.test.ts`（17 件）と `tests/cli/examples.test.ts`（12 件）が digest・mode・enum を pin。導出値が同一なら無変更。
- 不変条件リスク: なし（agent に渡る文章は変わらないので owner-approved は不要）。
- 規模: 3〜4 file、約 +60 / −120 行。
- PARKING 吸収: 「archive prompt 10 版」「旧 arm の examples」「`assignment` mode」の削除を行単位にする。

### 4. `planWordPressDiscovery` を profile の `discovery/plan.ts` へ移し、自分の interface で test する — Strong

- module: `src/cli/wordpress.ts` L884–1173（約 290 行）→ `src/profiles/wordpress/discovery/plan.ts`（新）。
- 現状: SPEC §4 は `cli` を「薄く接続する」と定めるが、prompt 本文の節の並べ方、Lab 認証情報の行、contract の版選択、Trial ordinal への arm 割付という WordPress discovery の中心知識が cli に居る。test 経路は `runCli` 経由（`cli.test.ts` 4,822 行）だけ。
- 提案: 入力（config・target・snapshot・lab handle・source・assets・runtimeProfile・clock・newId）を受け、`CampaignPipeline["discovery"]` の戻り値を返す純関数 module として profile に置く。cli は session（候補 2）を渡して 1 行で呼ぶ。
- test: 新設 `discovery-plan.test.ts` で「Lab 無しの Trial には Lab 節が無い」「索引 off なら `entryIndex.enabled=false`」「v5 + 索引で contract v3 と coverageSchema」等 10 件程度を直接 pin。既存 cli test は無変更。
- 不変条件リスク: なし（prompt に渡る文字列は同一、Harness 生成節の雛形は変えない）。
- 規模: 3 file、移動 290 行 + 新 test 約 150 行。cli/wordpress.ts は 1,733 → 約 1,400 行。
- PARKING 吸収: `assignment` mode 削除時の変更箇所がこの file に閉じる。

### 5. Lab scenario 定義が自分の setup script と再現注記を持ち、plugin 別 adapter 10 本を表の行にする — Worth exploring

- module: `src/profiles/wordpress/lab/scenarios.ts`（432 行、15 定義 + digest pin）、`wordpress-initialization.ts`（433 行）、plugin 別 adapter 10 file 428 行（brizy ×2、download-monitor、download-manager、user-registration ×2、wpdiscuz、wp-members、relevanssi、simply-schedule-booking）、`src/cli/wordpress.ts` の `reconstructionFor`。
- 現状: 1 scenario が「定義行 + adapterDigest」「adapter file の PHP script」「initialization の `seedScenarioX()` と `if (id === …)`」「cli の再現注記（TranslatePress 文言直書き）」の 3〜4 file に分散。削除は 3 file × 8 本の手作業。
- 提案: 定義に `setup`（順序付き script 列）と `reconstructionNotes` を持たせ、initialization は列を順に `wp eval` する。digest 変化を避けるなら定義本体の形は変えず id をキーにした隣接表に置く。削除は行削除。
- test: `tests/profiles/wordpress/wordpress-lab.test.ts`（42 件）が provision 結果を pin。adapter 単体 test 3 本（200 行）は表の test に置き換える（replace, don't layer）。
- 不変条件リスク: なし（Lab 供給は gVisor 内のまま、canary 配置は触らない）。注意: 定義 object の形を変えると `canonicalDigest(definition)` が変わり 15 件の pin と版更新が要る（SPEC §7）。隣接表方式なら digest 不変。ADR 0026 と一致。
- 規模: 約 15 file、net −600 行。
- PARKING 吸収: 「plugin 固有 Lab adapter 8 本の削除」。

### 6. `runDiscoveryCampaign`: 14 個の `let` を 1 つの TrialOutcome record に、再開走査を内部 seam に — Worth exploring

- module: `src/discovery/campaign.ts`（855 行、`runDiscoveryCampaign` 1 関数 580 行、内側 `executePlanned` 300 行）。
- 現状: 外の interface は小さく深い（test 27 件が 1 関数越しに通る）が、implementation で receipt の 14 欄が `let` として 300 行に渡り、`discovery-run-finished` の組み立てが try / catch / finally の 3 経路に分かれる。再開走査（finishes / started / spentOrdinals）70 行も同じ関数内。
- 提案: 1 Trial の実行を `TrialOutcome`（receipt 欄・failure・counted・foundNew・heldBoundary）を返す内部 module `executeTrial` にし、event は `finishedEventFrom(outcome)` 1 関数で 1:1 に写す。再開走査は `discoveryProgress(ledger, campaignId, snapshotDigest)` に切る。外 interface と event の形は不変。内部 seam は自分の test だけに使い interface に出さない。
- test: `tests/discovery/campaign-run.test.ts`（18 件）と `campaign-stop-resume.test.ts`（9 件）が無変更で通ることが完了条件。
- 不変条件リスク: なし（event の形 1:1、incomplete の理由付けは同一）。
- 規模: 1 file → 3 file、行数 ±0。
- PARKING 吸収: なし。

### 7. Codex transport: transcript 復号を内部 module に切り、`incompleteExecution` の位置引数 7 個を options に、WordPress の語を run 入力へ — Worth exploring

- module: `src/discovery/codex-native-agent-runtime.ts`（1,719 行）、`src/discovery/codex-gvisor-sandbox.ts`。
- 現状: 復号系（`decodeTranscript`・`usageFrom*`・`observedFrom*`・`decodeChildRollout`・`providerLimitOf`・`brokerRequestBytesExceeded`・`providerPolicyDetail`）約 450 行の純関数が class の周りに並ぶ。`incompleteExecution(state, reason, completedAt, grantReceiptDigest?, providerLimit?, reasonDetail?, attachment?)` を 17 箇所が `undefined` を位置で埋めて呼ぶ。汎用 discovery が `/workspace/wordpress`（×5）と `/\bwordpress\b/`（labRequests 判定）を知っている（ADR 0011 の合図。`tests/architecture/module-boundary.test.ts` の語彙 pattern には `wordpress` が無いので検出されない）。
- 提案: 復号を `codex-transcript.ts` に移し `decodeCodexRun(result, run) → DecodedRun | { reasonDetail }` の 1 interface にする。`incompleteExecution` は options object。依存 mount path は `run.dependencySource.mountPath` として profile が渡し、labRequests 判定は `run.lab.endpoint` の hostname を使う（現値はどちらも "wordpress" なので receipt は同一）。architecture test に `\bwordpress\b` を足す。
- test: `tests/discovery/codex-native-agent-runtime.test.ts`（23 件）と `codex-gvisor-sandbox.test.ts`（6 件）が receipt と mount を pin。復号 module に直接 test を 6 件ほど足す。
- 不変条件リスク: 2・3 に隣接するが変更しない（`admittedRun` / `sandboxAdmissionFailure` / `assertBrokerAddress` と broker は対象外。PR の「変えなかったこと」に明記）。
- 規模: 1 → 2 file、移動 450 行、約 −60 行。
- PARKING 吸収: なし。

### 8. host 側の source / snapshot 供給を 1 回で開く（`wordpress-host.ts`） — Worth exploring

- module: `src/cli/wordpress-host.ts`（711 行）。
- 現状: `selectionBoundaries` と `boundaries` が同じ 5 つ（`openWordPressOrgTargetSource`・`openMaterializedSources`・`openWordPressCoreSource`・`openSnapshot`・`openTranscribedWordfenceProgramme`）を別々に組み、`latestVersion` が 3 つ目の targetSource を組む。`loadSnapshot` は snapshot store の file 配置（`${digest.slice(7)}.json`）を知る。
- 提案: `openWordPressHostSources(host, wordpressVersion, deps)` に 5 つの open と `loadSnapshot / sourceFor / coreOf` を沈め、selection・campaign・latestVersion はそれを受ける。`snapshot` module に `load(digest)` を足して path 知識を戻す。
- test: `tests/cli/wordpress-host.test.ts`（4 件）と `cli.test.ts` が runDocker / fetch を差し替えて pin。無変更で通ることが条件。
- 不変条件リスク: なし（preflight と gVisor 起動条件は触らない）。
- 規模: 1〜2 file、約 −100 行。
- PARKING 吸収: なし。

### 9. CLI を command table にし、PARKING の削除候補を行削除にする — Speculative

- module: `src/cli/index.ts`（1,600 行、`runCli` の switch 800 行、34 command、`humanMinutes` + `recordHumanEffort` の対が 5 回）。
- 現状: `Review` と `Ledger` は深いが、その上の cli 層は 34 case が parse・実行・整形を 1 つの switch に書き、command の追加削除が switch・USAGE 文字列・options 表の 3 箇所に散る。PARKING の削除 4 件はいずれも case 削除だが、test（`cli.test.ts` 66 件）の該当行特定も手作業。skill 3 本（`.claude/skills/wbh-*`）が実際に打つのは review export・decide・scope・reproduced・reverify・draft・authorize。
- 提案: command を表の行（name・usage・parse・run）にし、USAGE と options を導出する。削除候補: `review open`（cli 20 行）、`eval score / keys / rubric`（cli 130 行 + `evaluation/key-registry.ts` 30 + `blind-rubric.ts` 41 + `profiles/wordpress/answer-key.ts` 93）、replay Verifier #126（`smoke-replay-verifier.ts` 207 + `smoke-replay-recipe.ts` 455 + `lab/recorder/replay-cli.ts` 387 + `reverify --smokeReplayDigest` + tests 438 行 + `scripts/smoke-real-lab.mjs`）。`eval compare` は OPERATIONS §8 が旧 Trial の読取用と記すので残す選択もある。
- test: `cli.test.ts` の削除 command 分を消し、表の USAGE 導出に 1 件。
- 不変条件リスク: なし（6・7 の判断点は Review class 側。削除対象は表示と研究用採点）。
- 規模: 約 −1,500 行（src）、−900 行（tests）。
- PARKING 吸収: 「review CLI の多機能を skill 側へ」「review open」「eval score / keys / rubric / compare」「replay Verifier（#126）」。再開条件（Step 2、skill 3 本が 10 件回って出力が安定）が先。

## 推奨順

1. 候補 2（session）→ 候補 4（plan 移動）→ 候補 3（registry）。いずれも `cli/wordpress.ts` に集まり、順にやると 1,733 行が約 1,000 行になる。
2. 候補 1（Ledger.readAll）は独立で最小。どの順でも最初の 1 PR にできる。
3. 候補 5〜8 は各 1 PR。候補 9 は PARKING の条件が満たされてから。

## やらないこと

- 8 不変条件、`judges.ts` の成功条件、`prompts/*.md` 本文、台帳 event の形、`policy/` は対象外（依頼の固定条件）。
- `src/cli/pipeline.ts`（1,606 行）を新しい汎用 module `campaign/` へ移すこと。`runCampaignPipeline` は既に 1 本の深い interface で、`cli.test.ts` 越しに pin されている。SPEC §4 の module 境界は Step 1 の間凍結（DEVELOPMENT §2）なので新 module を足さない。候補 1 がこの file の 11 loop を吸収する。
- `src/ledger/index.ts`（1,751 行）の分割。interface は 5 method で深い。`funnel` の長さは読み取り専用の集計であり、分けても複雑さが移るだけ（deletion test で「移る」側）。
- `tests/cli/cli.test.ts`（4,822 行）の分割だけを目的にした変更。test は interface に従う。候補 4 で plan の test が profile 側に移り、候補 9 で削除 command 分が消えるのが正しい縮み方。
- profile interface の汎用化（2 つ目の profile まで行わない、ADR 0011）。候補 4・7 は WordPress の語を profile 側へ戻すだけで、汎用 interface は増やさない。
- `provider-credential-egress-broker.ts`（865 行）と `provider-credential-proxy.ts`（576 行）。不変条件 2 の実装そのもので、読んだ範囲で interface は小さい。深化より監査の対象。
- `verification/index.ts`、`review/index.ts`、`selection`、`snapshot`、`lab/index.ts`、`infrastructure/`: interface が小さく implementation が厚い（既に深い）。候補 8 で `snapshot` に `load(digest)` を 1 本足す以外は触らない。
- 文書の整理（PARKING 2026-10-13、`docs/reviews/2026-10-12-consolidation-and-production-first.md` §4）。走査範囲が `src/` と `tests/` のため対象外。
- 継続運転の journal / lease / claim 系 branch（PARKING 2026-10-14）。merge されていない branch は走査していない。
- `src/discovery/provider-credential-proxy.ts` の "plugins" と `review/index.ts` の "plugs in" は ChatGPT と英語の慣用で、ADR 0011 の WordPress 語彙ではない。

## 測った数字

| 対象 | file | 行 |
| --- | ---: | ---: |
| `src/` 全体 | 122 | 37,032 |
| `tests/` 全体 | 94 | 32,612 |
| `src/cli/` | 8 | 6,614 |
| `src/discovery/` | 16 | 6,594 |
| `src/profiles/` | — | 16,687 |
| `src/cli/wordpress.ts` | 1 | 1,733 |
| `src/cli/index.ts` | 1 | 1,600 |
| `src/cli/pipeline.ts` | 1 | 1,606 |
| `src/cli/wordpress-host.ts` | 1 | 711 |
| `src/discovery/campaign.ts` | 1 | 855 |
| `src/discovery/codex-native-agent-runtime.ts` | 1 | 1,719 |
| `src/ledger/index.ts` | 1 | 1,751 |
| `tests/cli/cli.test.ts` | 1 | 4,822（it 66） |
| `tests/discovery/codex-native-agent-runtime.test.ts` | 1 | 1,737（it 23） |
| `tests/discovery/campaign-run.test.ts` + `campaign-stop-resume.test.ts` | 2 | 1,432（it 27） |
| 1000 件ページング loop | 14 file | 35 箇所 |
| `loadConfig` / `options.boundaries` 呼び（cli/wordpress.ts） | 1 file | 8 / 8 箇所 |
| prompt ID の列挙箇所 | 2 file | 6 箇所 |
| plugin 別 Lab adapter | 10 file | 428（test 3 file 200） |
| PARKING 削除候補（候補 9） | 約 12 file | 約 1,500（test 約 900） |
| 汎用 discovery の WordPress 語 | 2 file | `/workspace/wordpress` ×5、`\bwordpress\b` ×1 |
