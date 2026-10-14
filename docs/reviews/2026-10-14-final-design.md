# 最終設計（2026-10-14、決定版）

所有者の依頼「最終設計を出してほしい。自分では決め切れない」に答える。ここに書いた決定は、所有者が「この文書で進める」と言った時点で有効になり、以後は変えた行だけを更新する。不変条件（SPEC §2 の 8 項目）とモジュール境界は変えないので新しい ADR は要らない。SPEC §8b の 1 行と DEVELOPMENT / OPERATIONS の文言変更だけが所有者の `owner-approved` を要する。

調べ方: [2026-10-14 のレビュー](2026-10-14-overbuild-and-gaps-review.md)（第 0〜10 節）、読み手 4 本（#229 branch の runner、provider 拒否と第 2 経路、Lab 前提、人間レビュー経路）、角度の違う提案 2 本、規則と code の 2 つの lens による反証。対象は `main` d214de0 と branch `codex/issue-229-batch-pin` c5d0ef3、および関連 branch 8 本。実機、provider、`pnpm check` は動かしていない。

所有者の確定事項（2026-10-14）: `cyber_policy` 拒否（#220）は一時的な問題。#215 の既往照合は「判別不能 slug の保留」までで、全 slug の保留ではない。方向性は正しいが、いらない機能と厳しすぎる制約がある。

## 0. 決めたこと（10 行）

1. 探索 provider は Codex（`gpt-6-sol`、Daybreak）のまま。拒否は記録して対象を飛ばし、Opus arm は条件付きで寝かせる（D1）。
2. 既往照合はこの repo の台帳だけで行い、不明 slug は未探索として進める。旧世代の監査 manifest と registry は作らない（D2）。
3. 継続運転の状態源は追記専用台帳 1 つ。journal・owner lease・claim・reconciliation・recovery は捨てる（D3）。
4. quota は人間を呼ばず、backoff 付きで 1 Trial ずつ再試行する。その他の停止理由は対象を飛ばして次へ進む（D4）。
5. Lab は「plugin の通常の有効化設定」を Harness 所有の型付き setup が入れてよい。管理者権限の付与と重大 option の変更は不可（D5）。
6. 人間レビューは skill 3 本と `review export` の整合だけ直し、手動再現は `no-judge` の種別に限る（D6）。
7. 本番ループに乗っていない約 4,700 行（`c5d0ef3` 比）を消し、約 2,000 行を凍結する（D7）。
8. `owner-approved` は不変条件・Programme Boundary・判定器の変更だけに絞り、探索 PR の 3 Trial は異なる slug の初回で満たしてよい（D8）。
9. モデル配分は、本番は Codex 1 本、開発は設計と反証に最上位の Claude、分割と削除は Codex か Sonnet 級（D9）。
10. 10-24 までに「quota 1 週分を人手 0」、11-14 までに初提出。週の問いは 1 つ（D10）。

## 1. 変えないもの

- SPEC §2 の不変条件 8 項目。特に、対象の実行は gVisor 内だけ、`runtime-confirmed` は判定器だけ、外向き通信は broker 経由の provider API だけ、Harness は送信しない、台帳は digest 参照だけ。
- 主経路: 対象ごとに Root＋最大 3 子の協調 Trial を 1 回、wall 上限 60 分（ADR 0029）。
- 判定器の集合と成功条件。攻撃者位置は未認証と subscriber / customer のみ。
- 人間の判断点: 提出前レビュー、外部行動の承認、同じ slug の追加 Trial の承認（ADR 0032 Q6）。
- 判断の要る工程は skill、決定論の処理と自律ループは Harness（ADR 0031）。

## 2. 到達目標と期日

| 期日 | 到達点 | 測る数字 |
| --- | --- | --- |
| 2026-10-21 | D1〜D4、D6、D7 の PR が merge され、`continuous start` が実機で 1 batch を人手 0 で回る | 1 batch の対象数、Trial 完了数、停止理由の内訳 |
| 2026-10-24 | Step 1 完了条件: quota 1 週分を人手 0 で回り切り、Programme Boundary 内の Finding が全件 `review export` に届く | 週の対象数、Finding 数、`incomplete` の理由内訳、人間介入 0 回 |
| 2026-10-28 | 所有者が skill 3 本で最初のレビュー batch を完了 | batch の件数、所要分、accept / reject / defer の内訳 |
| 2026-11-14 | 初提出 1 件（最新版で確認済み、重複なし、承認付き） | 提出 1、転帰は後日 |
| 2026-12 以降 | 月 USD 1,000 の測定開始 | 提出転帰と報奨額 |

## 3. 最終形の流れ

```
在庫（WordPress.org 候補 pool、未探索 slug）
  → batch（最大 5 対象、台帳の既往を除く）
  → campaign run（Snapshot 固定 → Lab → 協調 Trial 1 回 → 検証と有界の自動再検証）
  → review export（scope 内 Finding 全件、判定結果に関係なく）
  → skill: wbh-review → wbh-dedupe → wbh-report（所有者が Claude Code で使う）
  → 所有者: decide / authorize / 送信 / submitted / outcome
runner の状態は台帳から導く。停止は operator stop、候補枯渇、provider 拒否 3 連続の 3 つ。
quota は backoff 付きの 1 Trial 再試行。その他の失敗は対象を飛ばして次へ。
```

## 4. 決定の詳細

### D1 provider: Codex のまま、拒否は記録して飛ばす

- 決定: 探索は Codex を既定のまま使う。branch `codex/provider-policy-diagnostics`（+103 行）を merge し、`cyber_policy` を `reasonDetail = provider-cyber-policy` として台帳に残す。runner はこの対象を `target-skipped` にして次へ進み、異なる対象で 3 連続のときだけ止まる。拒否を避けるための prompt の言い換えはしない（#220 の受入条件）。
- Opus arm は PARKING のまま。再開条件を「Step 1 完了後」から「1 週間の初回 Trial 10 本以上で拒否率 30% 以上、または週内に 2 連続拒否」に書き換える。拒否率は `discovery-run-finished.reasonDetail` を group by する `ledger refusals`（約 80 行）で読む。
- 理由: 所有者が「一時的」と判断した。#220 は同一対象で拒否 → 再試行で成功しており、拒否は決定論的でない。1 件の観測で provider を切り替えると誤判断になる。
- 変更箇所: `src/discovery/codex-native-agent-runtime.ts`（+37）、test（+64）、`src/cli/index.ts` と `src/ledger/index.ts`（集計 約 80 行）、`docs/PARKING.md` 1 行。
- 消し方: `ledger refusals` は読み取り専用コマンドなので削除は自由。

### D2 既往照合: この repo の台帳だけ、不明は未探索

- 決定: 「既往あり」は、既知の全 `--state` ディレクトリの台帳にある `discovery-run-started` の slug だけで判定する。state ディレクトリの一覧は Git 外の host 設定に 1 回書く。旧世代 DB・アーカイブとの照合、監査 manifest、`trial bootstrap / coverage-import / approve` の registry は作らない。不明 slug は未探索として進める。
- 同じ slug の追加 Trial の承認は、campaign 設定の `approvedRepeatSlugs: ["slug"]` 1 行と、台帳の `repeat-approved` event（slug と設定 digest）で表す。承認 JSON の作成、registry、trialOrdinal の結び付けは要らない。
- provider-limited で Finding 0 件・最終 JSON なしの Trial は「消費済み」に数えない（D4 の再試行は 2 回目にあたらない）。
- 理由: #215 の受入条件は「判別不能 slug の保留」であり、旧世代の全数監査が済むまで初回を止めることではない。再探索の費用は quota だけで、報奨は失わない。Step 1 の「人手 0」と両立する唯一の形。
- 変更箇所: `c5d0ef3` から `repeat-trial-gate.ts`（841 行）、`main.ts` の `trial` コマンド、`wordpress.ts` の gate 接続 4 箇所、`campaign.ts` の `beforeTrialStart / beforeTrialAppend`、`ledger` の `approvalDigest` を外す。`ledger-exclusions.ts` に provider-limited の除外規則を約 25 行。
- 消し方: `approvedRepeatSlugs` を設定から外せば現状に戻る。

### D3 runner: 台帳が唯一の状態源

- 決定: `continuous-runner.ts` を約 150 行に書き直す。周回は (1) 台帳から最新 child campaign を特定、(2) `continuous-child-assessment` で状態を導出、(3) 完了・skip・lab-failed なら次 batch を作って `runCampaign`、(4) `wait-review` は理由で分岐（D4）、(5) 毎周回 stop marker を確認。単一インスタンスは pid file、停止は marker file と SIGINT / SIGTERM。`status` は台帳と pid から約 60 行で表示する。
- 捨てる: `continuous-run-journal.ts`、`continuous-run-owner.ts`、`continuous-restart-reconciliation.ts`、`resource-recovery.ts`、`host-resource-claims.ts`、`target-resource-scope.ts`、`continuous-input-pin.ts`、`continuous-control.ts`、`main.ts` の `resources status / recover`、対応する test、#228 の Lab 側変更（`container-startup.ts`、`lab/index.ts` の uncertainCreations、broker +101）。
- 残す: `continuous-child-assessment.ts`（`reviewExportReady` 未指定を停止理由にしない修正を入れる）、`continuous-batch.ts`（parent record と owner への依存を `(parentRunId, ordinal, policyDigest)` に置き換え、消費済み slug は `inspectWordPressLedgerExclusions` に一本化）、`candidate-inventory.ts`、enumerator の変更、`campaign.ts` / `pipeline.ts` の stopSignal。
- 在庫 cursor は state ディレクトリの小さな JSON 1 つに置く（journal の代替。候補 (b)）。
- crash 復旧: 終了記録のない Trial は、wall 上限を超えていれば runner が `incomplete(provider)` の finish を代筆する（不変条件 4 と整合）。Lab の残骸は `lab cleanup` を runner 起動時に 1 回呼ぶ。実機で 2 回止まるまでは、それ以上の復旧機構を作らない（LESSONS 8）。
- 理由: 第 2 の journal は SPEC §4「単一の追記専用台帳」と二重になる。実機で 1 回も連続運転していない段階で crash 復旧と競合制御を持つのは先回り。
- PR は 3 本: (a) gate 抜きの在庫（`candidate-inventory.ts` 768 行が中心、enumerator と 2 本に割る）、(b) 最小 runner、(c) D4 の quota 再試行。

### D4 quota とその他の停止理由

- 決定: provider の rate-limit / quota では、1 対象の batch を作って Trial を 1 本だけ試す。再び quota なら 5 分 → 10 → 20 → 40 → 60 分の backoff。同じ slug で 5 回連続なら `target-skipped`。backoff 段は台帳の直近 `discovery-run-finished.occurredAt` と連続数から導く。人間は呼ばない。
- `wait-review` の他の理由（lab-failed、run-failed、版・Programme の変化、config の変化、pool 期限）はその対象を `target-skipped` にして次へ進む。新しい config は次の child から採用する。親 run を止めるのは operator stop、候補枯渇、provider 拒否 3 連続のみ。
- 理由: quota は毎週必ず起きる事象で、そこで人間を呼ぶ設計は「人手 0」と両立しない。盲目待ち（reset 時刻が台帳に無い）は backoff 上限 60 分で許容する。
- 変更箇所: `continuous-runner.ts` 内、`continuous-child-assessment.ts` の retry-eligible 判定、`ledger-exclusions.ts` 約 25 行。
- 消し方: backoff 定数と連続上限は runner の先頭に置き、設定にはしない。

### D5 Lab: 通常の有効化設定を Harness が入れる

- 決定: SPEC §8b の `lab` 行「設定は既定のまま」を次に差し替える。「plugin の通常の有効化設定（管理者が普通に行う初期設定）は Harness 所有の setup が型付き手順で入れてよい。権限付与、`default_role` / `siteurl` / `admin_email` / `users_can_register` 等の options-update 対象の変更、危険設定は不可。実行前後の状態差分を Private Evidence に残す」。SPEC §8a の「Labは既定設定で供給し」と ADR 0020 に同趣旨の 1 文を補い、ADR 0026 には決定を変えない追記 1 段落。Verifier にブラウザと管理者セッションを渡さない線は変えない。
- 実装: `src/profiles/wordpress/lab/ordinary-activation-defaults.ts`（約 150 行、版と digest 固定の汎用 PHP 1 本）。管理者文脈で `admin_init` を発火、未保存の `register_setting` 既定値だけを `add_option`（既存値は上書きしない）、登録済み shortcode を載せた公開ページを 1 つ作る。実行後に重大 option と管理者ユーザー数が変わっていないことを検査し、失敗は provision 失敗として扱う（判定には混ぜない）。`scenarios.ts` に `ordinary-activation-defaults-v1`（pluginSlug は null）を 1 件足し、`installPlugins` 直後に呼ぶ。対象固有の関数名・クラス名は使わず、WordPress 標準 API だけに頼る。
- 範囲: 上の (a) register_setting 既定値、(c) shortcode 付き公開ページまで。plugin 独自の installer やウィザード完了フラグ（b）は入れない（対象固有知識の混入になる）。
- 既存の 8 adapter と既存 scenario は変更しない（digest が変わる）。新規追加も止める。
- 探索 Lab と検証 Lab は同じ setup digest で立つので、この変更は「探索に触る PR」として異なる slug の初回 3 Trial で測る（D8）。
- 理由: 本番第 3 周の `incomplete(precondition)` は「管理者による対象固有の設定状態」で、既定設定のままでは埋まらない。Wordfence が却下するのは管理者の「誤設定」前提であり、通常の有効化設定ではない。adapter を対象ごとに書く作業は週 5 対象のループに追いつかない。
- 消し方: scenario 1 件と file 1 本を消し、SPEC の行を戻す。

### D6 人間レビュー経路

- 決定: skill 3 本の参照フィールド名を export に合わせる（`privateEvidence.directory / artifacts`、`labStateDiff`、約 10 行）。`review export` に最新の人間再現結果、最新 draft の digest・revision・preparedBy・programme、decide の reasonCode と duplicate、scopeAssessment id を追加する（schema literal は `review-export/v1` のまま互換追加、約 80 行＋test 40 行）。OPERATIONS §3 の冒頭に skill の起動順と所有者が打つコマンドの表を約 20 行で足す。
- 手動再現: 判定器が同じ Snapshot で nonce を回収し、再現パッケージの script を Harness が新しい Lab で再実行して緑なら、所有者は証拠を読むだけでよい。手で再現するのは `no-judge` の種別だけ。SPEC §8 の「人間は再現パッケージで自分の手で再現してから」をこの形に書き換える（不変条件 6 の「提出前レビュー」は残る）。
- 重複照合: Harness 側はローカル Wordfence mirror のみ。`wbh-dedupe` の手順に「提出直前に `history status` を打ち、stale なら更新」を 1 行足す。#231（日次更新）は低優先のまま。
- 理由: 本番 3 周で人間が開いた Finding は 0 件。所有者の時間は「読む」に使い、「手で打つ」は判定器が代替できる。
- 変更箇所: `.claude/skills/*/SKILL.md`、`src/review/export.ts`、`docs/OPERATIONS.md`、`docs/SPEC.md` §8 の 1 文。

### D7 削除と凍結

今すぐ消す（`c5d0ef3` 比で約 4,700 行、`main` 比で約 2,500 行）:

| 対象 | 場所 |
| --- | --- |
| 既往 gate と registry | `repeat-trial-gate.ts`、`main.ts` の `trial` コマンド、接続 4 箇所 |
| runner の journal / owner / reconciliation / recovery / claims / input-pin / control | D3 の一覧 |
| 週次 smoke 専用の replay Verifier | `smoke-replay-recipe.ts`、`smoke-replay-verifier.ts`、`scripts/smoke-real-lab.mjs` |
| 二段構え時代の `assignment` mode | `src/cli/wordpress.ts:183-248` と OPERATIONS §2「入口の分担」 |
| 旧 arm の campaign 設定 24 本 | `examples/translatepress-*/`（`campaign-production-v1.json`、`host.example.json`、`wordfence-programme.example.json` は残す） |

凍結（足さない、Step 2 で消す）:

| 対象 | 場所 |
| --- | --- |
| 評価モジュール | `src/evaluation/`、`eval score / keys / rubric / compare / prospective`、DEVELOPMENT §7 の行を消す |
| 起動可能 prompt を 3 本に限定 | `prompts/index.ts` を「起動可能: v4、v3、whitebox-v1.7」と「照合専用 archive」に分ける |
| plugin 固有 Lab adapter 8 本 | `lab/*-adapter.ts` 等 |
| `review scope / dedupe / open / reproduced` | `src/review/index.ts` |
| campaign・provider をまたぐ resource claim（#228） | 第 2 provider が実際に動くまで |

### D8 緩める制約

| 制約 | 変更後 | 場所 |
| --- | --- | --- |
| `owner-approved` ラベルが無いと CI で落ちる範囲 | 不変条件（SPEC §2）、Programme Boundary の impact 分類、判定器の成功条件の変更だけ。prompt と policy の変更は出典対照表を PR に貼れば通す | DEVELOPMENT §5 / §6、`check.yml` の adr-guard |
| 探索に触る PR は開発セット 3 Trial | 異なる slug の初回 Trial 3 本で満たしてよい。同じ slug の反復で埋めない | DEVELOPMENT §5 |
| 同じ slug の追加 Trial の承認形式 | campaign 設定 1 行＋台帳 event（D2） | OPERATIONS §2 |
| quota 後は人間の `resume` | backoff 付き自動再試行（D4） | OPERATIONS §2 |
| Lab は既定設定のまま | 通常の有効化設定は Harness が入れる（D5） | SPEC §8a / §8b、ADR 0020 / 0026 追記 |
| 提出前に人間が手で再現 | Harness の再実行が緑なら読むだけ、`no-judge` だけ手で（D6） | SPEC §8 |
| Reflected XSS は半年後に見直し | 「提出候補が 4 週連続で週 1 件未満」を見直しの引き金にする | ADR 0032 Q2 の 1 行 |

緩めない: 攻撃者位置、`runtime-confirmed` の出し手、gVisor 必須、Harness は送信しない、台帳は digest のみ、PR 500 行以内、週の問い 1 つ。

### D9 モデル配分

| 用途 | モデル | 理由 |
| --- | --- | --- |
| 本番の探索（Root＋3） | Codex `gpt-6-sol`（Daybreak Blue、ChatGPT 購読） | 所有者の決定。費用が月額固定。拒否は一時的 |
| 本番の Verifier | Codex 同上 | 変えない。探索と検証の provider を揃えておくと拒否率の比較が単純になる |
| Opus arm（寝かせる） | Claude Opus 5.5、Claude Agent SDK、API key、broker 経由 | D1 の引き金が引かれたときだけ。従量課金なので月 USD 1,000 の収支に直結する点を前提に |
| 開発: 設計文書、反証、レビュー | 最上位の Claude（Mythos / Opus） | 判断の質が結果を決める工程 |
| 開発: branch の分割、大きな削除、rebase | Codex（所有者の既存環境）または Claude Code の Opus | 文脈量が多く、手順が決まっている |
| 開発: フィールド名の修正、文書の表、test の書き換え | Sonnet 級 | 機械的で安い |
| 人間レビューの skill 3 本 | 所有者の Claude Code セッションの既定モデル | ADR 0031 どおり |

### D10 週の問いと PR 列

| 週 | 問い | PR（各 500 行以内） |
| --- | --- | --- |
| 10-14〜10-21 | 最小 runner は実機で 1 batch を人手 0 で回るか。止まった理由は何か | P1 #222 umask 修正の merge。P2 #223 source 取得の merge。P3 provider 拒否の分類（D1、+103）＋ `ledger refusals`。P4 gate 抜きの在庫（D2 / D3a、在庫と enumerator の 2 本）。P5 最小 runner（D3b）。P6 quota 再試行と skip 規則（D4）。P7 削除（D7 の「今すぐ消す」）。P8 レビュー経路（D6）。P9 文言（D8、owner-approved 要） |
| 10-21〜10-28 | quota 1 週分を人手 0 で回り切るか。所有者のレビュー batch は何件を何分で判断できたか | 実機運転。P10 Lab の通常設定（D5、異なる slug の初回 3 Trial を貼る）。修正は止まった理由に対する小 PR のみ |
| 10-28〜11-04 | 最初の提出候補は最新版で成立し、重複でないか | reverify、dedupe、report の skill 運用。コード変更は最小 |
| 11-04〜11-14 | 初提出。転帰を待つ間に Step 2 の整理 1 本 | 凍結分の削除 PR 1 本（評価モジュール、archive prompt、adapter、review の 4 subcommand、#228 claim） |

P4〜P6 は `c5d0ef3` を割って作る。40 commit の履歴は作り直しになるが、残す code は `candidate-inventory.ts`、`continuous-batch.ts`、`continuous-child-assessment.ts` と enumerator の変更が中心で、合計約 1,900 行。

## 5. やらないこと

- 拒否を避けるための prompt の言い換え、無断の再 Trial。
- 旧世代 DB・アーカイブの全数監査と、その manifest・registry。
- 第 2 の journal、owner lease、host 共通 claim、crash 復旧の自動化（実機で 2 回止まるまで）。
- 硬い総 token 枠（契約上保証できないことは `2026-10-14-issue-229-hard-usage-cap-feasibility.md` のとおり）。
- 新しい prompt arm、新しい判定器、Patchstack 第 2 送信先、plugin 固有 adapter の追加。
- 文書の大整理（Step 2）。

## 6. 残るリスク

- D5 の汎用 setup が実際に何件の `incomplete(precondition)` を解消するかは未測定。効かなければ D5 は 1 PR の損で止める。
- D3 で crash 復旧を外すため、電源断などで Lab の Docker 資源が残り得る。runner 起動時の `lab cleanup` と手動確認で運用する。
- D4 の backoff は reset 時刻を知らない盲目待ち。quota の浪費は Trial 1 本分に収まる。
- 拒否が非決定論的なため、D1 の引き金（30%）は 10 Trial 未満では判定しない。
- 3 branch（227 / 228 / 229）が `main.ts` / `wordpress.ts` / `pipeline.ts` を同時に変えており、P4〜P6 の rebase は重い。P7 の削除を先に入れると衝突が減る。

## 7. 所有者に残る判断

この文書で決め切ったので、残るのは 2 つだけ。

1. この文書を「決定」として採用するか（採用なら P9 の文言 PR に `owner-approved` を付ける）。
2. D1 の Opus 引き金の数値（拒否率 30%、10 Trial）をこのままにするか。

それ以外は AI が進め、週の問いの数字で報告する。
