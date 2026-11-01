# 探索の状態の設計案（2026-11-01）

> 調べて報告の成果物で、正本ではない。所有者の 2026-11-01 の指摘「探索途中の状態の持ち方を、大まかにではなくちゃんと設計する。時間も token も有限」に答える。採否は bench30 v3 の数字で決める（ADR 0045）。

## 1. いまの状態の持ち方と、その費用

| 範囲 | いま持っているもの | 問題 |
| --- | --- | --- |
| 子 1 体 | 自分のコンテキスト + Root の会話履歴の写し | 子は 1 片 3 分・18 ファイルで返り、履歴の写しが入力 token の 79%（Trial あたり約 2,500 万 token）。状態はファイルに書かれた分しか残らない |
| Trial | `/workspace/research/` の地図（recon-map.md）、REGISTRY.md、`<sink>.md`、hooks.tsv / sinks.tsv | 地図以外は自由形式の文章。REGISTRY の「残り行」は自己申告で、観測した被覆（hooks 0.71、sinks 0.38）と一致しない。閉じなかった経路は Lead として最終報告に出るだけで、次の子は拾わない |
| Trial をまたぐ | 台帳と Private Evidence（Finding、Lead、run の観測、research の archive） | 次の Trial には渡らない。同じ版を 3 回回しても毎回ゼロから地図を作る（例外は ADR 0044 の Lead 名指し） |

人手のホワイトボックス診断では、最初の数時間で表（入口、保存先の書き手と読み手、sanitizer、認可の行列、呼び出し関係）を作り、以後はその表を見ながら読む。いまの AI には表が無いので、読む速度は速くても、保存をまたぐ経路と認可の不一致で止まる（[v1 の記録分析](2026-11-01-bench30-v1-trial-records.md)、Lead の producer 欠落 42/56）。

## 2. 設計の原則

1. **判断の要らない表は道具が作り、判断の要る表は AI が作る**（LESSONS 4）。道具は Harness ではなく skill の付属として sandbox に置き、Root が 1 回走らせる（ADR 0043）。
2. **子は履歴ではなく表から始める**。子に渡すのは、自分の片に当たる表の行と、開いている経路だけにする。
3. **終了は表で数える**。「残り」は、作業列（queue）の未処理行数と、観測した読取ファイルから計算する。自己申告は使わない。
4. **Trial をまたいで同じ Snapshot の状態を再供給する**。Harness は前の Trial の research archive を `/workspace/prior/` に読み取り専用で置くだけで、中身を解釈しない（ADR 0044 と同じ「供給」であって舵取りではない）。
5. **Harness は観測だけ足す**。run ごとの読取ファイル一覧は既に取っている。それを Trial の終わりに表の形（coverage.tsv）で archive に残す。

## 3. 状態の構成（`/workspace/research/`）

| ファイル | 作る者 | 1 行 | 用途 |
| --- | --- | --- | --- |
| `entries.tsv` | 道具（hooks スクリプト）+ AI の訂正 | 入口 id、仕組み（hook / ajax / rest / shortcode / cron / 直接）、登録の file:line、handler の file:function、到達（anyone / low-role / high-role）、門（capability / nonce / login / owner の有無と位置）、読む parameter | 攻撃面の台帳。地図の「入口」表を機械可読にしたもの |
| `stores.tsv` | 道具（新規スクリプト）+ AI の訂正 | 保存先（option / post-meta / user-meta / transient / db-table / file）、key、書き手の file:function と門、読み手の file:function と描画の文脈 | 保存をまたぐ経路（格納型、second-order）を結ぶ表。producer 欠落を 1 回の参照で埋める |
| `sinks.tsv` | 道具（既存）+ AI が文脈列を足す | 種別、file:line、文脈（html-body / html-attr / js / url / sql / path / unserialize） | 既存。文脈列は sanitizer の照合に使う |
| `sanitizers.tsv` | AI | plugin 独自の escape / validate 関数、包んでいる本体関数、保証する文脈 | sink の文脈と突き合わせて「エスケープはあるが文脈が違う」を機械的に候補化 |
| `authz.tsv` | AI（entries から） | 特権操作（書く・消す・権限を変える・ログインさせる）× 入口 × 門 | 似た handler の不一致（片方だけ門が無い）を一覧で見る。C 型の見逃し（開いたが何も残さなかった 6 件）に当てる |
| `calls.tsv` | 道具（psalm か、PHP 字句解析の呼び出し索引） | caller の file:function → callee | wrapper と動的 dispatch を越えて追う。grep の一覧が写さない経路の補い |
| `routes.jsonl` | AI（子が書き、Root が併合） | 経路 id、入口 id、段の列（file:function:line）、sink、状態（open / closed / blocked）、欠けた辺、担当した子、更新時刻 | Lead と Finding の前段。open の経路は次の子の作業になる。重複は入口 id + sink で束ねる |
| `queue.tsv` | Root（skill の手順） | 作業 id、種類（入口の片 / open な経路 / 表の訂正）、対象の行、状態（todo / taken / done）、担当 | REGISTRY の置き換え。子は 1 行取って返す。残りは行数で数える |
| `coverage.tsv` | Harness（観測） | file、読んだ run の数、最初に読んだ時刻 | Trial 終了時に Harness が受領書の読取一覧から書く。自己申告と突き合わせる材料 |

`<sink>.md` と recon-map.md は残す（人間が読む用）。表が正で、文章は注釈。

## 4. 子の起動と終了

- 子に渡すのは、queue の 1 行と、その行が指す entries / stores / sinks / authz の行、open な routes、calls の該当部分、sanitizers 全体。Root の会話履歴は渡さない（Codex の設定で切れるかは確認が要る。切れなければ履歴は残るが、表があれば短い履歴で済む）。
- 子は routes.jsonl に書き足し、queue の自分の行を done にして返す。返り値は 30 行以内のまま。
- Root は queue の todo が 0 で、open な routes の担当が付いていない状態になったら閉じる。wall に当たったら、queue と routes をそのまま残して閉じる（再開区間はそこから続く）。
- 「Lead」は open のまま終わった routes を契約の形に写したもの。「Finding」は closed の routes。写すのは Root の最終報告時で、判断は変えない。

## 5. Trial をまたぐ再供給

- Harness は Trial 終了時に `/workspace/research/` 全体を Private Evidence に archive している（既存）。新しい Trial の Snapshot digest が同じなら、最新の archive を `/workspace/prior/` に読み取り専用で置く。中身は解釈しない。
- skill は「`/workspace/prior/` があれば entries / stores / calls / sanitizers をコピーして訂正から始め、queue は open な routes と未読の入口から作り直す」と書く。地図づくりを省けるので、2 回目以降は読む時間が経路の追跡に回る。
- 版が上がった再訪では、prior の表と新しいソースの差分（変わった file）だけを queue の先頭に置く。#724 の diff-watch はこの形で表に乗る。
- bench30 v3 の 2・3 回目は「同じ版の続き」として回せる。pass@3 の意味が「3 回の独立試行」から「3 区間の累積」に変わるので、基準線（独立 3 回）とは別の腕として測る。

## 6. 境界との整合

- Harness が足すのは、archive の再供給（供給）と coverage.tsv（観測）だけ。表の中身、queue の順、子の分担は skill と Root が決める（AGENTS.md「Harness は制御だけ」）。
- 道具は判断を含まない列挙（hooks / sinks / stores / calls）。psalm を使う場合も、結果を表として渡すだけで、候補の採否には使わない。
- 不変条件 1: prior に入るのは自分の前の Trial の research だけで、公開記録や答えは入らない。
- 確定は人間の Lab 観測のまま（不変条件 3）。
- プロンプト本文は増やさない。表と queue の扱いは skill に書く（owner-approved ラベル）。目的文からは、REGISTRY の行数を数えさせる段落と sink 種類の固定分担の段落を削る候補になる（削除のみ）。

## 7. 測り方（bench30 v3、同じ 30 本）

| 腕 | 変える点 | 見る数字 |
| --- | --- | --- |
| 基準線 | なし（v19-wide、lab none） | any-hit / 主答 pass@3、record recall、Lead だけ、修正腕の偽陽性、Codex 時間、Trial あたり token |
| 表 1（道具） | stores.tsv + calls.tsv を skill の付属に足す | 同上。特に producer 欠落の Lead の減り、record recall |
| 表 2（skill） | entries / authz / sanitizers / routes / queue を skill の手順にする | 同上。特に C 型の record recall、観測被覆と「残り」の一致 |
| 持ち越し | 同じ版の 2・3 区間に prior を供給 | 累積 recall、区間あたり token |
| Lab | `lab: attached` | Lead → Finding の転換、Trial 時間 |

採否の線は、同じ Codex 時間で record recall か any-hit が 10 ポイント以上上がり、修正腕の偽陽性と Finding/Trial が下がらないこと。1 腕ずつ、1 つ前の採った腕の上に積む。

## 8. 作る順と大きさ

1. `stores.tsv` と `calls.tsv` のスクリプト（skill の付属、判断なし）。1 PR。
2. skill 本文の改版（表と queue の手順、prior の読み方）。owner-approved ラベル。1 PR。
3. Harness: Trial 終了時の coverage.tsv と、同じ Snapshot の prior 供給。制御だけ。1 PR。
4. 目的文の削除候補 2 段落は、2 の数字を見てから。

消し方: 1・2 は skill の版を戻す。3 は PR を revert する（archive と prior は Private Evidence に残る）。
