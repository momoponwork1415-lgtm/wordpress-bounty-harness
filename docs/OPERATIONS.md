# 運用手引き

このHarnessを一人で回す運用者と、その手足になる AI 操作役のための手引き。正本は [SPEC.md](SPEC.md)、流れは [SYSTEM.md](SYSTEM.md)。コマンドは段ごとに並べ、ここに無い flag は無い。

共通の約束:

- `harness` は `pnpm build` が作る `dist/cli/main.js`。実際には `node --no-warnings dist/cli/main.js` と打つ。
- どのコマンドも `--state <dir>`（台帳と Private Evidence の置き場。既定は `~/.local/state/wordpress-bounty-harness`）と `--host <path>`（Git 外の host 設定）を先頭に付ける。`continuous status` と台帳の読取以外は host 設定が要る。
- Git 外の設定は `~/.config/wordpress-bounty-harness/` に置く。host 設定（docker、作業 dir、image の digest、runtime profile、認証情報ファイルの**パス**、Programme 写しのパス）、campaign 設定（Programme Boundary、`discovery`、`resources`、`selectionPolicyPath`）、選定方針（`selection.json` の写し）。中身をチャットや Issue に貼らない。
- 本番の checkout は `/home/dev/worktree/<名前>` に 1 つ。動いているランナーの checkout では `pnpm build` を打たない。新しい build は別の worktree で作り、ランナーを止めてから切り替える。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りの Docker ホスト。Codex CLI。ChatGPT にログイン。費用は購読の月額固定で、Harness は使用量（rate limit / quota）を見る | 初回と CLI 更新時 |
| build | `pnpm install && pnpm build`。credential proxy は `dist/discovery`、HTTP 捕捉 proxy は `dist/lab-recorder`、探索 Lab の制御口は `dist/lab-control` にでき、runsc コンテナへ読み取り専用で mount する | 更新のたび |
| 認証 | ホストで `codex login` し、その `auth.json`（0600、本人所有）のパスを host 設定の `credentialFilePath` に書く。読むのは egress broker だけで、エージェントには渡らない | 初回とログイン失効時 |
| Programme の写し | wordfence.com は自動取得できないので、公式ページを人間が page document へ写す。35 日を超えると選定が止まる | 月 1 回 |
| 選定方針 | repo の `src/profiles/wordpress/policy/selection.json`（説明は `selection.md`）を写し、`promptVariant` と、方法を変えたときの `revisitPolicy.countTrialsFrom` を足す | 方法を変えるとき |
| 履歴ミラー | 旧環境の `python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace` を host の cron（19:10 UTC）が回す。`history status` で鮮度を見る。選定は使わず、`wbh-screen` と `wbh-dedupe` が使う | 毎日と提出前 |

起動時検査: `campaign run`、`runtime check`、`lab cleanup`、`verify next`、`review reverify` は、境界を組む前に docker と `runsc`、全 image の digest、認証情報ファイル、proxy の bundle、Codex image の CLI 版とカタログ digest を確かめる。1 つでも欠ければ何も起動せず、runc や通常 Docker へ切り替えずに止まる。

```sh
harness runtime check --config <campaign.json>   # 全項目。欠ければ終了コード 1
harness history status                            # ミラーの鮮度。fresh 以外は終了コード 1
```

## 2. ランナー

```sh
harness continuous run --config <campaign.json> --selection <selection.json> --campaign-prefix <p> [--notify <command>] [--resume]
harness continuous stop --campaign-prefix <p>
harness continuous resume --campaign-prefix <p>
harness continuous status
harness continuous concurrency [<n>] [--runtime codex] --config <campaign.json>
```

- `run` は選定 → `campaign run --all` → 次のバッチを回り続ける。起動は `setsid nohup ... &` で、標準出力を `<state>/continuous-<日付>-<p>.out` へ向ける。実行履歴の正本は台帳で、`<state>/continuous-<p>.pid` / `.json` / `.stop` は作業用。
- 動いているか見るときは `pgrep -af '^node --no-warnings dist/cli/main.js .*continuous run'` と打つ。先頭を固定しないと、打っている shell 自身に一致する。
- `stop` は `<state>/continuous-<p>.stop` を置き、ランナーは進行中の対象を終わらせてから止まる。`--host` が要る。マーカーは crash や再起動でも消えないので、再開は `resume` か `run --resume`。
- 止まる理由は 5 つ: operator、候補枯渇（`exhausted`）、Programme 写しの 35 日超（`programme-stale`）、例外 3 バッチ連続（`errors`）、completed 0 のバッチ 3 連続（`no-progress`）。quota、拒否、ログイン失効（`waiting-login`）、disk 不足では止まらず待つ。
- 並列数は campaign 設定の `resources.maxConcurrentTargets`（1〜10）と `maxConcurrentTargetsByRuntime.codex` が上限で、ランナーを止めずに `continuous concurrency <n>` で下げ上げできる。値は `<state>/continuous.concurrency` と `continuous.concurrency.<runtime>` に残り、**再起動しても残る**。再起動のたびに引数なしの `continuous concurrency` で実効値を確かめる。
- Codex の `provider-limited` は backoff（rate-limit は 5 → 60 分、quota は 30 → 60 分、2 回連続なら 6 時間）の後に同じ Trial を再開する。拒否（`provider-cyber-policy`）、制限時間、スキーマの失敗は対象を `target-skipped` にして次へ進む。
- 起動時と各バッチの後に、探索の残骸（`provider-egress-*`、`codex-agent-*`、`claude-agent-*`）だけを掃除する。Lab（`wbh-*`）には触らない。手で回す `campaign run` と `campaign resume` は生きている間 `<state>/sweep-holds/<pid>` を置き、その間ランナーは掃除をしない。
- 接頭辞（`--campaign-prefix`）が違うランナーは同じ `--state` で並走できる。選定は 1 本ずつ行い、互いのバッチの slug を `reserved-by-runner` で選ばない。
- 新しい build や方針に切り替えるときは、`stop` → pid が消えるのを待つ → 新しい worktree で `pnpm build` → 新しい接頭辞で `run`。前の方針で束ねた未着手のバッチは `selection-batch-discarded`（`policy-changed`）で捨てられ、次の選定でまた選ばれうる。

## 3. 選定

選定はランナー（`continuous run`）が各バッチの前に行う。単独の `select` コマンドは 2026-11-05 に削除した。

- 人気順の一覧をインストール数の下限（5,000）か API の終端まで読み、180 日以内更新、除外著者と slug 以外を並べる。順序は `ordering`（本番は `install-band-then-published`）。1 バッチは `maximumTargets`（本番 10）件。
- 同じ版の Trial は 1 回（`previously-selected`）。版が上がれば戻す。探索の方法を変えて再開するときは `revisitPolicy.countTrialsFrom` に再開時刻を書き、それより前の Trial を数えない。
- 凍結が `deferred` で止まった版は 7 日除外（`freeze-deferred`）、archive が拒否された版は版が上がるまで除外。探索 Lab の供給に失敗した版は `lab-provision-failed`。別のランナーが予約中の slug は `reserved-by-runner`。
- 選定レポートは `selection-batch-bound` の artifact digest から Private Evidence の `selection-report.json` を辿る。`inspections[]` の `status` と `reasons` で、なぜ選ばれなかったかが分かる。読むのは slug・版・数字だけ。
- WordPress 本体は選定が WordPress.org の最新安定版を読み、host 設定の Lab image の版と比べる。違えば何も凍結せず `core-image-outdated` で止まる（ADR 0047）。

## 4. Trial を 1 つだけ回す

校正や比較で、1 つの slug を版を固定して回すとき。本番の台帳に混ぜないため、別の `--state` を使う。

```sh
harness campaign run <slug> --campaign <id> --config <campaign.json> --selection <selection.json> [--repeat <n>]
harness campaign resume --campaign <id> --run <runId> --config <campaign.json>
harness ledger stops --campaign <id>
harness ledger resumes --campaign <id>
harness research import --from <別の state dir> [--slug <slug>]
```

- 選定方針は手動の形にする: `candidateSlugs` と `pinnedVersions`、`minimumActiveInstallations: 0`、`maximumTargets: 1`、`revisitPolicy` 無し。campaign 設定は本番の写しで、`resources` を 1 対象にし、`selectionPolicyPath` をその方針に向ける。
- `--campaign` は 40 文字まで。`--repeat 3` は同じ Snapshot に別々の Trial ID を 3 つ作る。
- `campaign resume` は `completed` 以外で止まった Root を、同じ Snapshot・同じ runtime profile・残りの制限時間で新しいサンドボックスに再開する。残りが 5 分未満、receipt に `session` が無い、別の run がやり直した後（`superseded`）は `not resumable: <理由>` で終了コード 3。
- 台帳は `<state>/ledger.sqlite` の `ledger_events`。読み方は [agents/ledger-reading.md](agents/ledger-reading.md)。`node:sqlite` の `DatabaseSync` を `readOnly: true` で開く。
- `research import` は、別の `--state`（bench など）で終わった Trial の研究 file を、この state の `discovery.priorResearch: same-target` の候補にする（ADR 0049 決定 D）。別の state は読み取り専用で開き、研究の本文は共有の work directory にあるものを digest で参照する。2 回目は何も書かない。

## 5. 検証

```sh
harness verify next --config <campaign.json> --handoff <dir> [--campaign <id> [--finding <id>[,<id>...]]] [--port <n>] [--db-port <n>] [--hold-minutes <n>] [--egress-plan <path>]
harness review reverify --campaign <id> --finding <id> --config <campaign.json> [--version <target-version>] [--resnapshot-dependencies] [--handoff <dir> [--port <n>] [--db-port <n>] [--egress-plan <path>]]
```

- `verify next` は handoff 列（parked でなく結論の出ていない対象範囲内の Finding。最新の判断が `reject` のものは並ばない）から 1 件取り、その Snapshot に検証 Lab を立て、`<dir>/lab.json` と `<dir>/review-export.json` を書く。スキル `wbh-verify` が通常機能で前提を作って `<dir>/setup-done` を置くと、Harness は管理者の資格を破棄して基線を取り直し、`<dir>/observation-ready` と `<dir>/attack.json` を置く。スキルは攻撃者の位置だけで route を実行し、6 ファイル（`route.json` `http.json` `session.json` `steps.md` `refutation.md` `precondition`）か `<dir>/abort` を置く。待ちの上限は 30 分。
- 結果は `verification-finished`（`incomplete(awaiting-human-observation)`）で、捕捉があれば Lab を落とさず `127.0.0.1:80`（塞がっていれば空き port）に出し直して所有者の観測を待つ。出力の hosts の 1 行と `manual observation receipt` の digest を所有者に渡す。
- `--finding` は列の規則に関わらず名指しで検証する。`<dir>` は 1 attempt 専用に Git の外へ置き、終わったら消す。
- 検証 Lab は同じ host で何台でも同時に立つ。`--port` を固定して 2 台に同じ値を渡さない。1 台は WordPress・MySQL・recorder・canary receiver の 4 コンテナで、host の memory が上限。
- `--egress-plan <json>`（`--campaign` と 1 件の `--finding` が要る）は、外部サービス接続が前提の検証で Lab の出口に中継器を置く。計画は `schema: wbh-egress-plan/v1`、`campaignId`、`findingId`、`destinations`（ホストと port、4 件まで）、`reason` の 5 項目。`setup-done` 直後に Harness が出口を止め、Lab の中から届かないことを確かめてから基線を取り直す。確かめられなければ `egress-open` の `incomplete`。公開入口の開閉と資格情報の入力は所有者が行い、計画と停止確認の記録を Private Evidence に残す（ADR 0046）。
- 同じプラグインの探索 Trial が `lab-setup.md` を残していれば、`<dir>/prior-lab-setup.md` に写してから `verify next` を打てる。スキルは出発点として読み、Harness は読まない。
- `WBH_RECORD_VIDEO=1` を付けると、Lab browser は被害者の訪問ごとに最初のページを WebM で録画する（1 attempt 合計 8 MiB まで）。

## 6. レビューと提出

6 段（ADR 0038）を AI 操作役がスキルと CLI で進め、所有者が観測と承認を行う。Harness は送信しない。

```sh
harness review [--campaign <id>]                              # レビュー列
harness review parked --campaign <id>                         # park された Finding と reason
harness review leads --campaign <id>                          # Lead の全件
harness review held --campaign <id>                           # 出力契約を通らなかった候補
harness review restore --campaign <id> --finding <id> --reason <text> [--by <name>]
harness review export --campaign <id> --finding <id> [--version 2]   # スキルが読む 1 本の JSON。台帳には書かない
harness review dedupe --campaign <id> --finding <id>          # ローカルミラーとの照合
harness review scope --campaign <id> --finding <id>           # Wordfence / Patchstack ごとの in-scope / out-of-scope / ambiguous
harness review decide --campaign <id> --finding <id> --decision accept|reject|defer --reason <code> [--opened <digest>]... [--duplicate no-match|unavailable[:<reason>]|possible-match:<ref> [--duplicate-note <path>]] [--reproduced match|mismatch|unavailable [--reproduce-minutes <n>]] [--by <name>] [--minutes <n>]
harness review observe --campaign <id> --finding <id> --receipt <digest> --result match|mismatch|unavailable --evidence <path> --by <human> [--ordinary-site yes|no --ordinary-site-reason <text>]
harness review draft --campaign <id> --finding <id> --programme <id> --file <path> [--prepared-by human|ai]
harness review authorize --candidate <id> --draft <digest> --to <destination> --by <name>
harness review submitted --candidate <id> --draft <digest> --to <destination>
harness review submitted --external --campaign <id> --finding <id> --to <destination> --on <date> --by <who>
harness review outcome --candidate <id> --outcome triaged|resolved|duplicate|informative|not-applicable|rejected [--reward <usd>]
```

| 段 | 誰が | 何を |
| --- | --- | --- |
| 1 | AI 操作役 | `wbh-screen` で公式規則から明白に外れるものを分け、`除外` は所有者の了解のうえ `review decide --decision reject --reason screen-v5-<理由> --by ai` で記録する |
| 1b | AI 操作役 | `wbh-source-check` で固定ソースだけを読み、入力支配と到達性を yes / no / unknown で答えて `成立` / `不成立` / `未決` を決める。`不成立` は `--reason source-check-input` か `source-check-reach` で reject。Lab は立てない |
| 2・3 | AI 操作役 | `verify next --handoff` と `wbh-verify` で検証し、`review export` を `wbh-review` が読んで確認票と判断案を作る。AI の中間判断は `--by ai` で記録し、`--minutes` は付けない |
| 4 | AI 操作役 | Lab の前に `wbh-dedupe` で同じ slug と版をミラーと公開情報に照合し、`--duplicate` に 3 値と根拠を記録する。`possible-match` / `unavailable` は `defer` で止める |
| 5 | AI 操作役 | `review scope` と `wbh-destination` で提出先を決める。Wordfence が in-scope で報酬対象のときだけ先へ進む |
| 6 | 所有者 → AI 操作役 | 所有者が検証 Lab か `lab up --for-review` の review Lab で確かめ、結果を会話で明言する。AI 操作役が `review observe` と `review decide --decision defer --reason pending-final-review --reproduced <結果> --by <所有者>` を所有者の名前で記録し、attestation を残す。`match` のときだけ `wbh-report` で英語の報告書と Fill-Only JSON を作り、`review draft --prepared-by ai` で版を記録する |
| 7・8 | 所有者 | 文案を査読して `review draft --prepared-by human` と `review decide --decision accept --reason reviewed-report --by <name>` を記録し、`review authorize` で承認する。自身の拡張機能でフォームへ入力して送信し、`review submitted` と `review outcome` で転帰を記録する。Wordfence からの転帰のメールを会話に貼れば、AI 操作役が `review outcome` を打つ |

- `authorize` は、最新の観測が `match`、最新の文案が `--prepared-by human`、その後に同じ人の `accept` があるときだけ通る。review Lab を開き直したら段 6 からやり直す。
- 最新の判断が `reject` でなくなれば、Finding は handoff 列に戻る。落とした判断を取り消すときは別の判断（`defer` など）を記録する。
- 文書と同じく、Finding の本文、payload、path、画面画像はチャットや Issue に貼らない。数と category 名だけを書く。

## 7. 見る数字

```sh
harness ledger funnel --campaign <id> | --since <ISO>   # raw → 検証 → レビュー → in-scope → 提出 → 転帰
harness ledger stops [--campaign <id>] [--since <ISO>]  # run の失敗理由、target-skipped の段階×理由、Lab 失敗、campaign 停止理由
harness ledger usage [--campaign <id>]                   # provider が返した token を対象・UTC 日ごとに合計
harness ledger runtime [--campaign <id>]                 # model、effort、CLI 版、カタログ digest の組ごとの run 数
```

ADR 0045 の分母は「Codex 1 時間あたりの Lab 発火数」と Wordfence の転帰。収益の式は「対象数 × 当たり率 × in-scope 率 × 平均報奨 − 月費用」で、funnel の各段がこの各項に対応する。週に見るものは [DEVELOPMENT.md](DEVELOPMENT.md) 第 7 節。

## 8. 保守

### Lab

```sh
harness lab up --for-review --campaign <id> --finding <id>   # 手で確かめる review Lab。空いていれば 127.0.0.1:80
harness lab down [--config <campaign.json>]                   # review Lab と、人間のために残した検証 Lab を落とす
harness lab cleanup --config <campaign.json> [--remove]       # 持ち主の死んだ Lab と探索の残骸を一覧 / 削除
```

- review Lab をブラウザで開くには hosts に `127.0.0.1 wordpress` を足して `http://wordpress/` を開く。80 が塞がっているときは出力の `--host-resolver-rules` を付けて Chrome を起動する。
- `lab up --for-review` を打つたびに新しい `manual-observation-lab-ready` が追記され、数えるのは最新の ready より後の `review observe` だけ。
- `lab cleanup` は実行中の campaign が無いときに使う。持ち主の記録が無い Lab は、立っていても消える。

### 子の最終 JSON がスキーマで失敗したとき

Private Evidence の rollout に完全な JSON が残っていれば、parser を直した後に `node scripts/recover-child-reports.mjs --campaign <id> --state <dir> --attachments <provider-attachments dir> [--mode turns] [--dry-run]` で再解釈し、`child-report-recovered` と有効な Finding / Lead を追記する。元の失敗イベントは残す。

### Codex CLI / model catalog の更新

新しい Codex image を固定 digest で用意し、`runtime check` で image の CLI 版とカタログ digest を runtime profile と比べる。食い違ったまま回すと全 run が `incomplete(policy)` になる。更新後の campaign で `ledger runtime` に新しい組が現れれば記録は正しい。

### 履歴ミラー

cron（19:10 UTC）が取りこぼしたら、第 1 節のコマンドを手で 1 回回し、`history status` が `fresh` になるのを見る。`stale` / `unavailable` は「重複なし」を意味しない。

## 9. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへの PoC・payload・再現手順の提供。
- Harness からの外部送信。
- payload、HTTP 記録、画面画像、未公開の発見の Git へのコミット。
- 動いているランナーの checkout での `pnpm build`。
