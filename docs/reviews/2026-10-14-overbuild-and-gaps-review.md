# バグバウンティ Harness としての作り込み過ぎと不足（2026-10-14）

調べて報告。正本ではなく、食い違えば [SPEC](../SPEC.md) と [ADR](../adr/) が勝つ。対象は `main` HEAD `d214de0`（PR #210 まで）。読んだのは SPEC、ADR 0029 / 0031 / 0032、DEVELOPMENT、LESSONS、PARKING、OPERATIONS、評価記録 3 本、過去のレビュー 4 本、`src/` と `tests/` の構成、open Issue 32 件。Private Evidence、本番の台帳、Git 外の host 設定は読んでいない。対象の実行、runsc、provider 呼び出しはしていない。

所有者の問い: 「バグバウンティ Harness としてどこが作り込み過ぎで、どの機能が足りないか」。

## 0. 結論

- **土台（隔離、broker、Snapshot digest、追記台帳、判定器 9 種、Private Evidence）は完成している。** 一方、Step 1 の完了条件「quota 1 週分を人手 0 で回す」に対して、**外側のループ（選定の補充、quota 待ち、再開）がまだ無い**。これが今いちばん足りない機能で、open Issue #227 / #228 / #229 がそれにあたる。
- **作り込み過ぎは「本番ループで使われていない経路」に集中している。** 探索 prompt 15 版、評価モジュール（Answer Key 採点、blind rubric、arm 比較、前向き照合）、週次 smoke 専用の replay Verifier、plugin 固有の Lab adapter 8 本、二段構え時代の `assignment` mode、旧 arm の campaign 設定 27 本。合計でおよそ 4,500 行がいまの収益の式のどの項にも効いていない。削除は所有者が Step 2 と決めているので、ここでは「凍結して新規に足さない線」を明示することを勧める。
- **数字で見ると、失われているのは候補ではなく転換率と周回数である。** 本番第 3 周は Finding 8 件がすべて `incomplete`、人間が開いた Finding は 0 件、未知の `runtime-confirmed` は 0 件。再発見では Stored XSS（Brizy）と SQLi（SSA、別経路）の 2 分類で判定器が鳴っている。つまり判定器は動くが、本番の候補が判定器に届く前の段（Lab 前提、provider 方針、source 取得）で止まっている。

`pnpm check` はこの環境では 16 件が落ちるが、全件が「root ユーザーでは Codex sandbox を起動しない」という意図した拒否（`src/discovery/codex-gvisor-sandbox.ts:446`）によるもので、コードの欠陥ではない。非 root の CI では通る前提で以下を書く。

## 1. 現状の数字

| 項目 | 数 | 出典 |
| --- | --- | ---: |
| `src/` 行数 / ファイル数 | 33,439 / 113 | `wc -l` |
| `tests/` 行数 / ファイル数 | 28,812 / 87 | 同上 |
| ADR / reviews / evaluation 文書 | 32 / 30 / 5 | `docs/` |
| 探索 prompt 版 / Verifier prompt 版 | 15 / 7 | `src/profiles/wordpress/prompts/index.ts:4-19`、`verifier-v1..v7.md` |
| 現行経路が起動する prompt | 探索 1（`wp2shell-bounty-v3`）＋比較 arm 2、Verifier 1（v7） | `campaign.json`、`index.ts:88` |
| CLI subcommand | 約 30（うち `review` 13、`eval` 6） | `src/cli/index.ts:711-1371` |
| 判定器を持つ impact | 15 / 17 の対象内 impact（`content-deletion`、`rfi` は no-judge） | `judges.ts:1355-1413`、`finding.ts:40-64` |
| Lab scenario / plugin 固有 adapter | 8 / 8 | `lab/scenarios.ts`、`lab/*-adapter.ts` 等 |
| open Issue | 32 | GitHub |
| 本番第 3 周: Finding → confirmed | 8 → 0（no-judge 5、observation 2、precondition 1） | `docs/evaluation/2026-10-12-production-v3-cycle-03.md` |
| 再発見で confirmed | Brizy Stored XSS 1、SSA SQLi 1（公開記録と別経路） | `docs/evaluation/2026-10-12-rediscovery-benchmark.md` |
| 人間が開いた Finding / 提出 / 報奨 | 0 / 0 / 0 | 同上、ADR 0031 |

## 2. 作り込み過ぎ

優先順は「いま所有者と AI の読み込み・保守コストを食っている順」。削除は Step 2（ADR 0032 Q27、PARKING）なので、ここでの推奨は「凍結の線を引く」こと。

### 2.1 本番ループに乗っていないコード（約 4,500 行）

| 箇所 | 行数 | 事実 | 推奨 |
| --- | ---: | --- | --- |
| 評価モジュール `src/evaluation/` ＋ `profiles/wordpress/advisory.ts`、`eval score / keys / rubric / compare / prospective / case-blocked` | 620 ＋ CLI 分 ＋ test 5 本 | SPEC §4 で「任意の研究用」。本番 campaign で呼ぶ場所がない。DEVELOPMENT §7「週末に見る数字」に `eval score --keys` が残り、Answer Key を要求しないという SPEC §10 と文書内で食い違う | DEVELOPMENT §7 から `eval score` 行を消す。`eval case-blocked` だけ残し、他 5 つは Step 2 の削除候補に札を付ける |
| 週次 smoke 専用の replay Verifier `smoke-replay-recipe.ts`、`smoke-replay-verifier.ts`、`scripts/smoke-real-lab.mjs` | 1,226 | #126 の週次 smoke（「受入未達」）のためだけに、8 手順の HTTP 再生と型付き束縛を持つ第 2 の検証経路を作っている。本番の Verifier と判定器は別経路で、ここが緑でも本番の転換率は上がらない | 週次 smoke は既知 Finding に `review reverify` を 1 回打つ運用に置き換えられる。replay 経路は凍結し、Step 2 で消す |
| 二段構え時代の `assignment` mode（入口分担、`entriesPerRun`） | `wordpress.ts:183-248`、`storage-index.ts` の分担部分 | ADR 0025 は 0029 で置き換えられたが、campaign 設定の schema と OPERATIONS §2「入口の分担」に残っている。現行経路は索引をカタログとして渡すだけで、分担は Root が決める | `assignment` を設定 schema から外す小 PR。索引（entry-points / storage-index）は残す |
| 旧 arm の campaign 設定 `examples/translatepress-*/` | 27 JSON | luna-ab、short-managed v3 / v4、comment-fixture 等、ADR 0029 以降は起動しない arm。`tests/cli/examples.test.ts` が読むので消せない構造になっている | 本番用 2 本（`campaign-production-v1.json`、`host.example.json`、`wordfence-programme.example.json`）だけ `examples/` に残し、他は `docs/knowledge/` に写すか削除。test は本番用だけを読む |
| plugin 固有 Lab adapter 8 本 ＋ `wordpress-initialization.ts` | 748 | ADR 0026「plugin 非依存を優先」と逆方向。`wordpress-initialization.ts` は直近 40 commit で 10 回変更され、`src/` で最も churn が高い。対象 1 件ごとに手で足している | 新規追加を止める。`incomplete(precondition)` の理由集計（`scripts/report-wordpress-preconditions.mjs`）で 3 回出た前提だけを汎用 scenario にする、という SPEC §7 の規則を運用で守る。第 3 節 3.3 も見る |

### 2.2 prompt 版の増殖

探索 15 版のうち現行経路で起動できるのは `wp2shell-bounty-v3`、比較 arm `wp2shell-whitebox-v1.7` と `short-objective-managed-v4` の 3 本。残り 12 本は台帳の digest 照合用（ADR 0029）だが、`loadWordPressDiscoveryAsset` は 15 本すべてを同じ経路で読め、新規起動を型で止めていない（`prompts/index.ts:43-70`）。

- 2026-10-12 の整理案（「v3 を既定にして止める。比較 arm は v4 1 本」）の翌日に v1.7 arm（#205）と A/B 事前登録（#201）が入った。これは ADR 0032 Q10 の所有者決定なので矛盾ではないが、**開発セットの `runtime-confirmed` が全 PR で 0 のまま**なので、arm 比較は「判定不能」で終わる可能性が高い（SPEC §10「区間が重なれば判定不能」）。A/B に Trial を使う前に、第 3 節 3.3 の壁を外さないと信号が出ない。
- 推奨: `WORDPRESS_DISCOVERY_PROMPT_IDS` を「起動可能 3 本」と「照合専用 archive」に分け、campaign 設定の `promptId` は前者だけを受ける。消さずに起動不能にする。

### 2.3 review CLI の多機能

`review` は 13 subcommand、`src/review/index.ts` 1,051 行 ＋ `export.ts` 630 行。人間が開いた Finding は 0 件。ADR 0031 / 0032 Q27 で「CLI は機械向け、人間向けは skill、整理は Step 2」と決まっているので、ここは凍結済みとして扱う。`review scope` と `review dedupe` は skill `wbh-dedupe` / `wbh-review` と役割が重なるので、Step 2 の削除候補に札だけ付ける。

### 2.4 文書

正本 2 つ（SPEC、ADR）に対し、`docs/` 直下に 13 本、reviews 30 本、knowledge 配下に過去 4 世代の写し。SPEC §11（ADR 一覧の重複）、§13（移植一覧）、§14（spike 未確認事項、すべて決着）は役目を終えている。`IMPLEMENTATION-PLAN.md` は 10-10 時点の棚卸しで ADR 0016 を正本と書く。README は読む順を 10 本挙げる。所有者は 10-12 に「整理は本番が回ってから」と決めているので着手は勧めないが、agent が毎回 1,500 行超を読む費用は Step 1 の間も発生している。最小の手当てとして、AGENTS.md の読む順を SPEC §1〜§8b と DEVELOPMENT §2 に限定する 1 行だけを勧める。

### 2.5 テスト

`tests/` 28,812 行は `src/` の 86%。`tests/cli/cli.test.ts` 3,873 行、`wordpress-lab.test.ts` 1,904 行で、実装の変更ごとに同じファイルが膨らんでいる（直近 40 commit で 15 回と 13 回）。TEST-STRATEGY の「内部をなぞるテストを増やさない」と反対の勾配。直す必要はまだ無いが、Step 2 で CLI test を公開 seam ごとに分割する札を付ける。

## 3. 足りない機能

優先順は「Step 1 の完了条件と収益の式に効く順」。

### 3.1 外側のループが無い（最優先、Step 1 の完了条件そのもの）

- `campaign run --all` は選定 batch 1 つ（`maximumTargets: 5`）を 1 回流して終わる。quota 到達は exit 3 で止まり、人間が同じコマンドを再実行して再開する（OPERATIONS §2）。**「quota 1 週分を人手 0 で」は、この構造では満たせない。**
- 候補在庫が無い。`select` は毎回 WordPress.org を観測して 5 件を切るだけで、未探索の pool を持たない（#227）。`revisitPolicy: version-or-prompt-changed` はあるが、在庫から次を取る側がない。
- ADR 0032 Q18 で cron 2 本を止めたので、待機と再開は Harness 自身が持つ必要がある（#229）。
- 推奨: `select → campaign run → quota 待ち → 再開 → 次 batch` を 1 つの script に閉じ、停止条件を「quota 枯渇 / provider 方針拒否 N 回連続 / 人間の stop file」の 3 つに限る。新しい設定ブロック 1 つで足り、ADR は要らない。#227 / #228 / #229 は 1 本に畳める。

### 3.2 探索 provider が 1 本で、provider 側の方針で丸ごと止まる

- 探索 runtime は Codex 専用（`codex-native-agent-runtime.ts` 1,613 行、broker は ChatGPT OAuth 前提）。#220「実対象の協調 Trial が provider の cyber_policy 応答で開始直後に incomplete」が open で、これが本番の対象で起きると周回数がそのまま削れる。
- Opus runtime（#224、#226）は PARKING の「Step 1 完了後」。だが PARKING の再開条件は Step 完了に結び付いていて、「provider 拒否が本番を止めている」という事象に結び付いていない。
- 推奨: まず #220 の発生率を台帳の `discovery-run-finished.reasonDetail` で 1 週間分数える。対象の何割が開始直後に落ちるかで、Opus を第 2 arm として前倒しするかを所有者が決める。不変条件 2「暗黙に切り替えない」は守り、arm として明示する。

### 3.3 Lab の「通常利用の状態」を作る手段が、手書き adapter しかない

- 第 3 周の `incomplete(precondition)` の理由は「管理者による対象固有の設定状態」で、plugin 非依存の scenario では埋められないと記録されている。多くの plugin は管理者が初期設定をしないと攻撃面が出ない。
- いまの解は対象ごとに adapter を書くこと（第 2 節 2.1）で、対象 5 件 / 周のループでは追いつかない。ADR 0026 は Verifier にブラウザと管理者セッションを渡さないと決めており、これは正しい。
- 足りないのは、**Harness 所有の setup 側**が plugin の初期設定を既定値で通す汎用の手段。候補は (a) plugin の activation hook と `register_setting` の既定値を Lab 供給時に WP-CLI で適用する、(b) plugin が持つ「セットアップウィザード」相当を Lab 観測器（Harness 所有、型付き手順）で 1 回だけ踏む、(c) 諦めて `incomplete(precondition)` のまま review queue に載せ、人間が skill で見る（#185 で既にそうなっている）。
- 推奨: まず (c) が実際に人間に届いているかを第 2 週の問いで確認する。(a) は小さく試せる。(b) は Verifier にブラウザを渡さない線を保ったまま可能だが、plugin ごとの差が大きいので 3 回同じ前提が出てから。

### 3.4 今週の問いを止めている open bug

Step 1 第 1 週の問い「ループは quota 1 週分を人手 0 で回るか。止まった理由は何か」に直結する open Issue。これらは新機能ではなく、ループが 1 周目で止まる原因。

| Issue | 段 | 内容 |
| --- | --- | --- |
| #222 | Lab | 厳しい umask で固定した plugin source を WP-CLI が読めない |
| #223 | Snapshot | Node の接続タイムアウトを理由付きで記録し取得可能な ZIP へ到達する |
| #220 | 探索 | provider の cyber_policy 応答で開始直後に incomplete |
| #213 | 検証 | Lab scenario の通常機能前提が不足し実対象検証が停止する |
| #211 | 検証 | Verifier の任意セッション欄の空値で非セッション検証が recipe 未完了になる |
| #183 | 探索 | `unadmitted-event-type:error` の原因未特定（Brizy の Root が completed に数えられなかった原因） |

### 3.5 小さいが提出に効く不足

- **提出直前の鮮度**: 重複照合は Harness 内ではローカル Wordfence mirror だけで、Patchstack / WPScan は skill の Web 検索に委ねている（ADR 0031 どおり）。mirror の日次更新と鮮度表示は #231 が open。LESSONS 13 のとおり、提出が止まっている間に crowded になった対象は duplicate で落ちるので、mirror の鮮度は funnel の `duplicate` に直結する。
- **人間への通知が無い**: review queue に新しい項目が入っても、人間が `review` を打つまで見えない（`src/` に通知経路なし）。skill 運用なら「Claude Code を開いたときに `review` を打つ」で足りるが、LESSONS 5「人間に見えない成果は無いのと同じ」の線で、週次 batch の開始時に件数だけ出す 1 行があるとよい。
- **quota の消費率**: usage は token と wall で出るが、「1 Trial で週 quota の何分の 1 を使ったか」は出ない。1 週 N 対象の計画が立てられない。`ledger usage` に provider の rate-limit ヘッダ由来の残量を 1 列足せるかは provider 側の応答次第。
- **Step 2 送り（妥当）**: 修正版の負の対照の自動化、最新版再検証の自動化、Patchstack 第 2 送信先。いずれも提出候補が 1 件出てから必要になる。

### 3.6 閉じてよい Issue

- #118「Stored XSS 判定器の screenshot 要求で incomplete(evidence)」: Lab 観測器が screenshot を返し（`lab-observation.ts:94-97, 190-252`）、判定器がそれを証拠に載せる経路が入っている（`judges.ts:607-621`）。再発見で Brizy の Stored XSS が `runtime-confirmed` に到達した記録がその証明。Issue は閉じられる。
- #107「Verifier の incomplete を理由ごとに自動再試行」: #209 で有界の自動再検証が入った。閉じられるが、**実装は ADR 0022 の原文（recipe 2 回、observation 2 回、provision 1 回、precondition は scenario が変わったとき）に従い、ADR 0032 の修正（recipe 2 回、observation 1 回、provision 0 回、precondition 0 回）とは一致していない**（`src/cli/pipeline.ts:96-120`）。SPEC §7 も原文のまま。どちらを正本にするかを所有者が決め、合わない側を 1 行直す。ADR 0032 は `proposed` のままなので、accepted にする前にここを揃えるのが安い。
- #185 / #186 / #188: それぞれ #191 系、#197、#204 で merge 済み。閉じられる。

## 4. 推奨の要約（所有者が決めること）

| # | 項目 | 推奨 | 根拠 |
| --- | --- | --- | --- |
| R1 | 外側ループ（#227 / #228 / #229） | 1 本の PR に畳み、Step 1 第 1 週の問いの前提として最優先 | 3.1 |
| R2 | provider 拒否（#220） | 1 週間の発生率を数え、Opus 第 2 arm の前倒しを決める | 3.2 |
| R3 | plugin 固有 adapter | 新規追加を止め、(a) 既定値適用を小さく試す | 2.1、3.3 |
| R4 | 起動可能 prompt の限定 | 3 本以外は archive として起動不能にする小 PR | 2.2 |
| R5 | `assignment` mode | 設定 schema から外す小 PR | 2.1 |
| R6 | 評価モジュール、replay Verifier、旧 examples | 凍結の札を PARKING に 3 行足す。削除は Step 2 | 2.1 |
| R7 | Issue 整理 | #118 / #107 / #185 / #186 / #188 を閉じる | 3.6 |
| R8 | DEVELOPMENT §7 | `eval score --keys` の行を消す | 2.1 |
| R9 | 再試行回数の正本 | ADR 0032 の修正と `pipeline.ts` のどちらに揃えるかを決め、合わない側を直す | 3.6 |

R4、R5、R7、R8 は所有者の判断を要しない小さな手直しで、agent に渡る文章も ADR も触らない。R1〜R3、R6、R9 は所有者が決める。

## 5. 未確認の仮定

- 本番の台帳と Private Evidence は読んでいないため、第 3 周の `no-judge` 5 件の impact 内訳と、#185 以降の周回で何件が `finding-parked` になったかは分からない。
- `pnpm check` の 16 件の失敗は root ユーザー起因と判断したが、非 root 環境での再実行はしていない。
- 「使われていない」は「`campaign run` の経路から呼ばれない」の意味で、所有者が手で呼んでいる可能性は排除できない。
