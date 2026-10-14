# 最終設計（2026-10-14、決定版）

所有者の依頼「最終設計を出してほしい。自分では決め切れない」に答える。ここに書いた決定は、所有者が「この文書で進める」と言った時点で有効になり、以後は変えた行だけを更新する。不変条件（SPEC §2 の 8 項目）とモジュール境界は変えないので新しい ADR は要らない。SPEC §8 / §8b の文言、ADR 0020 / 0032 への追記、DEVELOPMENT §5 の変更だけが所有者の `owner-approved` を要する。

調べ方: [2026-10-14 のレビュー](2026-10-14-overbuild-and-gaps-review.md)（第 0〜10 節）、読み手 4 本（#229 branch の runner、provider 拒否と第 2 経路、Lab 前提、人間レビュー経路）、角度の違う提案 2 本（Step 1 最短、所有者時間最小）、規則と code の 2 lens による反証。対象は `main` d214de0 と branch `codex/issue-229-batch-pin` c5d0ef3、関連 branch 8 本。実機、provider、`pnpm check` は動かしていない。行数はすべて見積り。

所有者の確定事項（2026-10-14）: `cyber_policy` 拒否（#220）は一時的な問題。#215 の既往照合は「判別不能 slug の保留」までで、全 slug の保留ではない。方向性は正しいが、いらない機能と厳しすぎる制約がある。

## 0. 決めたこと（10 行）

1. `c5d0ef3`（#229）と #227 / #228 / #215 の branch は merge しない。参照用に残し、外側ループは `main` から約 200 行で新しく書く（D3）。
2. 探索 provider は Codex のまま。拒否は `provider-cyber-policy` として記録し、対象を飛ばす。Opus arm は数値の引き金付きで寝かせる（D1）。
3. 既往照合は旧 DB から 1 回だけ作る Git 外 JSON（started / ambiguous）とこの repo の台帳で行う。監査 manifest、registry、承認 JSON は作らない（D2）。
4. quota は人間を呼ばず、backoff 付きで再実行する。provider 失敗だけで終わった slug は 2 回まで再選定する。その他の失敗は対象を飛ばす（D4）。
5. Lab は「plugin の通常の有効化設定」を Harness 所有の型付き setup が入れてよい。管理者権限の付与と重大 option の変更は不可（D5）。
6. 人間レビューは skill 3 本と `review export` の整合を直し、判定器が確認した Finding の手動再現は `review reverify` の緑で代える（D6）。
7. 本番ループに乗っていないものは今は触らず、Step 1 完了後の整理 PR 1 本で消す。新規追加は今から止める（D7）。
8. `owner-approved` は不変条件・Programme Boundary・判定器の変更だけに絞り、探索 PR の 3 Trial は異なる slug の初回で満たす（D8）。
9. Codex の quota は本番 Trial だけに使う。開発 PR と skill は所有者の Claude Code（Opus）、設計と反証は最上位の Claude（D9）。
10. 10-24 までに「quota 1 週分を人手 0」、11-14 までに初提出。週の問いは 1 つ（D10）。

## 1. 変えないもの

- SPEC §2 の不変条件 8 項目。対象の実行は gVisor 内だけ、`runtime-confirmed` は判定器だけ、外向き通信は broker 経由の provider API だけ、Harness は送信しない、台帳は digest 参照だけ。
- 主経路: 対象ごとに Root＋最大 3 子の協調 Trial を 1 回、wall 上限 60 分（ADR 0029）。既定 prompt は Step 1 の 1 週間は `wp2shell-bounty-v3` のまま（分母を混ぜない）。
- 判定器の集合と成功条件。攻撃者位置は未認証と subscriber / customer のみ。
- 人間の判断点: 提出前レビュー、外部行動の承認、同じ slug の追加 Trial の承認（ADR 0032 Q6）。Step 1 は初回 Trial だけを回すので、追加 Trial の承認経路はまだ作らない。
- 判断の要る工程は skill、決定論の処理と自律ループは Harness（ADR 0031）。

## 2. 到達目標と期日

| 期日 | 到達点 | 測る数字 |
| --- | --- | --- |
| 10-17（金） | P1〜P4 が merge され、所有者が `continuous run` を 1 回起動する | 起動 1 回 |
| 10-17〜10-24 | Step 1 完了条件: quota 1 週分を人手 0 で回り切り、Programme Boundary 内の Finding が全件 `review export` に届く | 人手介入 0 回、開始した初回 Trial 数、completed、quota 待ちの回数と合計時間、停止理由の内訳 |
| 10-27 | 所有者が skill 3 本で最初のレビュー batch を完了 | batch の件数、`decide --minutes` の合計、accept / reject / defer の内訳 |
| 11-03 | Lab の通常設定（D5）が merge され、precondition の件数が前後で測れる | precondition 理由の件数の前後比、判定器が結論を出した件数 |
| 11-14 | 初提出 1 件（最新版で確認済み、重複なし、承認付き） | 提出 1、所有者の分数 |
| 12 月以降 | 月 USD 1,000 の測定開始 | 提出転帰と報奨額 |

## 3. 最終形の流れ

```
continuous run（約 200 行、main から新規）
  ループ:
    select --config selection.json          # WordPress.org pool から最大 5 対象。台帳と legacy JSON で既往を除く
    campaign run --all --campaign <id>       # Snapshot → Lab → 協調 Trial 1 回 → 検証と有界の自動再検証
    exit 0: 次の batch へ
    exit 3 (quota): 5 → 10 → 20 → 40 → 60 分の backoff で同じ campaign ID を再実行
    拒否 (provider-cyber-policy) が 3 batch 連続: 停止して status に理由を出す
    候補 0: 観測鮮度の期限（24 時間）まで眠って再試行
    stop marker / SIGTERM: 進行中の campaign を drain して停止
  状態は台帳と exit code から導く。pid file で単一インスタンス。
review export（scope 内 Finding 全件、判定結果に関係なく）
  → skill: wbh-review → wbh-dedupe → wbh-report（所有者の Claude Code）
  → 所有者: decide / authorize / 送信 / submitted / outcome
```

## 4. 決定の詳細

### D1 provider: Codex のまま、拒否は記録して飛ばす

- 決定: branch `codex/provider-policy-diagnostics`（4cc66b1、+103 行）をそのまま merge し、`cyber_policy` を `reasonDetail = provider-cyber-policy` として台帳に残す。runner は拒否された対象を飛ばし、異なる batch で 3 連続のときだけ止まる。拒否を避ける目的の prompt の言い換えはしない（#220 受入条件）。
- 集計: `ledger stops`（約 80 行、`discovery-run-finished.reasonDetail` と `target-skipped` の group by）を足し、週の拒否率を 1 コマンドで出す。分母は開始した初回 Trial、分子は `provider-cyber-policy` かつ開始 60 秒以内。
- Opus arm（`codex/opus-55-discovery`、+2,718 行）は PARKING のまま。再開条件を「Step 1 完了後」から「第 1〜4 週に開始した初回 Trial が 15 本以上あり、拒否率 30% 以上、または拒否による runner 停止が 2 回以上」に書き換える。再開するときは Claude 側の拒否分類（約 100 行）を先に入れ、2 provider を同じ物差しで比べてから arm を有効にする。拒否時の自動切替はしない（不変条件 2）。
- 理由: 所有者が「一時的」と判断した。#220 は同一対象で拒否 → 再試行で成功しており、拒否は決定論的でない。
- 変更箇所: `src/discovery/codex-native-agent-runtime.ts`（+37）、test（+64）、`src/cli/index.ts` と `src/ledger/index.ts`（集計）、`docs/PARKING.md` 1 行。

### D2 既往照合: 旧 DB の JSON 1 つと、この repo の台帳

- 決定: 「同じ対象」は slug で判定する（#215 の 10-14 追加条件）。この repo 側は `selection.json` の `revisitPolicy` を `never` にする（`ledger-exclusions.ts:11-16` に既にある値）。旧世代の履歴は、旧研究 DB を読み取り専用で 1 回走らせる使い捨て script（`scripts/export-legacy-slugs.mjs`、約 80 行）が作る Git 外 JSON `{schemaVersion, sourceDigest, started: [], ambiguous: []}` で照合する。`started` は `legacy-started` として除外、`ambiguous` は `legacy-ambiguous` として保留、どちらにも無い slug は初回として開始する。host 設定に `legacyHistory.file` を 1 行足し、選定レポートに JSON の digest を載せる。
- JSON が無いときは `select` を止めず、選定レポートに `legacyHistory: unavailable` を記録して進める。再探索の費用は quota だけで報奨は失わない。所有者が JSON を 10-16 までに作れば、第 1 週から照合が効く。
- 作らない: 4 source の全数監査 manifest、writer 停止時刻、失効 registry、`trial bootstrap / coverage-import / approve`、承認 JSON と trialOrdinal の結び付け（`repeat-trial-gate.ts` 841 行）。別 state ディレクトリによる抜け道は「本番 state は 1 つ」という運用規則で止める（#215 受入条件「機械的に防げない境界は運用で止める」）。
- 同じ slug の追加 Trial の承認（L2）は、所有者が実際に 2 回目を求めるまで作らない。Step 1 は初回 Trial だけを回す。
- 変更箇所: `src/profiles/wordpress/selection/ledger-exclusions.ts`（+70）、`src/cli/wordpress-host.ts`（+15）、`selection.json`（`revisitPolicy`、候補 pool の頁数）、`scripts/export-legacy-slugs.mjs`。

### D3 外側ループ: `main` から約 200 行

- 決定: `src/cli/continuous.ts` を新規に書き、`continuous run | stop | status` を足す。中身は第 3 節の流れだけ。状態は台帳と `campaign run` の exit code から導く。単一インスタンスは pid file、停止は stop marker file と SIGINT / SIGTERM。`status` は台帳から outcome と reasonDetail の件数を出す（約 60 行）。
- `c5d0ef3` 系（journal 525、owner 212、reconcile 446、stop 84、control 133、claims 564、scope 21、recovery 131、gate 841 の src 約 2,960 行と test 約 3,100 行、#227 の在庫 768 行、#228 の Lab 側変更）は merge も rebase もしない。branch は参照用に残す。
- 候補の補充は `select` の既存の仕組みで行う。`selection.json` の `popularPages` と `pagesPerTag` を 2 から 5 に上げ、`maxCandidates` を据え置く。在庫の cursor は持たない（毎回先頭から列挙し、台帳の既往で飛ばす）。
- 候補が尽きるときの規則: `select` の適格数が 3 日連続で 3 件未満なら、`minimumActiveInstallations` を 100,000 → 50,000 → 30,000 と 1 段ずつ下げる。数値の変更は選定方針の構造を変えないので ADR は要らず、`owner-approved` も要らない（DEVELOPMENT §2「数値は変えてよい」）。変えた日と値を選定レポートに残す。
- crash 後: 終了記録のない Trial と Lab の Docker 資源は、runner 起動時の `lab cleanup` と `status` の unsettled 件数で見る。自動復旧は実機で 2 回止まるまで作らない（LESSONS 8）。
- 理由: 3 branch が `main.ts` / `wordpress.ts` / `pipeline.ts` を同時に変えており、割って rebase するより `main` の `select` と `campaign run --all`（同じ ID で再開、quota は exit 3）を呼ぶ方が小さい。第 2 の journal は SPEC §4「単一の追記専用台帳」と二重になる。
- 変更箇所: `src/cli/continuous.ts`（新規約 200）、`src/cli/index.ts`（配線 +25）、`selection.json`、test（約 150）、OPERATIONS §2 の「複数 batch の継続運転」を差し替え。

### D4 quota とその他の停止理由

- 決定: `campaign run` が exit 3（provider の rate-limit / quota）で返ったら、runner は 5 → 10 → 20 → 40 → 60 分の backoff で同じ campaign ID を再実行する。人間は呼ばない。
- 再選定: Root 報告なし・Finding と Lead 0 件・`provider-limited` か `provider-cyber-policy` で終わった Trial しか持たない slug は、選定済みとして除外せず、slug ごとに 2 回まで再選定する。これは #215 の「追加の独立 Trial」ではなく「成立しなかった Trial のやり直し」として扱う（所有者の yes が要る）。
- その他の理由（Lab 失敗、run 失敗、版・Programme の変化、Snapshot 取得失敗）はその対象を `target-skipped` にして次へ進む。親を止めるのは stop、候補 0 が 24 時間続く、拒否 3 batch 連続の 3 つだけ。
- 変更箇所: `ledger-exclusions.ts`（D2 と同じ PR）、`continuous.ts`。
- 消し方: backoff 定数と上限は `continuous.ts` の先頭に置き、設定にはしない。

### D5 Lab: 通常の有効化設定を Harness が入れる

- 決定: SPEC §8b の `lab` 行「設定は既定のまま」を次に差し替える。「plugin の通常の有効化設定（管理者が普通に行う初期設定）は Harness 所有の setup が型付き手順で入れてよい。権限付与、`default_role` / `siteurl` / `admin_email` / `users_can_register` 等の options-update 対象の変更、危険設定は不可。実行前後の状態差分を Private Evidence に残す」。SPEC §8a の「Labは既定設定で供給し」と ADR 0020 に同趣旨の 1 文を補い、ADR 0026 には決定を変えない追記 1 段落。Verifier にブラウザと管理者セッションを渡さない線は変えない。
- 実装: `src/profiles/wordpress/lab/ordinary-activation-defaults.ts`（約 150 行、版と digest 固定の汎用 PHP 1 本）。管理者文脈で `admin_init` を 1 回発火、未保存の `register_setting` 既定値だけを `add_option`（既存値は上書きしない）、登録済み shortcode を載せた公開ページを 1 つ作る。実行後に重大 option と管理者ユーザー数が変わっていないことを検査し、失敗は provision 失敗として扱う。`scenarios.ts` に `ordinary-activation-defaults-v1`（pluginSlug は null）を 1 件足し、`installPlugins` 直後に呼ぶ。対象固有の関数名・クラス名・installer 名は使わず、WordPress 標準 API だけに頼る。範囲は (1) `admin_init`、(2) `register_setting` 既定値、(3) shortcode ページの 3 つに限り、ウィザードの操作は含めない。
- 探索 Lab と検証 Lab は同じ setup digest で立つので両方に入れる。したがって「探索に触る PR」として、runner が流す異なる slug の初回 3 Trial の数字を貼る（D8）。第 3 週の分母は第 1〜2 週と混ぜない。
- 既存の 8 adapter と既存 scenario は変更しない（digest が変わる）。新規追加も止める。
- 理由: 本番第 3 周の `incomplete(precondition)` は「管理者による対象固有の設定状態」で、既定設定のままでは埋まらない。Wordfence が却下するのは管理者の「誤設定」前提であり、通常の有効化設定ではない。対象ごとに adapter を書く作業は週 5 対象のループに追いつかない。
- 消し方: scenario 1 件と file 1 本を消し、SPEC の行を戻す。

### D6 人間レビュー経路

- 決定: skill 3 本の参照フィールド名を export に合わせる（`evidence.*` → `privateEvidence.*`、`stateDiff` → `labStateDiff`、約 10 行）。skill は提案だけを出し、`decide` は所有者が自分で打つ（不変条件 6）。`review export` に最新の人間再現結果、最新 draft の digest・revision・preparedBy・programme、decide の reasonCode と duplicate、scopeAssessment id を互換追加する（literal は `review-export/v1` のまま、約 70 行＋test 40 行）。OPERATIONS §3 の冒頭に skill の起動順と所有者が打つコマンドの表（約 20 行）。
- 手動再現（L7）: 判定器が `runtime-confirmed` を出した Finding は、`review reverify` が新しい Lab で緑なら所有者は証拠を読むだけでよい。`review reproduced --via-reverify`（約 60 行）でその事実を記録する。手で再現するのは `no-judge` の種別だけ。SPEC §8 の 1 文をこの形に書き換える。
- 重複照合: Harness 側はローカル Wordfence mirror のみ。`wbh-dedupe` の手順に「提出直前に `history status` を打ち、stale なら更新」を 1 行足す。#231（日次更新）は Step 1 では作らない。
- `incomplete` だけの batch でも、所有者が decide まで打てば Step 1 の「1 回の batch」とみなす。
- 変更箇所: `.claude/skills/*/SKILL.md`、`src/review/export.ts`、`src/review/index.ts`、`src/cli/index.ts`、`docs/OPERATIONS.md`、`docs/SPEC.md` §8 の 1 文。

### D7 削除と凍結

今から足さない（凍結）: 評価モジュール（`eval` 5 subcommand）、起動可能な探索 prompt（v3 と比較 arm 2 本以外）、plugin 固有 Lab adapter、`review scope / dedupe / open / reproduced`、週次 smoke 専用の replay Verifier、`assignment` mode、旧 arm の examples 24 本。PARKING に凍結の札を 3 行足す。

merge しない（branch は参照用に残す）: `codex/issue-229-batch-pin`、`codex/issue-227-inventory-slice`、`codex/issue-228-cross-campaign-claims`、`codex/repeat-trial-approval`、`codex/low-value-impact-gate`（566 行。review queue はほぼ空で `finding-parked` で足りる）。

Step 1 完了後に消す（第 4 週の整理 PR 1 本、削除行は 500 行の目安に数えない）: 上の凍結分のうち、評価モジュール、replay Verifier（1,226 行）、`assignment` mode、examples 24 本、`review` の 4 subcommand、起動不能にした prompt の load 経路。

理由: 第 1〜2 週は無人ループを回すことに集中し、削除の churn で実機の測定を乱さない。足さないことは今日から守る。

### D8 緩める制約

| 制約 | 変更後 | 場所 |
| --- | --- | --- |
| `owner-approved` ラベルが無いと CI で落ちる範囲 | 不変条件（SPEC §2）、Programme Boundary の impact 分類、判定器の成功条件の変更だけ。prompt と policy の変更は出典対照表を PR に貼れば通す | DEVELOPMENT §5 / §6、`check.yml` |
| 探索に触る PR は開発セット 3 Trial | 異なる slug の初回 Trial 3 本で満たしてよい。同じ slug の反復で埋めない | DEVELOPMENT §5 |
| quota 後は人間の `resume` | backoff 付き自動再実行（D4） | OPERATIONS §2 |
| 既往照合は全数監査が済むまで初回も保留 | JSON 1 つで照合、無ければ記録して進む（D2） | OPERATIONS §2 |
| Lab は既定設定のまま | 通常の有効化設定は Harness が入れる（D5） | SPEC §8a / §8b、ADR 0020 / 0026 追記 |
| 提出前に人間が手で再現 | 判定器確認済みは `reverify` の緑で代える、`no-judge` だけ手で（D6） | SPEC §8 |
| 再試行回数の正本 | 実装（ADR 0022 原文: recipe 2、observation 2、provision 1、precondition は scenario 変更時）に揃え、ADR 0032 の行を直す | ADR 0032 |
| Reflected XSS は半年後に見直し | 「提出候補が週 1 件未満の状態が 4 週続いたら」を引き金にする | ADR 0032 Q2 の 1 行 |

緩めない: 攻撃者位置、`runtime-confirmed` の出し手、gVisor 必須、Harness は送信しない、台帳は digest のみ、PR 500 行以内（削除行は除く）、週の問い 1 つ。

### D9 モデル配分

| 用途 | モデル | 理由 |
| --- | --- | --- |
| 本番の探索（Root＋3）と Verifier | Codex `gpt-6-sol`（Daybreak Blue、ChatGPT 購読、broker 経由） | 所有者の決定。拒否は一時的。Verifier は `codex-verifier.ts` のまま |
| Codex の quota | 本番 Trial だけに使う。開発作業には使わない | 週 quota が Step 1 の完了条件そのもの |
| Opus arm（寝かせる） | Claude Opus 5.5、Claude Agent SDK、API key、broker 経由 | D1 の引き金が引かれたときだけ。従量課金なので月 USD 1,000 の収支に直結する |
| 開発: 設計文書、反証、PR レビュー | 最上位の Claude（Mythos、無ければ Opus） | 判断の質が結果を決める工程。PR を書いたモデルと別のモデルがレビューする |
| 開発: P1〜P12 の実装 | 所有者の Claude Code（Opus 5.5） | PR 1 本につき agent 1 つ、500 行の予算を守る。既存 commit の移植（#221、#222）も同じ |
| 開発: フィールド名の修正、文書の表、test の書き換え | Sonnet 級 | 機械的で安い |
| 人間レビューの skill 3 本 | 所有者の Claude Code（Opus 5.5） | ADR 0031。本人のローカル token に限る購読条件にも合う |

### D10 週の問いと PR 列

| 週 | 問い | PR（各 500 行以内、削除行は除く） |
| --- | --- | --- |
| 10-14〜10-17 | 最小ループは quota と拒否をはさんでも人手 0 で回るか。止まった理由は何か | P1 #222 umask 修正（448129b をそのまま、162 行）。P2 #221 拒否の記録（103 行）＋ `ledger stops`（約 80 行）。P3 選定除外: legacy JSON、`revisitPolicy: never`、provider 失敗の再選定 2 回、候補頁 5（約 220 行）。P4 最小 runner `continuous run / stop / status`（約 400 行、test 込み） |
| 10-17〜10-24 | quota 1 週分を人手 0 で回り切るか | 実機運転。修正は止まった理由に対する小 PR のみ。P5 文書: DEVELOPMENT §5 の L5 / L6、OPERATIONS §2 / §3、ADR 0032 の再試行行、PARKING の引き金（約 40 行、owner-approved 要）。P6 既定 prompt v4 への切替（`codex/critical-high-discovery-focus` の 3 Trial 記録を貼り、第 1 週の分母には混ぜない） |
| 10-21〜10-27 | 所有者のレビュー batch は何件を何分で判断できたか | P7 skill 3 本の整合と OPERATIONS §3 の表（約 70 行）。P8 `review export` の互換追加（約 110 行）。所有者がレビュー batch を 1 回行い `decide --minutes` を記録 |
| 10-28〜11-03 | 通常の有効化 setup で precondition の Finding が何件判定器まで届くか | P9 SPEC §8a / §8b と ADR 0020 / 0026 の文言（約 20 行、owner-approved 要）。P10 scenario `ordinary-activation-defaults-v1`（約 330 行、異なる slug の初回 3 Trial を貼る）。#223 は第 2 週の Snapshot timeout が 3 件以上のときだけ 500 行以下に割って入れる |
| 11-04〜11-14 | 最初の提出候補 1 件を所有者の何分で送れるか | P11 `review reproduced --via-reverify`（約 140 行、SPEC §8 の 1 文）。P12 整理: 評価モジュール、replay Verifier、`assignment`、examples、`review` 4 subcommand、archive prompt の削除と PARKING 更新。初提出の authorize と送信は所有者 |

## 5. やらないこと

- 拒否を避けるための prompt の言い換え、無断の再 Trial、拒否時の provider 自動切替。
- `c5d0ef3` 系 branch の merge と rebase。旧世代 DB の全数監査、manifest、registry。
- 第 2 の journal、owner lease、host 共通 claim、crash 復旧の自動化（実機で 2 回止まるまで）。新しい台帳 event 型。
- 硬い総 token 枠（契約上保証できない。`2026-10-14-issue-229-hard-usage-cap-feasibility.md`）。
- Step 1 の 1 週間に既定 prompt を変える、新しい prompt arm、新しい判定器、Patchstack 第 2 送信先、plugin 固有 adapter、`low-value-impact-gate`。
- #231 の日次更新、L2 の承認経路、L9 の reflected XSS（引き金が引かれるまで）。
- Codex の quota を開発作業に使うこと。
- 文書の大整理（Step 2）。

## 6. 残るリスク

- 候補が尽きる: 下限 100,000 と `revisitPolicy: never` では適格な新規 slug が少ない可能性がある（Opus branch の調査では 100,000 で 1 件、30,000 で 3 件）。D3 の段階的な下限引き下げで対応する。
- 拒否が一時的でなかった場合、第 1 週の答えは「拒否で止まった」になる。D1 の引き金で第 4 週に判断する。
- 旧 DB の JSON が 10-16 までに揃わなければ、第 1 週は照合なしで回る（記録は残る）。
- pid file と stop marker は journal より保証が弱い。単一 host・単一運用者の前提を OPERATIONS に書く。
- `admin_init` の発火で plugin 固有の副作用（外向き HTTP の失敗、例外）が起き、provision が遅くなる・失敗する恐れがある。失敗は provision 失敗として記録され、判定には混ざらない。
- D5 が実際に何件の precondition を解消するかは未測定。効かなければ 1 PR の損で止める。
- 行数と所要時間はすべて見積りで、実測ではない。

## 7. 所有者に残る判断

この文書で決め切ったので、残るのは次の 4 つだけ。すべて yes / no で答えられる。

1. この文書を「決定」として採用する。
2. provider 失敗だけで終わった Trial の再選定（slug ごとに 2 回まで）を、#215 の「追加の独立 Trial」ではなく「成立しなかった Trial のやり直し」とみなす。
3. 旧 DB から legacy JSON を 1 回作る（`scripts/export-legacy-slugs.mjs` を旧環境で実行、10 分程度）。AI に実行を許可するか、所有者が自分で行う。
4. P5 / P9 / P11 の文言変更（DEVELOPMENT §5、SPEC §8 / §8a / §8b、ADR 0020 / 0026 / 0032）に `owner-approved` を付ける。

それ以外は AI が進め、週の問いの数字で報告する。
