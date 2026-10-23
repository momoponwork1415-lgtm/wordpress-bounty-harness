# 検証 skill の handoff 受入: TranslatePress と Brizy（2026-10-24）

## 問い

#352 の開発セット 2 件で、現行 `wbh-verify/v8` の `verify next --handoff` から Harness 判定器の結論まで届くか。時間は Lab 準備完了から台帳記録までを測る。

## 結果

| 対象 | campaign / Finding | 判定器の結果 | 判定器 | Lab 準備完了から結果まで |
| --- | --- | --- | --- | ---: |
| TranslatePress 3.2.6 | `v8-codex-wp2shell-tp326-1018-r1` / `sha256:4e2b44e9…` | `runtime-confirmed` | `wordpress-administrator-principal` | 約 6 分 |
| Brizy 2.8.11 | `v8-src-xh-brizy2811-1018-r3` / `sha256:db4fdafc…` | `runtime-confirmed` | `wordpress-stored-script` | 5 分 49 秒 |

両方とも新しい handoff ディレクトリで 1 回目の実 Lab 試行が判定器の結論に達した。TranslatePress の verification ID は `41129e62-9676-4458-82a3-32d1ae897df0`、Brizy は `be4c1fe3-a6b9-4218-9789-3584aa1d7c5d`。判定記録はそれぞれ 2026-10-23 15:56:26 UTC、16:04:46 UTC。各開発用台帳の `verification-finished` で結果、judge ID、Snapshot digest を再読した。handoff 作成時の `review-export.json` は判定前の状態である。両 Lab とも `runsc` で実行し、後片付けを確認した。

## 前提と測定上の制限

- 開始前の古い開発用 campaign 設定には、現行 schema が受けない探索用キーがあった。Git 外の派生設定でそのキーだけを外した。これは Lab 起動前の失敗で、検証試行には数えない。
- 開発用 PHP source に 143 バイトの余分な NTFS metadata 形式のファイルが混入し、固定 digest と合わなかった。TranslatePress と Brizy の各 source copy から、そのファイルだけを Git 外へ退避し、元の固定 digest と完全一致することを確認してから Lab を起動した。Snapshot、対象ソース、判定器の条件は変えていない。
- TranslatePress の通常機能の前提は既存の開発セット Lab が供給した。Brizy は公開ページとフォームを Lab 内で作り、匿名の無害な送信が Leads に保存されることを確認した。作成には既存の Brizy API setup script を参照しており、管理画面の UI から同じ構成を作れることまでは確かめていない。Brizy の結果はこの固定 Lab 構成での実行時証拠であり、提出前の通常構成・人間の再現確認を代替しない。
- 所要時間は Lab の準備完了から判定器結果の台帳記録まで。設定の修復、ソースの照合、事前調査、Lab 供給時間は含めない。

攻撃の route、認証情報、payload、HTTP 本文、具体的な setup は Git 外の各 handoff の Private Evidence に残した。Wordfence への提出や重複・最新版の判断はこの計測に含めない。

## 判断

#352 の Brizy / TranslatePress における handoff → 判定器到達という受入数字は 2/2 件で満たした。旧 Issue 本文にある人間の `review reproduced`、通常構成の手動再現や提出判断はこの計測では行っていない。次の失敗対策は判定器を緩めることではなく、検証する Finding の通常前提と被害者側観測を用意することにある。Brizy の API による前提作成を #353 で削除する前に、skill が管理画面または再現可能な通常操作で同じ前提を作れるかを確認する。
