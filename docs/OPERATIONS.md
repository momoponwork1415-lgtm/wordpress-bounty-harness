# 運用手引き（完成後に人間がすること）

探索主経路は、対象ごとにRoot＋subagentによる協調Trialを1回行う。目的promptは `discovery.mode` が `deep` なら `wp2shell-bounty-v11`、`wide` なら `wp2shell-bounty-v14-wide` で、子の上限は設定値 `discovery.maxChildren`（既定 4、1〜8）（[ADR 0029](adr/0029-single-wp2shell-cooperative-trial.md) のTrial構成、[ADR 0033](adr/0033-minimum-exploration-and-pinned-dependency-sources.md) の最低時間と依存source、[ADR 0019](adr/0019-harness-generated-output-contract.md) の生成出力契約）。新規探索で実行可能なのはv11・v14-wideと `wp2shell` modeだけ。比較中の候補 `wp2shell-bounty-v15-wide` は campaign 設定の `promptId` で名指ししたときだけ走る（ADR 0039 の 2026-10-26 追記 8）。旧版・旧mode・過去の実験結果は照合用に残す。実機縦断の受入前に本番稼働したものとみなさない。

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
| 選定方針 | `src/profiles/wordpress/policy/selection.json`（説明は同じ場所の `selection.md`）。インストール数 10k 以上・365 日以内更新・除外 slug を設定し、インストール数と更新日で順序を付ける（ADR 0037 の 2026-10-28 追記） | 月1回程度 |
| trust境界宣言 | `src/profiles/wordpress/prompts/trust-boundary-v1.md` をそのまま使う | ほぼ変えない |
| 対象範囲の方針 | `src/profiles/wordpress/policy/programme-scope.md` を公式ページで見直す | 提出前と月1回 |
| 履歴mirror | 第5節の手順で更新し、`history status` で鮮度を確かめる。選定は mirror を開かず、screen と dedupe が使う。日次更新は host の cron（19:10 UTC）が旧環境の `refresh_wordfence.py` を回す | 毎日と提出前 |
| 人手に数えない保守 | Step 1 の「人手介入 0」の判定で介入に数えないもの: 1 日 1 回の `continuous status`、ChatGPT の再ログイン（`waiting-login` からの再開）、Programme 写しの月 1 回の更新、提出前の mirror 更新、`docker system prune`（`-a` を付けない）、`lab cleanup`、レビュー batch の前後の `continuous stop` / `resume` / `run`。それ以外（下限の変更、設定変更、手動の `campaign run`、修正 PR）は介入に数える | 判定時 |

新しい host 設定では `legacyHistory` を拒否する。切替時はこの欄を外したコピーを用意し、既存の履歴ファイルは保持する。選定設定の旧採点・帯・待ち日数・固定ページ上限も外す。稼働中の設定を上書きせず、運用側が新しいコピーへ切り替える。

## 2. 週の流れ

```
harness history status                                   # 履歴mirrorの鮮度。fresh以外は終了コード1
harness runtime check --config <path>                    # 起動時検査の全項目とCodex image / runtime profileの一致。欠ければ終了コード1
harness select --config src/profiles/wordpress/policy/selection.json   # WordPress.org から `maximumTargets`（3〜10）件までの対象を選び Snapshot 固定。承認は不要
harness campaign run --all --campaign <id> --config <campaign.json>    # campaign 設定は同じ選定方針を参照する。最新の選定バッチから discovery（探索用 Lab は既定で付けない）。検証は後から verify next --handoff で Finding ごと
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

provider の構造化エラー `cyber_policy` は `incomplete(provider: provider-cyber-policy)` と記録する。これは broker の要求上限や認証期限切れ、正常な候補0件とは別の停止理由。詳細な診断は Git 外 Private Evidence の receipt に結び付けて保持し、台帳へエラー本文を写さない。拒否された対象は `target-skipped(provider-refused)` として次の対象へ進む。Root が source を 1 件も読まず、子を起動せず、broker 転送が 1 以下で終わった run は Trial に数えず、その対象は次の選定で戻る。途中まで走った Trial は数え、再選定しない。ただし provider 上限（`provider-limited`）で終わった初回 run は単独では Trial に数えない。Codex の run は runner が backoff 後に同じ Trial を再開し（ADR 0036 の 2026-10-19 追記 4）、Claude の run は backoff 後に新しい Trial としてやり直す（ADR 0029 の 2026-10-19 追記）。モデルの満杯（「Selected model is at capacity」）も 429 と同じ `rate-limit` として扱う。拒否を避ける目的で prompt を言い換えない。件数は `ledger stops` で見る。

```sh
harness ledger stops --campaign <id>                                        # 止まった run を見つける
harness campaign resume --campaign <id> --run <runId> --config <campaign.json>   # その Root thread を新しい sandbox で再開（ADR 0036）
harness ledger resumes --campaign <id>                                      # 再開した segment と、その終わり方を見る
```

`campaign resume` は操作者が名指しした 1 run だけを、同じ Snapshot・同じ runtime profile・同じ v8 再開段落・残り wall（120 分 − 消費済み）で、session file と notes を復元した新しい使い捨て container に `codex exec resume` する。再開できる run は `completed` 以外で終わったもの（拒否、provider 上限、モデル満杯、CLI 終了、schema、wall のどれでもよい、ADR 0036 の 2026-10-19 追記）で Lab 無し、receipt に `session` があり、残り wall が 5 分以上あるものだけ。それ以外は `not resumable: <理由>` を 1 行出して終了コード 3、event は書かない。再開 segment は同じ `trialId` で `discovery-run-started.resumesRun` を持ち、funnel では Trial 1 回のまま、wall と token は合算する。同じ thread が再び拒否されることはある。`continuous run` は Codex の run の `provider-limited` と死んだ run の `interrupted` を自動再開し、prompt の言い換えはしない。旧 receipt（`session` 無し）の run は再開できない。終了 event の無い run（電源断、WSL の停止、`kill -9`）も名指しできる。sandbox が開始時に `<scratch>/run-markers/<runId>.json` に書く印で、持ち主のプロセスが別の boot か死んだ pid なら、残った session と notes を封じて `failed(interrupted)` の終了 event を追記し、ディレクトリを消してから再開する。持ち主が生きていれば `run-alive`、印や残骸が無ければ `session-evidence-missing`、runner の再起動が同じ対象をやり直した後なら `superseded` で拒否する。印はこの変更以後の run にだけ付く（ADR 0036 の 2026-10-19 追記 2）。`continuous run` は再起動すると、持ち主が死んだ run を新しい Trial より先にこの経路で自動再開し、`interrupted run=<runId> resumed as <新 runId> ...` か、拒否なら `interrupted run=<runId> not resumed reason=<理由>; the target runs again as a new Trial` をログに 1 行書く。再開はその対象の枠の中で走り、`maxConcurrentTargets` を超えない。`interrupted` の再開 segment が `incomplete` で終わったら、続けるかは操作者が決める。`provider-limited` の再開 segment は次の backoff 後に再開を試みる（ADR 0036 の 2026-10-19 追記 4）。

Claude（Opus）の run も同じコマンドで再開する（ADR 0036 の 2026-10-20 追記）。`--config` には、元の campaign と同じく Claude に対象を割り当てる設定（`discovery.runtimeShare.claude` が 1 以上）を渡す。再開した segment は、元の run が台帳に記録した runtime（`configuration.runtime`）で走る。Claude の runtime profile の digest が元の receipt と違えば `runtime-profile-differs` で拒否する。新しい sandbox の Claude 設定ディレクトリ（`/tmp/claude/projects/`）に Root と子の transcript を、`/workspace/research/` に notes を戻し、runner は Root の session id で `resume` して、最初の turn から再開段落を送る。目的 prompt は送り直さない。2026-10-20 より前の Claude の receipt には `session` が無いが、同じ run が封じた diagnostic に transcript の一覧と digest が載っているので、そこから session を読む。拒否で止まった run も名指しすれば再開できる。自動では再開しない。終了 event の無い Claude の run（電源断など）は回収の仕組みがまだ無いので `run-unfinished` で拒否する。`ledger resumes` は再開した segment ごとに 1 行を出す。行には、再開した segment、その前の停止理由、runtime、終わり方、走った分数が並ぶ。

`campaign run` は無人で回る。本番の既定（`src/profiles/wordpress/policy/campaign.json`）は、2026-10-26 の所有者決定で `wide` にした。目的promptは同日の所有者指示で `wp2shell-bounty-v16-wide` にし、2026-10-27 の所有者決定（迷ったら Lead にする）で `wp2shell-bounty-v17-wide` にし（ADR 0039 の 2026-10-27 追記 10）、同日、Trial あたりの Finding と Lead が約 7 分の 1 に減った数字を見て `wp2shell-bounty-v16-wide` に戻し（追記 11）、その v16-wide も Codex の 42 Trial で Finding が 0.3/Trial に留まったので `wp2shell-bounty-v14-wide` に戻した（追記 12）。対象ごとにRoot＋子による協調Trialを1回行い、子の上限は設定値 `discovery.maxChildren`（既定 4、1〜8）、wall上限は120分。`wide` は最低時間を置かず、Rootの最初の最終報告でTrialを終える。`deep` の `wp2shell-bounty-v11` は名指しのTrialでだけ使い、campaign 設定の `discovery.mode` を `deep` にして回す。`deep` では最低60分（`discovery.minimumActiveMinutes`）は能動的に探索し、Rootが早く最終報告したときは同じ協調セッションで探索を続ける。campaign 設定で `discovery.mode` を省いたときの schema の既定は、今も `deep` である。継続不能、wall・provider・broker・schema等の失敗は理由付き `incomplete` として記録する。screeningや候補の有無による二段目、同一対象の追加Trialは起動しない。受理した scope 内 Finding はその時点で handoff 列に並び、検証 skill が `verify next --handoff`（ADR 0035）で 1 件ずつ Finding 単位の Lab に通し、Harness が捕捉と Lab browser の記録を残す（下の `discovery.lab`。判定器は ADR 0040 で削除した）。runner は検証しない（#423）。
wall 到達時は agent と broker を名前で `docker stop -t 10`（失敗時は `docker kill`）してから、子の報告を回収し `discovery-run-finished` に `incomplete(wall)` を記録して Lab を片付ける。
`continuous run` に SIGTERM を送ると進行中の探索 run を同じ手順で停止し、`stopped reason=operator` を記録して終了する。

v7 以降（現行 v8）は固定 source からの探索をRootに任せ、入口索引を渡さない（索引の生成 code は ADR 0034 で削除）。旧v5/v6の索引、coverage と `incomplete(depth)` の記録は過去の評価結果として読み続ける。

新規Trialで選べるpromptは、`deep` の `wp2shell-bounty-v11` と、本番の既定の `wide` の `wp2shell-bounty-v14-wide` だけ（ADR 0039 の 2026-10-27 追記 12。v10、v12-wide、v13-wide、v16-wide、v17-wide は archived、v8 は 2026-10-18 の所有者決定で入り、照合用に残す）。比較中の候補 `wp2shell-bounty-v15-wide` は campaign 設定の `promptId` で名指ししたときだけ走る（ADR 0039 の 2026-10-26 追記 8）。v18-wide は 2026-10-28 の 20 Trial で採らず archived にした（ADR 0039 の 2026-10-28 追記 14）。旧版と実験結果は履歴照合用に残し、探索には使わない。Snapshotに対象、WordPress core、実行imageと一致するPHP source、`Requires Plugins`、WooCommerceの版ヘッダ（`woocommerce`）または明示pinによる依存pluginを固定する。版ヘッダだけによる `woocommerce` は、pinだけで決める対象（`candidateSlugs` とreverify）でpinが無ければ入れず、依存のpinsetに `header-derived-unpinned` と残す。探索sourceは `/workspace/main`、`/workspace/wordpress`、`/workspace/php`、`/workspace/dependencies/<slug>` に読み取り専用でmountする。`ledger runtime` とrun receiptで実際のwall・source読取を確認する。日次上限はない。provider limitで停止したcampaignは自動retryせず、同じIDで未消費の対象から再開する。

自動選定の campaign は初回起動時に `selection-batch-bound` を追記し、選定バッチと対象集合を固定する。再開時はこの記録のバッチを読み、途中で `select` を再実行しても新しいバッチに切り替えない。runner が再起動したとき、続けようとする campaign の batch（束縛済みのもの、無ければ最新の未束縛のもの）が今の選定方針 digest と違えば、`selection-batch-discarded` を追記してその batch を捨て、新しい選定に進む（#302）。選定時に固定した Snapshot と materialized source は digest を再検査して使い、campaign 開始時に同じ ZIP を再取得しない。公開一覧の取得元・確認日時・available/stale/unavailable と失敗理由は Private Evidence の選定レポートに記録する。

- **同時run数**: campaign設定の `resources` で決める。
  - 既定の `resources` は `{"maxConcurrentRuns": 1, "memoryBudgetMiB": 10752}`。新主経路は対象ごとに1 Trialで、wall上限は120分。
  - `observed` は完了した command event の文字列から Harness が数える下限の近似。script 内部のファイル読出しや通信は含まない。
  - 実効の同時数は協調Trialでは `min(maxConcurrentRuns, floor(memoryBudgetMiB / 10752))`。10,752 MiBはRoot＋最大4子のCodex sandbox（10 GiB）とrunごとのegress broker（512 MiB）の合計。旧単独Trialの計算単位は2,560 MiB。
  - ホストが小さいときは `memoryBudgetMiB` を下げる。1run分に満たない値では開始しない。
  - **同時対象数**: `resources.maxConcurrentTargets`（1〜10）は対象ごとの campaign を何本同時に走らせるか。対象ごとの run は `maxRuns: 1` なので、実際に同時に走る探索 run はこの数になる。`memoryBudgetMiB` は対象ごとの run 数だけを縛り、対象をまたいだ合計は見ない（container の memory 上限は予約ではなく、Lab なし探索の実測は Codex 約 170 MiB、broker 約 110 MiB）。1 batch で選ぶ数は選定方針の `maximumTargets`（3〜10）で、同時対象数と同じにすると batch の最後に 1 本だけ走る時間が無くなる。`continuous run` のログイン余裕は `ceil(maximumTargets / maxConcurrentTargets) × (runWallTimeMinutes + 105)` 分（2026-10-19、所有者の指示で上限を 4 / 5 から 10 / 10 へ。#347）。`maxConcurrentTargetsByRuntime.codex` を書いたときは、`maxConcurrentTargets` の代わりにその値（小さいほう）で波を数える。batch が全部 Codex に偏っても足りるようにするためである。
  - **runtime ごとの同時対象数**（2026-10-19、所有者の指示「Opus 3 本、Codex 3 本」、ADR 0032 の 2026-10-19 追記 2）: `resources.maxConcurrentTargetsByRuntime: {"codex": <n>, "claude": <n>}` は、runtime ごとに同時に走る対象の上限。書かなければ合計の `maxConcurrentTargets` だけが効く。各値は 0〜`maxConcurrentTargets` で、`discovery.runtimeShare` の重みが正の runtime には 1 以上が要る（`runtimeShare` が無ければ Codex に要る）。枠が空くと、選定順で最初の「runtime に空きがある対象」が始まる。Codex 3 本と Claude 3 本を同時に回す設定は `"discovery": {"lab": "none", "runtimeShare": {"codex": 1, "claude": 1}}` と `"resources": {"maxConcurrentRuns": 1, "maxConcurrentTargets": 6, "memoryBudgetMiB": 10752, "maxConcurrentTargetsByRuntime": {"codex": 3, "claude": 3}}`。`memoryBudgetMiB` は対象ごとの値なので、6 対象でも 10752 のままでよい。host 設定には `claude` の節が要る。
  - Labのメモリは対象ごとに別に要る。
- **子の上限と最低時間**（2026-10-25、ADR 0039 の追記 3）: `discovery.maxChildren`（1〜8、既定 4）は同時に生きる子の上限で、Codex の `agents.max_threads` と Claude の hook に渡る。`discovery.minimumActiveMinutes`（0〜119）は最低時間で、省略すると `deep` は 60、`wide` は 0。`runWallTimeMinutes` は省略すると両 mode とも 120。これらの値は生成節 `## Run parameters` で Root に伝わり、`discovery-run-started.configuration` に残る。
- **上限での停止と再開**: provider のrate limit / quotaの応答を受けたとき。
  - 新しいrunを出さず、進行中のrunを記録して止まる（下の分割 campaign では、上限に当たった runtime の新しいrunだけを出さない）。終了コードは3で、台帳に `campaign-stopped(provider-limit)` が残る。
  - `discovery.runtimeShare` で Codex と Claude の両方に正の重みを付け、`discovery.lab` が `none` の campaign では、上限に当たった runtime の対象だけが止まる。もう一方の runtime の対象は起動と完了を続ける。このとき `campaign-stopped` に `runtime`（`codex` / `claude`）が付く。`runtime` の無いイベントは、従来どおり campaign 全体の停止である。片方の重みが 0 の campaign と `runtimeShare` の無い campaign の動きは変わらない（ADR 0032 の 2026-10-20 追記 3）。
  - 手で回すときは同じコマンドをもう一度実行すると再開する。`continuous run` の下では runner が backoff（quota は 30 → 60 分、rate-limit は 5 → 60 分、2 回連続なら 6 時間）の後に同じ campaign ID で、Codex の run の `provider-limited` の最新 segment を再開する（Claude の run は新しい Trial としてやり直す）。runtime 別に止まった場合は、待ち時間の段階も runtime ごとに数える。runner は待ち時間が最も早く終わる runtime に合わせて再開し、まだ待ち時間の残る runtime の対象は、その終わりまで起動しない。ADR 0032 Q18 で止めたのは外側 cron の quota tick であり、runner の in-process の待機は別物。再開は同じ Trial で再開 segment 最大 5（元の run は数えない）と残り wall 5 分を上限にし、拒否されたら診断付き `incomplete` として対象を閉じる。新しい Trial は作らず、未検証の Finding と未消費の対象へ進む。
  - 拒否（`provider-cyber-policy`）、wall、schema、CLI 終了などの対象単位の失敗は campaign を止めず、その対象を `target-skipped`（理由 `provider-refused` / `run-failed`）にして次へ進む。同じ campaign の再実行ではその対象を再開しない。
  - Verifier が provider の上限を受けたときは、runtime を問わず campaign 全体を `campaign-stopped(provider-limit)` で止める。再開時はその検証を同じ Lab Setup で 1 回だけ自動再試行する。
  - operator の stop は対象の境界で効く。進行中の対象は終わらせ、新しい対象を始めず、台帳に `campaign-stopped(operator)` が残る。
- **旧入口分担の記録**: 旧 `assignment` mode（2026-10-18 削除）の索引・成分digestは過去Trialの照合用に台帳から読む。v8 の新規探索では mode は `wp2shell` だけで、入口索引も渡さない。
- **過去Trialの記録**: 旧 `stage` / `continuationOf` 付きevent、旧ablation arm、旧prompt・入口索引のdigestは台帳から読める。新規探索には旧prompt・旧modeを使わず、段やcontinuationも新規に書かない。Leadの本文はPrivate Evidenceに置き、台帳にはdigestと分類だけを記録する。
- **対象ごとの失敗**（取得、探索、検証）: 標準エラーに `skipped <対象> <版> at <段階>: <理由>` と出す。台帳の `target-skipped` には段階、短い理由コード、Private Evidence に置いた `target-skip-diagnostic.json` の digest を残し、次の対象へ進む。診断には `kind`（台帳の理由コードと同じ）と、取得側が付けた理由コードの `reason`（例: `main-plugin-file-ambiguous`、`invalid-required-plugins-header`）を書く。依存 plugin が原因のときは `detail.slug` にその slug が入る。DNS、接続タイムアウト、HTTP 応答、source 検査不一致を区別する。WordPress.org への取得は Node 同梱の `fetch` に `AbortSignal.timeout`（metadata 30 秒、archive 5 分）を付ける。取得失敗を探索の正常な候補0件に数えない。
- Lab 準備では使い捨て runsc コンテナから HTTP 到達を確認する。`lab-provisioned.reachability.http = failed` なら探索を始めず、`failureStage` と `reason` を記録する。DB 到達の失敗は記録するが HTTP が通れば続ける。Docker の診断文は Private Evidence に置き、台帳には digest だけを残す。
- pinned WordPress image の core は `<workDirectory>/wordpress-core` に実行せず取り出し、Dependency Snapshot として固定する。同じimageのPHP archiveもchecksumと版を照合して `<workDirectory>/php-runtime` に固定する。探索はそれぞれ `/workspace/wordpress` と `/workspace/php` の read-only mount で読み、Labは実行中のPHP版を照合する。必要な依存pluginもSnapshotに固定し、Labに供給して探索では `/workspace/dependencies/<slug>` にread-onlyでmountする。
- campaign の `lab.databaseAccess` は既定で `read-only`、Lab 単体の既定は `none`。reader は provision 時点で存在する table にだけ SELECT 権限を持ち、後で作る canary table は読めない。`configuration.labAccess` と `lab-provisioned.reachability.database` を併せて見る。Codex image に MySQL client があるかは実 run で未確認で、無い場合は image に `mariadb-client` が要る。
- User Registration & Membership と wpDiscuz の通常利用画面を作っていた `lab.scenarioId`（`public-registration-and-account-v1`、`public-free-membership-v1` / `v2`、`public-plugin-comment-v1`）は #353 で削除した。campaign 設定に `lab.scenarioId` があれば Lab を立てる前に拒否する。前提は wbh-verify が Lab の通常機能で作る。過去の Lab の scenario 記録は台帳から読み続ける。
- VerifierのHTTPはLab内のrunsc捕捉proxyへ向ける。Harnessの捕捉が残ったattemptは `incomplete(awaiting-human-observation)`、捕捉がなければ `incomplete(evidence)` になる。Verifierの `http.json` は `agent-authored` の補助記録として読む。HTTP本文はPrivate Evidence、台帳にはoptionalな `verification-finished.evidenceCapture` enumだけを残す。新しい検証は `runtime-confirmed` を出さず、canaryも播種しない（ADR 0040）。
- 失敗した探索 run は `discovery-run-finished.reason`、`reasonDetail`、`providerLimit` で区別する。`reasonDetail` は検査名などの短いコードで、実行記録や HTTP 本文は含まない。

人間が触るのは `review` だけ。並ぶのは次の2種類。

| 種類 | 付いてくるもの | 人間がすること |
| --- | --- | --- |
| `incomplete(awaiting-human-observation)` | Harnessの捕捉、Lab状態の差分、Lab browserの記録（dialogと画面）、Verifierの `route.json` と手順 | `verify next --handoff` が記録後も残した検証 Lab（後日なら `lab up --for-review` の新しい review Lab）で自分の目で確かめ、`review observe` と `review decide --reproduced` で記録する。影響が意味を持つか、意図された動作でないか、重複でないかを判断する |
| ほかの `incomplete` | 理由コードと次の手 | 環境・手順の不足なら再検証を指示する |
| `runtime-confirmed`（判定器があった時期の記録） | 再現パッケージ（手動手順、Pythonスクリプト、Lab再構築情報、判定器の証拠）と、判定器が観測した条件 | 自分の手で再現する。既存の `incomplete(no-judge)` も手で確かめる |

`contradicted` は件数しか出ない。

### 探索だけ回し、検証を 1 件ずつ回す

`campaign.json` の `discovery.lab` は `"none"`、`"attached"`、`{"mode": "none" | "attached", "maxResets": 0〜5}` を受理し、object の形に直す（省略時は `{"mode": "none", "maxResets": 2}`）。`none` は探索用 Lab を供給せず、Finding は台帳に記録して検証を後へ送る（所有者決定 2026-10-18「通常モードは Lab を起動しない探索」）。

`attached`（Phase D1、ADR 0003 の 2026-10-25 追記）は、Trial ごとに探索 Lab を 1 台立て、Trial の終わりに壊す。host lease は取らず、検証 Lab と並走する。sandbox からは `http://wordpress`（recorder 経由の HTTP）と `http://labctl/` だけに届き、Lab DB は渡さない。Root には生成節 `## Lab` で URL、管理者と低権限の account とパスワード、再供給の予算を伝える。`POST http://labctl/reset` は WordPress・DB・site volume を同じ setup で作り直し、`maxResets`（既定 2）を超えた要求は 429 で拒否する。`POST http://labctl/observe` は、型付きの要求（`role`、`path`、任意の `actions` と `dialogMarker`）を受け、検証と同じ Playwright 観測器をその account で Lab 内に走らせ、HTTP status、dialog の有無、marker の alert の有無、console error の数、画面の digest を返す。`maxObservations`（既定 20）を超えた要求は 429、形の合わない要求と Lab に無い役割は 400 で拒否する。形の合わない要求の答えには、合わなかった項目の名前だけを `field` に入れる（値は返さない）。画面は 1 回ごとに Private Evidence の `screenshot.png` に置く。canary は置かず、判定もしない。Trial の終わりに recorder の捕捉（`capture.jsonl`）と、Lab の世代ごとの状態の before / after / 差分を Private Evidence の `exploration-lab` に封じ、`discovery-run-finished` に digest と `labObserved`（`requests`、`droppedRequests`、`resets`、`refusedResets`、`droppedAnswers`、`observations`、`refusedObservations`）を残す。観測器の通信は recorder を通らないので `requests` に入らない。数えるのは `http://wordpress`（recorder）を通った要求だけで、sandbox が WordPress の固定 IP へ直接送った要求は数えない。labctl は Lab network の上で待ち受けるので WordPress の container と観測用ブラウザからも届くが、できるのは予算を使うことと 409 busy を返させることだけである。制御口の処理中に Harness が例外を出した要求には `failed`（`harness-error`）を返して 1 回に数え、制御口は続ける。答えが届かなければ 1 回送り直し、それでも届かなければ `droppedAnswers` に数え、labctl が同じ要求を出し直したら同じ答えを渡す（命令は 2 度実行しない）。`attached` では `--repeat` を、選定と freeze の前に 1 度だけ拒否する。再開（runner の自動再開と `campaign resume --run`）では、区間ごとに同じ setup digest の新しい Lab を立て、再供給と観測の予算の残りと、Lab を立て直したことを書いた `## Lab` 節を最初の turn で渡す。区間ごとに `exploration-lab` を封じる。setup digest が前の区間と違えば `lab-setup-differs`、設定が `discovery.lab: none` なら `lab-mode-differs`、Trial を始めたときの `maxResets`・`maxObservations` と今の設定が違えば `lab-budget-differs`、新しい Lab が立たなければ `lab-provision-failed` で拒否する。runner の再起動で再開する対象には、pipeline がその対象のために立てた Lab が使われないまま残る。この Lab は対象の終わりに壊す。再開区間の Lab と同時に 2 台立つのが、いまの費用である。死んだ持ち主の区間は再供給と観測の回数が台帳に残らないので、0 回として数える。Lab の container は Trial あたり 4 つ（WordPress、DB、recorder、labctl）で、network は Docker が選んだ subnet を明示して作り直し、WordPress の address を固定する。`pnpm build` で `dist/lab-control/` ができていることが前提である。

2026-10-23〜25 の間は `"attached"` を退役として拒否していた。過去の attached Trial の台帳と集計は引き続き読める。`none` と `attached` を暗黙に切り替えない。管理用セッションに旧 Verifier は不要で、未提供の旧経路を明示利用すると退役エラーになる。

旧 `campaign run --retry-incomplete` も退役した。指定すると、状態を開く前に不明なオプションとして拒否する。過去の再試行記録は引き続き読める（ADR 0022）。

```sh
harness campaign run <slug> --campaign <id> --config <campaign.json> [--repeat 3]
harness verify next --config <campaign.json> --handoff <dir>
harness ledger funnel --campaign <id>
```

`verify next` は handoff 列から Finding を 1 件取り、その Finding の Snapshot に新しい検証 Lab を立てて skill に通し、Lab を片付ける。handoff 列には、parked でなく結論（`runtime-confirmed`、`contradicted`、`reproduced`）の出ていない Finding が、全 campaign から台帳順に並ぶ。最新の判断が `reject` の Finding（段 1 で落としたものを含む、#436）は並ばない。`--campaign <id>` を付けると、その campaign に絞る。再試行予算（ADR 0022）は現行の skill 版の試行だけで数える。そのため、旧 Codex Verifier（`verifier-v8`）が `incomplete` で残した Finding も列に並ぶ。`--handoff` の無い `verify next` は UsageError で止まる（#423）。対象が無ければ `no verification pending` と出す。Lab の供給に失敗すると、例外の class 名と message（先頭 500 文字）、`nextStep` を Private Evidence の `lab-diagnostic` に封じ、台帳の `lab-provisioned`（探索）か `verification-lab-failed`（検証）が digest で参照する。`campaign run` は対象行に `failed at <stage> (<reason>)  diagnostic <digest 先頭 12 文字>` と `next step:` を出し、`setup-failed` の対象が 1 つでもあれば終了コード 1 で終わる（#284）。`--repeat 3` は同じ Snapshot に別々の Trial ID を 3 つ作る。既定は 1 回。`campaign run` の `--campaign` は 40 文字まで（台帳の `target-selected-<campaign>-<snapshot digest>` が 128 文字に収まる長さ）で、超えると何も始めずに UsageError で止まる。全対象が skip された `campaign run` は終了コード 1 で終わる（#281）。funnel の `by Lab` は探索用 Lab の有無、`verification Lab failed` は検証側の供給失敗を示す。

```sh
harness verify next --config <campaign.json> --handoff <dir> [--campaign <id> [--finding <id>]] [--port <n>] [--db-port <n>]
```

`--handoff <dir>` は検証 Lab を skill `wbh-verify` に受け渡す（ADR 0035）。Harness は検証 Lab を立てて `127.0.0.1:<port>` に Lab の recorder 経由で公開し（`--port` と `--db-port` を省くと Docker が空いている loopback port を選ぶ。実際の port は `lab.json` の `host.url` と `attack.json` の `database.port` に書く）、setup 用の `<dir>/lab.json`（接続先と Host header、設定管理者の資格、`<dir>/review-export.json` の path）を書く。skill が `<dir>/setup-done` を置くと Harness は設定管理者の session と application password を破棄して password を変え、HTTP 捕捉と Lab 状態の基線を取り直し（#430）、完了後に `<dir>/observation-ready`、続いて攻撃用の `<dir>/attack.json`（Finding の攻撃者位置の資格、必要な比較 route）を置く。skill は合図と `attack.json` の両方を待ってから攻撃者位置で操作し、6 file（`route.json` `http.json` `session.json` `steps.md` `refutation.md` `precondition`）か `<dir>/abort` を置く。session がなければ `session.json` は空 file にする。待ち時間の上限は従来どおり 30 分で、超過と `abort` は理由付き `incomplete`。以後は Harness の捕捉と Lab browser の記録 → `verification-finished`（`incomplete(awaiting-human-observation)`、判定器は 2026-10-25 に削除、ADR 0040。現行 `promptVersion: wbh-verify/v11`、旧 v1〜v10 の本文は `.claude/skills/wbh-verify/versions/`）→ review queue と同じ。記録の後、捕捉と review Lab package があれば Harness は検証 Lab を落とさず、`127.0.0.1:80`（使えなければ空いている port）に公開し直して、`lab down`、中断、30 分の wall のどれかまで残す。出力の hosts の 1 行と `manual observation receipt` の digest を所有者に渡し、所有者はその Lab で観測して `review observe --receipt <digest>` を打つ。台帳の `manual-observation-recorded` には `labKind: verification` が残る（ADR 0038 追記 12）。確定の根拠は、所有者が検証 Lab か新しい review Lab で記録した `review observe` の match と `review decide --reproduced match` だけである（不変条件 3）。AI 操作役は `review observe` と `review decide --reproduced` を打たない。どちらも所有者のコマンドである。`--finding <id>`（`--campaign` と併せて指定する）は操作者が名指しした Finding を、列の規則（parked、再試行予算）に関わらず検証する。`<dir>` は 1 attempt 専用に Git の外へ置き、終わったら消す。既存の受け渡し file がある directory は使えない。
検証 Lab（`verify next --handoff`、`review reverify --handoff`、`lab up --for-review`）は同じ host で何台でも同時に立てられる。Harness は台数を制限せず、待たせもしない（2026-10-26 所有者決定、#432）。Lab ごとに container・network・volume の名前は Lab ID で分かれ、host の port は上のとおり Lab ごとに取る。`--port` を固定して 2 台に同じ値を渡すと、後の Lab は公開に失敗して理由付き `incomplete` になる。1 台は WordPress・MySQL・recorder・canary receiver の 4 container（host に公開する間は gateway を足して 5）で、host の memory（約 47 GB）が実際の上限になる。#526 より前の checkout で動く runner は Lab も掃除し、持ち主の記録を読まない。`verify next` は sweep-hold を置かないので、並列の `verify next` を使う前に runner を新しい checkout で再起動する。
`route.json` の HTTP step に本文がある場合、`body` は実際に送信した wire body と一致させる。本文が空のときだけ省略できる。
`verify next --handoff` を `WBH_RECORD_VIDEO=1` で走らせると、Lab browser は `victim.paths` の訪問ごとに最初のページを WebM で録画する（#549）。1 本も 1 attempt の合計も 8 MiB まで、EBML の署名が無いものは捨て、画面と dialog の記録はそのまま残す。録画は `victim-visit-<n>.webm` として Private Evidence に置き、`lab-browser-observation.json` の `videos` に大きさと sha256 を書く。台帳には evidence の digest だけが載る。

`continuous run` は探索だけを回し、検証 Lab を立てない（#423。旧 `--verify-concurrency` と検証 worker は削除した）。handoff 列は探索 batch と並行して skill が消化してよく、検証 Lab の数は `resources.maxConcurrentTargets` に含めない。

handoff の `route.json` で被害者画面を開くとき、`victim.paths` に 1 path あたり最大 5 件の型付き `actions`（`click`、`click-text`、`fill`）を指定できる。操作の選択は skill が行い、実行と dialog・画面の記録は Harness の Lab browser が行う。被害者の操作にファイルが要るときは `set-file`（`selector`、`fixture`、省略できる `fileName`）を使う。`fixture` は Harness が持つ `image-png`、`image-jpeg`、`text-plain` のどれかで、中身は route から渡せない。`fileName` の拡張子は fixture のものに限る。入れたファイルは `lab-browser-observation.json` の `files` に sha256 と大きさで残る（#468）。探索 Lab の `/observe` は `set-file` を受け付けない。

### 継続運転（`continuous run`、最終設計 P6）

```
harness continuous run    --host <path> --state <dir> --config <campaign.json> --selection <selection.json> [--campaign-prefix <text>] [--notify <command>] [--resume]
harness continuous stop   --state <dir> [--campaign-prefix <text>]
harness continuous resume --state <dir> [--campaign-prefix <text>]
harness continuous status --state <dir>
harness continuous concurrency [<n>] [--runtime <name>] --state <dir> --config <campaign.json>
```

- `run` は `select` → `campaign run --all` → 次の batch を回り続ける。実行履歴の正本は台帳で、`<state>/continuous.json` / `.pid` / `.log` は作業用、`.stop` は理由とともに解除まで残す停止指示。第 2 の journal、owner lease、host 共通 claim、crash 復旧の自動化は持たない。検証 Lab の host 単位の lease（1 host 1 枠）も 2026-10-26 に削除した（#432）。残したのは Lab ごとの持ち主記録（`~/.local/state/wordpress-bounty-harness-host/lab-owners/<labId>.json`）だけで、誰も待たせず、広い掃除が生きている持ち主の Lab を消さないためだけに読む。
- 止まるのは operator の stop、候補枯渇（`exhausted`）、Programme 写しの 35 日超（`programme-stale`）、例外 3 batch 連続（`errors`）、completed 0 の batch 3 連続（`no-progress`）の 5 つ。明示的な operator stop と他 4 つの理由は、理由付き停止マーカーを残して終了コード 0 で終え、systemd の `Restart=on-failure` では再起動しない。`OnFailure` はこれらの停止では発火しないため、停止の通知は `--notify` と `continuous status` の監視で行う。例外による crash は終了コード 1 で再起動対象。quota、拒否、ログイン失効（`waiting-login`）、disk 不足では止まらず待つ。
- `status` は状態、pid、最後の例外、今日と今週の Trial 数・completed・provider-limited・provider-refused・run-failed・Lab 失敗・unsettled、review queue と parked を出す。Trial 数は探索 run の開始数から、Trial に数えない run（単独の provider 上限 run と、source・子・転送の無い run。SPEC §6）と、終了 event の無いまま runner の再起動でやり直された run（`superseded`）を引いた数で、provider-limited の run 数はその横に別に出す。`unsettled` は終了 event の無い run から `superseded` を引いた数で、実行中の run と、まだ再開できる死んだ run（runner の次の起動か `campaign resume` で再開する）を数える。再開した segment は元の Trial に数え、Trial の結果は最後の segment で決める。停止マーカーが残り pid が生きていれば `stopping`、pid が死んでいれば `stopped(<理由>)`、停止マーカーがなく memo だけ実行中なら `stale` と表示し、いずれも終了コード 1。`stop` は `<state>/continuous.stop` に `operator` を記録し、runner は次の対象の境界で止まる。停止マーカーは crash や systemd 再起動でも消えず、通常の `continuous run` は選定・campaign・Lab 掃除を始めない。
- レビュー後または異常停止の原因を確認・修正した後は pid が消えたことを `continuous status` で確認し、systemd 運用なら `continuous resume --state <dir>` で停止マーカーを解除してから unit を起動する。手動運用なら `continuous run ... --resume` で解除と起動を一度に行える。実行中 pid がある間の再開は拒否する。systemd unit の `ExecStart` に `--resume` を固定しない。SIGINT / SIGTERM は進行中の対象を drain して終了するが、停止マーカーは残さない。runner は `campaign run --selection <path>` と同じく campaign 設定の `selectionPolicyPath` を差し替えて走る。起動時と各 batch の後の残骸の掃除は、探索の残骸（`provider-egress-broker-*`、`codex-agent-<uuid>`、`claude-agent-<uuid>` の container と `provider-egress-*` の network）だけを消し、Lab（`wbh-<uuid>-*`）には触らない（#526）。探索の container と network は、作る前に host 共通の持ち主記録（`~/.local/state/wordpress-bounty-harness-host/discovery-owners/<名前>.json`）を置く。持ち主のプロセスが生きている間は、別の state dir や checkout の runner も `lab cleanup` もそれを名指ししない。持ち主が死んだものと記録の無いものは今までどおり消す（#550）。#550 より前の checkout で動くプロセスは記録を置かないので、別の state dir で 2 つ目の runner や `campaign run` を回す前に、同じ host の runner を新しい checkout で起動し直す。Lab の後始末は、Lab を立てた側（`verify next --handoff`、`review reverify`、`lab up --for-review`、`lab down`、操作者の `lab cleanup`）が持つ。検証は探索と並行して走らせてよく、runner を止めて待つ必要はない。手で回す `campaign run` と `campaign resume` は、生きている間 `<state>/sweep-holds/<pid>` を 1 プロセス 1 ファイルで置き、その間 runner は掃除をしない。終わるとファイルを消す。pid が死んだファイルは保留に数えない。
- 同時に走る対象の数は、runner を止めずに変えられる（2026-10-19、所有者の指示）。`continuous concurrency <n>` は `<state>/continuous.concurrency` に `n` を書き、`continuous.log` に `<時刻> concurrency <前>-><後>` を 1 行足す。`n` は 1 から campaign 設定の `resources.maxConcurrentTargets` までで、その外は拒否する。設定の値は上限のまま残り、引数なしの `continuous concurrency` は実効値、上限、file の値を出す。`continuous status` は file があるときだけ `concurrency live <n>` を出す。runner は新しい対象を始める直前に毎回この file を読み、`min(file の値, 上限)` を超える分は始めない。下げても走っている Trial は止めず、数が下がるまで新しい対象を待たせるだけである。上げたときは、待っている対象が 30 秒以内に始まる。file が無いか読めなければ上限を使う（変更前と同じ動き）。runner は campaign の最初の対象を始めるときと実効値が変わったときに `concurrency effective=<n> campaign=<id>` をログに書く。設定、方針、選定 batch の digest は変わらないので、`continuous stop` も再起動も要らない。ログイン余裕は上限で計算したままなので、下げて長く回すときは `waiting-login` が遅れて出ることがある。手で回す `campaign run` はこの file を読まず、設定の上限で走る。
- runtime ごとの同時対象数も、runner を止めずに変えられる（2026-10-19、ADR 0032 の 2026-10-19 追記 2）。`continuous concurrency <n> --runtime <name>` は `<state>/continuous.concurrency.<name>` に `n` を書き、`continuous.log` に `<時刻> concurrency runtime=<name> <前>-><後>` を 1 行足す。`n` は 0 から campaign 設定の `resources.maxConcurrentTargetsByRuntime.<name>` までで、上限の無い runtime と範囲外の値は拒否する。0 にすると、その runtime の新しい対象は始まらない。`--runtime` なしで `n` も無いときは、合計の行に続けて runtime ごとの実効値、上限、file の値を 1 行ずつ出す。`continuous status` は file がある runtime だけ `concurrency live runtime=<name> <n>` を出す。runner は合計の file と同じく新しい対象を始める直前に毎回読み、`min(file の値, 上限)` を使い、変わったときに `concurrency runtime=<name> effective=<n> campaign=<id>` をログに書く。file が無いか読めなければ設定の上限を使う。下げても走っている Trial は止めない。
- runtime の偏りで枠が空く。runner は batch が終わるまで次の選定をしないので、batch の対象の runtime が偏ると、先に尽きた runtime の枠は batch の終わりまで空く。たとえば Claude 7 件と Codex 3 件の batch では、Codex の 3 枠は 1 波で空き、Claude の 3 波目が終わるまで使われない。Codex 3、Claude 3、重み 1:1、Trial の長さが同じと置いた計算では、`maximumTargets` 6 で枠の使用率は 66%、8 で 65%、10 で 74%（runtime の上限を置かず合計 6 だけのときは 10 で 83%）。長さを 60〜120 分（2 割は 5〜30 分で終わる）でばらつかせた試算では、`maximumTargets` 10 で 65%（合計 6 だけなら 73%）。そのため、runtime ごとの上限を使うときは選定方針の `maximumTargets` を上限の 10 にする。0 にした runtime の対象が batch に残ると、その batch は値を戻すまで終わらず、もう片方の runtime も次の batch に進めない。0 は短い間だけ止める用途に使う。
- 選定は 10k 以上の一つの列をインストール数と更新日で並べ、同版は 1 Trial、新版なら待たずに戻す（ADR 0037 の 2026-10-28 追記）。
- インストール数の段ごとの群 / Trial・提出 / Trial は、`target-selected` の artifact digest からインストール数と初回 / 版上昇の理由を読み、campaign と Snapshot で Trial と転帰を結んで数える。
- 版の比較は、接頭辞の違う runner を同じ `--state` で並走させて行う（#604、所有者の決定 2026-10-26）。runner は接頭辞ごとに 1 つで、pid・memo・停止マーカーを接頭辞ごとに持つ。既定の `prod` は今までの `continuous.pid` / `continuous.json` / `continuous.stop` を使い、それ以外は `continuous-<接頭辞>.pid` / `.json` / `.stop` を使う。同じ接頭辞の 2 本目は今までどおり `already running as pid` で止まる（#604 より前の build で動く `prod` の runner とも）。`continuous.log`、`continuous.concurrency*`、`sweep-holds/` は共有する。起動時の再開（memo の campaign、持ち主の死んだ run の再開、ADR 0036）は自分の接頭辞の campaign だけを対象にする。掃除は持ち主記録で生きている持ち主の container・network を名指しせず、Lab には触らないので、互いの Trial を消さない。選定は 1 本ずつ行う（`<state>/continuous-select.lock`）。選んだ batch は memo に書いてから lock を離し、ほかの接頭辞の runner はその batch と、まだ終わっていない campaign が束縛した batch の slug を `reserved-by-runner` で選ばない。campaign は自分が選んだ batch を束縛する。`continuous status` は接頭辞ごとに 1 行（末尾に `prefix <接頭辞>`）を出し、件数の行は state 全体を数える。`continuous stop` / `resume` は `--campaign-prefix`（既定 `prod`）の runner だけに効き、方針による停止（`errors` など）も自分のマーカーにだけ書く。全部を止めるときは接頭辞ごとに `stop` を打つ。#604 より前の build の runner は他の接頭辞の予約を読まないので、並走の前に `prod` も新しい build で起動し直す。比較を終えた接頭辞は、campaign を終えてから `continuous-<接頭辞>.json` と `.stop` を消す（memo が残る間は、その未完の batch の slug を他の runner が選ばない）。
- 前提: 単一 host、単一運用者、本番の `--state` は 1 つ。硬い総 token 枠は置かず、provider の quota と operator の stop だけで止まる。未 merge branch で回した Trial は本番の分母に混ぜない。起動は systemd user unit（`loginctl enable-linger`、`WorkingDirectory=<本番 checkout>`、`Restart=on-failure`、`RestartSec=300`、`TimeoutStopSec=4500`、`KillMode=mixed`、`OnFailure=<通知 unit>`）か `nohup`。本番 checkout での `pnpm build` は `continuous stop` の後だけ。
- Claude Opus の Trial を runner に混ぜるときは、runner の campaign 設定に `discovery.runtimeShare` と `resources.maxConcurrentTargetsByRuntime` を書く（2026-10-19、所有者の指示「Opus 3 本、Codex 3 本」）。ただし、provider 上限で止まったときに runner が batch 全体を待たせる動きは変えていない。Claude の quota で止まると、backoff の間は同じ batch の Codex の新しい対象も始まらない。runner の `waiting-login` が見るのは Codex のログインだけである。Opus を runner に混ぜずに回すときは、`runtimeShare: { "codex": 0, "claude": 100 }` を書いた別の campaign 設定と別の campaign ID で、`campaign run` を手で回す。`--state` は本番と同じものを使う。手で回す `campaign run` は、生きている間 `<state>/sweep-holds/<pid>` を置くので、runner の残骸掃除が Opus のコンテナを消すことはない。台帳では `configuration.runtime` で Codex と分けて読む。
- Opus が応答を拒否した（`stop_reason: refusal`）run は、Root も子も `incomplete(provider: provider-refusal)` と記録し、Codex の `provider-cyber-policy` と同じく `target-skipped(provider-refused)` になる。拒否されたとき、Claude Code は別のモデルに切り替えずにそこで止まる（`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` と `CLAUDE_CODE_NO_MODEL_FALLBACK=1`。2026-10-19 の所有者の決定）。それでも別モデルを求めた要求は、broker が 403 `model-not-admitted` で断る。この 403 を Claude Code は「Failed to authenticate」と書くが、拒否の後に出たものは拒否として扱う。拒否の後でない 403 `model-not-admitted` は `incomplete(policy: model-not-admitted)` にする。
- 同じ plugin slug の再訪は選定方針の `revisitPolicy`（版上昇、ADR 0037 の 2026-10-28 追記）で決まり、所有者の事前承認は要らない。同じ版を手で再 Trial するときは ADR 0032 Q6 のまま 1 Trial ごとに所有者が事前承認する。
- 週次 smoke（#126）は、既知の `runtime-confirmed` Finding に `review reverify` を 1 回打つことで代える（campaign ID は `smoke-<YYYYMMDD>`）。旧 Codex Verifier の経路は退役したため、実 host は `--handoff` がなければ退役エラーで止まる。
- 最新版で確認した新しい `runtime-confirmed` Finding が出たら、その Snapshot と Lab Setup を保持し、週次 smoke の case に加える。通った検証は回帰試験になる。
- **探索を絞る引き金**（所有者決定 2026-10-26、[監査](reviews/2026-10-26-system-audit.md) 第 B.3 節の段 (4)）: 探索は止めずに回し続ける。週に 1 回、本番で直近 7 日に記録された scope 内 Finding の group（`finding-recorded` の `group.id`）を数え、15 件を超えていたら `continuous concurrency <n>` で同時対象数を下げて Trial を減らす。数は DEVELOPMENT 第 2 節の Step 2 の引き金（scope 内候補が週 15 件超）と同じである。`occurredAt` は Trial の開始時刻なので（#212）、7 日の切り方は近似になる。数え方は `sqlite3 <state>/ledger.sqlite "select count(distinct coalesce(json_extract(event_json,'$.group.id'), finding_id)) from ledger_events where event_type='finding-recorded' and campaign_id like 'prod%' and julianday(json_extract(event_json,'$.occurredAt')) >= julianday('now','-7 days')"`。

## 3. 提出までの操作

当面は Wordfence 向けの 1 件の Finding を、AI 操作役が検証から英語の暫定文案まで用意し、最後に所有者が Lab で手動再現して文案と送信先を確認する順で進める（SPEC §3、ADR 0038）。Patchstack 向けの追加自動化は、報告が増えてから扱う。6 段を連続実行する自動 orchestrator はまだ無い。AI 操作役が各 skill と CLI を順に起動し、所有者に代わって中間記録を実行する。段別 skill の本文は、判断方法を変えずにこの運用へ揃えた（#587、#595）。AI の中間判断は `review decide --by ai` で記録し、`--minutes` を付けて人間の作業時間に混ぜない。`incomplete`、重複照合の `possible-match` / `unavailable`、scope の `ambiguous` は提出用の文案に進めず、理由と次の手を review に残す。`incomplete(observation)` に同じ検証内の攻撃要求との marker 一致、順序、別の被害者での Lab browser dialog 観測がある場合、`wbh-report` v7 は因果関係と既存コンテンツの確認待ちの内部プレビューだけを作れる。権限・対象範囲の拡張が必要なら所有者の明示承認を得る。

最終目標は、公開中最新版の通常利用構成で所有者が手動再現し、同じSnapshotでの `match`、重複・Wordfence scopeの確認、証拠付き英語報告書とFill-Only JSONが揃ったFindingを最終査読へ渡すこと。canary不着だけでは候補を落とさない。Harnessは判定器を持たず、捕捉したHTTP・ブラウザ観測・digestの整合性を記録として守る。新しい検証は `runtime-confirmed` を出さない（ADR 0040）。`incomplete(awaiting-human-observation)` は、所有者の `review observe` の `match` と `review decide --reproduced match` が揃ったときだけ正式な文案・Candidateへ進む（段 6）。上の内部プレビューは提出準備完了に数えない。有効な手順で `mismatch` なら提出を止め、環境・手順・観測不足なら `incomplete` / `defer` と次の手を残す。

| 順 | 誰が | 何を |
| --- | --- | --- |
| 0 | AI 操作役 | 検証前に `wbh-screen` v5（段 1、ADR 0038 追記 16）で `not-verified` / `incomplete` と旧 `reject` を `要検証` / `除外` の 2 値に分ける。規則の写しに加え、本体依存、外部サービス入力、通常利用の範囲（readme と公式資料）、連鎖の脆さ、一時スクリプト、報奨にならない格付け、同根の提出、明らかに公開済み、最新版での修正を見る。中間の区分は置かない。`要検証` は同根ごとに 1 つの報告単位にまとめ、人間向けには報告単位の一覧（HTML か Artifact）を出す。結果は Private Evidence の報告と個別メモに残す。`除外` の台帳への記録は、所有者の了解を得た AI 操作役が `review decide --decision reject --reason screen-v5:<理由コード> --by ai` で行う。旧版の `reject` が `要検証` なら `--decision defer --reason screen-v5-reassessment --by ai` を追記し、検証列への復帰を確認する。次の一手が Lab の代表を `verify next --config <path> --campaign <id> --finding <id> --handoff <dir>` で通す |
| 0b | AI 操作役 → 所有者 | 段 1 の `提出可` を Lab に回す前に `wbh-source-check` v1（段 1b、ADR 0038 の 2026-10-27 追記 14）。対象ごとに agent 1 体が固定ソース（`work/sources/<digest>`、本体を含む）だけを読み、入力支配（低権限の攻撃者が値を置けるか）と到達性（既定かもっともらしい設定で sink に届くか）を yes / no / unknown で答え、`成立` / `不成立` / `未決` を決める。実行も通信もしない。結果は対象ごとの表にして Private Evidence の `source-check-report-<日付>.md` に書く。`不成立` は報告の末尾の `harness review decide ... --decision reject --reason source-check:<input|reach> --by ai` を所有者か運用者が打ち、handoff 列から外れる。`成立` は何も打たず段 2 の群へ、`未決` は欠けているソースを名指しして所有者の判断にする。2026-10-27 の 162 件では成立 88・不成立 67・未決 7、人間の選別との一致 159 / 162 |
| 1 | AI 操作役 | `verify next --handoff` と `wbh-verify`（段 2・3）で検証し、`review export --campaign <id> --finding <id>` から検証の結果と Harness の捕捉を読む。`wbh-review` は要約と判断案を作る。`incomplete` は観測と次の手を残し、登録する暫定文案には進めない |
| 1a | AI 操作役 | 現行 `incomplete(awaiting-human-observation)` の `review export --version 2` に Harness の捕捉があり、まだ人間の観測が無い場合だけ、`wbh-report` v8 で Wordfence 用の内部プレビューを Git 外に作れる。Lab browser の記録（`lab-browser-observation.json`）は同じ Snapshot・Lab Setup のものだけを使う。因果関係と既存コンテンツ由来かどうかは人間の確認待ちと記す。英語 Markdown と、必須値がすべて根拠付きなら `human_verification.status: pending` の Fill-Only JSON を作る。`review draft`、package manifest、Submission Candidate は作らず、この行から段 6 の正式な手動再現記録や提出へ進まない |
| 2 | AI 操作役 | `wbh-dedupe`（段 4）の 3 値と根拠を記録する。`no-match` で `wbh-review` も受理を提案したら `review decide ... --decision accept --reason preliminary-pass --by ai --duplicate no-match --duplicate-note <path>` とし、これは提出前の人間査読ではない。`possible-match` / `unavailable` は `--decision defer --reason duplicate-unresolved --by ai` と照合値・メモを記録して止める |
| 3 | AI 操作役 | WordPress.org の頁と export で最新版を確認し、`review reverify --campaign <id> --finding <id> --config <path> --handoff <dir>` で最新版の Snapshot と Lab で再検証する。出力の `as <findingId>` を以後の Finding ID として控える。新しい Snapshot では派生 Finding ID が作られ、元 Finding の暫定 `accept` や重複結果は継承されない。最新版で成立した証拠が無ければ先へ進めない |
| 4 | AI 操作役 | 段 3 の `as <findingId>` に対して `review export`、`wbh-review`、`wbh-dedupe` を再実行する。受理案と `no-match` が揃ったら `review decide --decision accept --reason preliminary-pass --by ai --duplicate no-match --duplicate-note <path>` を新 ID に記録する。ほかの結果は理由を記録して止める。続けて同じ ID で `review scope` と `wbh-destination`（段 5）を行う。Wordfence が `in-scope` で報酬対象の場合だけ、今回の文案へ進む |
| 5 | AI 操作役 | 段 3 の `as <findingId>` に判定器の `runtime-confirmed` がある場合か、2026-10-25 以降の `incomplete(awaiting-human-observation)` に所有者の `review observe` の `match` と `--reproduced match` が先に記録された場合だけ（6 の手順を先に行う。ADR 0040）、同じ ID の `wbh-report`（段 6）で Wordfence 向け英語 Markdown の**暫定文案**、`wordfence-fill-only/3` JSON、添付一覧と package manifest を Private Evidence に作る。Markdown に JSON の digest を記し、同じ ID で `review draft ... --programme wordfence --prepared-by ai` を実行して文案版を記録する。未確認箇所は人間の確認事項として別に示す。これだけでは提出を承認できない |
| 6 | 所有者 | 段 3 の `as <findingId>` について、`verify next --handoff` が残した検証 Lab で再現パッケージの手順を自分の手で試す。残っていなければ（後日の再観測など）`lab up --for-review --campaign <id> --finding <id>` の新しい review Lab で試す。`incomplete(awaiting-human-observation)` では、見たものを先に `review observe ... --result match|mismatch|unavailable --by <name>` で記録する。`lab up --for-review` を打つたびに新しい `manual-observation-lab-ready` が追記され、数えるのは最新の ready より後の `review observe` だけである。そのため `match` の後に review Lab を開き直すと根拠は消え、その Lab で `review observe` と `--reproduced` を記録し直すまで段 5・7・8 は通らない。結果を同じ ID の `review decide ... --decision defer --reason pending-final-review --reproduced match|mismatch|unavailable --by <name> --reproduce-minutes <n>` で記録する。`mismatch` / `unavailable` ならここで止まり、原因の調査か再検証へ戻す |
| 7 | 所有者 | 同じ ID の暫定文案の実値、版、影響、手順、添付、フォーム欄と送信先を査読し、JSON と manifest も最終版に作り直す。確認した提出用 Markdown を同じ ID の `review draft ... --programme wordfence --prepared-by human` で**新しい最終版**として保存する。本文を変えなくても人間が確認した最終版を保存する。その後、同じ人が同じ ID の `review decide ... --decision accept --reason reviewed-report --by <name>` で最終査読を記録する。この間に review Lab を開き直したら、6 の観測と再現の記録からやり直す |
| 8 | 所有者 | 最終版の正確な Submission Candidate・文案 digest・送信先に `review authorize --candidate <id> --draft <digest> --to wordfence --by <same name>` で承認を記録する。自身の拡張機能でフォームへ入力して送信し、`review submitted` と `review outcome` で転帰を記録する。Harness は送信しない。承認の前に review Lab を開き直した場合、`authorize` は `manual-reproduction-required` で止まるので 6 に戻る |

従来の 1 件あたりの見積りは reverify 30 分、手での再現 40 分、skill 30 分である。新しい順序では段ごとの所要時間を測り直す。1 回の batch は 3 件までにし、超える分は `defer` にする。RAM 16 GiB 未満の host では batch の前に `continuous stop`、後に `continuous resume` と `continuous run` を打つ（人手に数えない保守）。runner を起動し直す前に `lab down` で review 用の Lab を消す。

```
harness review parked --campaign <id>                       # parked Finding と reason を一覧する
harness review leads --campaign <id>                        # Lead（影響まで 1 辺足りない primitive）を位置と要旨で一覧する
harness review held --campaign <id>                         # 保留（candidate-held）の Finding 候補と schema の issue を一覧する
harness review export --campaign <id> --finding <id>         # 1画面のレビュー材料をJSON 1本（schema review-export/v1）で出す。台帳には書かない。skillはこれだけを読む
harness review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--by <name>] [--opened <digest>]... [--duplicate no-match|unavailable[:<reason>]|possible-match:<ref> [--duplicate-note <path>]] [--reproduced match|mismatch|unavailable [--reproduce-minutes <n>]] [--minutes <n>]
harness review dedupe --campaign <id> --finding <id>          # ローカルWordfence履歴mirrorと照合
harness review scope --campaign <id> --finding <id>           # Wordfence / Patchstack ごとに in-scope / out-of-scope / ambiguous
harness review reverify --campaign <id> --finding <id> --config <path> --handoff <dir> [--port <n>] [--db-port <n>] # 新しい版のLabをskillへ渡して再検証し、捕捉を人間の観測待ちで残す
harness review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]
harness review authorize --candidate <id> --draft <digest> --to <destination> --by <name>
harness review submitted --candidate <id> --draft <digest> --to <destination>
harness review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]
```

- `export` は Finding（claim / attackerPosition / brokenProperty / impact）、HTTP の method / path / status 行、反証メモ、検証 Lab の実行前後差分の要約（option 名と digest、ユーザーの役割、テーブル件数と checksum）、探索した版と台帳が知る最新版、install 数、Private Evidence の path を 1 本の JSON にまとめる。候補本文、payload、HTTP 本文、option 値は path と digest でだけ参照し、stdout に値を出さない。
- `review parked` の reason は `outside-programme-boundary`（影響分類が対象外）、`admin-configuration-precondition`（旧規則。特定値または非既定の管理者設定が前提）、`declared-precondition`（エージェントが申告欄で、管理者の脆弱な設定、攻撃者が書けないデータ（ベンダー、サイト自身、管理者だけが書く）、時間窓か競合に頼る発火のどれかを選んだ。#613）の 3 種類。どれも Finding の Private Evidence を保持し、検証・review queue に入れない。`declared-precondition` の行は、reason の後に申告した値（`configurationClass=…`、`attackerInputPath=…`、`exploitTiming=…`）を並べる。`outside-programme-boundary` 以外は `review restore` で戻せる。
- `review held` は、正規化しても schema を通らなかった Finding 候補（ADR 0018）を 1 行ずつ出す。並べるのは impact 分類、生の candidate の digest と path、run ID と候補番号、issue path（2026-10-20 以降の event では zod の issue code も）だけで、本文は出さない。同じ候補が後で正規化し直されたものは出さない。
- `decide --minutes` は人間がその項目に使った時間を `human-effort-recorded` に分で、`review-decided` に `humanElapsedSeconds` として残す。決定は検証 ID、探索 run ID、prompt digest に結び付いて記録され、提出から run と prompt まで辿れる。検証の前の Finding（`review` に `not-verified` で並ぶもの）にも記録でき、その記録は検証 ID を持たない（#436）。落とした判断を取り消すときは、別の判断（`defer` など）を記録する。最新の判断が `reject` でなくなれば、Finding は handoff 列に戻る。
- `scope` は検証の証拠（判定器があった時期の記録を含む）と選定記録から事実を読む。最新版での確認が要るプログラムは、`reverify` が `runtime-confirmed` を返した後でだけ満たされる。
- 確認済みrouteのないFindingは、前回が`incomplete(precondition)`でLab記録があり、`--version`なしで選定されたSnapshotが元のFindingと同じ場合だけ、前回と異なるscenario IDのLabで独立再検証できる。Snapshotが異なる場合と`--version`付きの修正版比較はLab起動前に拒否する。元のverification eventは残り、再試行は新しいverificationIdとsetup digestを記録する。
- `draft --prepared-by ai` は登録する暫定文案の版を保存する。Review API は `reproduced` も早期保存できるが、今回の Wordfence 向け登録経路は `runtime-confirmed` だけを扱う。`incomplete(observation)` の内部プレビューは `review draft` を呼ばない。`authorize` は、同じ検証と再現パッケージに対する人間の手動再現が最新の記録で `match`、かつ最新の文案が `--prepared-by human` で保存され、その後に同じ人の最後の `review decide --decision accept` がある場合にだけ、正確な Candidate・文案 digest・送信先の承認を記録する。後続の検証や同じ Finding の最新版再検証があれば、旧文案の承認・提出を止める。`admitExternalAction` も提出時にこれらの条件を確認する。Harness は送信しない。今回の Wordfence への送信は人間が画面で行い、`submitted` で記録する。
- `--prepared-by human` と `--by <name>` は CLI が記録する属性で、本人認証ではない。AI 操作役は人間の観測の `review observe`、手動再現の `--reproduced`、最終版の `--prepared-by human`、最終 `accept` と `authorize` を代行しない。
- 提出後の転帰と報奨額を `outcome` で台帳に戻す。選定方針と検証の改善材料になる。探索へは戻らない。
- Reflected XSSはWordfence向けの候補にならない。authz / IDORは、乗っ取り・権限昇格・サイト全体への影響に届くときだけ in-scope。

## 4. 見るべき数字

```
harness ledger funnel --campaign <id> | --since <ISO>  # --since は全 campaign の指定時刻以降の event を合算。旧 Trial の incomplete(depth) を独立表示（生成は ADR 0034 で削除、旧 event だけ）。raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome、種別別、arm別（旧 Trial）、転帰と報奨
harness ledger stops [--campaign <id>] [--since <ISO>]  # run の失敗理由×provider上限、target-skipped の段階×理由、Lab 失敗段階、campaign 停止理由の件数。拒否 run は explore 件数と 60 秒以内の件数も出す
harness ledger usage [--campaign <id>]    # providerが返したtokenを対象・UTC日ごとに合計。返らなかった項目はunavailableの件数
harness ledger runtime [--campaign <id>]  # runが記録したmodel、effort、CLI版、カタログdigest、tier、access、認証の組ごとのrun数
```

収益の式は「対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用」。funnelの各段がこの各項に対応する。

提出準備の進捗は、同じ最新版Snapshotの手動再現 `match`、重複・scopeの確認、根拠付き英語報告書とFill-Only JSON、最終査読の準備が揃ったFinding件数で見る。`runtime-confirmed` 件数は判定器の到達度として残し、提出完了の代理指標にしない。既存の `ledger funnel` の集計は変えない。

旧方式の `incomplete(depth)` は件数があるときだけ表示する。`by Lab` は attached Lab の履歴集計があるときだけ表示し、現在の表示でも `verification Lab failed` は省かない。旧比較の `by arm` も記録があれば表示する。台帳の読取と集計は変えない。

| 細い段 | 直す場所 |
| --- | --- |
| raw Findingが少ない | 探索 prompt の版（開発セット 6 case × 3 run の 6 段、DEVELOPMENT 第 5 節）、選定方針 |
| verifier通過が少ない | 検証 skill と Lab構成（`incomplete` の理由コードを見る） |
| in-scopeが少ない | 選定方針（対象外になりやすい種別・tierを避ける） |
| duplicateが多い | Finding 後の重複照合と履歴mirrorの鮮度。選定は mirror を開かず、提出前の重複照合で記録を読む（ADR 0037 の 2026-10-28 追記） |

## 5. 保守

### 履歴mirrorの更新

- 更新は既存の正規化器で行う。旧環境で `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を実行する。API keyは `WORDFENCE_INTELLIGENCE_API_KEY` か `~/.config/wordfence/env` に置く。成功後30分以内の再取得は抑止される。
- 更新後に `harness history status` を見る。照合口と同じ規則で、`fresh` / `stale`（既定24時間超、または前回更新の失敗）/ `unavailable`（stateが読めない、DBとstateが食い違う）を表示する。
- `stale` / `unavailable` は「重複なし」を意味しない。詳細は [wordfence-history/README.md](../src/profiles/wordpress/wordfence-history/README.md)。
- 選定は mirror の鮮度を gate にしない。screen と dedupe のための日次更新は host の cron（19:10 UTC）で回す。

### 対象の自動選定

`select` は [選定方針 JSON](../src/profiles/wordpress/policy/selection.json) を直接読み、WordPress.org の人気順・タグ順を列挙する。install下限もこの JSON が正本。`pluginDependencySlugs` は `Requires Plugins` ヘッダにも `WC requires at least` / `WC tested up to` ヘッダ（`woocommerce` と決める）にも現れない必要な依存を対象slugごとに列挙し、freeze時点の公式stable版をSnapshotに固定する。手動の開発・歴史的評価対象は `pluginDependencyPins` で版を明示する。台帳の探索開始（`runKind: explore` の `discovery-run-started`）と Finding を照合し、適格な次点候補で補充して `maximumTargets`（3〜10）件までの対象を返す。選定だけで Trial が始まらなかった対象のうち、Snapshot の失敗は `deferred` を除いて除外しない。Snapshot 固定が `deferred`（plugin ヘッダを読めないなど、対象の source に起因する保留）で skip された対象は、同じ選定または campaign で別の対象が固定できていれば、その版に限って `freeze-deferred` で除外し、版が上がれば戻す。どの対象も固定できなかった選定の `deferred` は host 側の失敗かもしれないので数えない。探索用 Lab の供給に失敗した対象は、その版に限って `lab-provision-failed` で除外し、版が上がれば戻す。依存pluginはSnapshotに固定し、Labと探索に同じsourceを渡す。source 0 件・子 0・broker 転送 1 以下で終わった run しか持たない対象は除外しない。終了記録と観測値のない開始記録だけの attempt も Trial に数えない。途中まで走った Trial は数え、再選定しない。provider 上限で終わった初回 run は単独では Trial に数えない。Codex の run は runner が同じ Trial を再開し、再開できずに閉じた対象は理由付き incomplete の Trial 1 回に数え、次の campaign でも同じ版を再実行しない。Claude の run の対象は除外せず、新しい Trial としてやり直す。自動候補源の `revisitPolicy` は `{ "kind": "version-increased" }` とし、現行 stable が台帳に数えた同 slug の全 Trial より高ければ戻す。prompt 版の変更では戻さず、未公開 Finding による除外はしない（ADR 0037 の 2026-10-28 追記）。

選定は人気順と各タグの一覧をインストール数の下限か API 終端まで読み、10k 以上・365 日以内更新・除外著者と slug 以外を並べる。順序はインストール数の降順、同数なら更新日の降順。同じ版は 1 Trial で、版が上がれば日数を待たずに戻す。未提出 Finding と旧世代の履歴では除外しない。`select --minimum <n>`（既定 3、runner は 1）未満しか固定できないときは、台帳に `target-selected` を書かず `below-minimum` を付けて空の選定を返す。

インストール数、更新日、初回 / 版上昇の理由、除外理由、候補一覧の取得元と観測時刻は標準出力と Git 外の `selection-report` に残る。Snapshot の固定に失敗した候補は `snapshot-unavailable` として除外し、同じ列の次の候補で補う。`target-skipped` と `target-selected` から既存の digest 参照で選定記録・レポート・診断を読める。次の `campaign run --all` は同じ方針 digest の最新バッチを使い、Snapshot が変われば止まる。

選定はミラーを開かない。`wbh-screen` と `wbh-dedupe` は引き続きミラーを使う。旧採点欄のある `target-selection.json` と旧台帳イベントは読める。Git 外の legacy 履歴ファイルも消さずに保持する。

### 子の最終JSONがschemaで失敗したとき

子のrunが `child-final-message-not-report` で失敗しても、Private Evidenceの不変rolloutに完全なJSONが残っている場合がある。Codex の子で、報告の無いまま最後の turn が provider error で終わったものは `provider`、`turn_aborted` で終わったものは `interrupted` として記録し、`schema` にはしない（#540）。parserを修正・テストした後、同じcampaignの失敗runを次のコマンドで再解釈できる。Rootと子のthread lineage、model、effort、cyber access、Snapshotを照合し、元の失敗eventは残したまま `child-report-recovered` と有効なFinding / Leadを追記する。source traceやrecipe本文は標準出力へ出さない。

```sh
node scripts/recover-child-reports.mjs \
  --campaign <id> \
  --state /path/to/private/state \
  --attachments /path/to/private/provider-attachments
```

完了した Codex の子の前のターンの報告（#539 より前の取り込みは最後のターンしか読まなかった）は、`--mode turns` で追記する。不変 rollout が記録済みの報告を再現することを確かめてから、記録済みの報告に無い Finding / Lead だけを `child-turns-merge-v1` として記録する。Root がまだ終わっていない子は飛ばし、数を出す。先に `--dry-run` を付けると、state を読み取り専用で開いて件数だけを出す。

```sh
node scripts/recover-child-reports.mjs \
  --campaign <id> \
  --state /path/to/private/state \
  --attachments /path/to/private/provider-attachments \
  --mode turns [--dry-run]
```

復旧後は同じcampaign IDで `campaign run` を再開する。`incomplete` のTrialを正常な0件として扱わず、独立Verifierへ渡すのは復旧して台帳へ入ったFindingだけにする。

### Codex CLI / model catalogの更新

1. 新しいCodex imageを固定digestで用意する。
2. `harness runtime check --config <path>` で、imageの実際のCLI版とカタログdigestをruntime profileと比べる。食い違いがあるまま回すと、全runが `incomplete(policy)` になる。
3. runtime profile（CLI版、カタログdigest、image digest）を新しい値に更新し、`runtime check` が `ok` になることを確かめる。
4. 次のcampaignの後で `harness ledger runtime` を見る。新しい組が現れ、更新前のrunと分かれて数えられていれば記録は正しい。

### 手で確かめるためのLab

```
harness lab up --for-review --campaign <id> --finding <id>
harness lab down [--config <path>]
```

- 手で再現する Lab は `lab up --for-review` で立てる（上の review の表の 7 行目）。`--config` を取る旧形の `lab up` は 2026-10-19 に削除した。
- review Lab は、空いていれば host の `127.0.0.1:80` に出る（#592）。ブラウザで開くには、hosts に `127.0.0.1 wordpress` を 1 行足して `http://wordpress/` を開く。80 が塞がっているときは空きポートに出る。その場合、出力に表示される `--host-resolver-rules` を付けて Chrome を起動する。
- `lab up --for-review` は state dir の `review-lab.json` に Lab を記録する。`verify next --handoff` が人間のために残した検証 Lab も、同じ file に `labKind: "verification"` を付けて記録する。1 つの state dir で記録できる Lab は 1 つだけである。`lab down` は、まずこの記録を読む。持ち主の `lab up` が生きていれば SIGTERM を送り、持ち主が公開を外して Lab を消すのを待つ。その後、残ったものを Lab id で削除する。記録が無いときは、旧形の `lab up` が記録した 1 つの Lab の container / network / volume だけを削除する。どちらの場合も、残存が 0 でなければ終了コード 1 で残りを列挙する。同時に動く campaign の Lab には触らない。

### Lab / brokerの残骸

持ち主のプロセスが生きている Lab（Lab ごとの持ち主記録、#432）は、一覧にも削除にも出ない。持ち主が死んだ Lab と記録の無い Lab は残骸として出る。削除したときは、死んだ持ち主の記録も消す。

```
harness lab cleanup --config <path>            # 一覧だけ
harness lab cleanup --config <path> --remove   # 削除
```

- 対象は、Labが付ける `wbh-<uuid>-{db,wp,canary,proxy,host,net,site}` と、探索が付ける `provider-egress-broker-<id>` / `provider-egress-<id>` / `codex-agent-<uuid>` / `claude-agent-<uuid>` の名前に一致するものだけ。
- **実行中のcampaignがないときに使う。** 持ち主の記録が無い Lab は、立っていても消える。
- `continuous run` が起動時と batch の後に行う掃除は、このうち Lab 以外だけを対象にする（#526）。持ち主の記録も読まず、消さない。

## 6. 評価

主指標は本番から得る。旧 `eval score --keys` と Answer Key、盲検 rubric、`eval compare`、`eval prospective`、`eval case-blocked` は 2026-10-18 に削除した（PARKING 2026-10-14 行）。campaign 設定の `ablation` / `comparison` / `entry-index-control` / `assignment` mode も 2026-10-18 に削除した。旧 A/B の割当・digest と `evaluation-case-blocked` event は台帳に残り、`ledger funnel` の arm 別集計で読める。

- **過去比較の照合**: 旧prompt版や入口索引の有無を変えた独立Trialは過去結果として別armで読む。新規探索のprompt・modeはv8と `wp2shell` のみ。旧段付きTrialを同じ分母に混ぜない。
- **旧A/Bの読取**: 過去の `ablation.axes` にあった `history`、`prompt`、`continuation` と旧 `{"axis":"history","armBFraction":0.5}` の割当・digestは台帳に残る。旧基準は `short-objective-managed-v4` と継続なしだった。
  - #73のLuna開発セットでは公開2事例に対して全cellでsource候補0/3だった。当時の事前登録の規則で短い目的promptを既定に残したが、優劣の証明ではない。失敗Trialの補充は元の12試行と分けて記録した。150分対照も実wallは設定上限より短かった。現在の既定はADR 0029に従う。
- **前向き評価**: 公開されたadvisoryで本番台帳を見直し、見逃しを数える。採点 command（`eval prospective`、盲検 rubric）は上のとおり削除したので、行うときは台帳と公開記録を照合して `docs/evaluation/` に記録する。
- **held-out**: 初期の開発と本番開始には使わない。比較研究が必要になった時だけ予算とcaseを決める。

## 7. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへのPoC・payload・再現手順の提供。評価runへのheld-out公開日以降の記録の提供。
- Harnessからの外部送信。
- payload、HTTP記録、画面画像、未公開の発見のGitへのコミット。
