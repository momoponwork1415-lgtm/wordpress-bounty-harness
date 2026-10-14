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
| 人手に数えない保守 | Step 1 の「人手介入 0」の判定で介入に数えないもの: 1 日 1 回の `continuous status`、ChatGPT の再ログイン（`waiting-login` からの再開）、Programme 写しの月 1 回の更新、提出前の mirror 更新、`docker system prune`（`-a` を付けない）、`lab cleanup`、レビュー batch の前後の `continuous stop` / `run`。それ以外（下限の変更、設定変更、手動の `campaign run`、修正 PR）は介入に数える | 判定時 |

## 2. 週の流れ

### 実 Lab の週次 smoke（週1回、CI 外）

`runsc`、固定 image、provider 認証を使えるホストで、既に `runtime-confirmed` となった TranslatePress 3.3.1 の ATO Finding を指定する。元 campaign の 3.3.1 と 3.3.2 の Snapshot と materialized source を保持しておく。Finding ID は台帳から、host 設定と Private Evidence は Git 外から読む。`pnpm build` の後、リポジトリのルートで実行する。

```sh
node scripts/smoke-real-lab.mjs \
  --host /path/to/private/host.json \
  --state /path/to/private/state \
  --config examples/translatepress-3.3.1/campaign-real-lab-smoke.json \
  --source-campaign <known-ato-campaign> \
  --binding-campaign <independent-positive-campaign> \
  --finding <confirmed-ato-finding-id>
```

script は別の `smoke-real-lab-...` campaign を作る。`--binding-campaign` は同じ Finding と3.3.1 Snapshotについて独立に陽性が確認された campaign を指す。2つの陽性 Harness 捕捉を照合し、Lab canary 名、security 値、reset key の型付き束縛を Private Evidence に保存する。新しい gVisor Lab で固定の8 HTTP手順を再生し、3.3.1 の陽性、続いて別 Snapshot の 3.3.2 の負の対照を取る。`recipe` / `observation` 不足だけは新 Lab で各 2 回まで再試行する。判定器は再生8手順と束縛後の同一路径を Harness 捕捉で照合する。応答から値を取得できない、8手順が揃わない、または同一路径でない場合は捕捉を Private Evidence に残して `incomplete(observation)` とし、終了コード1にする。`runtime-confirmed` と `contradicted` の両方が台帳に記録され、陽性の束縛後経路も元の route と一致した場合だけ終了コード0。失敗時は段階と `incomplete` の理由を表示し、残った smoke campaign を `harness ledger funnel --campaign <id>` で調べる。再実行には新しい campaign ID を使い、本番 funnel と混ぜない。Stored XSS の経路は判定器修正後に追加する。

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

provider の構造化エラー `cyber_policy` は `incomplete(provider: provider-cyber-policy)` と記録する。これは broker の要求上限や認証期限切れ、正常な候補0件とは別の停止理由。詳細な診断は Git 外 Private Evidence の receipt に結び付けて保持し、台帳へエラー本文を写さない。拒否された対象は `target-skipped(provider-refused)` として次の対象へ進む。run 開始記録がある対象は source・子・broker の完全な不実行を証明できるまで初回候補へ自動で戻さず保留する。拒否を避ける目的で prompt を言い換えない。件数は `ledger stops` で見る。

`campaign run` は無人で回る。既定は対象ごとに `wp2shell-bounty-v3` のRoot＋最大3子による協調Trialを1回行い、wall上限は60分。Rootの報告で正常終了し、Harnessと既定promptは最低実行時間を設けない。wall・provider・broker・schema等の失敗は理由付き `incomplete` として記録する。screeningや候補の有無による二段目、Harnessのcontinuation差し込みは起動しない。各 Finding は別コンテナの Verifier と判定器を通る。

固定 source から列挙した入口索引は既定で探索 prompt の末尾に付く。比較実験で外すときは campaign 設定に `"entryIndex": false` を書く。索引の有無と有効時の digest は `discovery-run-started` に記録される。

既定promptは `wp2shell-bounty-v3`、入口索引は固定source由来のカタログ入力として既定で有効。索引の全件処理は終了条件にしない。`wp2shell-bounty-v2` と `short-objective-managed-v4` は比較armとして残す。`ledger runtime` とrun receiptで実際のwall・coverageを確認する。日次上限はない。provider limitで停止したcampaignは自動retryせず、同じIDで未消費の対象から再開する。

自動選定の campaign は初回起動時に `selection-batch-bound` を追記し、選定バッチと対象集合を固定する。再開時はこの記録のバッチを読み、途中で `select` を再実行しても新しいバッチに切り替えない。選定時に固定した Snapshot と materialized source は digest を再検査して使い、campaign 開始時に同じ ZIP を再取得しない。公開一覧の取得元・確認日時・available/stale/unavailable と失敗理由は Private Evidence の選定レポートに記録する。

- **同時run数**: campaign設定の `resources` で決める。
  - 既定の `resources` は `{"maxConcurrentRuns": 2, "memoryBudgetMiB": 10240}`。新主経路は対象ごとに1 Trialで、wall上限は60分。
  - `observed` は完了した command event の文字列から Harness が数える下限の近似。script 内部のファイル読出しや通信は含まない。
  - 実効の同時数は協調Trialでは `min(maxConcurrentRuns, floor(memoryBudgetMiB / 8704))`。8,704 MiBはRoot＋最大3子のCodex sandbox（8 GiB）とrunごとのegress broker（512 MiB）の合計。旧単独Trialの計算単位は2,560 MiB。
  - ホストが小さいときは `memoryBudgetMiB` を下げる。1run分に満たない値では開始しない。
  - Labのメモリは対象ごとに別に要る。
- **上限での停止と再開**: provider のrate limit / quotaの応答を受けたとき。
  - 新しいrunを出さず、進行中のrunを記録して止まる。終了コードは3で、台帳に `campaign-stopped(provider-limit)` が残る。
  - 手で回すときは同じコマンドをもう一度実行すると再開する。`continuous run` の下では runner が backoff（quota は 30 → 60 分、rate-limit は 5 → 60 分、2 回連続なら 6 時間）の後に同じ campaign ID で再開する。ADR 0032 Q18 で止めたのは外側 cron の quota tick であり、runner の in-process の待機は別物。開始済みTrialは追加せず、未検証のFindingを検証して未消費の対象へ進む。
  - 拒否（`provider-cyber-policy`）、wall、schema、CLI 終了などの対象単位の失敗は campaign を止めず、その対象を `target-skipped`（理由 `provider-refused` / `run-failed`）にして次へ進む。同じ campaign の再実行ではその対象を再開しない。
  - Verifier が provider の上限を受けたときも同じく `campaign-stopped(provider-limit)` で止める。再開時はその検証を同じ Lab Setup で 1 回だけ自動再試行する。
  - operator の stop は対象の境界で効く。進行中の対象は終わらせ、新しい対象を始めず、台帳に `campaign-stopped(operator)` が残る。
- **入口の分担**: campaign の `assignment: {"unit":"entry-point","entriesPerRun":8}` で有効にする。WordPress profile が登録入口、保存先、core 交差、1 hop の include を text 走査し、保存先を共有する入口を同じ scope に置く。索引は事実の列挙で、探索範囲を制限しない。台帳には索引・成分の digest だけを置く。上限（PHP file 20,000、1 file 2 MiB、成分 key 200）を超えた索引は scope に partial と表示する。
- **過去Trialの記録**: 旧 `stage` / `continuationOf` 付きeventと旧ablation armは台帳から読める。旧promptの目的文とdigestで構成を照合するが、旧screeningを現行modeで新規起動しない。新主経路は段やcontinuationを新規に書かず、比較するpromptと入口索引の有無を別armとして明示する。Leadの本文はPrivate Evidenceに置き、台帳にはdigestと分類だけを記録する。
- **対象ごとの失敗**（取得、探索、検証）: 標準エラーに `skipped <対象> <版> at <段階>: <理由>` と出す。台帳の `target-skipped` には段階、短い理由コード、Private Evidence に置いた `target-skip-diagnostic.json` の digest を残し、次の対象へ進む。DNS、接続タイムアウト、HTTP 応答、source 検査不一致を区別する。WordPress.org への取得は Node 同梱の `fetch` に `AbortSignal.timeout`（metadata 30 秒、archive 5 分）を付ける。取得失敗を探索の正常な候補0件に数えない。
- Lab 準備では使い捨て runsc コンテナから HTTP 到達を確認する。`lab-provisioned.reachability.http = failed` なら探索を始めず、`failureStage` と `reason` を記録する。DB 到達の失敗は記録するが HTTP が通れば続ける。Docker の診断文は Private Evidence に置き、台帳には digest だけを残す。
- pinned WordPress image の core は `<workDirectory>/wordpress-core` に実行せず取り出し、Dependency Snapshot として固定する。探索と Verifier は `/workspace/wordpress` の read-only mount で同じ版を読む。
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

### 継続運転（`continuous run`、最終設計 P6）

```
harness continuous run    --host <path> --state <dir> --config <campaign.json> --selection <selection.json> [--campaign-prefix <text>] [--notify <command>]
harness continuous stop   --state <dir>
harness continuous status --state <dir>
```

- `run` は `select` → `campaign run --all` → 次の batch を回り続ける。状態の正本は台帳で、作業メモは `<state>/continuous.json` / `.pid` / `.stop` / `.log` だけ。第 2 の journal、owner lease、host 共通 claim、crash 復旧の自動化は持たない。
- 止まるのは operator の stop、候補枯渇（`exhausted`）、Programme 写しの 35 日超（`programme-stale`）、legacy JSON の欠落（`legacy-history-missing`）、下限別の方針 file の欠落（`missing-floor-policy`）、例外 3 batch 連続（`errors`）、completed 0 の batch 3 連続（`no-progress`）の 7 つ。quota、拒否、ログイン失効（`waiting-login`）、disk 不足では止まらず待つ。
- `status` は状態、pid、最後の例外、今日と今週の Trial 開始・completed・provider-limited・provider-refused・run-failed・Lab 失敗・unsettled、review queue と parked を出し、停止中は終了コード 1。`stop` は `<state>/continuous.stop` を書き、runner は次の対象の境界で止まる。`--selection` の隣に `selection.50000.json` と `selection.30000.json` が無ければ起動しない。runner は `campaign run --selection <path>` と同じく campaign 設定の `selectionPolicyPath` を差し替えて走る。各 batch の後の Lab 残骸の掃除は、`lab up` の Lab か `lab up --for-review` が生きている間は行わない。
- install 下限は runner が無人で変えない。`exhausted` のときは所有者が `--selection selection.50000.json` のように下限だけ違う方針 file で起動し直す。
- 前提: 単一 host、単一運用者、本番の `--state` は 1 つ。硬い総 token 枠は置かず、provider の quota と operator の stop だけで止まる。未 merge branch で回した Trial は本番の分母に混ぜない。起動は systemd user unit（`loginctl enable-linger`、`WorkingDirectory=<本番 checkout>`、`Restart=on-failure`、`RestartSec=300`、`TimeoutStopSec=4500`、`KillMode=mixed`、`OnFailure=<通知 unit>`）か `nohup`。本番 checkout での `pnpm build` は `continuous stop` の後だけ。
- 同じ plugin slug の 2 回目以降の独立 Trial は 1 Trial ごとに所有者が事前承認する（ADR 0032 Q6）。承認の形式は所有者が 2 回目を求めるときに設計する。Step 1 は初回 Trial だけを回す。
- 週次 smoke（#126）は、既知の `runtime-confirmed` Finding に `review reverify` を 1 回打つことで代える（campaign ID は `smoke-<YYYYMMDD>`）。

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

1 件あたりの見積りは reverify 30 分、手での再現 40 分、skill 30 分。1 回の batch は 3 件までにし、超える分は `defer` にする。RAM 16 GiB 未満の host では batch の前に `continuous stop`、後に `continuous run` を打つ（人手に数えない保守）。runner を起動し直す前に `lab down` で review 用の Lab を消す。

```
harness review inspect --campaign <id> --finding <id>        # 1件の参照情報を開き、台帳へ記録する（review-item-opened）
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
- `decide --minutes` は人間がその項目に使った時間を `human-effort-recorded` に分で、`review-decided` に `humanElapsedSeconds` として残す。決定は検証 ID、探索 run ID、prompt digest に結び付いて記録され、提出から run と prompt まで辿れる。
- `scope` は判定器の証拠と選定記録から事実を読む。最新版での確認が要るプログラムは、`reverify` が `runtime-confirmed` を返した後でだけ満たされる。
- 確認済みrouteのないFindingは、前回が`incomplete(precondition)`でLab記録があり、`--version`なしで選定されたSnapshotが元のFindingと同じ場合だけ、前回と異なるscenario IDのLabで独立再検証できる。Snapshotが異なる場合と`--version`付きの修正版比較はLab起動前に拒否する。元のverification eventは残り、再試行は新しいverificationIdとsetup digestを記録する。
- `authorize` は「この文案のこの版を、この送信先へ出す」ことの記録で、送信はしない。送信は人間がWordfence / Patchstackの画面で行い、`submitted` で記録する。
- 提出後の転帰と報奨額を `outcome` で台帳に戻す。選定方針と判定器の改善材料になる。探索へは戻らない。
- Reflected XSSはWordfence向けの候補にならない。authz / IDORは、乗っ取り・権限昇格・サイト全体への影響に届くときだけ in-scope。

## 4. 見るべき数字

```
harness ledger funnel --campaign <id> | --since <ISO>  # --since は全 campaign の指定時刻以降の event を合算。raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome、種別別、arm別、転帰と報奨
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
| duplicateが多い | Finding 後の重複照合と履歴mirrorの鮮度。公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030） |

## 5. 保守

### 履歴mirrorの更新

- 更新は既存の正規化器で行う。旧環境で `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を実行する。API keyは `WORDFENCE_INTELLIGENCE_API_KEY` か `~/.config/wordfence/env` に置く。成功後30分以内の再取得は抑止される。
- 更新後に `harness history status` を見る。照合口と同じ規則で、`fresh` / `stale`（既定24時間超、または前回更新の失敗）/ `unavailable`（stateが読めない、DBとstateが食い違う）を表示する。
- `stale` / `unavailable` は「重複なし」を意味しない。詳細は [wordfence-history/README.md](../src/profiles/wordpress/wordfence-history/README.md)。

### 対象の自動選定

`select` は [選定方針 JSON](../src/profiles/wordpress/policy/selection.json) を直接読み、WordPress.org の人気順・タグ順を列挙する。install下限もこの JSON が正本。台帳の探索開始（`runKind: explore` の `discovery-run-started`）と Finding を照合し、適格な次点候補で補充して3〜5対象を返す。選定されただけで Trial が始まらなかった対象（Lab や Snapshot の失敗）と、source を 1 件も読まず子を起動せず broker 転送 1 以下で終わった run しか持たない対象は除外しない。版またはprompt版が変わったときの再訪は `revisitPolicy` で決める。未公開 Finding を持つ対象は、提出済みでも公開を確認できないため除外する。

旧世代の既往は host 設定の `legacyHistory: {"file": "/abs/legacy-slugs.json"}` で渡す。`select` のたびに読み、`started` を `legacy-started`、`ambiguous` を `legacy-ambiguous` として除外する。`reconsider` は旧記録照合で初回と確認した `ambiguous` の slug だけに使え、`started` や現行台帳の開始済み run は解除できない。file が無ければ `select` は `legacy history unavailable` と表示し、候補源による `campaign run` と `continuous run` は起動しない。選定レポートの旧履歴 digest と実行時の digest が違えば止まる。`select --minimum <n>`（既定 3、runner は 1）未満しか固定できないときは、台帳に `target-selected` を書かず、各対象に `below-minimum` を付けて空の選定を返す。

列挙は人気順 10 頁と方針のタグ 8 個を各 1 頁、1 頁 50 件、候補 1,000 件まで読む（schema の上限は `popularPages` 20、`maxCandidates` 2,000）。`revisitPolicy` は `never` で、版や prompt 版が変わっても探索を始めた slug は戻らない。下限だけを変えた写し `selection.50000.json` と `selection.30000.json` を同じ場所に置き、起動時に所有者が選ぶ。方針 file を差し替えると policy digest が変わり束縛済みの batch を再開できないので、batch の境界で入れ替える。

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

スコア内訳、除外理由、候補一覧の取得元と観測時刻は標準出力と Git 外の `selection-report` に残る。最初の Snapshot 固定に失敗した候補は `snapshot-unavailable` として除外し、`target-skipped` から対象選定記録・選定レポート・Private Evidence の診断を digest 参照できるようにする。台帳の理由は短い定型コードだけにする。`target-selected` は固定済み Snapshot digest と `target-selection` の Private Evidence を参照する。次の `campaign run --all` は同じ方針 digest の最新バッチを使い、Snapshot が変われば止まる。公開履歴の件数・内容は選定候補の列挙・除外・採点に使わず、Finding 後の重複照合と時点で切った探索入力にのみ使う（ADR 0030）。

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
