# wp2shell-bounty-v18-wide の本文と出典対照表（2026-10-28）

v18-wide の本文は v16-wide（[出典対照](2026-10-26-wp2shell-bounty-v16-wide.md)、[日本語訳](2026-10-26-wp2shell-bounty-v16-wide-japanese.md)）とバイト単位で同じである。fragment も digest も同じで、違うのは Harness が生成して付ける出力契約の版だけ（v16-wide は v5、v18-wide は v4）。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。本文に新しい文は無い。

## 問い

Issue #639。所有者が 2026-10-26 に指示した「置ける者がベンダーだけなら攻撃者ではない」の 1 文を、Finding を減らすことが分かっている契約 v5（ADR 0038 追記 15）から切り離して契約 v4 で測ると、ベンダーだけが書く配信を攻撃者入力とする Finding は減り、全体の Finding は v14-wide の水準を保つか。

## なぜ別の id にするか

v16-wide の行を契約 v4 に書き換えると、台帳の `configuration.promptVariant` が同じ `wp2shell-bounty-v16-wide` のまま、契約 v5 の 42 Trial と契約 v4 の新しい Trial が 1 つの分母に混ざる。ADR 0039 追記 12 で「文 1 が原因か、同時に変えた子の上限が原因か分けられない」となった失敗を繰り返さないために、契約だけが違う版に別の id を与える。

## 出典対照表

| # | 断片 | 文 | 出典 |
| --- | --- | --- | --- |
| 1 | `strategy/sinks-v16`（既存） | v16-wide と同じ。v14-wide の `sinks-v14` から替わっている 1 文は [v16-wide の出典対照](2026-10-26-wp2shell-bounty-v16-wide.md) の表 #1 | 所有者指示 2026-10-26（「置ける者がベンダーだけなら攻撃者ではない」、「外部サービスでもいいが、SNS など書き込めればいい」） |
| 2 | 登録 | `wp2shell-bounty-v18-wide` を `wide` の `candidate` にし、契約 v4 を受け取る行にする。`current` は v14-wide のまま。campaign 設定の `promptId` で名指ししたときだけ走る | ADR 0039 の 2026-10-26 追記 8（candidate の仕組み）、2026-10-28 追記 13。ADR 0038 の 2026-10-27 追記 15（新しい Trial の契約は v4） |

## 変えない要素

- v16-wide の本文、`sinks-v16`、digest、`archived`・契約 v5 の状態。
- v14-wide（`current`）、v15-wide（`candidate`）、`deep` の v11、`campaign.json`、`examples/campaign-wide-20.json`。
- Harness の code、出力契約 v4 の本文、出口の振り分け、Finding / Lead の schema。

## 測った数字（切り替え前）

2026-10-28 02:34〜04:21 JST の Codex v14-wide（契約 v4、同時 1 対象、子の上限 8、campaign `prod-20261027-14`〜`17`）:

| 項目 | 値 |
| --- | --- |
| Trial | 12 |
| Finding | 12（全部 stored-xss、7 グループ） |
| Finding が 1 件以上出た Trial | 6 / 12（7 はグループの数） |
| Lead | 27 |
| Finding のうち、ベンダーだけが書く配信を攻撃者入力とする前提のもの | 9 / 12（wp-carousel-free 2、insert-php 1、login-customizer 4、koko-analytics 2） |
| `wbh-screen` v2.2 の結果 | 提出不可 11、提出可 1（wp-ulike、Subscriber の表示名が BuddyPress 通知の属性へ） |
| Root の分（平均） | 6 |
| 子の数 / Trial（平均） | 5.7 |

## 測り方

ADR 0038 追記 15 の 20 Codex Trial（契約 v4 の v14-wide）を先に満たし、その後に runner の `promptId` を v18-wide に替えて 20 Codex Trial を回す。同じ選定帯、同じ子の上限 8、同じ契約 v4。台帳の `configuration.promptVariant` で分ける。比べる数字は次のとおり。

- Trial あたりの scope 内 Finding（M2）。completed が Trial 数の 5 分の 4 未満の窓は判定しない。
- Finding が 1 件以上出た Trial の割合。
- Finding のうち、`configurationPrecondition` がベンダーだけが書く内容を前提にする割合。下がることを期待する。
- Trial あたりの Lead。
- Root の分と読んだ file 数。
- 採用後の最初の 30 Trial で Finding が出た Trial が 0 なら戻す（DEVELOPMENT 第 5 節の段 5）。

## 測った数字（切り替え後、2026-10-28 15:13 JST）

v18-wide / 契約 v4 の 20 Codex Trial（`prod-20261028-4`〜`7`、5 並列、子の上限 8）と、直前の v14-wide / 契約 v4 の 21 Codex Trial（`prod-20261027-14`〜`17`、`prod-20261028-1`〜`3`）。

| 項目 | v14-wide / v4 | v18-wide / v4 |
| --- | --- | --- |
| Trial | 21 | 20 |
| Finding（群） | 16（9） | 4（2） |
| Finding が 1 件以上出た Trial | 7 / 21 | 2 / 20 |
| Finding / Trial | 0.76 | 0.20 |
| Lead / Trial | 3.0 | 4.5 |
| ベンダーだけが書く内容を前提にする Finding | 13 / 16 | 0 / 4 |
| ベンダー由来でない Finding | 3 | 2〜4 |

判定: 採らない。v18-wide は `archived` にし、本番は v14-wide / v4 に戻す（ADR 0039 の 2026-10-28 追記 14、#639）。

## 消し方

v18-wide の行と `wp2shell-bounty-v18-wide.md` を消す。Trial が走った後なら `archived` にして残す。採る版が決まったら、採る版を `current`、もう一方を `archived` にし、`candidate` の行を残さない。
