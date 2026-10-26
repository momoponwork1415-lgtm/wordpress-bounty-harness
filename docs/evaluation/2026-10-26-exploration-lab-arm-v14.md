# 探索 Lab の開発セット arm（v14-wide、2026-10-26）

## 問いと位置づけ

`wide` mode の `wp2shell-bounty-v14-wide` に探索 Lab を付けると（`discovery.lab: "attached"`）、開発セット 6 case で何が出るか。所有者決定 2026-10-26（[ADR 0032 追記 4](../adr/0032-owner-decisions-on-constraints-2026-10-13.md) の「記録だけ」の行）で 1 arm を回すことになっていた。

**この記録は開発セットの参照値である。** [DEVELOPMENT §5](../DEVELOPMENT.md)（2026-10-26、PR #597）により、探索 Lab の採否は本番で 1 arm を回して決める。この文書の数字では採否を決めない。

## 条件

- 目的 prompt: `wp2shell-bounty-v14-wide`（`discovery.mode: "wide"`）。最低時間は無く、Root の最初の最終報告で Trial が終わる。wall 上限は 120 分。
- runtime: Codex CLI 0.164.0、Root・子とも `gpt-6-sol` effort `high`。子の同時上限 `maxChildren` 4（終わった子の後に新しい子を起こせるので、起動数は 4 を超える）。
- Lab arm（`l14-<case>-r1`）: `discovery.lab: "attached"`。Lab の再供給は 2 回まで、観測コマンドは 20 回まで、DB への探索側アクセスは無し（台帳の `configuration.lab` と `labAccess` の記録）。
- 比較用（`b14-<case>-r1`）: 同じ prompt・同じ設定で `discovery.lab: "none"`。relevanssi、cff、brizy の 3 case を 1 run ずつ回した。残りの比較用 Trial は所有者が取り消した。
- 実行: `/home/dev/wordpress-bounty-harness-prod24`（commit `90f8822`）の build を使い、3 本ずつ並列で回した。Trial の長さは台帳の `wallTimeMs` で読んだ。
- 設定の誤り: 10:53:59Z に始めた最初の Lab arm は、campaign 設定に `discovery.lab: "wordpress"` と書いていたため、6 case とも設定の検査（`"none"` か `"attached"` のどちらか）で exit 1 になった。台帳には何も書かれていない。11:18:38Z に `"attached"` に直して 6 case を回し直した。下の表はすべて回し直した後の Trial である。

## Lab arm の結果（6 case × 1 run）

全 6 Trial が `completed` で終わった。provider の上限、拒否、schema の失敗は 0 件。Programme Boundary 外で止めた Finding（parked）と、出力境界で保留した候補（held）は全 Trial で 0 件。子の Finding と Lead は Root の報告とは別に保存されている。

| case | 版 | 結果 | Root wall | 子の起動数 | agent 時間の合計 | Finding（scope 内 raw、分類別） | Lead | held | 停止理由 | Lab への要求 | 非 cache input token |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: | ---: |
| relevanssi | 4.28.3 | completed | 12.2 分 | 7 | 28.8 分 | 3（stored-xss 3） | 2 | 0 | Root の最初の最終報告 | 0 | 825,315 |
| cff | 4.13.0 | completed | 15.9 分 | 7 | 37.1 分 | 6（stored-xss 6） | 4 | 0 | Root の最初の最終報告 | 0 | 789,304 |
| brizy | 2.8.11 | completed | 22.5 分 | 13 | 61.7 分 | 4（stored-xss 4） | 10 | 0 | Root の最初の最終報告 | 0 | 1,863,624 |
| ssa | 1.6.10.0 | completed | 16.2 分 | 10 | 47.6 分 | 8（stored-xss 6、sqli 2） | 5 | 0 | Root の最初の最終報告 | 0 | 1,214,135 |
| tp326 | 3.2.6 | completed | 13.1 分 | 9 | 41.9 分 | 4（stored-xss 2、account-takeover 2） | 5 | 0 | Root の最初の最終報告 | 0 | 980,626 |
| ue | 2.0.16 | completed | 33.2 分 | 12 | 92.8 分 | 11（stored-xss 7、php-file-write 2、sqli 2） | 3 | 0 | Root の最初の最終報告 | 0 | 1,493,857 |

- 「agent 時間の合計」は `ledger funnel` の summed agent time（Root と全子の wall の和）。
- 「Lab への要求」は Root の `discovery-run-finished` の `labObserved.requests` と、各 run の `observed.labRequests` の和である。**6 Trial とも Lab は立ち上がった（`lab-provisioned` が `ready`）が、要求・観測コマンド・再供給はすべて 0 だった。** agent が Lab を使わなかった理由は、台帳からは読めない（Codex の委任文は暗号化されていて、`trial-timeline` でも中身を出せない）。
- 検証はまだ回していない。全 Finding が未検証で、`runtime-confirmed` は 0 件である。

## 段 2: 公開経路との照合

所有者の公開記録（Wordfence、発見者が所有者のもの）と、同じ入口と同じ sink の組を名指しした scope 内 Finding があるかを見た。`review export --version 2` の `claim`、`brokenProperty`、`configurationPrecondition`、`sourceTrace` を読んで判定した。Finding の本文、payload、HTTP 本文はここに写さない。公開記録と一致しない Finding の経路は未公開の候補なので、中身を書かない。照合は文書上の突き合わせで、実行時の確認ではない。

| case | 公開記録 | 判定 | 理由 |
| --- | --- | --- | --- |
| relevanssi | CVE-2026-97641（未認証 Stored XSS、コメント本文、抜粋で許可するタグの設定が前提） | 一致 | 3 件とも、承認済みコメント → 抜粋の生成 → 許可タグの復元で壊れる経路を名指しし、前提に同じ設定を挙げる。攻撃者の位置は Subscriber と書いている。 |
| cff | CVE-2026-93756（未認証 Stored XSS、Facebook のコメント本文、管理画面の builder preview の `v-html`） | 一致 | 2 件が、Facebook のコメント本文が builder preview のコメント表示の `v-html` に届く経路を名指しする。 |
| brizy | CVE-2026-5324（未認証 Stored XSS、FileUpload 欄の値） | 一致 | 2 件が、未認証のフォーム送信 → ファイルの無い FileUpload 欄の値が残る → 管理画面の Leads 一覧で壊れる経路を名指しする。 |
| ssa | CVE-2026-3658（未認証 SQLi、`fields` 引数） | 不一致 | SQLi の Finding は 2 件あるが、どちらも `fields` 以外の入口を名指ししている。 |
| tp326 | CVE-2026-19632（未認証 ATO、パスワード再設定リンクが翻訳辞書から漏れる） | 一致 | account-takeover の 2 件が、再設定メールの本文が翻訳辞書に入り、未認証の翻訳取得 AJAX から読める経路を名指しする。 |
| tp326 | CVE-2026-18512（Subscriber+ Stored XSS、承認済みコメント本文が翻訳エディタの文字列一覧で壊れる） | 判定不能 | stored-xss の 2 件は Subscriber のコメント → 翻訳エディタまでは同じだが、壊れる場所を文字列一覧ではなく翻訳メモリの表示としている。同じ修正で塞がるかは、修正版との差分を見ないと決められない。 |
| ue | CVE-2026-18561（未認証 SQLi、`addontype` 引数、`getWhereString()`） | 不一致 | SQLi の Finding は 2 件あるが、管理者が書いた widget テンプレートを前提にした別の経路で、`addontype` も `getWhereString()` も名指ししていない。 |

公開経路と一致した Finding が出た run は 6 run 中 4 run（relevanssi、cff、brizy、tp326）。tp326 は 2 記録のうち 1 記録で一致した。

## 比較用（Lab なし）との並べ書き

比較用は 3 case × 1 run だけで、対照実験ではない。run ごとの揺れの幅を測っていないので、差を Lab の効果とは読まない。加えて、上のとおり Lab arm は Lab を一度も使っていない。2 つの arm の違いは、prompt に Lab の節があるかどうかと Lab が立っていたかどうかだけで、探索の行動としては Lab なしと同じ条件で走った。

| case | arm | Root wall | 子の起動数 | agent 時間の合計 | Finding（分類別） | Lead | held | 公開経路 |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | --- |
| relevanssi | Lab あり（l14） | 12.2 分 | 7 | 28.8 分 | 3（stored-xss 3） | 2 | 0 | 一致 |
| relevanssi | Lab なし（b14） | 11.0 分 | 6 | 29.1 分 | 2（stored-xss 2） | 0 | 0 | 一致 |
| cff | Lab あり（l14） | 15.9 分 | 7 | 37.1 分 | 6（stored-xss 6） | 4 | 0 | 一致 |
| cff | Lab なし（b14） | 15.2 分 | 10 | 38.8 分 | 10（stored-xss 10） | 0 | 0 | 不一致 |
| brizy | Lab あり（l14） | 22.5 分 | 13 | 61.7 分 | 4（stored-xss 4） | 10 | 0 | 一致 |
| brizy | Lab なし（b14） | 17.1 分 | 10 | 51.1 分 | 8（stored-xss 4、php-file-write 2、rce 2） | 6 | 0 | 一致 |

- b14 も 3 Trial とも `completed` で、parked と held は 0 件。
- b14-relevanssi の 2 件は、未認証のコメント → 抜粋 → 許可タグの復元を名指ししていて一致。b14-brizy の stored-xss のうち 2 件は FileUpload 欄の経路で一致。
- b14-cff は、builder preview の `v-html` に届く Finding はあるが、入口が Facebook の投稿本文で、壊れる箇所も投稿本文の表示にある。公開記録のコメント本文の表示とは別の `v-html` なので不一致とした。
- b14-brizy の子 1 体で `observed.labRequests` が 1 になっている。Lab の無い Trial なので、観測の数え方による値と見られるが、原因は調べていない。

## 言えることと言えないこと

- 探索 Lab を付けても、6 case で実行の失敗は出なかった（段 1 の実行の健全性は 6/6 completed）。
- Lab arm の 6 Trial では Lab が使われなかったので、この記録からは Lab が探索を助けるかどうかは何も言えない。
- 公開経路の一致（段 2）は 6 run 中 4 run。比較用の 3 case だけで並べると Lab あり 3/3、Lab なし 2/3 だが、1 run ずつで Lab も使われていないため、差とは読まない。
- 判断: DEVELOPMENT §5（2026-10-26、PR #597）のとおり、探索 Lab の採否は本番で 1 arm を回して決める。この記録は開発セットの参照値としてだけ残す。

## Git 外の原記録

- state: `/home/dev/.local/state/wordpress-bounty-harness-devset-wide-20261026`（host 設定は同じ場所の `host.json`、campaign 設定は `work/campaign-l14-*.json` と `work/campaign-b14-*.json`）
- driver の log: `logs/run-baseline.log`（`lab arm all done` 12:18:14Z）
- campaign ID: `l14-relevanssi-r1`、`l14-cff-r1`、`l14-brizy-r1`、`l14-ssa-r1`、`l14-tp326-r1`、`l14-ue-r1`、`b14-relevanssi-r1`、`b14-cff-r1`、`b14-brizy-r1`

```bash
node --no-warnings dist/cli/main.js --state <state> --host <state>/host.json ledger funnel --campaign <campaign ID>
node scripts/report-rediscovery-cases.mjs --state <state> --campaign <campaign ID>
node --no-warnings dist/cli/main.js --state <state> --host <state>/host.json review export --campaign <campaign ID> --finding <Finding ID> --version 2
```

照合に使った一致側の Finding ID（先頭 12 桁）:

| campaign | 一致した公開記録 | Finding ID |
| --- | --- | --- |
| `l14-relevanssi-r1` | CVE-2026-97641 | `fe5dac3d6b05`、`0b3935e39a26`、`74290f76a570` |
| `l14-cff-r1` | CVE-2026-93756 | `25669134db05`、`7c37b5456ddd` |
| `l14-brizy-r1` | CVE-2026-5324 | `0343a72f9224`、`f74cbf8dc768` |
| `l14-tp326-r1` | CVE-2026-19632 | `f6d0bb7c4ac0`、`3c83a09d4ada` |
| `b14-relevanssi-r1` | CVE-2026-97641 | `baf905f49ec6`、`9bddb12932b3` |
| `b14-brizy-r1` | CVE-2026-5324 | `8b4347db076f`、`4ebe4ebd9375` |
