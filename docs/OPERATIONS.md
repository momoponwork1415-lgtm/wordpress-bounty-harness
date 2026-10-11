# 運用手引き（完成後に人間がすること）

探索主経路は、対象ごとに `wp2shell-bounty-v3` のRoot＋最大3 subagentによる協調Trialを1回行う（[ADR 0029](adr/0029-single-wp2shell-cooperative-trial.md) のTrial構成、[ADR 0019](adr/0019-harness-generated-output-contract.md) の生成出力契約）。旧単独Trialと二段構えの記録は読めるが、新規探索には使わない。実機縦断の受入前に本番稼働したものとみなさない。

対象読者: このHarnessを一人で回す運用者。正本は [SPEC.md](SPEC.md)。

- `harness` は `pnpm build` が作る `dist/cli/main.js`（`bin.harness`）。実際の境界アダプターを束ねる。
- Root＋3の実機preflightは `pnpm preflight:root-three --host <Git外host.json> --state <Git外Private Evidence dir>`。固定した無害なtext sourceとrunscのHTTP Labを使い、broker経由でRootと3子のmodel・usage・source読取・Lab到達を測る。`preflight.json` とrolloutはrunごとにGit外へ保存される。これ自体はTranslatePress探索Trialには数えない。
- コマンド名は `runCli`（`src/cli/index.ts`）が受け付けるもの。
- host設定は `--host <path>` か `WBH_HOST_CONFIG` で渡す。
- 台帳とPrivate Evidenceの置き場は `--state <dir>` か `WBH_STATE_DIRECTORY` で選ぶ。既定は `~/.local/state/wordpress-bounty-harness`。
- 過去の単独Trialの設定例は [examples/translatepress-3.3.1/](../examples/translatepress-3.3.1/README.md)、過去の2×2開発セットは [examples/translatepress-3.2.5/](../examples/translatepress-3.2.5/README.md)。Root＋3の本番開始条件は [TranslatePressベンチマーク](TRANSLATEPRESS-BENCHMARK.md)。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りのDockerホスト。Codex CLI ≥ 0.161。ChatGPT Proにログイン。費用は購読の月額固定で、Harnessは金額でなく使用量（rate limit / quota）を見る | 初回とCLI更新時 |
| build | `pnpm install && pnpm build`。credential proxyは `dist/discovery`、HTTP捕捉proxyは `dist/lab-recorder` にでき、それぞれrunsc containerへ読み取り専用でmountする | 更新のたび |
| host設定 | Git外のJSON（`wordpressHostConfigSchema`、雛形は `examples/translatepress-3.3.1/host.example.json`）。docker、作業dir、全imageのdigest固定、Codex runtime profile、認証情報ファイルの**パス**、Programme写しのパス、履歴mirror | 初回とimage更新時 |
| 認証 | ホストでCodex CLIにChatGPTログインし（`codex login`）、その `auth.json`（0600、本人所有）のパスをhost設定の `credentialFilePath` に、`authenticationMethod` を `chatgpt-oauth-host` にする。読むのはegress brokerだけで、エージェントには渡らない（下記） | 初回とログイン失効時 |
| Programmeの写し | wordfence.comは自動取得できないので、公式3ページを人間がpage documentへ写す（雛形は `examples/translatepress-3.3.1/wordfence-programme.example.json`）。35日を超えると選定が止まる | 月1回 |
| campaign設定 | JSONファイル（`wordpressCampaignConfigSchema`）。Programme Boundary、停止規則、Lab、`resources` を書く。認証情報と鍵は書かない | 方針を変えるとき |
| 選定方針 | `src/profiles/wordpress/policy/selection.json`（説明は同じ場所の `selection.md`）。インストール数の下限、更新の鮮度、除外slug、High Threatタグ、run予算 | 月1回程度 |
| trust境界宣言 | `src/profiles/wordpress/prompts/trust-boundary-v1.md` をそのまま使う | ほぼ変えない |
| 対象範囲の方針 | `src/profiles/wordpress/policy/programme-scope.md` を公式ページで見直す | 提出前と月1回 |
| 履歴mirror | 第5節の手順で更新し、`history status` で鮮度を確かめる | 週1回と提出前 |

## 2. 週の流れ

```
harness history status                                   # 履歴mirrorの鮮度。fresh以外は終了コード1
harness runtime check --config <path>                    # 起動時検査の全項目とCodex image / runtime profileの一致。欠ければ終了コード1
harness select --config src/profiles/wordpress/policy/selection.json   # WordPress.org から3〜5対象を選び Snapshot 固定。承認は不要
harness campaign run --all --campaign <id> --config <campaign.json>    # campaign 設定は同じ選定方針を参照する。最新の選定バッチから Lab → discovery → verification
harness review [--campaign <id>]                         # 検証済みの列を見る
```

**起動時検査**: `campaign run`、`runtime check`、`lab cleanup`、`review reverify` は、境界を組む前に次を全部確かめる。1つでも欠ければ何も起動せず、runc・通常Docker・ホストプロセスへ切り替えずに止まる。`select` は公開情報と固定sourceだけを扱い、provider credential と Lab は起動しない。programme写しの鮮度、WordPress.org観測、固定core image と source の取得を検査し、満たさない候補を選ばない。

- dockerが応答し、`runsc` が登録されている。
- host設定の全imageが、digest固定のまま手元にある。
- 認証情報ファイルが通常ファイル、0600、本人所有で、空でない。APIキーの中身は読まない。ChatGPTログインはメモリ上で読み、access tokenが1時間以上残っていることだけを確かめる。
- credential proxy（`dist/discovery`）のbundleがある。Lab HTTP捕捉proxy（`dist/lab-recorder`）はLab provision時に使うため、実行前の `pnpm build` を要する。
- Codex imageのCLI版と同梱カタログのdigestが、runtime profileと一致する。

**ChatGPTログインの中継**: runごとのbroker（runsc）が、そのrunだけのCAと `provider-egress.internal` の証明書でHTTPSを待ち受ける。

- エージェントのsandboxには、grant tokenとダミーaccountだけでできた使い捨ての `auth.json`、そのCA、brokerのIPだけが入る。本物のaccess tokenとaccount IDはbrokerだけが持ち、refresh tokenはbrokerにも渡さない。
- brokerは `responses` のPOSTだけを、bindしたmodel・件数・大きさ・期限の範囲で `chatgpt.com` へ転送する。workspace discoveryはbrokerが自分で答え、それ以外のendpoint（plugins、analyticsなど）は403にする。
- Root＋3 Trialのbroker上限は1,600 provider要求。既定wall上限60分とは独立に記録し、要求件数の上限到達は `incomplete(policy: broker-request-cap)` として扱う。過去の単独Trialの100要求上限は新主経路に適用しない。
- provider要求本文の上限はRoot＋3で8 MiB。長い協調探索で1 MiBを超えた実測を受けて拡張した。413応答は `incomplete(policy: broker-request-bytes-cap)` として記録し、探索0件として数えない。
- tokenの更新はしない。preflightが「1時間以内に失効」を出したら、ホストで `codex login` をやり直す。
- APIキー（`host-private-bearer`）の経路も残っている。

`campaign run` は無人で回る。既定は対象ごとに `wp2shell-bounty-v3` のRoot＋最大3子による協調Trialを1回行い、wall上限は60分。Rootの報告で正常終了し、Harnessと既定promptは最低実行時間を設けない。wall・provider・broker・schema等の失敗は理由付き `incomplete` として記録する。screeningや候補の有無による二段目、Harnessのcontinuation差し込みは起動しない。各 Finding は別コンテナの Verifier と判定器を通る。

固定 source から列挙した入口索引は既定で探索 prompt の末尾に付く。比較実験で外すときは campaign 設定に `"entryIndex": false` を書く。索引の有無と有効時の digest は `discovery-run-started` に記録される。

既定promptは `wp2shell-bounty-v3`、入口索引は固定source由来のカタログ入力として既定で有効。索引の全件処理は終了条件にしない。`wp2shell-bounty-v2` と `short-objective-managed-v4` は比較armとして残す。`ledger runtime` とrun receiptで実際のwall・coverageを確認する。日次上限はない。provider limitで停止したcampaignは自動retryせず、同じIDで未消費の対象から再開する。

自動選定の campaign は初回起動時に `selection-batch-bound` を追記し、選定バッチと対象集合を固定する。再開時はこの記録のバッチを読み、途中で `select` を再実行しても新しいバッチに切り替えない。公開一覧の取得元・確認日時・available/stale/unavailable と失敗理由は Private Evidence の選定レポートに記録する。

- **同時run数**: campaign設定の `resources` で決める。
  - 既定の `resources` は `{"maxConcurrentRuns": 2, "memoryBudgetMiB": 10240}`。新主経路は対象ごとに1 Trialで、wall上限は60分。
  - `observed` は完了した command event の文字列から Harness が数える下限の近似。script 内部のファイル読出しや通信は含まない。
  - 実効の同時数は協調Trialでは `min(maxConcurrentRuns, floor(memoryBudgetMiB / 8704))`。8,704 MiBはRoot＋最大3子のCodex sandbox（8 GiB）とrunごとのegress broker（512 MiB）の合計。旧単独Trialの計算単位は2,560 MiB。
  - ホストが小さいときは `memoryBudgetMiB` を下げる。1run分に満たない値では開始しない。
  - Labのメモリは対象ごとに別に要る。
- **上限での停止**: provider のrate limit / quotaの応答を受けたとき。
  - 新しいrunを出さず、進行中のrunを記録して止まる。終了コードは3で、台帳に `campaign-stopped` が残る。自動retryはしない。
  - 同じコマンドをもう一度実行すると再開する。開始済みTrialは追加せず、未検証のFindingを検証して未消費の対象へ進む。
- **入口の分担**: campaign の `assignment: {"unit":"entry-point","entriesPerRun":8}` で有効にする。WordPress profile が登録入口、保存先、core 交差、1 hop の include を text 走査し、保存先を共有する入口を同じ scope に置く。索引は事実の列挙で、探索範囲を制限しない。台帳には索引・成分の digest だけを置く。上限（PHP file 20,000、1 file 2 MiB、成分 key 200）を超えた索引は scope に partial と表示する。
- **過去Trialの記録**: 旧 `stage` / `continuationOf` 付きeventと旧ablation armは台帳から読める。旧promptの目的文とdigestで構成を照合するが、旧screeningを現行modeで新規起動しない。新主経路は段やcontinuationを新規に書かず、比較するpromptと入口索引の有無を別armとして明示する。Leadの本文はPrivate Evidenceに置き、台帳にはdigestと分類だけを記録する。
- **対象ごとの失敗**（取得、探索、検証）: 標準エラーに `skipped <対象> <版> at <段階>: <理由>` と出す。台帳には `target-skipped`（段階だけ）を残し、次の対象へ進む。
- Lab 準備では使い捨て runsc コンテナから HTTP 到達を確認する。`lab-provisioned.reachability.http = failed` なら探索を始めず、`failureStage` と `reason` を記録する。DB 到達の失敗は記録するが HTTP が通れば続ける。Docker の診断文は Private Evidence に置き、台帳には digest だけを残す。
- pinned WordPress image の core は `<workDirectory>/wordpress-core` に実行せず取り出し、Dependency Snapshot として固定する。探索と Verifier は `/workspace/wordpress` の read-only mount で同じ版を読む。
- campaign の `lab.databaseAccess` は既定で `read-only`、Lab 単体の既定は `none`。reader は provision 時点で存在する table にだけ SELECT 権限を持ち、後で作る canary table は読めない。`configuration.labAccess` と `lab-provisioned.reachability.database` を併せて見る。Codex image に MySQL client があるかは実 run で未確認で、無い場合は image に `mariadb-client` が要る。
- User Registration & Membership 5.2.8 の通常利用画面は campaign の `lab.scenarioId` に `public-registration-and-account-v1` を指定して作る。scenario の版と digest は profile が固定し、探索 Lab と検証 Lab の両方で同じ登録フォーム・ログイン・アカウント画面を供給する。WordPress 標準の `users_can_register=1` を設定し、`default_role=subscriber` を検査する。現行の人間向け再現資料はこの設定を `enabledSettings` に自動列挙しないため、#141 で扱う。
- wpDiscuz 7.6.72 の通常コメント環境は campaign の `lab.scenarioId` に `public-plugin-comment-v1` を指定して作る。profile が管理者初回訪問に相当する初期化を行い、公開フォームと承認済みの無害なコメントを用意する。探索 Lab と検証 Lab は同じ scenario digest と setup digest を持つ。
- VerifierのHTTPはLab内のrunsc捕捉proxyへ向ける。判定器はHarness捕捉のrequest / responseを優先し、捕捉がないときだけVerifierの `http.json` を `agent-authored` として読む。HTTP本文はPrivate Evidence、台帳にはoptionalな `verification-finished.evidenceCapture` enumだけを残す。`runtime-confirmed` には引き続きcanary回収が要る。
- 失敗した探索 run は `discovery-run-finished.reason`、`reasonDetail`、`providerLimit` で区別する。`reasonDetail` は検査名などの短いコードで、実行記録や HTTP 本文は含まない。

人間が触るのは `review` だけ。並ぶのは次の2種類。

| 種類 | 付いてくるもの | 人間がすること |
| --- | --- | --- |
| `runtime-confirmed` | 再現パッケージ（手動手順、Pythonスクリプト、Lab再構築情報、判定器の証拠）と、判定器が観測した条件 | 自分の手で再現する。影響が意味を持つか、意図された動作でないか、重複でないかを判断する |
| `incomplete` | 理由コードと次の手 | 環境・手順の不足なら再検証を指示する。`no-judge`（判定器がない種別）なら手で確かめる |

`contradicted` は件数しか出ない。

## 3. 提出までの操作

```
harness review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>]
harness review dedupe --campaign <id> --finding <id>          # ローカルWordfence履歴mirrorと照合
harness review scope --campaign <id> --finding <id>           # Wordfence / Patchstack ごとに in-scope / out-of-scope / ambiguous
harness review reverify --campaign <id> --finding <id> --config <path>   # 最新版を新しいLabで検証し直す
harness review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]
harness review authorize --candidate <id> --draft <digest> --to <destination>
harness review submitted --candidate <id> --draft <digest> --to <destination>
harness review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]
```

- `scope` は判定器の証拠と選定記録から事実を読む。最新版での確認が要るプログラムは、`reverify` が `runtime-confirmed` を返した後でだけ満たされる。
- `authorize` は「この文案のこの版を、この送信先へ出す」ことの記録で、送信はしない。送信は人間がWordfence / Patchstackの画面で行い、`submitted` で記録する。
- 提出後の転帰と報奨額を `outcome` で台帳に戻す。選定方針と判定器の改善材料になる。探索へは戻らない。
- Reflected XSSはWordfence向けの候補にならない。authz / IDORは、乗っ取り・権限昇格・サイト全体への影響に届くときだけ in-scope。

## 4. 見るべき数字

```
harness ledger funnel --campaign <id>     # raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome、種別別、arm別、転帰と報奨
harness ledger usage [--campaign <id>]    # providerが返したtokenを対象・UTC日ごとに合計。返らなかった項目はunavailableの件数
harness ledger runtime [--campaign <id>]  # runが記録したmodel、effort、CLI版、カタログdigest、tier、access、認証の組ごとのrun数
```

収益の式は「対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用」。funnelの各段がこの各項に対応する。

| 細い段 | 直す場所 |
| --- | --- |
| raw Findingが少ない | 本番A/B（第6節）、分担単位 |
| verifier通過が少ない | 判定器の成功条件、Lab構成（`incomplete` の理由コードを見る） |
| in-scopeが少ない | 選定方針（対象外になりやすい種別・tierを避ける） |
| duplicateが多い | Finding 後の重複照合と履歴mirrorの鮮度。公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030） |

## 5. 保守

### 履歴mirrorの更新

- 更新は既存の正規化器で行う。旧環境で `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を実行する。API keyは `WORDFENCE_INTELLIGENCE_API_KEY` か `~/.config/wordfence/env` に置く。成功後30分以内の再取得は抑止される。
- 更新後に `harness history status` を見る。照合口と同じ規則で、`fresh` / `stale`（既定24時間超、または前回更新の失敗）/ `unavailable`（stateが読めない、DBとstateが食い違う）を表示する。
- `stale` / `unavailable` は「重複なし」を意味しない。詳細は [wordfence-history/README.md](../src/profiles/wordpress/wordfence-history/README.md)。

### 対象の自動選定

`select` は [選定方針 JSON](../src/profiles/wordpress/policy/selection.json) を直接読み、WordPress.org の人気順・タグ順を列挙する。install下限もこの JSON が正本。台帳の過去選定と Finding を照合し、適格な次点候補で補充して3〜5対象を返す。版またはprompt版が変わったときの再訪は `revisitPolicy` で決める。未公開 Finding を持つ対象は、提出済みでも公開を確認できないため除外する。

旧 `scripts/prepare-pilot-selection.mjs` は `harness select` の薄い呼び出しとして残す。`--host`、`--state`、`--config` を受け取り、候補と順位は作らない。

スコア内訳、除外理由、候補一覧の取得元と観測時刻は標準出力と Git 外の `selection-report` に残る。`target-selected` は固定済み Snapshot digest と `target-selection` の Private Evidence を参照する。次の `campaign run --all` は同じ方針 digest の最新バッチを使い、Snapshot が変われば止まる。公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030）。

### 子の最終JSONがschemaで失敗したとき

子のrunが `child-final-message-not-report` で失敗しても、Private Evidenceの不変rolloutに完全なJSONが残っている場合がある。parserを修正・テストした後、同じcampaignの失敗runを次のコマンドで再解釈できる。Rootと子のthread lineage、model、effort、cyber access、Snapshotを照合し、元の失敗eventは残したまま `child-report-recovered` と有効なFinding / Leadを追記する。source traceやrecipe本文は標準出力へ出さない。

```sh
node scripts/recover-child-reports.mjs \
  --campaign <id> \
  --state /path/to/private/state \
  --attachments /path/to/private/provider-attachments
```

復旧後は同じcampaign IDで `campaign run` を再開する。`incomplete` のTrialを正常な0件として扱わず、独立Verifierへ渡すのは復旧して台帳へ入ったFindingだけにする。

### Codex CLI / model catalogの更新

1. 新しいCodex imageを固定digestで用意する。
2. `harness runtime check --config <path>` で、imageの実際のCLI版とカタログdigestをruntime profileと比べる。食い違いがあるまま回すと、全runが `incomplete(policy)` になる。
3. runtime profile（CLI版、カタログdigest、image digest）を新しい値に更新し、`runtime check` が `ok` になることを確かめる。
4. 次のcampaignの後で `harness ledger runtime` を見る。新しい組が現れ、更新前のrunと分かれて数えられていれば記録は正しい。

### Lab / brokerの残骸

```
harness lab cleanup --config <path>            # 一覧だけ
harness lab cleanup --config <path> --remove   # 削除
```

- 対象は、Labが付ける `wbh-<uuid>-{db,wp,canary,proxy,net,site}` と、brokerが付ける `provider-egress-broker-<id>` / `provider-egress-<id>` の名前に一致するものだけ。
- **実行中のcampaignがないときに使う。**

## 6. 評価

主指標は本番から得る。現在の `eval score --keys` は任意の研究用互換機能で、TranslatePressベンチマークや本番開始には使わない。下記の `eval compare` の旧軸は過去Trialの読取用であり、新主経路へcontinuation軸を適用しない。

```
harness eval compare [--axis history|prompt|continuation] [--campaign <id>]   # 旧軸の比較。新主経路のcontinuationは無い
harness eval prospective --advisories <path> [--campaign <id>]    # 後日公開されたadvisoryで本番台帳を再採点
harness eval score --campaign <id> --keys <path> --case <id> [--manifest <path>] # 答えの鍵でlocation-overlap。held-outは任意
harness eval keys --keys <path> [--manifest <path>]                # 私的な鍵を検査し、公開可能なcase IDとdigestだけを出す
harness eval rubric --file <path>                                 # 私的な盲検rubricを検査し、件数とdigestだけを出す
```

- **新主経路の比較**: 同じ対象・model・source・Lab・wall上限で、prompt版や入口索引の有無だけを変えた独立Trialを別armとして記録する。旧段付きTrialを同じ分母に混ぜない。
- **旧A/Bの読取**: 過去の `ablation.axes` にあった `history`、`prompt`、`continuation` と旧 `{"axis":"history","armBFraction":0.5}` の割当・digestは台帳に残る。旧基準は `short-objective-managed-v4` と継続なしだった。
  - `eval compare --axis` の分母はLab HTTP到達 `ok` のcompleted探索Trial。継続runを別Trialに数えず、provider失敗も分母に入れない。区間が重なれば「判定不能」と出す。
  - #73のLuna開発セットでは公開2事例に対して全cellでsource候補0/3だった。当時の事前登録の規則で短い目的promptを既定に残したが、優劣の証明ではない。失敗Trialの補充は元の12試行と分けて記録した。150分対照も実wallは設定上限より短かった。現在の既定はADR 0029に従う。
  - 履歴を渡せるのは、安定版の公開日時（WordPress.orgの最終更新）より前の公開記録だけ。版を固定した対象やmirrorが使えない対象では、全runがarm aになる。
- **前向き評価**: 四半期ごとに、公開されたadvisoryで本番台帳を再採点し、見逃しを数える。
  - advisoryファイルはGit外に置く私的データ。1件ごとに `{schemaVersion: 1, advisoryId, slug, affectedVersions: [{fromVersion, fromInclusive, toVersion, toInclusive}], publishedAt, impact, allowedLocations: [{file, function?}]}` を書く。`allowedLocations` は公開パッチを読んで人間が書く。
  - 結果は `found` / `missed` / `unscorable`（採点失敗）/ `predates-run` / `not-searched` に分かれる。`missed` 以外は見逃しに数えない。
  - `blind rubric pairs:` の (advisory, Finding) 対だけを、armや検証結果を見ずに人間がtarget-hit / partial / non-targetで採点する。
- **held-out**: 初期の開発と本番開始には使わない。比較研究が必要になった時だけ予算とcaseを決める。

### 任意の旧評価鍵と盲検rubric

将来の比較研究で旧採点器を使う場合だけ、Answer Keyの本文をGit外の権限を絞ったJSONファイルに置く。`eval keys --keys <path>` は形式と重複を検査し、case IDと正規化した鍵のSHA-256 digestだけをJSONで出す。この出力だけをGitのdigest manifestに保存できる。`eval keys --keys <path> --manifest <path>` で全鍵のdigestを照合し、`eval score` にも `--manifest <path>` を付けて採点する鍵のdigestを確認できる。鍵本文や原因箇所は標準出力・台帳に出さない。現行計画では人間に鍵の記入を求めない。

人間の盲検採点には [入力テンプレート](../examples/evaluation/blind-rubric.template.json) をGit外へコピーし、caseとFindingの対ごとに場所、root cause、攻撃者条件、影響を `match` / `partial` / `mismatch` / `unknown` で評価する。armと検証結果を見ずに `target-hit` / `partial` / `non-target` を人間が決め、記入者と時刻を残す。`eval rubric --file <path>` は必須欄と重複を検査し、件数とdigestだけを出す。記入済みフォームはPrivate EvidenceとしてGit外に保管する。

## 7. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへのPoC・payload・再現手順の提供。評価runへのheld-out公開日以降の記録の提供。
- Harnessからの外部送信。
- payload、HTTP記録、画面画像、未公開の発見のGitへのコミット。
