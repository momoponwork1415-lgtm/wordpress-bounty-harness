# 探索の現状（2026-11-01、SQLi と格納型 XSS を軸に）

> 調べて報告の成果物で、正本ではない。所有者の「まず現状がどうなっているか」に答える。数字は bench30 v1（48 Trial）、本番 prod-v19（20 Trial）、台帳から。Finding / Lead の本文は書かない。

## 1. 1 Trial の構成（本番の設定）

```
対象 1 件（install 順、1 版 1 回）
  │ Snapshot: plugin + WP 7.1.3 + PHP + 依存 plugin を digest で固定
  ▼
gVisor sandbox（ネット無し、provider API は broker 経由）
  入力: 固定ソース（読み取り専用）/ trust 境界 / Programme Boundary /
        目的文 wp2shell-bounty-v19-wide（1,162 語）/ Run parameters（子 ≤8、wall 120 分）/
        skill wbh-recon-v1・wbh-tools-v1 / 出力契約 v4（Finding・Lead の JSON）
  道具: rg, grep, sed, awk, php-cli, python3, jq（+ semgrep / psalm は未使用）
  Lab: none（動かして確かめる手段は無い）
  ▼
Root（Codex gpt-6-sol, effort high）
  0〜2 分  地図: recon-map.md（形、サブシステム、入口、門、保存先、JS 境界）
           列挙: hooks.tsv（add_action 等の grep）、sinks.tsv（echo / $wpdb / include / unserialize / update_option 等）
  2 分〜   sink の種類ごとに子を 1 体: html / sql / files / identity
           子は 1 片（中央値 3 分、18 ファイル）で返る。返った子に追依頼はしない
           返った種類の次の束を新しい子へ（sql_2, files_3, html_5 …）。1 Trial で 4〜17 体
  12〜21 分 REGISTRY「残り 0」で最終報告（wide は最初の最終報告で終了）
  ▼
Harness の出口: 全件保存 → 契約で正規化 → Programme 外 10 種は park → 台帳 + Private Evidence
  Finding → 検証列（段 1 screen → 1b source-check → 2 群 → 3 Lab で人間が観測 → 4 重複 → 5 提出先 → 6 報告書）
  Lead    → 検証列に入らず、review leads で人間が見るだけ
```

状態の持ち方: 子は Root の会話履歴の写しから始まる（入力 token の 79%、Trial あたり約 2,500 万 token、キャッシュ 95%）。Trial 内の共有は `/workspace/research/` のファイル。Trial をまたぐ持ち越しは無い（ADR 0044 の Lead 名指しだけ）。

## 2. 数字

| 項目 | bench v1（48 Trial、10k+ の 30 件） | 本番 prod-v19（20 Trial） |
| --- | ---: | ---: |
| Finding（実体の群） | 65（22 群） | 0 |
| Lead | 284 | 56 |
| case / 対象あたりの hit | 9/30（A 3、B 5、C 1） | - |
| wall | 中央値 12.1 分、最大 30.3 分 | 10〜21 分 |
| 子の Finding : Lead | html 23:48、files 8:39、sql 2:24、identity 1:30 | - |
| Lead の欠けた辺 | producer 28/47（答えのファイルを名指す Lead） | producer 42 / consumer 6 / reachability 4 / auth-use 2 / precondition 2 |
| 自己申告「残り 0」 vs 観測被覆 | hooks 0.71、sinks 0.38 | - |
| 答えのファイルを誰かが開いた | 48/48 | - |

過去の本番全体（v14〜v18）の本物の脆弱性は 0.05〜0.07 件/Trial。Lab で成立した 20 件の内訳は A 1 / B 11 / C 8（[noticing-vs-reasoning](2026-11-01-noticing-vs-reasoning.md)）。

## 3. 格納型 XSS（B 型）はいまどう追っているか

経路の形: 低権限者が置ける値 → 保存（option / meta / 独自テーブル / コメント・表示名など本体の保存）→ 別の画面やテンプレートで描画。

| 段 | いまの動き | 止まる点 |
| --- | --- | --- |
| 描画箇所を見つける | html の子が sinks.tsv の output 行とテンプレートを読む | 出来ている（B は 3 型で最も当たる、5/10） |
| 値の保存先を特定する | 地図の「保存先」節と、その場の読み | 保存先の key までは辿れることが多い |
| 書き手と門を特定する | 子がその場で grep して戻る | **ここで Lead（producer）になる**。書き手が別サブシステム、wrapper 越し、本体の保存（コメント・プロフィール）だと戻らない |
| 文脈と sanitizer の照合 | 子が個別に判断 | 「エスケープはあるが文脈が違う」は当たるが、独自 sanitizer の保証は毎回読み直し |
| 確かめる | 無し（Lab none） | 読んだ推測のまま Finding か Lead |

## 4. SQLi（A 型）はいまどう追っているか

経路の形: 要求の parameter（配列のキー、orderby / order、IN リスト、日付、検索語、identifier）→ plugin の query builder や helper → `$wpdb`。多くは `prepare` 済みで、残るのは「prepare の外に連結される部分」。

| 段 | いまの動き | 止まる点 |
| --- | --- | --- |
| `$wpdb` の呼び出しを列挙 | sinks.tsv の query 行 | 自前の DB クラス（`$this->db->get()`）は写らない |
| 連結されている引数を見つける | sql の子が呼び出し箇所を読む | 出来る（prepare の有無は読める） |
| その引数が要求から来るかを遡る | 子が呼び出し元を grep で戻る | **wrapper 越しに 2〜3 段戻ると片の外**。sql の子は Finding 2 : Lead 24 |
| 入口と門を結ぶ | 地図の入口表 | 入口側から追う（forward）子がいないので、sink 側から遡る途中で切れる |
| 確かめる | 無し | 同上 |

## 5. 構造的な要因（所見）

1. **方向が片側**: 子は sink から遡るだけ。SQLi と認可は入口から追う方が閉じやすい。
2. **表が無い**: 保存先の書き手 / 読み手、認可の行列、呼び出し索引、sanitizer の棚卸しが無く、子が毎回その場で読む。
3. **片が短く戻らない**: 1 片 3 分・18 ファイルで、閉じなかった経路を次の子が拾わない。Root は向け直ししない（目的文の指示）。
4. **終了が自己申告**: REGISTRY の残り行は観測被覆と一致せず、12 分で閉じる。
5. **確かめる手段が無い**: Lab none。読んで閉じなければ Lead。
6. **持ち越しが無い**: 同じ版を再び回しても地図から作り直す。

## 6. 変えられる場所と、変えられない場所

| 変えられる | 変えない（ADR 0045） |
| --- | --- |
| skill 本文と付属スクリプト、設定値（子の数、wall、mode、lab の有無）、目的文の削除、Harness の観測と供給 | 確定は人間の Lab 観測、Harness は制御のみ、台帳追記専用、判断の分母は Lab 発火 / Codex 時間、設計変更は月 1 回 |

関連: [探索の状態の設計案](2026-11-01-exploration-state-design.md)、[v1 の記録分析](2026-11-01-bench30-v1-trial-records.md)、[流れの整理](2026-10-31-pipeline-overview.md)。
