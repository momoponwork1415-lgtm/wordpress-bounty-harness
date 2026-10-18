# 運用手引き（完成後に人間がすること）

探索主経路は、対象ごとに `wp2shell-bounty-v8` のRoot＋最大4 subagentによる協調Trialを1回行う（[ADR 0029](adr/0029-single-wp2shell-cooperative-trial.md) のTrial構成、[ADR 0033](adr/0033-minimum-exploration-and-pinned-dependency-sources.md) の最低時間と依存source、[ADR 0019](adr/0019-harness-generated-output-contract.md) の生成出力契約）。新規探索で実行可能なのはv8と `wp2shell` modeだけ。旧版・旧mode・過去の実験結果は照合用に残す。実機縦断の受入前に本番稼働したものとみなさない。

対象読者: このHarnessを一人で回す運用者。正本は [SPEC.md](SPEC.md)。

- `harness` は `pnpm build` が作る `dist/cli/main.js`（`bin.harness`）。実際の境界アダプターを束ねる。
- Root＋4の実機preflightは `pnpm preflight:root-four --host <Git外host.json> --state <Git外Private Evidence dir>`。固定した無害なtext sourceとrunscのHTTP Labを使い、broker経由でRootと4子のmodel・usage・source読取・Lab到達を測る。`preflight.json` とrolloutはrunごとにGit外へ保存される。これ自体はTranslatePress探索Trialには数えない。
- コマンド名は `runCli`（`src/cli/index.ts`）が受け付けるもの。
- host設定は `--host <path>` か `WBH_HOST_CONFIG` で渡す。
- 台帳とPrivate Evidenceの置き場は `--state <dir>` か `WBH_STATE_DIRECTORY` で選ぶ。既定は `~/.local/state/wordpress-bounty-harness`。
- 過去の単独Trialの設定例は [examples/translatepress-3.3.1/](../examples/translatepress-3.3.1/README.md)。過去の2×2開発セット（`examples/translatepress-3.2.5/`）は 2026-10-18 に削除し、Git 履歴にだけ残る。Root＋4の本番開始条件は [TranslatePressベンチマーク](TRANSLATEPRESS-BENCHMARK.md)。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りのDockerホスト。Codex CLI ≥ 0.161。ChatGPT Proにログイン。費用は購読の月額固定で、Harnessは金額でなく使用量（rate limit / quota）を見る | 初回とCLI更新時 |
| build | `pnpm install && pnpm build`。credential proxyは `dist/discovery`、HTTP捕捉proxyは `dist/lab-recorder` にでき、それぞれrunsc containerへ読み取り専用でmountする | 更新のたび |
| host設定 | Git外のJSON（`wordpressHostConfigSchema`、雛形は `examples/translatepress-3.3.1/host.example.json`）。docker、作業dir、全imageのdigest固定、Codex runtime profile、認証情報ファイルの**パス**、Programme写しのパス、履歴mirror | 初回とimage更新時 |
| 認証 | ホストでCodex CLIにChatGPTログインし（`codex login`）、その `auth.json`（0600、本人所有）のパスをhost設定の `credentialFilePath` に、`authenticationMethod` を `chatgpt-oauth-host` にする。読むのはegress brokerだけで、エージェントには渡らない（下記） | 初回とログイン失効時 |
| Programmeの写し | wordfence.comは自動取得できないので、公式3ページを人間がpage documentへ写す（雛形は `examples/translatepress-3.3.1/wordfence-programme.example.json`）。35日を超えると選定が止まる | 月1回 |
| campaign設定 | JSONファイル（`wordpressCampaignConfigSchema`）。Programme Boundary、停止規則、Lab、`resources` を書く。認証情報と鍵は書かない | 方針を変えるとき |
| 選定方針 | `src/profiles/wordpress/policy/selection.json`（説明は同じ場所の `selection.md`）。インストール数の下限と上限、更新の鮮度、除外slug、公開履歴の重み・window・mirror の最大 age（ADR 0037） | 月1回程度 |
| trust境界宣言 | `src/profiles/wordpress/prompts/trust-boundary-v1.md` をそのまま使う | ほぼ変えない |
| 対象範囲の方針 | `src/profiles/wordpress/policy/programme-scope.md` を公式ページで見直す | 提出前と月1回 |
| 履歴mirror | 第5節の手順で更新し、`history status` で鮮度を確かめる。mirror が 2 日以上古いと選定が止まる（方針 `maximumHistoryAgeDays`、ADR 0037）。日次更新の自動化は #231 | 毎日と提出前 |
| 人手に数えない保守 | Step 1 の「人手介入 0」の判定で介入に数えないもの: 1 日 1 回の `continuous status`、ChatGPT の再ログイン（`waiting-login` からの再開）、Programme 写しの月 1 回の更新、提出前の mirror 更新、`docker system prune`（`-a` を付けない）、`lab cleanup`、レビュー batch の前後の `continuous stop` / `resume` / `run`。それ以外（下限の変更、設定変更、手動の `campaign run`、修正 PR）は介入に数える | 判定時 |

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
- 認証情報ファイルが通常ファイル、0600、本人所有で、空でない。APIキーの中身は読まない。ChatGPTログインはメモリ上で読み、access tokenがTrialのwall上限と起動余裕15分を超えて有効なことを確かめる（既定120分Trialでは135分）。
- credential proxy（`dist/discovery`）のbundleがある。Lab HTTP捕捉proxy（`dist/lab-recorder`）はLab provision時に使うため、実行前の `pnpm build` を要する。
- Codex imageのCLI版と同梱カタログのdigestが、runtime profileと一致する。

**ChatGPTログインの中継**: runごとのbroker（runsc）が、そのrunだけのCAと `provider-egress.internal` の証明書でHTTPSを待ち受ける。

- エージェントのsandboxには、grant tokenとダミーaccountだけでできた使い捨ての `auth.json`、そのCA、brokerのIPだけが入る。本物のaccess tokenとaccount IDはbrokerだけが持ち、refresh tokenはbrokerにも渡さない。
- brokerは `responses` のPOSTだけを、bindしたmodel・件数・大きさ・期限の範囲で `chatgpt.com` へ転送する。workspace discoveryはbrokerが自分で答え、それ以外のendpoint（plugins、analyticsなど）は403にする。
- Root＋4 Trialのbroker上限は2,000 provider要求。既定wall上限120分とは独立に記録し、要求件数の上限到達は `incomplete(policy: broker-request-cap)` として扱う。過去の単独Trialの100要求上限は新主経路に適用しない。
- provider要求本文の上限はRoot＋4で8 MiB。長い協調探索で1 MiBを超えた実測を受けて拡張した。413応答は `incomplete(policy: broker-request-bytes-cap)` として記録し、探索0件として数えない。
- tokenの更新はしない。preflightが期限不足を出したら、ホストで `codex login` をやり直す。
- APIキー（`host-private-bearer`）の経路も残っている。

provider の構造化エラー `cyber_policy` は `incomplete(provider: provider-cyber-policy)` と記録する。これは broker の要求上限や認証期限切れ、正常な候補0件とは別の停止理由。詳細な診断は Git 外 Private Evidence の receipt に結び付けて保持し、台帳へエラー本文を写さない。拒否された対象は `target-skipped(provider-refused)` として次の対象へ進む。Root が source を 1 件も読まず、子を起動せず、broker 転送が 1 以下で終わった run は Trial に数えず、その対象は次の選定で戻る。途中まで走った Trial は数え、再選定しない。拒否を避ける目的で prompt を言い換えない。件数は `ledger stops` で見る。

```sh
harness ledger stops --campaign <id>                                        # provider-cyber-policy の run を見つける
harness campaign resume --campaign <id> --run <runId> --config <campaign.json>   # その Root thread を新しい sandbox で再開（ADR 0036）
```

`campaign resume` は操作者が名指しした 1 run だけを、同じ Snapshot・同じ runtime profile・同じ v8 再開段落・残り wall（120 分 − 消費済み）で、session file と notes を復元した新しい使い捨て container に `codex exec resume` する。再開できる run は `failed(provider: provider-cyber-policy)` で Lab 無し、receipt に `session` があり、残り wall が 5 分以上あるものだけ。それ以外は `not resumable: <理由>` を 1 行出して終了コード 3、event は書かない。再開 segment は同じ `trialId` で `discovery-run-started.resumesRun` を持ち、funnel では Trial 1 回のまま、wall と token は合算する。同じ thread が再び拒否されることはある。自動では再開せず、prompt の言い換えもしない。旧 receipt（`session` 無し）の run は再開できない。

`campaign run` は無人で回る。既定は対象ごとに `wp2shell-bounty-v8` のRoot＋最大4子による協調Trialを1回行い、wall上限は120分。最低60分は能動的に探索し、Rootが早く最終報告したときは同じ協調セッションで探索を続ける。継続不能、wall・provider・broker・schema等の失敗は理由付き `incomplete` として記録する。screeningや候補の有無による二段目、同一対象の追加Trialは起動しない。各 Finding は別コンテナの Verifier と判定器を通る。
wall 到達時は agent と broker を名前で `docker stop -t 10`（失敗時は `docker kill`）してから、子の報告を回収し `discovery-run-finished` に `incomplete(wall)` を記録して Lab を片付ける。
`continuous run` に SIGTERM を送ると進行中の探索 run を同じ手順で停止し、`stopped reason=operator` を記録して終了する。

v7 は固定 source からの探索をRootに任せ、入口索引を渡さない。`discovery-run-started` に索引無効を記録する。旧v5/v6の索引、coverage と `incomplete(depth)` の記録は過去の評価結果として読み続ける。

既定かつ新規Trialで唯一選べるpromptは `wp2shell-bounty-v8`（2026-10-18、所有者決定）。旧版と実験結果は履歴照合用に残し、探索には使わない。Snapshotに対象、WordPress core、実行imageと一致するPHP source、`Requires Plugins` または明示pinによる依存pluginを固定する。探索sourceは `/workspace/main`、`/workspace/wordpress`、`/workspace/php`、`/workspace/dependencies/<slug>` に読み取り専用でmountする。`ledger runtime` とrun receiptで実際のwall・source読取を確認する。日次上限はない。provider limitで停止したcampaignは自動retryせず、同じIDで未消費の対象から再開する。

自動選定の campaign は初回起動時に `selection-batch-bound` を追記し、選定バッチと対象集合を固定する。再開時はこの記録のバッチを読み、途中で `select` を再実行しても新しいバッチに切り替えない。選定時に固定した Snapshot と materialized source は digest を再検査して使い、campaign 開始時に同じ ZIP を再取得しない。公開一覧の取得元・確認日時・available/stale/unavailable と失敗理由は Private Evidence の選定レポートに記録する。

- **同時run数**: campaign設定の `resources` で決める。
  - 既定の `resources` は `{"maxConcurrentRuns": 1, "memoryBudgetMiB": 10752}`。新主経路は対象ごとに1 Trialで、wall上限は120分。
  - `observed` は完了した command event の文字列から Harness が数える下限の近似。script 内部のファイル読出しや通信は含まない。
  - 実効の同時数は協調Trialでは `min(maxConcurrentRuns, floor(memoryBudgetMiB / 10752))`。10,752 MiBはRoot＋最大4子のCodex sandbox（10 GiB）とrunごとのegress broker（512 MiB）の合計。旧単独Trialの計算単位は2,560 MiB。
  - ホストが小さいときは `memoryBudgetMiB` を下げる。1run分に満たない値では開始しない。
  - Labのメモリは対象ごとに別に要る。
- **上限での停止と再開**: provider のrate limit / quotaの応答を受けたとき。
  - 新しいrunを出さず、進行中のrunを記録して止まる。終了コードは3で、台帳に `campaign-stopped(provider-limit)` が残る。
  - 手で回すときは同じコマンドをもう一度実行すると再開する。`continuous run` の下では runner が backoff（quota は 30 → 60 分、rate-limit は 5 → 60 分、2 回連続なら 6 時間）の後に同じ campaign ID で再開する。ADR 0032 Q18 で止めたのは外側 cron の quota tick であり、runner の in-process の待機は別物。開始済みTrialは追加せず、未検証のFindingを検証して未消費の対象へ進む。
  - 拒否（`provider-cyber-policy`）、wall、schema、CLI 終了などの対象単位の失敗は campaign を止めず、その対象を `target-skipped`（理由 `provider-refused` / `run-failed`）にして次へ進む。同じ campaign の再実行ではその対象を再開しない。
  - Verifier が provider の上限を受けたときも同じく `campaign-stopped(provider-limit)` で止める。再開時はその検証を同じ Lab Setup で 1 回だけ自動再試行する。
  - operator の stop は対象の境界で効く。進行中の対象は終わらせ、新しい対象を始めず、台帳に `campaign-stopped(operator)` が残る。
- **旧入口分担の記録**: 旧 `assignment` mode（2026-10-18 削除）の索引・成分digestは過去Trialの照合用に台帳から読む。v8 の新規探索では mode は `wp2shell` だけで、入口索引も渡さない。
- **過去Trialの記録**: 旧 `stage` / `continuationOf` 付きevent、旧ablation arm、旧prompt・入口索引のdigestは台帳から読める。新規探索には旧prompt・旧modeを使わず、段やcontinuationも新規に書かない。Leadの本文はPrivate Evidenceに置き、台帳にはdigestと分類だけを記録する。
- **対象ごとの失敗**（取得、探索、検証）: 標準エラーに `skipped <対象> <版> at <段階>: <理由>` と出す。台帳の `target-skipped` には段階、短い理由コード、Private Evidence に置いた `target-skip-diagnostic.json` の digest を残し、次の対象へ進む。DNS、接続タイムアウト、HTTP 応答、source 検査不一致を区別する。WordPress.org への取得は Node 同梱の `fetch` に `AbortSignal.timeout`（metadata 30 秒、archive 5 分）を付ける。取得失敗を探索の正常な候補0件に数えない。
- Lab 準備では使い捨て runsc コンテナから HTTP 到達を確認する。`lab-provisioned.reachability.http = failed` なら探索を始めず、`failureStage` と `reason` を記録する。DB 到達の失敗は記録するが HTTP が通れば続ける。Docker の診断文は Private Evidence に置き、台帳には digest だけを残す。
- pinned WordPress image の core は `<workDirectory>/wordpress-core` に実行せず取り出し、Dependency Snapshot として固定する。同じimageのPHP archiveもchecksumと版を照合して `<workDirectory>/php-runtime` に固定する。探索はそれぞれ `/workspace/wordpress` と `/workspace/php` の read-only mount で読み、Labは実行中のPHP版を照合する。必要な依存pluginもSnapshotに固定し、Labに供給して探索では `/workspace/dependencies/<slug>` にread-onlyでmountする。
- campaign の `lab.databaseAccess` は既定で `read-only`、Lab 単体の既定は `none`。reader は provision 時点で存在する table にだけ SELECT 権限を持ち、後で作る canary table は読めない。`configuration.labAccess` と `lab-provisioned.reachability.database` を併せて見る。Codex image に MySQL client があるかは実 run で未確認で、無い場合は image に `mariadb-client` が要る。
- User Registration & Membership 5.2.8 の通常利用画面は campaign の `lab.scenarioId` に `public-registration-and-account-v1` を指定して作る。scenario の版と digest は profile が固定し、探索 Lab と検証 Lab の両方で同じ登録フォーム・ログイン・アカウント画面を供給する。WordPress 標準の `users_can_register=1` を設定し、`default_role=subscriber` を検査する。現行の人間向け再現資料はこの設定を `enabledSettings` に自動列挙しないため、#141 で扱う。
- 同じ版の公開無料会員フォーム、無料プラン、通常加入済み subscriber、会員管理画面が必要なときは `public-free-membership-v1` を指定する。plugin 自身の初期化と会員サービスで作り、探索 Lab と検証 Lab は同じ setup digest を持つ。この scenario は旧 `public-registration-and-account-v1` を残したまま追加する。
- wpDiscuz 7.6.72 の通常コメント環境は campaign の `lab.scenarioId` に `public-plugin-comment-v1` を指定して作る。profile が管理者初回訪問に相当する初期化を行い、公開フォームと承認済みの無害なコメントを用意する。探索 Lab と検証 Lab は同じ scenario digest と setup digest を持つ。
- VerifierのHTTPはLab内のrunsc捕捉proxyへ向ける。判定器はHarness捕捉のrequest / responseを優先し、捕捉がないときだけVerifierの `http.json` を `agent-authored` として読む。HTTP本文はPrivate Evidence、台帳にはoptionalな `verification-finished.evidenceCapture` enumだけを残す。`runtime-confirmed` には引き続きcanary回収が要る。
- 失敗した探索 run は `discovery-run-finished.reason`、`reasonDetail`、`providerLimit` で区別する。`reasonDetail` は検査名などの短いコードで、実行記録や HTTP 本文は含まない。

人間が触るのは `review` だけ。並ぶのは次の2種類。

| 種類 | 付いてくるもの | 人間がすること |
| --- | --- | --- |
| `runtime-confirmed` | 再現パッケージ（手動手順、Pythonスクリプト、Lab再構築情報、判定器の証拠）と、判定器が観測した条件 | 自分の手で再現する。影響が意味を持つか、意図された動作でないか、重複でないかを判断する |
| `incomplete` | 理由コードと次の手 | 環境・手順の不足なら再検証を指示する。`no-judge`（判定器がない種別）なら手で確かめる |

`contradicted` は件数しか出ない。

### 探索だけ回し、検証を 1 件ずつ回す

`campaign.json` の `discovery.lab` は既定（省略時）が `"none"` で、探索用 Lab を供給せず、Finding は台帳に記録して検証を後へ送る（所有者決定 2026-10-18「通常モードは Lab を起動しない探索」）。`"attached"` にすると従来どおり探索用 Lab を供給する。設定変更は campaign.json の PR で行い、prompt 本文は変えない。

```sh
harness campaign run <slug> --campaign <id> --config <campaign.json> [--repeat 3]
harness verify next --campaign <id> --config <campaign.json>
harness ledger funnel --campaign <id>
```

`verify next` は未検証または既存の有界再検証規則に該当する Finding を 1 件選び、その Finding の Snapshot に新しい検証 Lab を立てて Verifier と判定器を回し、Lab を片付ける。対象が無ければ `no verification pending` と出す。`--repeat 3` は同じ Snapshot に別々の Trial ID を 3 つ作る。既定は 1 回。funnel の `by Lab` は探索用 Lab の有無、`verification Lab failed` は検証側の供給失敗を示す。

```sh
harness verify next --campaign <id> --config <campaign.json> --handoff <dir> [--finding <id>] [--port 8080] [--db-port 3307]
```

`--handoff <dir>` は Verifier を Codex から skill `wbh-verify` への受け渡しに替える（ADR 0035）。Harness は検証 Lab を立てて `127.0.0.1:<port>` に Lab の recorder 経由で公開し、`<dir>/lab.json`（接続先と Host header、攻撃者位置の資格、設定管理者の資格、canary、`<dir>/review-export.json` の path）を書き、`<dir>/setup-done` を待ってから HTTP 捕捉と Lab 状態の基線を取り、6 file（`route.json` `http.json` `session.json` `steps.md` `refutation.md` `precondition`）か `<dir>/abort` を待つ。待ち時間の上限は Codex Verifier と同じ 30 分で、超過と `abort` は `incomplete(recipe)`。以後は判定器 → `verification-finished`（`promptVersion: wbh-verify/v1`）→ review queue と同じ。`--finding <id>` は操作者が名指しした Finding を自動再試行の規則（prompt 版の一致、再試行予算）に関わらず検証する。`<dir>` は Git の外に置き、終わったら消す。

`continuous run --verify-concurrency <n>` は探索 batch と並行して検証 queue を消化する。既定の `n` は 1。検証 Lab の同時数は `resources.maxConcurrentTargets` に含めず、`--verify-concurrency` で別に制限する。

### 継続運転（`continuous run`、最終設計 P6）

```
harness continuous run    --host <path> --state <dir> --config <campaign.json> --selection <selection.json> [--campaign-prefix <text>] [--notify <command>] [--resume]
harness continuous stop   --state <dir>
harness continuous resume --state <dir>
harness continuous status --state <dir>
```

- `run` は `select` → `campaign run --all` → 次の batch を回り続ける。実行履歴の正本は台帳で、`<state>/continuous.json` / `.pid` / `.log` は作業用、`.stop` は理由とともに解除まで残す停止指示。第 2 の journal、owner lease、host 共通 claim、crash 復旧の自動化は持たない。
- 止まるのは operator の stop、候補枯渇（`exhausted`）、Programme 写しの 35 日超（`programme-stale`）、legacy JSON の欠落（`legacy-history-missing`）、下限別の方針 file の欠落（`missing-floor-policy`）、例外 3 batch 連続（`errors`）、completed 0 の batch 3 連続（`no-progress`）の 7 つ。明示的な operator stop と他 6 つの理由は、理由付き停止マーカーを残して終了コード 0 で終え、systemd の `Restart=on-failure` では再起動しない。`OnFailure` はこれらの停止では発火しないため、停止の通知は `--notify` と `continuous status` の監視で行う。例外による crash は終了コード 1 で再起動対象。quota、拒否、ログイン失効（`waiting-login`）、disk 不足では止まらず待つ。
- `status` は状態、pid、最後の例外、今日と今週の Trial 開始・completed・provider-limited・provider-refused・run-failed・Lab 失敗・unsettled、review queue と parked を出す。停止マーカーが残り pid が生きていれば `stopping`、pid が死んでいれば `stopped(<理由>)`、停止マーカーがなく memo だけ実行中なら `stale` と表示し、いずれも終了コード 1。`stop` は `<state>/continuous.stop` に `operator` を記録し、runner は次の対象の境界で止まる。停止マーカーは crash や systemd 再起動でも消えず、通常の `continuous run` は選定・campaign・Lab 掃除を始めない。
- レビュー後または異常停止の原因を確認・修正した後は pid が消えたことを `continuous status` で確認し、systemd 運用なら `continuous resume --state <dir>` で停止マーカーを解除してから unit を起動する。手動運用なら `continuous run ... --resume` で解除と起動を一度に行える。実行中 pid がある間の再開は拒否する。systemd unit の `ExecStart` に `--resume` を固定しない。SIGINT / SIGTERM は進行中の対象を drain して終了するが、停止マーカーは残さない。`--selection` の隣に `selection.50000.json` と `selection.30000.json` が無ければ起動しない。runner は `campaign run --selection <path>` と同じく campaign 設定の `selectionPolicyPath` を差し替えて走る。各 batch の後の Lab 残骸の掃除は、`lab up` の Lab か `lab up --for-review` が生きている間は行わない。
- install 下限は runner が無人で変えない。`exhausted` のときは所有者が `--selection selection.50000.json` のように下限だけ違う方針 file で起動し直す。
- 前提: 単一 host、単一運用者、本番の `--state` は 1 つ。硬い総 token 枠は置かず、provider の quota と operator の stop だけで止まる。未 merge branch で回した Trial は本番の分母に混ぜない。起動は systemd user unit（`loginctl enable-linger`、`WorkingDirectory=<本番 checkout>`、`Restart=on-failure`、`RestartSec=300`、`TimeoutStopSec=4500`、`KillMode=mixed`、`OnFailure=<通知 unit>`）か `nohup`。本番 checkout での `pnpm build` は `continuous stop` の後だけ。
- 同じ plugin slug の 2 回目以降の独立 Trial は 1 Trial ごとに所有者が事前承認する（ADR 0032 Q6）。承認の形式は所有者が 2 回目を求めるときに設計する。Step 1 は初回 Trial だけを回す。
- 週次 smoke（#126）は、既知の `runtime-confirmed` Finding に `review reverify` を 1 回打つことで代える（campaign ID は `smoke-<YYYYMMDD>`）。
- 最新版で確認した新しい `runtime-confirmed` Finding が出たら、その Snapshot と Lab Setup を保持し、週次 smoke の case に加える。通った検証は回帰試験になる。

## 3. 提出までの操作

1 件のレビューは次の順で進める。skill は提案と文案だけを出し、台帳に書くコマンドは所有者が打つ。

| 順 | 誰が | 何を |
| --- | --- | --- |
| 1 | 所有者 | `harness review export --campaign <id> --finding <id>` |
| 2 | skill | `wbh-review`（要約と accept / reject / defer の提案。`verification.status` が `incomplete` なら 3〜8 を飛ばし `defer` の提案で終える） |
| 3 | skill | `wbh-dedupe`（重複の 3 値と根拠） |
| 4 | 所有者 | WordPress.org の plugin 頁で最新版を確認（export に `target.versions.latestObserved` があればそれを使う） |
| 5 | 所有者 | `harness review reverify --campaign <id> --finding <id> --config <path> --version <最新版>` |
| 6 | 所有者 | `harness review scope --campaign <id> --finding <id>`（`wordfence in-scope` のものだけ先へ） |
| 7 | 所有者 | `harness lab up --for-review --campaign <id> --finding <id>` で手で再現し、`harness review reproduced --campaign <id> --finding <id> --result match --minutes <n>` |
| 8 | 所有者 | `harness review decide ...`（skill が示したコマンドを確かめて打つ） |
| 9 | skill | `wbh-report`（英語の下書きを Private Evidence に書き、`review draft` で digest を記録） |
| 10 | 所有者 | `harness review authorize --to wordfence` → 送信 → `harness review submitted` → `harness review outcome` |

1 件あたりの見積りは reverify 30 分、手での再現 40 分、skill 30 分。1 回の batch は 3 件までにし、超える分は `defer` にする。RAM 16 GiB 未満の host では batch の前に `continuous stop`、後に `continuous resume` と `continuous run` を打つ（人手に数えない保守）。runner を起動し直す前に `lab down` で review 用の Lab を消す。

```
harness review parked --campaign <id>                       # parked Finding と reason を一覧する
harness review export --campaign <id> --finding <id>         # 1画面のレビュー材料をJSON 1本（schema review-export/v1）で出す。台帳には書かない。skillはこれだけを読む
harness review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate unavailable|no-match|possible-match:<ref>] [--minutes <n>]
harness review dedupe --campaign <id> --finding <id>          # ローカルWordfence履歴mirrorと照合
harness review scope --campaign <id> --finding <id>           # Wordfence / Patchstack ごとに in-scope / out-of-scope / ambiguous
harness review reverify --campaign <id> --finding <id> --config <path>   # 最新版を新しいLabで検証し直す
harness review reverify --campaign <id> --finding <id> --config <new-scenario.json> # incompleteを元のSnapshotで再試行
harness review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]
harness review authorize --candidate <id> --draft <digest> --to <destination>
harness review submitted --candidate <id> --draft <digest> --to <destination>
harness review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]
```

- `export` は Finding（claim / attackerPosition / brokenProperty / impact）、HTTP の method / path / status 行、反証メモ、検証 Lab の実行前後差分の要約（option 名と digest、ユーザーの役割、テーブル件数と checksum）、探索した版と台帳が知る最新版、install 数、Private Evidence の path を 1 本の JSON にまとめる。候補本文、payload、HTTP 本文、option 値は path と digest でだけ参照し、stdout に値を出さない。
- `review parked` の reason は `outside-programme-boundary`（影響分類が対象外）と `admin-configuration-precondition`（特定値または非既定の管理者設定が前提）の 2 種類。どちらも Finding の Private Evidence を保持し、検証・review queue に入れない。
- `decide --minutes` は人間がその項目に使った時間を `human-effort-recorded` に分で、`review-decided` に `humanElapsedSeconds` として残す。決定は検証 ID、探索 run ID、prompt digest に結び付いて記録され、提出から run と prompt まで辿れる。
- `scope` は判定器の証拠と選定記録から事実を読む。最新版での確認が要るプログラムは、`reverify` が `runtime-confirmed` を返した後でだけ満たされる。
- 確認済みrouteのないFindingは、前回が`incomplete(precondition)`でLab記録があり、`--version`なしで選定されたSnapshotが元のFindingと同じ場合だけ、前回と異なるscenario IDのLabで独立再検証できる。Snapshotが異なる場合と`--version`付きの修正版比較はLab起動前に拒否する。元のverification eventは残り、再試行は新しいverificationIdとsetup digestを記録する。
- `authorize` は「この文案のこの版を、この送信先へ出す」ことの記録で、送信はしない。送信は人間がWordfence / Patchstackの画面で行い、`submitted` で記録する。
- 提出後の転帰と報奨額を `outcome` で台帳に戻す。選定方針と判定器の改善材料になる。探索へは戻らない。
- Reflected XSSはWordfence向けの候補にならない。authz / IDORは、乗っ取り・権限昇格・サイト全体への影響に届くときだけ in-scope。

## 4. 見るべき数字

```
harness ledger funnel --campaign <id> | --since <ISO>  # --since は全 campaign の指定時刻以降の event を合算。探索の incomplete(depth) を独立表示。raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome、種別別、arm別、転帰と報奨
harness ledger stops [--campaign <id>] [--since <ISO>]  # run の失敗理由×provider上限、target-skipped の段階×理由、Lab 失敗段階、campaign 停止理由の件数。拒否 run は explore 件数と 60 秒以内の件数も出す
harness ledger usage [--campaign <id>]    # providerが返したtokenを対象・UTC日ごとに合計。返らなかった項目はunavailableの件数
harness ledger runtime [--campaign <id>]  # runが記録したmodel、effort、CLI版、カタログdigest、tier、access、認証の組ごとのrun数
```

収益の式は「対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用」。funnelの各段がこの各項に対応する。

| 細い段 | 直す場所 |
| --- | --- |
| raw Findingが少ない | 本番A/B（第6節）、分担単位 |
| verifier通過が少ない | 判定器の成功条件、Lab構成（`incomplete` の理由コードを見る） |
| in-scopeが少ない | 選定方針（対象外になりやすい種別・tierを避ける） |
| duplicateが多い | Finding 後の重複照合と履歴mirrorの鮮度。選定は mirror の件数と公開日だけを採点に使い、記録の内容は重複照合でだけ読む（ADR 0037） |

## 5. 保守

### 履歴mirrorの更新

- 更新は既存の正規化器で行う。旧環境で `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を実行する。API keyは `WORDFENCE_INTELLIGENCE_API_KEY` か `~/.config/wordfence/env` に置く。成功後30分以内の再取得は抑止される。
- 更新後に `harness history status` を見る。照合口と同じ規則で、`fresh` / `stale`（既定24時間超、または前回更新の失敗）/ `unavailable`（stateが読めない、DBとstateが食い違う）を表示する。
- `stale` / `unavailable` は「重複なし」を意味しない。詳細は [wordfence-history/README.md](../src/profiles/wordpress/wordfence-history/README.md)。
- 選定は同じ mirror の件数を採点に使い、`last_successful_at` が 2 日（方針 `maximumHistoryAgeDays`）を超えると `select` と runner の選定が止まる（ADR 0037）。日次更新を回す（#231）。

### 対象の自動選定

`select` は [選定方針 JSON](../src/profiles/wordpress/policy/selection.json) を直接読み、WordPress.org の人気順・タグ順を列挙する。install下限もこの JSON が正本。`pluginDependencySlugs` は `Requires Plugins` ヘッダに現れない必要な依存を対象slugごとに列挙し、freeze時点の公式stable版をSnapshotに固定する。手動の開発・歴史的評価対象は `pluginDependencyPins` で版を明示する。台帳の探索開始（`runKind: explore` の `discovery-run-started`）と Finding を照合し、適格な次点候補で補充して3〜5対象を返す。選定だけで Trial が始まらなかった対象のうち Snapshot の失敗は除外しない。探索用 Lab の供給に失敗した対象は、その版に限って `lab-provision-failed` で除外し、版が上がれば戻す。依存pluginはSnapshotに固定し、Labと探索に同じsourceを渡す。source 0 件・子 0・broker 転送 1 以下で終わった run しか持たない対象は除外しない。終了記録と観測値のない開始記録だけの attempt も Trial に数えない。途中まで走った Trial は数え、再選定しない。自動候補源の `revisitPolicy` は `never` に固定し、版または prompt 版が変わっても Trial 済み slug を戻さない。未公開 Finding を持つ対象は、提出済みでも公開を確認できないため除外する。

旧世代の既往は host 設定の `legacyHistory: {"file": "/abs/legacy-slugs.json"}` で渡す。`select` のたびに読み、`started` を `legacy-started`、`ambiguous` を `legacy-ambiguous` として除外する。所有者が `reconsider` に書いた slug は `legacy-*` と、file の `exportedAt` より前に始まった Trial の `previously-selected` を解除して再選定できる。`exportedAt` 以降に始まった Trial は通常どおり数えるので、同じ slug が batch ごとに選ばれ続けることはない（2026-10-16 の本番で popup-maker と the-events-calendar が連続選定された修正）。file が無ければ `select` は `legacy history unavailable` と表示し、候補源による `campaign run` と `continuous run` は起動しない。選定レポートの旧履歴 digest と実行時の digest が違えば止まる。`select --minimum <n>`（既定 3、runner は 1）未満しか固定できないときは、台帳に `target-selected` を書かず、各対象に `below-minimum` を付けて空の選定を返す。

列挙は人気順 10 頁と方針のタグ 8 個を各 1 頁、1 頁 50 件、候補 1,000 件まで読む（schema の上限は `popularPages` 20、`maxCandidates` 2,000）。`revisitPolicy` は `never` で、版や prompt 版が変わっても Trial として数えた slug は戻らない（所有者の `reconsider` を除く）。下限だけを変えた写し `selection.50000.json` と `selection.30000.json` を同じ場所に置き、起動時に所有者が選ぶ。方針 file を差し替えると policy digest が変わり束縛済みの batch を再開できないので、batch の境界で入れ替える。

legacy JSON は起動前に 1 回作る。旧研究 DB の slug を返す SQL は実物の schema を見て書く。

```sh
node scripts/export-legacy-slugs.mjs \
  --db /abs/old-research.sqlite \
  --db-started-sql "SELECT ... AS slug FROM ..." \
  --db-ambiguous-sql "SELECT ... AS slug FROM ..." \
  --state /abs/old-state-1 --state /abs/old-state-2 \
  --report /abs/selection-report.json > /abs/legacy-slugs.json
```

旧 `--state` の台帳では探索開始のある slug を `started` に畳み込む。`--report` には下限 30,000 の方針で別の state に `select` した選定レポートを渡す。標準エラーに下限 100,000 / 50,000 / 30,000 ごとの列挙可能数と残り候補数が出る。本番の台帳には触れない。

旧 `scripts/prepare-pilot-selection.mjs` は `harness select` の薄い呼び出しとして残す。`--host`、`--state`、`--config` を受け取り、候補と順位は作らない。

スコア内訳、除外理由、候補一覧の取得元と観測時刻は標準出力と Git 外の `selection-report` に残る。最初の Snapshot 固定に失敗した候補は `snapshot-unavailable` として除外し、`target-skipped` から対象選定記録・選定レポート・Private Evidence の診断を digest 参照できるようにする。台帳の理由は短い定型コードだけにする。`target-selected` は固定済み Snapshot digest と `target-selection` の Private Evidence を参照する。次の `campaign run --all` は同じ方針 digest の最新バッチを使い、Snapshot が変われば止まる。公開履歴は host 設定 `wordfenceHistory` の mirror から slug 単位の件数と最新公開日だけを採点に使い（`scoreWeights.history`、既定 5。`historyPayingClass` は既定 0）、記録の内容は読まず探索にも渡さない。mirror の `last_successful_at` が方針の `maximumHistoryAgeDays`（既定 2 日）より古い、state と DB が食い違う、host に mirror が無いときは `select` が候補を観測せずに止まる。選定レポートと `target-selection.json` に mirror の時点と digest、件数、最新公開日が残る（ADR 0037）。

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

### 手で確かめるためのLab

```
harness lab up --campaign <id> --finding <id> --config <campaign.json> [--port 8080] [--db-port 3307]
harness lab down [--config <path>]
```

- `lab up` は検証と同じ Lab 供給（runsc、同じ scenario、依存 plugin、固定 Snapshot）を立て、runsc の gateway container で `127.0.0.1:<port>` に WordPress を、Lab が DB を公開する設定なら `127.0.0.1:<db-port>` に read-only DB を出す。攻撃者用アカウントと DB 接続情報を表示し、台帳には何も書かない。Snapshot が Finding と違えば Lab を起動せずに止まる。
- 画面出力の `setup` 行で、検証時の Lab setup digest と同じかが分かる。
- `lab down` は `lab up` が記録した 1 つの Lab の container / network / volume だけを削除し、残存が 0 でなければ終了コード 1 で残りを列挙する。同時に動く campaign の Lab には触らない。

### Lab / brokerの残骸

```
harness lab cleanup --config <path>            # 一覧だけ
harness lab cleanup --config <path> --remove   # 削除
```

- 対象は、Labが付ける `wbh-<uuid>-{db,wp,canary,proxy,host,net,site}` と、brokerが付ける `provider-egress-broker-<id>` / `provider-egress-<id>` の名前に一致するものだけ。
- **実行中のcampaignがないときに使う。**

## 6. 評価

主指標は本番から得る。旧 `eval score --keys` と Answer Key、盲検 rubric、`eval compare`、`eval prospective`、`eval case-blocked` は 2026-10-18 に削除した（PARKING 2026-10-14 行）。campaign 設定の `ablation` / `comparison` / `entry-index-control` / `assignment` mode も 2026-10-18 に削除した。旧 A/B の割当・digest と `evaluation-case-blocked` event は台帳に残り、`ledger funnel` の arm 別集計で読める。

- **過去比較の照合**: 旧prompt版や入口索引の有無を変えた独立Trialは過去結果として別armで読む。新規探索のprompt・modeはv8と `wp2shell` のみ。旧段付きTrialを同じ分母に混ぜない。
- **旧A/Bの読取**: 過去の `ablation.axes` にあった `history`、`prompt`、`continuation` と旧 `{"axis":"history","armBFraction":0.5}` の割当・digestは台帳に残る。旧基準は `short-objective-managed-v4` と継続なしだった。
  - #73のLuna開発セットでは公開2事例に対して全cellでsource候補0/3だった。当時の事前登録の規則で短い目的promptを既定に残したが、優劣の証明ではない。失敗Trialの補充は元の12試行と分けて記録した。150分対照も実wallは設定上限より短かった。現在の既定はADR 0029に従う。
- **前向き評価**: 四半期ごとに、公開されたadvisoryで本番台帳を再採点し、見逃しを数える。
  - advisoryファイルはGit外に置く私的データ。1件ごとに `{schemaVersion: 1, advisoryId, slug, affectedVersions: [{fromVersion, fromInclusive, toVersion, toInclusive}], publishedAt, impact, allowedLocations: [{file, function?}]}` を書く。`allowedLocations` は公開パッチを読んで人間が書く。
  - 結果は `found` / `missed` / `unscorable`（採点失敗）/ `predates-run` / `not-searched` に分かれる。`missed` 以外は見逃しに数えない。
  - `blind rubric pairs:` の (advisory, Finding) 対だけを、armや検証結果を見ずに人間がtarget-hit / partial / non-targetで採点する。
- **held-out**: 初期の開発と本番開始には使わない。比較研究が必要になった時だけ予算とcaseを決める。

## 7. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへのPoC・payload・再現手順の提供。評価runへのheld-out公開日以降の記録の提供。
- Harnessからの外部送信。
- payload、HTTP記録、画面画像、未公開の発見のGitへのコミット。
