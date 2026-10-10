# 運用手引き（完成後に人間がすること）

この文書のコマンドは2026-10-10時点の単独Trial実装用。Root＋最大3 subagentの主経路は [実装計画](IMPLEMENTATION-PLAN.md) に従って移行中で、実機縦断の受入前に本番稼働したものとみなさない。

対象読者: このHarnessを一人で回す運用者。正本は [SPEC.md](SPEC.md)。

- `harness` は `pnpm build` が作る `dist/cli/main.js`（`bin.harness`）。実際の境界アダプターを束ねる。
- コマンド名は `runCli`（`src/cli/index.ts`）が受け付けるもの。
- host設定は `--host <path>` か `WBH_HOST_CONFIG` で渡す。
- 台帳とPrivate Evidenceの置き場は `--state <dir>` か `WBH_STATE_DIRECTORY` で選ぶ。既定は `~/.local/state/wordpress-bounty-harness`。
- 現行の単独Trialの設定例は [examples/translatepress-3.3.1/](../examples/translatepress-3.3.1/README.md)、過去の2×2開発セットは [examples/translatepress-3.2.5/](../examples/translatepress-3.2.5/README.md)。新しいRoot＋3の本番開始条件は [TranslatePressベンチマーク](TRANSLATEPRESS-BENCHMARK.md)。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りのDockerホスト。Codex CLI ≥ 0.161。ChatGPT Proにログイン。費用は購読の月額固定で、Harnessは金額でなく使用量（rate limit / quota）を見る | 初回とCLI更新時 |
| build | `pnpm install && pnpm build`。credential proxyは `dist/discovery`、HTTP捕捉proxyは `dist/lab-recorder` にでき、それぞれrunsc containerへ読み取り専用でmountする | 更新のたび |
| host設定 | Git外のJSON（`wordpressHostConfigSchema`、雛形は `examples/translatepress-3.3.1/host.example.json`）。docker、作業dir、全imageのdigest固定、Codex runtime profile、認証情報ファイルの**パス**、Programme写しのパス、履歴mirror | 初回とimage更新時 |
| 認証 | ホストでCodex CLIにChatGPTログインし（`codex login`）、その `auth.json`（0600、本人所有）のパスをhost設定の `credentialFilePath` に、`authenticationMethod` を `chatgpt-oauth-host` にする。読むのはegress brokerだけで、エージェントには渡らない（下記） | 初回とログイン失効時 |
| Programmeの写し | wordfence.comは自動取得できないので、公式3ページを人間がpage documentへ写す（雛形は `examples/translatepress-3.3.1/wordfence-programme.example.json`）。35日を超えると選定が止まる | 月1回 |
| campaign設定 | JSONファイル（`wordpressCampaignConfigSchema`）。Programme Boundary、停止規則、Lab、`resources`、任意の `ablation` を書く。認証情報と鍵は書かない | 方針を変えるとき |
| 選定方針 | `src/profiles/wordpress/policy/selection.json`（説明は同じ場所の `selection.md`）。インストール数の下限、更新の鮮度、除外slug、High Threatタグ、run予算 | 月1回程度 |
| trust境界宣言 | `src/profiles/wordpress/prompts/trust-boundary-v1.md` をそのまま使う | ほぼ変えない |
| 対象範囲の方針 | `src/profiles/wordpress/policy/programme-scope.md` を公式ページで見直す | 提出前と月1回 |
| 履歴mirror | 第5節の手順で更新し、`history status` で鮮度を確かめる | 週1回と提出前 |

## 2. 週の流れ

```
harness history status                                   # 履歴mirrorの鮮度。fresh以外は終了コード1
harness runtime check --config <path>                    # 起動時検査の全項目とCodex image / runtime profileの一致。欠ければ終了コード1
harness select --config <path>                           # 方針から今週の対象を出す。承認は不要
harness campaign run --all --campaign <id> --config <path>   # 選定済み対象を順に: snapshot → lab → discovery → verification → ledger
harness review [--campaign <id>]                         # 検証済みの列を見る
```

**起動時検査**: 境界を使うコマンド（`select`、`campaign run`、`runtime check`、`lab cleanup`、`review reverify`）は、境界を組む前に次を全部確かめる。1つでも欠ければ何も起動せず、runc・通常Docker・ホストプロセスへ切り替えずに止まる。

- dockerが応答し、`runsc` が登録されている。
- host設定の全imageが、digest固定のまま手元にある。
- 認証情報ファイルが通常ファイル、0600、本人所有で、空でない。APIキーの中身は読まない。ChatGPTログインはメモリ上で読み、access tokenが1時間以上残っていることだけを確かめる。
- credential proxy（`dist/discovery`）のbundleがある。Lab HTTP捕捉proxy（`dist/lab-recorder`）はLab provision時に使うため、実行前の `pnpm build` を要する。
- Codex imageのCLI版と同梱カタログのdigestが、runtime profileと一致する。

**ChatGPTログインの中継**: runごとのbroker（runsc）が、そのrunだけのCAと `provider-egress.internal` の証明書でHTTPSを待ち受ける。

- エージェントのsandboxには、grant tokenとダミーaccountだけでできた使い捨ての `auth.json`、そのCA、brokerのIPだけが入る。本物のaccess tokenとaccount IDはbrokerだけが持ち、refresh tokenはbrokerにも渡さない。
- brokerは `responses` のPOSTだけを、bindしたmodel・件数・大きさ・期限の範囲で `chatgpt.com` へ転送する。workspace discoveryはbrokerが自分で答え、それ以外のendpoint（plugins、analyticsなど）は403にする。
- tokenの更新はしない。preflightが「1時間以内に失効」を出したら、ホストで `codex login` をやり直す。
- APIキー（`host-private-bearer`）の経路も残っている。

`campaign run` は無人で回る。1対象あたりの Trial は、選定のrun予算（既定20、High Threat面は40）と設定の上限（既定6）の小さい方まで。新規 Finding も Lead もない Trial が続いたら（既定3回）止まる。各 Finding は別コンテナの Verifier と判定器を通り、`runtime-confirmed` / `contradicted` / `incomplete` として台帳に入る。

既定promptは `short-objective-v2`。版を明示した設定はその版で再現できる。Trial数には対象ごとの上限があり、日次上限の設定はない。provider limitで停止したcampaignは自動retryせず、同じIDで再開する。

- **同時run数**: campaign設定の `resources` で決める。
  - 既定は `{"maxConcurrentRuns": 2, "memoryBudgetMiB": 10240}`。`stopRules.maxRuns` は Trial 上限（既定 6）、`noFindingRuns` は新規発見のない Trial の連続数（既定 3）、探索 run の wall time は既定 90 分。
  - `observed` は完了した command event の文字列から Harness が数える下限の近似。script 内部のファイル読出しや通信は含まない。
  - 実効の同時数は `min(maxConcurrentRuns, floor(memoryBudgetMiB / 2560))`。2,560 MiBは、Codex sandbox（2 GiB）とrunごとのegress broker（512 MiB）の `--memory` の合計。
  - ホストが小さいときは `memoryBudgetMiB` を下げる。1run分に満たない値では開始しない。
  - Labのメモリは対象ごとに別に要る。
- **上限での停止**: provider のrate limit / quotaの応答を受けたとき。
  - 新しいrunを出さず、進行中のrunを記録して止まる。終了コードは3で、台帳に `campaign-stopped` が残る。自動retryはしない。
  - 同じコマンドをもう一度実行すると再開する。探索を終えた対象は飛ばし、途中の対象は残り回数から続け、未検証のFindingだけを検証する。
- **入口の分担**: campaign の `assignment: {"unit":"entry-point","entriesPerRun":8}` で有効にする。WordPress profile が登録入口、保存先、core 交差、1 hop の include を text 走査し、保存先を共有する入口を同じ scope に置く。索引は事実の列挙で、探索範囲を制限しない。台帳には索引・成分の digest だけを置く。上限（PHP file 20,000、1 file 2 MiB、成分 key 200）を超えた索引は scope に partial と表示する。
- **A/B の軸**: `ablation.axes` に `history`、`prompt`、`continuation` を最大3本指定する。旧 `ablation: {"axis":"history","armBFraction":...}` も読める。Trial ordinal から arm を決め、台帳 `configuration.arms` に記録する。`prompt` 軸の arm b は `armBPromptId` の版付き prompt を使う。`continuation` 軸は `continuation` ブロックを要する。`eval compare --axis` は各軸の探索 run だけを分母にする。
- **Lead の継続**: `continuation: {"maxRunsPerTrial":2,"runWallTimeMinutes":30}` を指定すると、completed の探索 run で得た Lead から同じ Trial 内で最大2本、1 hop の継続 run を順に実行する。`continuation` 軸がある場合は arm b だけで実行する。継続には選んだ Lead と source index の近傍だけを渡す。失敗した継続 run は探索 Trial の失敗にしない。Lead の本文は Private Evidence に置き、台帳には digest と分類だけを記録する。`eval score` は Lead の location-overlap を source candidates の別列に表示する。
- **対象ごとの失敗**（取得、探索、検証）: 標準エラーに `skipped <対象> <版> at <段階>: <理由>` と出す。台帳には `target-skipped`（段階だけ）を残し、次の対象へ進む。
- Lab 準備では使い捨て runsc コンテナから HTTP 到達を確認する。`lab-provisioned.reachability.http = failed` なら探索を始めず、`failureStage` と `reason` を記録する。DB 到達の失敗は記録するが HTTP が通れば続ける。Docker の診断文は Private Evidence に置き、台帳には digest だけを残す。
- pinned WordPress image の core は `<workDirectory>/wordpress-core` に実行せず取り出し、Dependency Snapshot として固定する。探索と Verifier は `/workspace/wordpress` の read-only mount で同じ版を読む。
- campaign の `lab.databaseAccess` は既定で `read-only`、Lab 単体の既定は `none`。reader は provision 時点で存在する table にだけ SELECT 権限を持ち、後で作る canary table は読めない。`configuration.labAccess` と `lab-provisioned.reachability.database` を併せて見る。Codex image に MySQL client があるかは実 run で未確認で、無い場合は image に `mariadb-client` が要る。
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
| duplicateが多い | 選定方針（公開履歴の多いpluginを避ける）、履歴mirrorの鮮度 |

## 5. 保守

### 履歴mirrorの更新

- 更新は既存の正規化器で行う。旧環境で `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を実行する。API keyは `WORDFENCE_INTELLIGENCE_API_KEY` か `~/.config/wordfence/env` に置く。成功後30分以内の再取得は抑止される。
- 更新後に `harness history status` を見る。照合口と同じ規則で、`fresh` / `stale`（既定24時間超、または前回更新の失敗）/ `unavailable`（stateが読めない、DBとstateが食い違う）を表示する。
- `stale` / `unavailable` は「重複なし」を意味しない。詳細は [wordfence-history/README.md](../src/profiles/wordpress/wordfence-history/README.md)。

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

主指標は本番から得る。現在の `eval score --keys` は任意の研究用互換機能で、TranslatePressベンチマークや本番開始には使わない。下記のCLIは現行の単独Trial実装用であり、Root＋3への移行後に更新する。

```
harness eval compare [--axis history|prompt|continuation] [--campaign <id>]   # 本番A/B: Trial別の当たり率（Clopper-Pearson 95%）と費用
harness eval prospective --advisories <path> [--campaign <id>]    # 後日公開されたadvisoryで本番台帳を再採点
harness eval score --campaign <id> --keys <path> --case <id> [--manifest <path>] # 答えの鍵でlocation-overlap。held-outは任意
harness eval keys --keys <path> [--manifest <path>]                # 私的な鍵を検査し、公開可能なcase IDとdigestだけを出す
harness eval rubric --file <path>                                 # 私的な盲検rubricを検査し、件数とdigestだけを出す
```

- **本番A/B**: 同じ対象の独立Trialへ `ablation.axes` で `history`、`prompt`、`continuation` をopt-in割当する。どのarmが見つけても提出できる。旧 `{"axis":"history","armBFraction":0.5}` も読める。
  - 既定は `short-objective-v2` と継続なし。`prompt` 軸のarm bは `armBPromptId` で版付きpromptを指定し、`continuation` 軸のarm bは `continuation` ブロックの上限内で、自分のLeadだけを1 hop継続する。割当とdigestは台帳へ残る。
  - `eval compare --axis` の分母はLab HTTP到達 `ok` のcompleted探索Trial。継続runを別Trialに数えず、provider失敗も分母に入れない。区間が重なれば「判定不能」と出す。
  - #73のLuna開発セットでは公開2事例に対して全cellでsource候補0/3だった。事前登録の規則で安い短い目的promptと継続なしを既定に残したが、優劣の証明ではない。失敗Trialの補充は元の12試行と分けて記録した。150分対照も実wallは設定上限より短かった。
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
