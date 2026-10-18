# 2026-10-18 使っていない機能の棚卸し（削除候補の一覧）

これは報告であり正本ではない。正本は [SPEC.md](../SPEC.md) と [adr/](../adr/)。所有者の「使っていない機能などは削除対象かも」（2026-10-18）に対して、何が使われていないかを根拠付きで並べたもの。**ここでは何も削除していない。採否は所有者が行ごとに決める。** 同日の [アーキテクチャ深化報告](2026-10-18-architecture-deepening-report.md) 候補 9（CLI command table）と [PARKING.md](../PARKING.md) 2026-10-14 行（削除候補 4 件）の分析は繰り返さず、その先を埋める。HTML 版は同名の [.html](2026-10-18-unused-feature-inventory.html)。

## 走査の条件

- 対象: origin/main `c8d390c`（2026-10-18）。`src/` 165 file 38,678 行（うち `.ts` 124 file）、`tests/` 33,177 行。code は読み取りだけで、`src/` は触っていない。
- 「参照」の数え方: repo 内の skill 3 本（`.claude/skills/wbh-*/SKILL.md`。`~/.claude/skills/wbh-*` は repo 外に存在しない）、`docs/agents/*.md`・`docs/DEVELOPMENT.md`・`docs/SPEC.md`・`docs/OPERATIONS.md`、`docs/evaluation/*.md` と `docs/reviews/2026-10-1*.md`、`examples/`・`scripts/`・`src/profiles/wordpress/policy/`、`tests/` を `grep` で数えた。test は配列形（`run("eval", "score", …)`）も数えた。
- 台帳: `~/.local/state/wordpress-bounty-harness-v6-measure-20261018/{brizy,relevanssi,tp326}/state/ledger.sqlite` を read-only で開き、`event_type` の件数だけを取った（3 台帳、12 campaign、98 event）。Private Evidence は開いていない。**本番台帳は読んでいない**: 依頼にあった `~/.local/state/wordpress-bounty-harness-prod/` は存在せず、本番の state は別名（`~/.local/state/wordpress-bounty-harness`）にあると memory が示すが、依頼の「それ以外の `~/.local/state` に触らない」に従って開かなかった。本番で実際に出た event 種別の件数は未確認。
- 行数は `wc -l` と case の開始行差による概算。test の削減行は別に書く。

## 規則の前提（この表で「残す」と書く根拠）

- 不変条件 1〜8（SPEC §2、AGENTS.md）。判定器・broker・Private Evidence・台帳の追記専用・人間の 2 判断点に関わる code は、未使用でも削除候補にしない。
- AGENTS.md: 「prompt 本文を変えたら版を上げ、旧版を残して digest pin を更新する。旧 prompt は過去 Trial の目的文と digest を照合するために維持する」「台帳の旧 `stage` / `continuationOf` 付き event も読み続け、既存 event を消さない」。
- DEVELOPMENT §2: Step 1 の間は不変条件・module 境界・**判定器の集合**・選定方針の構造・探索 prompt を凍結。
- PARKING 2026-10-14: 「週次 smoke の replay Verifier（#126）、`assignment` mode、旧 arm の examples、`eval score / keys / rubric / compare`、`review open`、archive prompt 10 版、plugin 固有 Lab adapter 8 本の削除」は **Step 1 合格後の整理 PR** と決まっている。PARKING 2026-10-13: review CLI の多機能を skill 側へ寄せるのは Step 2。
- ADR 0029: `wp2shell-bounty-v2`・`short-objective-managed-v4` は比較 arm、`screening-v1` は過去 Trial の構成照合用に保持。ADR 0032 Q27: CLI は機械向け、既存の多機能は削除せず拡張を止め、整理は Step 2。ADR 0032 2026-10-17: `sensitive-object-access`・`content-deletion`・`options-update`・`privesc-to-contributor+`・`auth-bypass-non-admin` は出口で `finding-parked`。

推奨の記号: **削除候補** = 参照 0 で規則上の障害が無い、または PARKING が既に削除を決めている（条件付き）。**保留** = 使われていないが規則か進行中の作業が絡み、所有者の判断が要る。**残す** = 使われている、または規則で保持が決まっている。

## 軸 1: CLI command（37 subcommand）

参照列は `skill / 運用文書（agents・DEVELOPMENT・SPEC・OPERATIONS）/ 測定・review 文書 / examples+scripts / test 起動数`。path は `src/cli/index.ts` の `case` 開始行。

| command | path | 参照 | 規則 | 削除規模 | 推奨 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `review open` | L1097–1115、event `review-item-opened` | 0 / 0 / 2 / 0 / **0** | PARKING 2026-10-14 が Step 1 合格後の削除と決定 | cli 19 行 + `humanMinutes` 呼び 1 + option `opened` は decide が使うので残る | **削除候補**（PARKING 条件） | skill も運用文書も呼ばない。test も無い。手で再現した事実は `review reproduced` が記録する。event 種別の reader は残す |
| `eval score` | L1500–1541 | 0 / 2 / 3 / 0 / 4 | OPERATIONS §8「任意の研究用互換機能。本番には使わない」。PARKING が削除を決定 | cli 42 行 + `evaluation/key-registry.ts` 30 + `profiles/wordpress/answer-key.ts` 93 + `evaluation/index.ts` の location-overlap 部分 + CliProfile `answerKeys` / `locationsOf` | **削除候補**（PARKING 条件） | Answer Key は Git 外にしか無く、ベンチマークは所有者実績 case だけに縮んだ（2026-10-16）。test: `tests/evaluation/key-registry.test.ts` 37、`location-overlap.test.ts` 132、`tests/profiles/wordpress/answer-key.test.ts` 62 |
| `eval keys` | L1542–1576 | 0 / 1 / 0 / 0 / 1 | 同上 | 上に含む（cli 35 行） | **削除候補** | `eval score` と一体 |
| `eval rubric` | L1577–1597 | 0 / 1 / 0 / 0 / 1 | 同上 | cli 21 行 + `evaluation/blind-rubric.ts` 41 + `examples/evaluation/blind-rubric.template.json` 14 + test 52 | **削除候補** | 人間の盲検採点は一度も運用されていない（台帳 event も無い） |
| `eval compare` | L1624–1652 | 0 / 1 / 0 / 0 / 2 | OPERATIONS §8「旧軸の比較。過去 Trial の読取用」。PARKING が削除を決定。深化報告は「残す選択もある」 | cli 29 行 + `evaluation/index.ts` の compare 部分 + `interval.ts` 50 + test `compare.test.ts` 343 | **削除候補（弱）** | 旧二段構え Trial の history / prompt / continuation 軸。ablation mode（軸 2）と対で消える。旧 Trial を読み返す必要が残るなら保留 |
| `eval prospective` | L1598–1623 | 0 / 1 / 1 / 0 / 1 | 規則なし（PARKING に無い）。OPERATIONS §8 に 1 行 | cli 26 行 + `profiles/wordpress/advisory.ts` 53 + `evaluation/index.ts` prospective 部分 + CliProfile `advisories` + test `prospective.test.ts` 265 | **保留** | 「後日公開 advisory で本番台帳を再採点」は設計上の価値が残る。ただし 2026-10-16 以降の運用で 1 度も使われていない |
| `eval case-blocked` | L1464–1499、event `evaluation-case-blocked` | 0 / 0 / 2 / 0 / 1 | docs/evaluation/README.md が再発見ベンチマークの手順として記す。PARKING に無い | cli 36 行 + event writer | **保留** | 13 case 拡張は 2026-10-16 に中止。所有者実績 case だけなら使う場面は少ないが、ベンチマーク手順の一部 |
| `review inspect` | L978–1006 | 0 / 1 / 3 / 0 / 2 | PARKING 2026-10-13: review CLI の人間向け表示は Step 2 で skill へ | — | 残す | skill が `review export` を使うので表示用途は重なるが、整理は Step 2 の決定 |
| `review reproduced` | L1116–1145 | 2 / 1 / 2 / 0 / 0 | OPERATIONS 表 7 行目 | — | 残す | test 起動 0 は test の欠落であり未使用ではない |
| `review dedupe` / `scope` / `draft` / `authorize` / `submitted` / `outcome` | L1146–1293 | 1〜3 / 1 / 1〜4 / 0 / 1〜4 | 不変条件 6・7 の判断点を記録。PARKING: Step 2 で skill へ | — | 残す | `review outcome` は skill 0 だが報酬記録の唯一の入口 |
| `ledger coverage` | L1433–1451 | 0 / 0 / 0 / 0 / 1 file | #336（当日 merge） | — | 残す | 新規。v6 測定で使う |
| `lab up --campaign … --config`（review 用でない方） | L1326–1367 | skill は `--for-review` だけ。OPERATIONS L268 が手順を記す | — | — | 残す | 検証 Lab を手で立てる経路。`--port` / `--db-port` は OPERATIONS のみに出る |
| `campaign run --repeat` / `--retry-incomplete` | L916–963 | `--retry-incomplete`: 運用文書 0、review 文書 3、test 2。`--repeat`: 運用文書 1 | ADR 0029「開発セットの 3 回反復は独立 Trial」 | 各 10 行前後 | 保留 | 開発セット測定の道具。本番 runner は使わない |
| その他 24 command（`select`、`campaign run`、`continuous *`、`review` / `export` / `decide` / `parked` / `reverify`、`verify next`、`ledger funnel` / `stops` / `usage` / `runtime`、`history status`、`runtime check`、`lab cleanup` / `down`） | — | 運用文書または skill に 1 件以上 | — | — | 残す | 本番 runner・skill・運用手順が呼ぶ |

未参照の判定: skill と運用文書の両方で 0 なのは `review open`・`eval case-blocked`・`ledger coverage` の 3 つ。skill だけ 0 で運用文書にあるものは、ADR 0032 Q27 の「機械向け」の位置づけどおり。

## 軸 2: 設定 option（campaign / host / selection schema）

| option | path | 非使用の根拠 | 規則 | 削除規模 | 推奨 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `mode: "assignment"` + `assignment.{unit,entriesPerRun}` | `src/cli/wordpress.ts` L200–203, 253–260, 269–270, 905–960 | examples 2 file（`translatepress-3.2.5/campaign-luna-ab*.json`、2026-10-10）。policy 0。本番 0 | PARKING 2026-10-14 が削除を決定。**ただし #324（2026-10-18、`discovery/task-plan.ts`）が entry assignment の上に dispatch task 計画を足した** | schema 15 行 + wordpress.ts 約 55 行 + `entry-points.ts` の `planWordPressEntryAssignments` + test | **保留（矛盾の解消が先）** | PARKING は削除、当日の #324 は拡張。所有者が dispatch 構想（docs/reviews/2026-10-18-codex-plan-dispatch-architecture.md）を採るかで決まる |
| `mode: "ablation"` + `ablation.axes[]` / `armBFraction` / `armBPromptId` | wordpress.ts L131–148, 245–252, 316–322; `discovery/campaign.ts` L165–215（`allocateArm`） | examples 2 file（同上）。policy 0。本番 0。cli.test 14 行 | ADR 0013（版付き prompt ablation）は accepted のまま。ADR 0032 #9「A/B 事前登録は Step 1 中止」、PARKING「A/B 事前登録は Step 1 合格後」 | 約 100 行 + `eval compare` と共有の集計 | **保留** | A/B は中止でなく延期。消すなら ADR 0013 の追記が要る |
| `mode: "entry-index-control"`（`entryIndex: false`） | wordpress.ts L222–237 | examples 0（3 file とも `entryIndex: true`）。test 1 | ADR 0029「索引を渡さない比較 Trial は別 arm として記録」。2026-10-16 の v5 比較で使用 | 16 行 | 残す | 比較 arm の定義そのもの |
| `mode: "comparison"` | wordpress.ts L238–244 | examples では明示せず preprocess が推定（short-objective 系 prompt） | ADR 0029 比較 arm | — | 残す | — |
| `lab.scenarioId` | wordpress.ts L188, 307–315, 625–656 | examples 2（値はどちらも `translatepress-translation-data-v1`）。policy 0。test 1 | ADR 0026（汎用 scenario 優先）。PARKING 2026-10-13: precondition 文から scenario を選ぶ仕組みの置き換えは条件待ち | — | 残す | 15 scenario のうち設定から選べる唯一の経路。**grep の範囲では precondition 文から scenario を自動選択する code は現行 main に無く、scenario は `lab.scenarioId` でだけ決まる。** policy/campaign.json は未設定なので本番は常に既定 scenario |
| `lab.translatePress.administratorSecondaryLocale` | wordpress.ts L183–187 | examples 14（すべて TranslatePress 開発セット）。policy 0 | AGENTS: prompt と scenario に対象固有名を入れない（設定 schema は対象外だが同じ匂い） | 5 行 + Lab 初期化の分岐 | 保留 | 開発セットが TranslatePress である間は必要。汎用 campaign schema に plugin 名があるのは ADR 0011 の合図 |
| `lab.customerRole` | wordpress.ts L181 | 必須 boolean だが examples 23 file と policy のすべてが `false`。`true` は src / tests / examples に 0 | Programme Boundary は Customer を攻撃者位置に含む。WooCommerce 常備は PARKING 2026-10-13 | 1 行 + Lab 初期化の分岐 | 保留 | `true` が一度も試されていない option。消すなら Boundary 文の Customer と整合を取る |
| `lab.initialApprovedComment` | wordpress.ts L180, 299–306, 654 | examples 2（`*-comment-fixture.json`、2026-10-11）。policy 0。test 2 | PARKING「旧 arm の examples」と同じ組 | 10 行 | 保留 | `approved-comment-v1` scenario と重複する機能。fixture examples を消すとき一緒に |
| `lab.databaseAccess: "none"` | wordpress.ts L182 | 設定された 4 箇所はすべて既定値 `read-only`。`none` は examples / policy に 0 | ADR 0029 2026-10-18 追記（探索 Lab は任意） | — | 残す | 既定値を持つ enum。`none` は設定で到達できる |
| `discovery.lab: "none"` | wordpress.ts L153–155, 898, 1272 | policy/campaign.json は `attached`。`none` は examples 0。`pipeline.ts` L459 が内部で使う | ADR 0029 2026-10-18 所有者決定「探索用 Lab は任意」 | — | 残す | 当日の所有者決定 |
| `coverage.maxUnvisitedRatio` | wordpress.ts L159–163 | policy/campaign.json が設定。test 1 | ADR 0029 2026-10-17 改訂（v6 depth） | — | 残す | — |
| host `scopePolicyPath` | `src/cli/wordpress-host.ts` L91, 491 | examples 0、policy 0、tests 0。使われれば `loadWordpressScopePolicy` に path を渡す | 規則なし | 3 行 | 保留 | scope 方針 file を差し替える口。一度も使われていないが、Patchstack 追加（PARKING）のときに要る可能性 |
| host `wordfenceHistory` / `legacyHistory` | wordpress-host.ts L93–97 | `host.example.json` が `wordfenceHistory` を設定。`legacyHistory` は examples 0 だが本番 host 設定が持ち、`continuous run` が必須にする | ADR 0032 2026-10-14 決定 3 | — | 残す | — |
| selection `surfaceTagWeights` / `highThreatTags` / `scoreWeights.{surface,highThreat,history}` / `runBudget` | `src/profiles/wordpress/selection/contracts.ts` L36–52 と `WordPressTargetSelection.highThreatSurface` / `runBudget` / `scoreBreakdown.*` | code 注記が「Legacy（ADR 0032 Q5 / Q6）、現行方針では使わない」。policy/*.json 0。examples 5 file（旧手動方針）。tests 2〜3 | ADR 0032 Q5 / Q6。台帳 `target-selected` が `scoreBreakdown` を持つなら reader は残る | schema 約 25 行 + 選定の score 計算の分岐 | 保留 | 旧方針 file と旧 event を読むために残っている。旧 arm examples を消す PR で一緒に判断 |
| selection `historySignals` / `historySource` | contracts.ts L56–66, 69–82 | examples 0、policy 0、tests 1 | ADR 0030「過去の手動指名は読めるまま」 | 約 25 行 | 保留 | ADR 0030 の文言が保持を求める。手動方針 file が Git に 1 つも無いので実害は無い |
| selection `pinnedVersions` / `candidateSlugs`（手動方針） | contracts.ts L54–55, 69–73 | examples 5（開発セット） | 再発見ベンチマーク（所有者実績 case）が使う | — | 残す | — |

## 軸 3: prompt 版（探索 18 + trust-boundary 1 + Verifier 7）

AGENTS.md の規則により、**旧 prompt は削除候補にしない**。ただし PARKING 2026-10-14 は「archive prompt 10 版の削除」を Step 1 合格後と決めているので、2 つの文書が食い違っている。どちらを採るかは所有者。深化報告 候補 3 は、`.md` 本文を消しても台帳の `promptVariant` と digest を照合できるよう「archived 行を読み取り専用の registry 行として残す」案を示している。

| prompt | 行 | examples / tests / docs | 状態 | 規則 | 推奨 |
| --- | --- | --- | --- | --- | --- |
| `wp2shell-bounty-v5` | 34 | 4 / 3 / 9 | 既定（schema default、ADR 0032 2026-10-16） | — | 残す |
| `wp2shell-bounty-v6` | 42 | 1 / 2 / 1 | 測定 arm（`examples/campaign-v6-measure.json`、ADR 0029 2026-10-17） | — | 残す |
| `wp2shell-bounty-v2` | 17 | 3 / 4 / 15 | 比較 arm | ADR 0029 | 残す |
| `short-objective-managed-v4` | 11 | 4 / 3 / 14 | 比較 arm | ADR 0029 | 残す |
| `wp2shell-whitebox-v1.7` | 55 | 1 / 3 / 7 | 所有者の実績 prompt。v5 比較の arm | 2026-10-16 比較 | 残す |
| `screening-v1` | 13 | 0 / 3 / 9 | 構成照合用。`runnablePrompt` から除外済み | ADR 0029 | 残す |
| `wp2shell-bounty-v3` / `-v4` | 11 / 11 | 0 / 5・3 / 13・8 | 旧既定（v3 は ADR 0029 当初、v4 は所有者の 1 回改訂） | AGENTS（digest 照合） | 残す（規則） |
| `wp2shell-derived-v1` / `-v2` | 13 / 9 | 0 / 1 / 1・0 | archive | AGENTS は保持、PARKING は Step 1 合格後に削除 | **保留**（規則の食い違い） |
| `short-objective-v1` / `-v2` | 7 / 7 | 2・3 / 3 / 1・4 | archive。参照は旧 arm examples のみ | 同上 | **保留** |
| `short-objective-managed-v1` / `-v2` / `-v3` / `-v5` | 11 / 11 / 11 / 7 | 2・0・1・0 / 1〜2 / 1〜2 | archive | 同上 | **保留** |
| `wp2shell-single-http-v2` | 9 | 2 / 3 / 1 | archive | 同上 | **保留** |
| `wp2shell-bounty-v1` | 15 | 2 / 1 / 4 | archive | 同上 | **保留** |
| `trust-boundary-v1` | 9 | 0 / 1 / 14 | 不変条件 1 の人間が書いた宣言 | 不変条件 1 | 残す |
| `verifier-v7` / `-v6` | 15 / 15 | 0 / 5・1 / 4 | v7 が現行、v6 は `loadWordPressVerifierPrompt` が受ける唯一の旧版 | #207 / #208 | 残す |
| `verifier-v1` 〜 `-v5` | 7+9+9+11+13 = 49 | 0 / 0 / 3・2・0・0・0 | **code から読めない**（`loadWordPressVerifierPrompt` は v6 / v7 だけを受ける） | AGENTS の規則は探索 prompt の文言だが、Verifier 指示の digest も台帳に記録される（#208） | **保留** | 本文の照合は Git 履歴でも可能。消すなら digest pin を docs に残す |

archive 10 版の本文は計 100 行。削除しても agent に渡る文章は変わらないので owner-approved は不要だが、`WORDPRESS_DISCOVERY_PROMPT_IDS`・switch・schema enum・preprocess の 6 箇所（深化報告 候補 3）を同時に直す必要がある。

## 軸 4: 台帳 event 種別（31）と読取

reader は全種別を残す（AGENTS.md）。ここでは **writer** の有無と、v6 測定台帳での出現を見る。

| event 種別 | src の writer | test file 数 | v6 測定台帳での件数（98 中） | 規則 | 推奨 |
| --- | --- | --- | --- | --- | --- |
| `candidate-rejected` | **0**（#111 / ADR 0018 で writer 削除。`ledger/index.ts` L280, 623, 1339 が読む） | 2 | 0 | ADR 0018、AGENTS（旧 event を読み続ける） | 残す（reader のみ） |
| `child-report-recovered` | src 0。`scripts/recover-child-reports.mjs` L205–206 だけが書く | 0 | 0 | OPERATIONS L247 が手順を記す | 残す（script 経路） |
| `review-item-opened` | `cli/index.ts`（`review open` のみ） | 2 | 0 | PARKING（`review open` 削除） | `review open` と一緒に writer を消し、reader は残す |
| `evaluation-case-blocked` | `cli/index.ts`（`eval case-blocked` のみ） | 2 | 0 | docs/evaluation/README.md | 保留（軸 1 と同じ） |
| `verification-lab-failed` | `verification/index.ts` | 1 | 0 | 不変条件 4（失敗は incomplete） | 残す |
| `finding-precondition-classified` | `codex-verifier.ts` | 1 | 1 | ADR 0022 | 残す |
| `discovery-report-recovered` | `discovery/reaccept-candidates.ts`（CLI 表に無い別入口 `reaccept-cli.ts`） | 1 | 0 | ADR 0018 | 残す（運用の回復手順） |
| `human-effort-recorded` / `human-reproduction-recorded` / `review-decided` / `scope-assessed` / `draft-saved` / `external-action-authorized` / `submission-recorded` / `submission-outcome` | `review/index.ts` | 1〜5 | 0（測定台帳には review 操作が無い） | 不変条件 6・7 | 残す |
| `target-selected` / `selection-batch-bound` / `snapshot-frozen` / `lab-provisioned` / `discovery-run-started` / `-finished` / `discovery-concluded` / `campaign-stopped` / `target-skipped` / `candidate-normalized` / `candidate-held` / `finding-recorded` / `finding-parked` / `lead-recorded` / `verifier-run-finished` / `verification-finished` | 複数 | 2〜17 | 13 種別が出現（`lab-provisioned` 19、`discovery-run-*` 各 13、`target-*` 各 11、`snapshot-frozen` 11、`candidate-normalized` 5、`verifier-run-finished` 4、`verification-finished` 4、`finding-recorded` 3、`lead-recorded` 2、`finding-precondition-classified` 1、`discovery-concluded` 1） | 主経路 | 残す |

旧 `stage` / `continuationOf`（L74–76）、`discovery-run-finished.stage`（L246）は reader として残る。台帳の query / 集計（`read` / `usage` / `stops` / `funnel`）はすべて CLI から到達する。

## 軸 5: 検証 scenario・plugin 固有 Lab adapter・判定器

### scenario 15 件（`src/profiles/wordpress/lab/scenarios.ts` L38–224）と adapter 10 file 428 行

scenario は `lab.scenarioId` でだけ選ばれる（軸 2）。policy/campaign.json は未設定なので、本番で到達できる scenario は既定だけで、以下 14 件は開発セットの設定か test からしか到達できない。

| scenario | adapter（行） | examples / docs(evaluation・OPERATIONS) / tests | 規則 | 削除規模 | 推奨 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `translatepress-translation-data-v1` | なし（初期化の分岐） | 2 / 3 / 2 | 開発セット（TranslatePress） | — | 残す | 唯一設定から使われる scenario |
| `approved-comment-v1` | なし | 0 / 0 / 3 | ADR 0026（plugin 非依存） | — | 残す | 汎用。Stored XSS 判定器の消費者 |
| `private-post-v1` / `private-page-v1` | なし | 0 / 0 / 4・2 | sensitive-object 判定器の前提。ADR 0032 2026-10-17 で同分類は出口で parked | 定義 2 行組 約 30 行 | 保留 | 判定器の集合は Step 1 凍結。消すなら sensitiveObject 判定器と一緒に Step 2 |
| `approved-comment-searchable-v1` | `relevanssi-search-index.ts`（56） | 0 / 0 / 1 | PARKING「plugin 固有 Lab adapter 8 本の削除」。13 case 拡張は 2026-10-16 中止 | 56 + 定義 12 + 初期化分岐 | **削除候補**（PARKING 条件） | Relevanssi の再発見 case は所有者実績でない |
| `public-booking-page-v1` | `simply-schedule-booking.ts`（44） | 0 / 0 / 1（test 65 行） | 同上 | 44 + 65 test | **削除候補** | 同上 |
| `public-builder-page-v1` / `public-file-attachment-form-v1` | `brizy-builder-page.ts`（46）/ `brizy-file-attachment-form.ts`（75） | 0 / 0 / 1・1（test 69 + 66） | 同上。v6 測定の `brizy` 台帳は既定 scenario で走った | 121 + 135 test | **削除候補** | Brizy は所有者実績 case でない |
| `public-file-download-v1` | `download-monitor-adapter.ts`（35） | 0 / 0 / 1 | 同上 | 35 | **削除候補** | — |
| `public-and-subscriber-downloads-v1` | `download-manager-adapter.ts`（29） | 0 / 0 / 1 | 同上 | 29 | **削除候補** | — |
| `public-member-post-v1` | `wp-members-adapter.ts`（37） | 0 / 0 / 2 | 同上 | 37 | **削除候補** | — |
| `public-registration-and-account-v1` / `public-free-membership-v1` / `-v2` | `user-registration-adapter.ts`（26）/ `user-registration-membership-adapter.ts`（58） | OPERATIONS 1 / 1・1・0 / 1 | OPERATIONS に残る記述が 1 件。所有者実績 case に含まれるかは所有者の一覧で確認が要る | 84 | 保留 | 所有者実績の再発見 case が User Registration を含むなら残す |
| `public-plugin-comment-v1` | `wpdiscuz-adapter.ts`（22） | OPERATIONS 1 / 1 / 2 | 同上 | 22 | 保留 | 同上 |

adapter の削除は深化報告 候補 5 のとおり `scenarios.ts` の定義行・digest pin・`wordpress-initialization.ts` の分岐・`cli/wordpress.ts` の再現注記の 3〜4 file にまたがる。

### 判定器 9 件（`judges.ts` L626–1413、合計 1,413 行）

| 判定器 | path | 到達性 | 規則 | 推奨 |
| --- | --- | --- | --- | --- |
| `sensitiveObjectJudge` | L882–981（100 行） | impact `sensitive-object-access` は 2026-10-17 以降 `finding-parked` → 検証 queue に入らず **主経路から到達不能** | DEVELOPMENT §2「判定器の集合」凍結。ADR 0024 | 残す（凍結）。半年後の見直し（ADR 0032）で判断 |
| `nonAdministratorJudge` | L1031–1055（25 行） | `privesc-to-contributor+` / `auth-bypass-non-admin` は parked → 到達不能 | 同上 | 残す（凍結） |
| `optionJudge` | L1201–1236（36 行） | `options-update` は parked → 到達不能 | 同上 | 残す（凍結） |
| `administratorJudge` / `sqlCanaryJudge` / `executionCanaryJudge` / `fileReadJudge` / `fileDeleteJudge` / `storedScriptJudge` | L1011–1237 | 主経路 | 不変条件 3 | 残す |

### 週次 smoke の replay Verifier（#126）

| 部品 | path | 行 | 参照 | 規則 | 推奨 |
| --- | --- | --- | --- | --- | --- |
| `SmokeReplayVerifier` | `profiles/wordpress/verification/smoke-replay-verifier.ts` | 207 | `cli/wordpress.ts` が import。test 46 | PARKING 2026-10-14 が削除を決定。OPERATIONS L148「週次 smoke は `review reverify` 1 回で代える」 | **削除候補**（PARKING 条件） |
| smoke replay recipe | `smoke-replay-recipe.ts` | 455 | `scripts/smoke-real-lab.mjs` と test 179 | 同上 | **削除候補** |
| HTTP 再生 CLI | `lab/recorder/replay-cli.ts` | 387 | test 213。`lab/recorder/index.ts`（142）と `cli.ts`（12）は Lab に mount する捕捉器（ADR 0015）で別物 | 同上 | **削除候補**（recorder 本体は残す） |
| `scripts/smoke-real-lab.mjs` | — | 564 | OPERATIONS L32–46 が手順を残す（L148 と矛盾） | 同上 | **削除候補** |
| `reverify.smokeReplayDigest` | `cli/index.ts` L262、`cli/wordpress.ts`、`judges.ts` の参照 | 数十行 | — | 同上 | **削除候補** |
| `examples/translatepress-3.3.1/campaign-real-lab-smoke.json` | — | 29 | smoke 専用 | 同上 | **削除候補** |

合計: src 約 1,050 行 + script 564 行 + test 438 行 + OPERATIONS の 1 節。

## 軸 6: 他 file から import されない export

`src/**/*.ts` 124 file の export 632 件を走査し、自 file と `tests/` 以外に importer が無いものは **185 件**。内訳はおおよそ型・interface 115 件、実行時の値 70 件。実行時の値のほとんどは自 file 内で使われており、`export` 修飾子が余っているだけで削除行は 0〜1 行（例: `cli/continuous.ts` の定数 19 件、`cli/index.ts` の `format*` 8 件、`allocateArm`、`encodeCanonicalJson`、`wordpressVictimActionSchema`）。本体ごと未使用なのは次の 4 関数。

| export | path | importer | 行 | 規則 | 推奨 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| `renderWordPressLeadNeighbourhood` | `profiles/wordpress/discovery/lead.ts` L139–180 | tests 1 のみ。src 0（2026-10-09 #82 以来） | 42 | 規則なし | **削除候補** | Lead の近傍描画。どの CLI 経路からも呼ばれない |
| `describeWordPressEntryPlan` | `profiles/wordpress/discovery/entry-points.ts` L470–480 | tests 1 のみ。src 0（2026-10-11 6375b18 以来） | 11 | 規則なし | **削除候補** | assignment mode の説明文。軸 2 の `assignment` と一緒に |
| `planWordPressTasks` | `profiles/wordpress/discovery/task-plan.ts` L29–70（file 70 行） | tests 1（62 行）のみ。src 0 | 42（file 70） | #324（当日）。dispatch 構想の途中 | 保留 | 配線前の新規 module。構想を採らないなら file ごと削除候補 |
| `describeWordPressUnresolved` | `profiles/wordpress/discovery/unresolved.ts` L149–153 | tests 1 + `scripts/report-index-unresolved.mjs`（29 行、docs 0、当日 #335） | 5（file 153） | #335 | 残す | script 経路で使う。script 自体は docs に 0 参照なので手順を OPERATIONS か measurement.md に 1 行足すとよい |

`export` 修飾子だけの整理（約 60 箇所）は行数が減らないので、この表では候補にしない。

## 軸 7: 実運用の台帳で出た event（件数のみ）

| 台帳 | campaign | event | 出現した種別 |
| --- | --- | --- | --- |
| v6-measure `brizy` | 2 | 12 | 6 種別（選定〜探索終了のみ） |
| v6-measure `relevanssi` | 2 | 12 | 同上 |
| v6-measure `tp326` | 8 | 74 | 13 種別（検証・候補正規化・precondition 分類を含む） |
| 本番（`~/.local/state/wordpress-bounty-harness`） | — | — | **未読**（依頼の許可範囲外。memory では 2026-10-16 以降 111 Trial 超） |

3 台帳で一度も出なかった種別は 18。うち review 系 8 種別は測定台帳に出ないのが正常。`candidate-rejected`・`child-report-recovered`・`review-item-opened`・`evaluation-case-blocked`・`candidate-held`・`finding-parked`・`verification-lab-failed`・`campaign-stopped`・`selection-batch-bound`・`discovery-report-recovered` は本番台帳で確認するまで未使用と断定しない。

## 軸外: scripts・examples・spike・policy

| 対象 | 行 | 参照 | 規則 | 推奨 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `examples/translatepress-3.2.5/`（4 file） | 156 | `tests/cli/examples.test.ts` が `campaign-luna-ab*.json`・`selection-luna-40.json` を pin。最終 commit 2026-10-10 | PARKING「旧 arm の examples」 | **削除候補**（PARKING 条件） | ablation / assignment / 90 分 wall の旧 A/B 設定。消すと examples.test.ts の pin も消える |
| `examples/translatepress-3.2.6/`（13 file） | 413 | examples.test.ts が `*-comment-fixture.json`・`campaign-short-managed-v4.json` 等を pin。最終 commit 2026-10-11 | 同上。ただし 3.2.6 は所有者実績の再発見 case（TranslatePress 3.2.6） | 保留 | selection file と `campaign-production-v1.json` は再発見で使う可能性。旧 arm 分（managed-v1 / v3、short-objective-v1 / v2、wp2shell-bounty-v1、single-http-v2 を指す 8 file）だけ削除候補 |
| `scripts/preflight-unlimited-elements-sources.mjs` | 286 | docs 2、tests 0 | PARKING 2026-10-13「Unlimited Elements 等の残りは Step 2」 | **削除候補（弱）** | 対象のベンチマークが止まっている。再開時は Git 履歴から戻せる |
| `scripts/prepare-pilot-selection.mjs` | 31 | docs 4（PILOT-2026-10-10） | 規則なし | 保留 | pilot の記録文書が参照する |
| `scripts/preflight-root-three.mjs` | 323 | `pnpm preflight:root-three`、docs 2 | — | 残す | runtime check の前段 |
| `scripts/report-index-unresolved.mjs` | 29 | docs 0、tests 0（当日 #335） | — | 残す | 新規。手順文書に未記載 |
| `spike/`（3 file、2026-10-08） | — | SPEC.md と 10-09 review が参照 | — | 残す | 設計根拠の記録 |
| `policy/patchstack-scope-2026-10-08.md` | — | docs 1、tests 1 | PARKING「Patchstack を第 2 の提出先に」 | 保留（parked） | 再開条件が書かれている |
| `policy/selection.30000.json` / `.50000.json` | — | OPERATIONS L144 が存在を必須にする | — | 残す | — |
| `containers/development-set/` | — | `examples/translatepress-3.2.5/README.md` が参照 | — | 保留 | 旧 arm examples と一緒に判断 |

## まとめ（削減行 ÷ リスクの順）

| 順 | 候補 | 削減規模（src / tests） | 規則上の障害 | 推奨 |
| --- | --- | --- | --- | --- |
| 1 | 週次 smoke の replay Verifier（#126）一式 | 約 1,050 + script 564 / 438 | なし。PARKING が決定済み（Step 1 合格後） | 削除候補 |
| 2 | `eval score / keys / rubric` + Answer Key + 盲検 rubric | 約 400 / 約 280 | なし。PARKING が決定済み。OPERATIONS §8 の 1 節を消す | 削除候補 |
| 3 | plugin 固有 Lab adapter 6 本（Brizy ×2、Relevanssi、Simply Schedule、Download Monitor、Download Manager）+ scenario 6 行 + 初期化分岐 | 約 285 + 定義約 70 / 200 | なし。PARKING が決定済み。残り 4 本（User Registration ×2、wpDiscuz、WP-Members）は所有者実績 case との照合が先 | 削除候補 |
| 4 | 旧 arm の examples（3.2.5 全部 + 3.2.6 の旧 arm 8 file） | 約 156 + 約 250 / examples.test.ts の pin | なし。PARKING が決定済み | 削除候補 |
| 5 | `eval compare` + ablation mode + `allocateArm` + `interval.ts` | 約 180 / 343 | ADR 0013 は accepted のまま。A/B は延期（PARKING） | 削除候補（弱）／保留 |
| 6 | `assignment` mode + `planWordPressEntryAssignments` + `describeWordPressEntryPlan` | 約 80 / 約 30 | PARKING は削除、#324（当日）は拡張 | 保留（矛盾の解消が先） |
| 7 | archive prompt 10 版 | 100 + registry 6 箇所 | AGENTS は保持、PARKING は削除 | 保留（規則の食い違い） |
| 8 | `renderWordPressLeadNeighbourhood` | 42 / 約 30 | なし | 削除候補 |
| 9 | `verifier-v1`〜`v5` | 49 | AGENTS 規則の類推 | 保留 |
| 10 | `review open` + `review-item-opened` writer | 19 | なし。PARKING が決定済み | 削除候補 |
| 11 | `eval prospective` + `advisory.ts` | 約 80 / 265 | PARKING に無い | 保留 |
| 12 | `scripts/preflight-unlimited-elements-sources.mjs` | 286 | PARKING（Step 2） | 削除候補（弱） |

PARKING が既に決めている 1〜4・10 を合わせると src 約 2,100 行 + script 850 行、tests 約 1,200 行が Step 1 合格後の整理 PR 1 本（または 4 本）で消える。これは深化報告 候補 9 の見積り（約 −1,500 / −900）を adapter と examples の分だけ上回る。

## 消してはいけないもの

- 不変条件 1〜8 を実装する code: `discovery/provider-credential-egress-broker.ts`・`provider-credential-proxy*.ts`（不変条件 2）、`profiles/wordpress/verification/judges.ts` の 9 判定器と canary 配置（不変条件 3。到達不能な 3 判定器も Step 1 凍結）、`verification/index.ts` の incomplete 判定（4）、Snapshot digest 照合（5）、`review/index.ts` の決定・承認・提出記録（6・7）、`ledger/index.ts` の追記専用と digest 参照（8）。
- 判定器の集合（DEVELOPMENT §2 凍結）。`sensitiveObjectJudge`・`nonAdministratorJudge`・`optionJudge` は parked 分類のため到達不能だが、半年後の見直しで戻る可能性がある。
- 保持が決まっている prompt: `wp2shell-bounty-v5`（既定）、`-v6`（測定）、`-v2`・`short-objective-managed-v4`（比較 arm）、`screening-v1`（構成照合）、`wp2shell-whitebox-v1.7`（所有者実績）、`-v3`・`-v4`（旧既定、digest 照合）、`trust-boundary-v1`、`verifier-v6` / `-v7`。
- 台帳の全 event 種別の reader（`candidate-rejected`、`child-report-recovered`、旧 `stage` / `continuationOf` を含む）。writer を消しても schema と読取は残す。既存 event は消さない。
- owner-approved の対象 path: `docs/adr/`、`docs/SPEC.md`、trust 境界宣言、Programme Boundary、`policy/`、判定器、agent に渡る文章（prompt 本文、skill 本文、Harness 生成節の雛形）。削除であっても差分の確認と委任を明記した PR comment が要る（ADR 0032 2026-10-18）。
- 本番 runner が使うもの: `continuous *`、`select`、`campaign run`、`verify next`、`review export / decide / parked / reverify`、`history status`、`runtime check`、`lab cleanup`、`policy/selection*.json`、host の `legacyHistory`、`scripts/export-legacy-slugs.mjs`。
- Lab の HTTP 捕捉器 `lab/recorder/index.ts`・`cli.ts`（ADR 0015）。replay（`replay-cli.ts`）だけが #126 の削除対象。

## 測った数字

| 対象 | 数 |
| --- | --- |
| CLI subcommand | 37（USAGE 38 行）。skill と運用文書の両方で参照 0: 3（`review open`、`eval case-blocked`、`ledger coverage`）。削除候補: 4（`review open`、`eval score / keys / rubric`）、弱 1（`eval compare`） |
| 設定 option（campaign 23 key、host 12 key、selection 約 25 key） | examples と policy のどこにも非既定値が無い: campaign 7（`assignment`、`ablation`、`entry-index-control` 明示、`customerRole: true`、`databaseAccess: none`、`discovery.lab: none`、`initialApprovedComment` は fixture 2 件のみ）、host 1（`scopePolicyPath`）、selection 2（`historySignals` / `historySource`）+ Legacy 注記 4 |
| 探索 prompt | 18。既定 1、測定 1、比較 arm 3、構成照合 1、旧既定 2、archive 10（規則の食い違いで保留） |
| Verifier prompt | 7。code から読めない旧版 5 |
| 台帳 event 種別 | 31。src の writer 0: 2（`candidate-rejected` は意図的、`child-report-recovered` は script が書く）。CLI 1 command だけが書く: 2（`review-item-opened`、`evaluation-case-blocked`） |
| 実運用台帳（v6 測定 3 台帳） | 98 event、12 campaign、出現 13 種別。本番台帳は未読 |
| scenario / adapter / 判定器 | 15 / 10 file 428 行 / 9（到達不能 3）。設定から到達できる scenario: 1 |
| export | 632 件。他 file から import されない 185 件。本体ごと未使用の関数 4（95 行） |

## 注記

- これは報告で、正本ではない。削除の採否は所有者が行ごとに決め、採った行だけを Step 1 合格後の整理 PR（PARKING 2026-10-14、最終設計 P13）に入れる。
- PARKING と AGENTS.md の食い違い（archive prompt 10 版）、PARKING と #324 の食い違い（`assignment` mode）は、この報告では解決せず両方を記した。
- 本番台帳の件数は未確認なので、「本番で一度も出ていない」とはどの event 種別についても言っていない。

## 訂正（2026-10-18、削除 PR の実装時に判明）

- 軸 2 と軸 5 の「precondition 文から scenario を自動選択する code は現行 main に無く、scenario は `lab.scenarioId` でだけ決まる」は**誤り**。`nextWordPressScenario` が precondition 文から 4 つの scenario（`approved-comment-searchable-v1`、`public-booking-page-v1`、`public-builder-page-v1`、`public-file-attachment-form-v1`）を自動選択し、`verify next` の再検証（#209）がそれを使う。したがって Relevanssi、Simply Schedule、Brizy ×2 の adapter 4 本は本番経路から到達するので削除候補から外す（#344 は Download Monitor / Download Manager の 2 本だけを削除）。
- `review-item-opened` の writer は `review open` ではなく `review inspect` にある。`review open` の削除（#343）で writer は消えない。
- `examples/translatepress-3.2.6/` で旧 arm を参照するのは 8 file ではなく 4 file。残り 5 file は比較 arm（v2 / v4）の設定で、残す。
- `containers/development-set/` は host 固定 image の唯一の build 手順なので残す。
