# ハーネス全体の機能利用・削除候補・設計の棚卸し

調査日: 2026-10-23。調査対象: `cde675ed27b5030d0f0c8d4e0d72b258918c13aa`。報告のみ。コード、設定、台帳、ランナーの状態は変更していない。この文書は正本ではない。

## 結論

変更を重ねた結果、**旧方式の実行経路と、呼び出し元を失った公開メソッド・表示項目が残っている**。削除候補はある。ただし「本番で使っていない」「今のコードから呼べない」「古い記録を読むために必要」は別である。

- 小さく削れる候補は、`inspectOrphans`、旧 `openReproductionPackage` の読み取り入口、`Review.inspect` の余分な返却項目、deprecated alias。選定の `select` も本体の呼び出しがないが、SPEC の契約整理が先に必要。
- 大きな削除候補は、旧 Codex Verifier、シナリオ選択、プラグイン別 adapter、旧 campaign 内検証。ただし現在も呼べる入口があり、移行の受け入れ条件が残る。「未使用だから一括削除」とはできない。
- 実利用のある機能にも、レビューの途中記録、現在状態と履歴の読み分け、集計定義の分散という設計上の問題がある。
- 正式文案、外部行動承認、提出、転帰、人間再現のイベントは、確認した台帳でいずれも 0 件。これは縦断利用の証拠不足であり、不要な機能という証明ではない。
- 全 `src/**/*.ts` 142 ファイル・44,374 行の相対 import を走査した。指定した 4 入口から 141 ファイルへ到達し、残り 1 ファイルも手動復旧 script が使う。大量の孤立ファイルより、**使われているファイルの内部に残った旧分岐・余分な interface**が整理対象になっている。

## 1. 調査方法と、何を「利用」としたか

| 区分 | 意味 | 削除判断 |
| --- | --- | --- |
| 実利用を確認 | 台帳の該当イベント、または日付付きの運用・開発記録があり、実装へ接続できる | 保持が基本。全分岐の実証とは限らない |
| 現行経路・利用回数不明 | CLI、skill、script から呼ばれる。閲覧などで呼出記録がない | 0 回とは扱わない |
| 到達可能・記録 0 件 | 入口と実装はあるが、この台帳には該当記録がない | 不要とは断定しない |
| 退役途中 | 新しい主経路から外れたが、別入口や旧設定からまだ呼べる | 入口と移行条件を確かめてから削除 |
| 履歴互換 | 新しい書込みはないが、保存済みの記録を読む | 原則保持 |
| 未使用候補 | 調べたリポジトリ内で、定義・再 export・テスト以外の呼出元が見つからない | 小さな削除候補。Git 外の個人 script まで不存在を証明したものではない |

SPEC、ADR、GLOSSARY、DEVELOPMENT、LESSONS、PARKING、現在の CLI・skill・script・テスト、運用報告を照合した。探索手法の改良、対象の実行、実 Finding の内容評価は今回の対象外。

本番台帳 `/home/dev/.local/state/wordpress-bounty-harness/ledger.sqlite` は、Python sqlite3 の `mode=ro`、`PRAGMA query_only=on`、読取り transaction で件数と型付きメタデータだけを集計した。Private Evidence の本文、HTTP 記録、候補本文、認証情報は読んでいない。`ledger` CLI は書込み可能な接続を作るため、今回の実台帳観測には使わなかった。

主な観測は **19:25〜19:30 JST**。各集計で最大 sequence は **11,699**、最大 `occurredAt` は **16:23:26 JST**。`occurredAt` は記録内の時刻であり、ファイルの書込み時刻ではない。以下の「本番」は原則 `campaign_id LIKE 'prod-%'` の命名による抽出で、手動・実験 Campaign の完全な分類を保証しない。

## 2. 現行コードと、最後の本番 checkout は同じではない

| 観測対象 | 確認内容 |
| --- | --- |
| 今回の実装 checkout | `/home/dev/wordpress-bounty-harness`、`cde675e` |
| 監視記録にある最後の本番 checkout | `/home/dev/wordpress-bounty-harness-prod19`、`4a339e9`。今回 `git status --short` は空 |
| その本番ビルド | `dist/cli/continuous.js` に旧検証 worker の実装が残っている |
| 現在の本番用設定ファイル | `campaign-production-mixed-6.json` は `discovery.lab: none`、runtime 比率は Claude のみ。ただし保存された設定は現在のプロセスの存在を意味しない |
| プロセス観測 | 19:27 前後、`node .../cli/main.js ... continuous run` に該当するプロセスは見つからなかった |
| 保存された runner 状態 | `continuous.json` は `backoff` だが、更新時刻は 10/21 22:18 JST。現在稼働中の証拠にはならない |

現行 main は [continuous.ts:680](/home/dev/wordpress-bounty-harness/src/cli/continuous.ts:680) で探索のみと説明する。旧本番版は別の検証 worker を持ち、`discovery.lab: none` だけではその worker を無効にしない。したがって **「現行 main の通常経路では探索のみ」と「最後の本番版で自動検証がなくなっていた」は別の主張**である。再起動・配備・設定変更は行っていない。

さらに現行コードでも `attached` 設定を許容し、[pipeline.ts:546](/home/dev/wordpress-bounty-harness/src/cli/pipeline.ts:546) の `none` 分岐以外には campaign 内検証が残る。[OPERATIONS:134](/home/dev/wordpress-bounty-harness/docs/OPERATIONS.md:134) の「探索だけ」という説明は、現在の本番設定を前提に読む必要がある。

## 3. 台帳から確認できた実利用

| 記録 | prod-% の件数 | 読み方 |
| --- | ---: | --- |
| `target-selected` | 287 | 選定の記録数。固有対象数ではない |
| `snapshot-frozen` | 287 | Snapshot 固定の記録数 |
| Root 開始 (`runKind: explore`) | 335 | 再開区間を含む開始イベント数。Trial 数ではない |
| うち v8・探索 Lab なし | 218 | 現行方式と同じ prompt 名・Lab 条件の開始イベント |
| runtime 名が明示された Root | Codex 74 / Claude 95 | 166 件は runtime フィールドがない。欠落を片方の runtime に決め付けない |
| 再開を明示する開始イベント | 28 | 利用実績だけを示す。自動／手動の全内訳は今回確定しない |
| `finding-recorded` | 84 | 候補の記録。確認済み・固有脆弱性の件数ではない |
| `finding-parked` | 57 | 対象範囲外などで保留した記録 |
| `lead-recorded` | 1,244 | Lead の記録。Finding や確認結果とは別 |
| 旧 Verifier の `verification-finished` | 99 | `verifier-v7` 5 + `verifier-v8` 94。過去の利用証拠 |
| handoff の `verification-finished` | 49 | 元 Finding 48 試行 + 最新版に派生した Finding 1 試行 |
| handoff を受けた元 Finding | 27 | 最新の handoff 結果は確認 10 / `incomplete` 17 |
| 現行 skill `wbh-verify/v8` | 0 | 記録は v2〜v7。経路の実績を現行版の受入結果と混同しない |
| `review-decided` | 19 | accept 1 / reject 18 |
| `human-effort-recorded` | 19 | 作業時間の記録。人間再現の記録とは別 |
| `scope-assessed` | 6、3 Finding | すべて `ambiguous` |
| 正式文案／承認／提出／転帰／人間再現 | 各 0 | この state 全体で見ても各 0。Harness 外で行われた行為の不存在までは示さない |

末行のイベント名は `draft-saved`、`external-action-authorized`、`submission-recorded`、`submission-outcome`、`human-reproduction-recorded`。閲覧、export、照合の試行、保存前に止まった文案作成などは、これらの件数だけでは観測できない。

## 4. 機能ごとの棚卸し

### 制御・選定・探索・記録

| 機能 | 利用状態と根拠 | 判断 |
| --- | --- | --- |
| 自動選定・選定 batch の束縛 | 実利用あり。選定 287、batch 束縛 47。[入口](/home/dev/wordpress-bounty-harness/src/cli/continuous-cli.ts:284)、[選定実装の呼出](/home/dev/wordpress-bounty-harness/src/cli/wordpress.ts:1144) | 保持 |
| 公開情報・mirror・旧選定履歴の読取り | 選定の現行経路。[履歴を読む箇所](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/selection/wordpress-selection.ts:720) | `legacy` という名前だけでは不要でない |
| Snapshot・依存ソースの固定 | 実利用あり。固定 287。[Host の構成](/home/dev/wordpress-bounty-harness/src/cli/wordpress-host.ts:406) | 保持。依存の全種類を試した証拠とは別 |
| Codex / Claude runtime | 両者に明示された本番開始記録あり。[Codex の構成](/home/dev/wordpress-bounty-harness/src/cli/wordpress-host.ts:448)、[Claude の構成](/home/dev/wordpress-bounty-harness/src/cli/wordpress-host.ts:862) | 保持。adapter が 2 本あるのは実際の差を扱うため |
| broker・gVisor・上限・停止 | 上記実行経路の制御に接続。[Codex sandbox](/home/dev/wordpress-bounty-harness/src/discovery/codex-gvisor-sandbox.ts:779)、[Claude sandbox](/home/dev/wordpress-bounty-harness/src/discovery/claude-gvisor-sandbox.ts:296) | 保持。隔離・資格分離を重複として削らない |
| 継続運転・backoff・再開 | 過去の運用記録と再開イベントあり。現在の常駐プロセスは未検出。[監視記録](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-21-monitor-report.md:324) | 機能は利用済み。現在の稼働とは区別 |
| 正規化・候補保留・park | 正規化 1,460、保留 77、park 57 の本番イベント。[記録処理](/home/dev/wordpress-bounty-harness/src/discovery/record-discovery-report.ts) | 保持。各数値はイベント数で、同一候補の遷移を含む |
| 台帳・Private Evidence | 全 11,699 イベント。保存・参照の中核。[Ledger](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:788)、[Evidence store](/home/dev/wordpress-bounty-harness/src/infrastructure/private-artifact-store.ts:155) | 保持 |
| `ledger funnel / usage / stops / resumes / runtime` | CLI と現行計測手順から到達。[CLI](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1382)、[計測手順](/home/dev/wordpress-bounty-harness/docs/agents/measurement.md:47) | 現行の操作者向け機能。呼出回数は不明 |
| 子の報告の手動回収 script | 独立した script が profile の回収処理を import。[script](/home/dev/wordpress-bounty-harness/scripts/recover-child-reports.mjs:5)、[操作手順](/home/dev/wordpress-bounty-harness/docs/OPERATIONS.md:267) | CLI から import されなくても孤立コードではない。個別の利用回数は不明 |

### 検証・レビュー・提出準備

| 機能 | 利用状態と根拠 | 判断 |
| --- | --- | --- |
| handoff 検証 | 49 試行。[CLI の入口](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1223)、[transport 選択](/home/dev/wordpress-bounty-harness/src/cli/wordpress-session.ts:380) | 現行経路、保持。現行 skill v8 の実績は別途必要 |
| Lab・観測・判定器・片付け | handoff 実績が接続の証拠。[構成](/home/dev/wordpress-bounty-harness/src/cli/wordpress-session.ts:387) | 保持。全判定分類の実証とは限らない |
| 旧 Codex Verifier | 過去 99 試行。現行でも handoff なしの `review reverify` と `attached` campaign から到達。[ADR 0035](/home/dev/wordpress-bounty-harness/docs/adr/0035-verification-as-a-skill.md:44) | 退役途中。大きな条件付き削除候補 |
| plugin 別 scenario / adapter | [設定読取](/home/dev/wordpress-bounty-harness/src/cli/wordpress-session.ts:115) → [解決](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/lab/provision-input.ts:72) → [初期化](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/lab/wordpress-initialization.ts:267) | 到達可能。個別の本番使用は確認できず。移行後の削除候補 |
| 標準 reproducer | 現行判定器の構成に接続。[構成箇所](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/verification/judges.ts:1747) | 旧週次 smoke と別物。名前だけで削除しない |
| review 列・群・export | 列は判断の入口、export は handoff と skill も消費。[列](/home/dev/wordpress-bounty-harness/src/cli/index.ts:924)、[handoff の利用](/home/dev/wordpress-bounty-harness/src/cli/wordpress-host.ts:643) | 保持。閲覧回数は分からない |
| 判断・照合結果・工数の記録 | 判断 19、工数 19。[CLI](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1025) | 実利用あり。記録の interface に問題あり（後述 R1） |
| scope / mirror 照合 | scope は 6 回。照合は skill から呼ばれる。[scope](/home/dev/wordpress-bounty-harness/src/review/index.ts:602)、[dedupe skill](/home/dev/wordpress-bounty-harness/.claude/skills/wbh-dedupe/SKILL.md:23) | 拡張凍結と不要は別。[ADR 0031](/home/dev/wordpress-bounty-harness/docs/adr/0031-review-report-dedupe-as-skills.md:16) に従い保持 |
| `lab up --for-review` / 人間再現 | CLI はある。[入口](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1531)。人間再現イベントは 0 | 到達可能・記録未確認。ラベルだけで不要とはしない |
| 正式文案・承認・提出・転帰 | CLI、skill、模擬一巡テストあり。台帳は各 0。[入口](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1260)、[テスト](/home/dev/wordpress-bounty-harness/tests/cli/cli.test.ts:4296) | 縦断実績なし。将来の中核契約であり、単純削除の根拠なし |
| `review parked / held` | 現行 CLI。対象イベントは存在するが表示回数は分からない。[parked](/home/dev/wordpress-bounty-harness/src/cli/index.ts:947)、[held](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1621) | 保持。表示ロジックの分散と上限に注意 |

### 開発用・履歴用

| 機能 | 根拠 | 判断 |
| --- | --- | --- |
| `report-rediscovery-cases.mjs` | [計測手順](/home/dev/wordpress-bounty-harness/docs/agents/measurement.md:52)、[10/19 の使用記録](/home/dev/wordpress-bounty-harness/docs/evaluation/2026-10-19-v8-five-target-rediscovery.md:14) | 開発用の実利用あり。本番から呼ばれなくても保持 |
| `report-wordpress-preconditions.mjs` | [独立 CLI](/home/dev/wordpress-bounty-harness/scripts/report-wordpress-preconditions.mjs:274) とテストあり。[既存設計](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-14-final-design.md:485) には利用予定がある | 現在の継続利用を確認する対象。使用実績が未確認というだけでは、未使用と確定しない |
| `selection-statistics.py` | [分析記録](/home/dev/wordpress-bounty-harness/docs/reviews/2026-10-19-selection-statistics.md:43)、ADR 0037 の再計測方針 | 過去分析の再現用。常駐機能でないことは削除理由にならない |
| build / copy-assets / preflight / 品質ゲート | [package.json](/home/dev/wordpress-bounty-harness/package.json:18)、[CI](/home/dev/wordpress-bounty-harness/.github/workflows/check.yml:1) | 開発経路に接続。全 CI run の履歴は今回未調査 |
| 旧 prompt・skill 版・イベント・旧選定フィールド | [prompt registry](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/prompts/index.ts:12)、[旧フィールド](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/selection/contracts.ts:275) | 履歴の digest・記録の読み取りに必要 |
| smoke の reader | [ファイル冒頭](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/verification/smoke-replay-recipe.ts:1) が実行器の削除と reader の残存理由を明記 | reader を実行機能と誤認しない |
| evaluation module、旧 eval CLI、索引・coverage・dispatch | [SPEC](/home/dev/wordpress-bounty-harness/docs/SPEC.md:40)、[PARKING](/home/dev/wordpress-bounty-harness/docs/PARKING.md:22) | すでに削除済み。再び削減見込みに数えない |

## 5. 削除・縮小の候補

以下は候補を明確にするための一覧であり、削除の実施や interface の決定ではない。

| ID・優先 | 候補 | 根拠・削る範囲 | 残すもの・確認条件 |
| --- | --- | --- | --- |
| D1・小 | `PrivateArtifactStore.inspectOrphans` | [実装:297](/home/dev/wordpress-bounty-harness/src/infrastructure/private-artifact-store.ts:297) と専用テストだけ。運用・CLI・skill の接続なし | メソッドが対象。証拠ファイルや staging の削除は対象外。Git 外の import は未確認 |
| D2・小 | `Review.openReproductionPackage` と下位の同名 reader | [公開入口:1069](/home/dev/wordpress-bounty-harness/src/review/index.ts:1069)、[reader:53](/home/dev/wordpress-bounty-harness/src/review/reproduction-package.ts:53)。本体の呼出元は見つからず、専用テストが使用 | 同ファイルの `openLabReconstruction` は [手動レビュー Lab:49](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/lab/review-lab.ts:49) が使用。ファイル丸ごとの削除不可。保存形式の検査は残す |
| D3・中 | `Review.inspect` の旧表示用の返却項目 | [返却型:133](/home/dev/wordpress-bounty-harness/src/review/index.ts:133) の `verificationStatus`、`drafts`、`privateEvidenceDigests`、`reproductionPackageDigest`。現行の本体呼出元 [CLI:1275](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1275) は `scopeAssessments` のみを読む | `inspect` 全体は文案作成が使う。余分な読取り・組立だけが候補。文案履歴等を確認するテストの責務を保つ |
| D4・小 | `EGRESS_BROKER_LEFTOVER_PATTERNS` の deprecated alias | [定義:36](/home/dev/wordpress-bounty-harness/src/discovery/provider-credential-egress-broker.ts:36) と [再 export:143](/home/dev/wordpress-bounty-harness/src/discovery/index.ts:143) だけ | 現役の `DISCOVERY_LEFTOVER_PATTERNS` と掃除の振る舞いを残す。Git 外の旧名利用は未確認 |
| D5・低／契約確認 | `WordPressSelection.select` | [本体:785](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/selection/wordpress-selection.ts:785) は `decide(...).selected`。直接呼出は専用テスト 4 箇所、本体は `decide` を使用 | [SPEC:33](/home/dev/wordpress-bounty-harness/docs/SPEC.md:33) に公開 interface として残る。即削除扱いにしない。選定機能・CLI `select` は別で現役 |
| D6・大／移行待ち | 旧 Verifier・scenario 選択・plugin 別 adapter・attached campaign 内検証 | [旧 adapter](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/verification/codex-verifier.ts:43)、[scenario 選択](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/lab/scenarios.ts:313)、[campaign 内検証](/home/dev/wordpress-bounty-harness/src/cli/pipeline.ts:754) に実装と呼出が残る | [ADR 0035:40](/home/dev/wordpress-bounty-harness/docs/adr/0035-verification-as-a-skill.md:40) の受入条件後。handoff、Lab、観測、判定器、旧イベントの読取りは残す。現在の手動入口を廃止するかも判断が必要 |

D6 の plugin 別 adapter は `brizy-builder-page`、`brizy-file-attachment-form`、`relevanssi-search-index`、`simply-schedule-booking`、`user-registration-adapter`、`user-registration-membership-adapter`、`wpdiscuz-adapter`、`wp-members-adapter` の 8 ファイル。すべて `src/profiles/wordpress/lab/` にある。ファイルの存在だけでなく [初期化側の呼出](/home/dev/wordpress-bounty-harness/src/profiles/wordpress/lab/wordpress-initialization.ts:216) を確認したため、「未使用確定」としていない。

GitHub を読取りで確認し、移行受け入れの [#352](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/352) と削除・整理の [#353](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/353) はともに open。古い Issue 本文の未チェック項目には、すでに削除済みのものも含まれる。**Issue のチェック欄より、現行コードと後続 ADR を優先する**。

公開されているだけで別ファイルから名前参照されない型も少数あるが、機能の削減量としては数えない。小さな export 整理を、大きな不要機能が消えるかのように扱わない。

## 6. 設計上の問題とリファクタリング候補

### R1. 人間レビュー 1 回分の検査と記録順序が CLI に漏れている — Strong

[CLI:1063](/home/dev/wordpress-bounty-harness/src/cli/index.ts:1063) は「不正な入力なら何も書かない」とする。しかし、手動再現・工数を追記した後、[Review:450](/home/dev/wordpress-bounty-harness/src/review/index.ts:450) で理由コード・開いた証拠の digest・操作者名を検査する。後段の入力が不正だと、判断だけが失敗し、先の記録が残り得る。照合メモも、決定全体の検査より先に保存する。

これは静的に確認できる順序の不整合。本番で起きた証拠はなく、人間再現イベント自体が今回の台帳では 0 件である。既存テストは一部の不正引数と正常時の順序を確認するが、理由コード等による後段失敗は覆わない。[CLI テスト:4462](/home/dev/wordpress-bounty-harness/tests/cli/cli.test.ts:4462)

候補は、CLI adapter が知る検査と順序を既存 Review module の interface 内へ集めること。depth と locality が増し、同じ seam で「不正入力なら追記ゼロ」を検査できる。呼出元は現在 1 箇所なので、将来の多数の利用者を想定した抽象化は不要。FS と DB の一般的な transaction、障害回復基盤、別の記録を 1 イベントに統合する変更へは広げない。

### R2. 「現在の判断」と「過去の記録」を読む知識が分散 — Worth exploring

[queue:331](/home/dev/wordpress-bounty-harness/src/review/index.ts:331) は、最新の検証より古い判断を現在の判断から外す。[export:676](/home/dev/wordpress-bounty-harness/src/review/export.ts:676) は最後の判断を履歴として返す。照合結果は次の判断へ引き継ぐ。[引継ぎ:431](/home/dev/wordpress-bounty-harness/src/review/index.ts:431)

**表示が違うこと自体をバグと断定しない**。問題は、この読み分けを理解・変更するために CLI・Review・export を往復する必要があること。現在状態と履歴の意味を保ったまま、Review module に読み分けの知識を集める余地がある。独立した集計 DB や、意味を持たない latest-event helper の追加は不要。

D3 と同じ記録周辺なので、まず旧表示用の余分な interface を縮め、残った読者に必要な意味を明確にする方がよい。先に新しい共通 module を増やすと、不要部分まで温存する。

### R3. 履歴の集計定義が複数箇所にある — Worth exploring

- `report-rediscovery-cases.mjs` は [保留集合:60](/home/dev/wordpress-bounty-harness/scripts/report-rediscovery-cases.mjs:60) を作るが、後の正規化で除かない。Ledger は [正規化時:1494](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1494) に保留を解除する。累計か現在値かを明示しないまま比較すると数が異なる。
- `funnel --since` は Campaign をまたいで読むが、Finding は [findingId 単独:1518](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1518) でまとめる。保存時の一意性は [campaignId + findingId:958](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:958)。今回の台帳には同じ Finding ID の複数 Campaign 所属が 0 件で、実害は観測していない。
- funnel の [reviewed:1651](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:1651) は検証未実施や `contradicted` の判断を数えない。「検証後の段」としての指標には理由があり、人間の判断件数全体とは一致しない。現在の総作業数として読むなら定義の説明が必要。

既存 Ledger module の interface に集計の意味を集中する候補。script の独立性を失わせるか、何を共有するかは未決定。汎用 query module や二つ目の台帳を作る根拠はない。

### R4. 読取り操作にも state の作成・書込み権限が必要

[openState:25](/home/dev/wordpress-bounty-harness/src/cli/state.ts:25) はディレクトリを作り、[Ledger constructor:771](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:771) は書込み可能な SQLite 接続と `CREATE TABLE/INDEX IF NOT EXISTS` を使う。読み取りコマンドでも、誤った state パスで空の台帳を作り得る。

毎回既存データを書き換えるという指摘ではない。観測用 interface と初期化用 interface の副作用が同じ入口に含まれる点が問題。今回のように完全な読取りを行うには、CLI 外から DB を開く必要があった。監視・監査の入口の契約を明確にする候補であり、新しい保存基盤を要求するものではない。

### R5. 手順文書と必須入力・実行者の説明がずれている

[OPERATIONS:166](/home/dev/wordpress-bounty-harness/docs/OPERATIONS.md:166) は skill が提案だけを行うとする一方、同 179 行と report skill は文案記録を行う。操作表には destination の段がないが、report は [提出先メモ:30](/home/dev/wordpress-bounty-harness/.claude/skills/wbh-report/SKILL.md:30) を必須とする。人間再現を執筆前に求める skill と、[ADR 0038](/home/dev/wordpress-bounty-harness/docs/adr/0038-verification-phases-and-submission-flow.md) の順序にも差がある。

また [Review README:5](/home/dev/wordpress-bounty-harness/src/review/README.md:5) などには旧 runner の説明が残る。これは機能の利用者・前提が分からなくなる文書上の問題。先に現行の手動手順と記録責務を正確にし、不要機能の判定に使える状態にする候補である。

文案 0 件の原因をこの不一致だけには帰せない。scope は全件 `ambiguous` で、[文案保存:723](/home/dev/wordpress-bounty-harness/src/review/index.ts:723) の前提を満たしていない。今回は自動実行役の追加や検証手法の変更は提案しない。

### 小さな正確性の問題（大きな再設計とは分ける）

| 問題 | 根拠 | 今回確認した影響 |
| --- | --- | --- |
| 問い合わせのイベント一覧から `verification-lab-failed` が抜ける | [イベント定義:141](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:141) は 31 種、[query schema:665](/home/dev/wordpress-bounty-harness/src/ledger/index.ts:665) は 30 種 | 型を指定した query が実行時に拒否される静的経路。本番のこのイベントは 0 件。二重一覧の解消で足りる |
| `review parked` が最大 1,000 件で打ち切る | [CLI:952](/home/dev/wordpress-bounty-harness/src/cli/index.ts:952) が `read({limit:1000})` を使用 | 今回の Campaign 内最大は 14 件。現在の欠落ではなく潜在的な表示漏れ |

## 7. 推奨する順番

1. **最初の削除検討は D3、D2、D1、D4。** 呼出元を失った小さな interface から削る範囲を決める。特に D3 は旧表示処理に伴う読取りも減る。保存形式・履歴・現役の文案作成を壊さないテストが条件。
2. **最初の不具合修正候補は R1。** 人間レビュー 1 回分の入力検査と記録順序に限定する。削除の PR と無関係に混ぜない。
3. **大きな削減は D6 の既存移行を閉じるところから。** #352 の受入証拠と残る入口の扱いを確認し、#353 の予定と現物を合わせる。今回の報告だけで削除完了条件を満たしたとは扱わない。
4. **その後に R2/R3。** 使われる読者を確定した上で記録の読み方を整理する。巨大ファイルを分割すること自体は目的にしない。

D5 のためだけの変更、未使用 export 型の一括整理、新しい汎用基盤、0 件の提出機能の一括削除は、優先度が低いか根拠が不足している。

## 8. 確認範囲と未確認事項

- 相対 import グラフの入口は `src/cli/main.ts`、`src/lab/recorder/cli.ts`、`src/discovery/provider-credential-proxy-cli.ts`、`src/discovery/claude-runner.ts`。到達性はテキスト解析なので、各関数・設定分岐の実行を証明しない。残りの `profiles/wordpress/discovery/recover-child-reports.ts` は script からの利用を個別確認した。
- `rg` で `src`、`scripts`、`tests`、`examples`、skill、運用文書を検索した。外部利用者の全 script、シェル履歴、他ホストまでは調べていない。
- 今回実行した関連テストは `tests/scripts/report-rediscovery-cases.test.ts`、`tests/scripts/report-wordpress-preconditions.test.ts`、`tests/ledger/stops.test.ts`、`tests/review/skill-references.test.ts` の **4 ファイル・15 件、成功**。Lab・対象コード・provider を動かさないテストである。
- これらのテスト成功は、指摘した未カバー条件が問題ないことや、本番で提出まで通ったことを意味しない。全 suite と `pnpm check` は今回未実行。コード変更・コミットは行っていない。
- 大きな旧経路の撤去可能性、各 read-only コマンドの実利用回数、正式文案前に止まった試行、外部で行われた提出、現在の本番設定と過去の各実行時設定の完全な対応は未確認。
- 調査前から存在した未コミットの報告書は編集していない。この報告書だけを追加した。

再集計の核は次の読取り専用 SQL。`prod-%` の抽出とイベント数であることを変えずに比較する。

```sql
SELECT event_type, count(*) AS events
FROM ledger_events
WHERE campaign_id LIKE 'prod-%'
GROUP BY event_type;

SELECT json_extract(event_json, '$.promptVersion') AS version,
       count(*) AS attempts
FROM ledger_events
WHERE event_type = 'verification-finished'
  AND campaign_id LIKE 'prod-%'
GROUP BY version;
```
