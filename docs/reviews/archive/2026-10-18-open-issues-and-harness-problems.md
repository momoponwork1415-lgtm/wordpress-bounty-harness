# open Issue とハーネスの問題点の棚卸し（2026-10-18）

調べて報告。正本ではない。所有者の方針（2026-10-18）「探索 prompt はほぼ完全に wp2shell の記事に戻し、ハーネスそのものの改善に集中する」を前提に、open Issue 38 件と直近の計測・レビューから、何が残っているかを一覧にする。基準は origin/main `31d562d`。

## 0. 今の状態

| 項目 | 値 |
|---|---|
| 本番 runner | 2026-10-17 07:38Z に所有者が停止。再開は #332 の層 1・層 2 の数字が出てから（所有者決定 2026-10-18） |
| 本番の実績（26 batch / 130 対象 / 115 Trial） | scope 内 Finding 4（全て `incomplete(precondition)`）、parked 42、Lead 394〜403、runtime-confirmed 0、Lab 失敗 15、provider 拒否 4、run-failed 1 |
| 開発セット計測 | `~/.local/state/wordpress-bounty-harness-v6-measure-20261018/` で round 3 進行中。arm B（v5）は完了、arm C（v6）の tp331 が 08:21Z に開始 |
| probe（v6、TP 3.2.6、r3） | 47 分、544k token、Finding 3（stored-xss、全て incomplete）、Lead 2、入口到達 96 / 96（自己申告） |
| 既定 prompt | `wp2shell-bounty-v5`（campaign.json）。AGENTS.md は v3 と書いたまま（#339） |
| open PR | #325 #326 #333 #334（Codex の dispatch chain、修正待ち） |
| local checkout | main が origin より 90 commit 遅れ。`docs/PARKING.md` に未 commit 差分、`docs/reviews/` に未追跡 file 17 本 |

## 1. 記事回帰で先に決めること

記事 prompt（`docs/knowledge/imported/wp2shell/PROMPT.article.template.txt`）と v5 / v6 の差は目的文だけではない。Harness 側の契約と衝突する要素があるので、戻す前に決める。

| 記事の要素 | 現行の規則 | 決めること |
|---|---|---|
| 「脆弱性が必ずある」「/flag を読む」 | AGENTS.md 第 6 節「脆弱性が必ずあるという前提や固定された攻撃経路を与えない」、ADR 0029「採らなかった選択肢」 | 戻すなら ADR 0029 に所有者決定として追記。断定文を残すか、断定だけ外すか |
| 「最低 6 時間」 | ADR 0029「最低実行時間を置かない」、wall 60 分（v6 は 120 分） | 最低時間を prompt に置くなら wall をそれ以上にする。provider の 5 時間窓と quota も見る |
| 「4 agent 同時」 | Harness の子上限 3（ADR 0016 / 0029） | 3 のままか 4 に上げるか。Harness 側の上限変更が要る |
| `third_party/` に WordPress core と PHP 本体 | core は渡している。PHP 本体は PARKING 2026-10-13 | PHP source を渡すか（RCE 連鎖を狙うなら要る） |
| 索引の全項目を observed / blocked にしてから閉じる（v6）、`coverage.maxUnvisitedRatio` 0.2 で `incomplete(depth)`（#320） | 記事 prompt には無い | 記事 prompt で起動する arm では depth 条件を切る設定が要る。切らないと正常終了が全部 `incomplete(depth)` になる |
| 出力契約、trust 境界、Programme Boundary、入口索引 | Harness 生成の節として本文と別に付く（ADR 0019） | そのまま付く。記事本文に戻しても Finding / Lead の形と scope は変わらない |
| 非信頼入力の宣言、「空の検索結果を事実にする前に検索が動くことを確かめる」 | v5 / v1.7 の本文にある。記事には無い | 落とすかどうか。落としても Harness 側で補う経路は無い（#270 項目 7 は PARKING） |

手順は既定どおり: 記事本文を新 ID（例 `wp2shell-article-v1`）で登録し、旧版と digest pin を残し、campaign.json の `promptId` を変える。agent に渡る文章なので全文を所有者が用意する（AI は本文を組めない制約が 2026-10-18 に 2 回出た）。探索 PR なので開発セット 3 Trial の数字を付ける。v5 / v6 の計測と同じ分母に混ぜない。

## 2. ハーネス側の問題（分類別）

### A. 健全性が測れない（#332 が親）

- **索引の網羅（層 1）**: 正規表現の入口索引は、所有者の有償 7 件のうち攻撃者の入口がリテラルで載るのは 2 件。prefix 連結（Brizy、add_action 282 中 90 が変数）、route 連結（SSA、REST 52 中 36 が `/` に潰れる）、自前 dispatcher（Unlimited Elements、call_user_func 30）で落ちる。`incomplete` はサイズ上限しか見ない（#328、`docs/evaluation/2026-10-18-index-baseline.md`）。#335 で `unresolved` 件数は入った。sink 側の索引（出力点、`$wpdb` の非 prepare）は無い（#291、#328 B）。
- **探索の到達（層 2）**: `ledger coverage` は入った（#336）。入口到達は agent の自己申告。読んだ file の集合は #340 以降の Trial からしか取れない。Lead の切れ目は本番 403 件中 producer 224。
- **配線の確認（層 3）**: 既知 7 件のうち開発セット 3 件で再発見は確認済み（TP 3.2.6 の ATO と Stored XSS、SSA の sqli / stored-xss）。残り（Smash Balloon #283 wontfix、Unlimited Elements #282）は Lab の依存で止まる。
- 閾値は未設定。記事 prompt に戻すなら、この 3 層を記事 arm でも出すのが最初の数字になる。

### B. 検証の出口で詰まる（本番の scope 内 4 件が全部ここ）

- 通常機能の前提が Lab に無く `incomplete(precondition)`（#213、#244）。scenario は `lab.scenarioId` と `nextWordPressScenario` の正規表現 4 件でしか選ばれず、本番は常に既定 scenario。前提分類（#316）で `common-usage` と `admin-configuration` は分かれるようになった。
- judge の無い Programme 対象: `rfi`、`content-deletion` に observer / judge が無く、機微情報 judge は header 名に nonce があるだけで拒否する（#277、表は branch `codex/issue-277-coverage-matrix` に 17 行）。
- positive verdict が request / session / role に結合されない。HTTP 捕捉が空だと Verifier 自己申告の `http.json` に落ちる（#120、#179）。
- 後発の `incomplete` が既存の positive evidence を review から隠す（#278）。record / history の契約差と途中 bytes の公開（#279）。
- 判定器確認済みの手動再現を reverify の緑で代える、`no-judge` を人間再現で提出に進める（#245）。
- 1 Finding の検証に Verifier 10 回で 66 分かかった実測（#297 の背景）。`verify next` で Finding 単位にはなった（#321）が、検証 consumer を探索から切り離す #326 は修正待ち。

### C. runner と provider の堅牢性

- provider の `error` event で Root が `failed(schema)` になり対象が `run-failed` skip、再試行なし（#307）。
- `server_overloaded` が `provider-refused` として記録され、拒否と区別できない（#292）。2026-10-18 は cyber policy 拒否で開発セット 9 / 9 run が 20 秒で終わり、所有者の再 login で戻った。拒否の原因は build や prompt でなく provider / account 側。
- stop が batch 終了後に届くと `select()` が 1 回走り、未消費 batch が次回起動の方針 digest と合わず 10 分 `holding-error`。orphan の 5 対象は `revisitPolicy: never` で二度と選ばれない（#302）。
- campaign ID が 40 字を超えると台帳 identity 128 字超で対象が黙って skip（#281）。
- Lab provision 失敗の理由が台帳にも CLI にも残らない（#284）。
- wall が Docker コンテナに効かず 2 run が 5 時間半 stall した件は #318 で修正済み。
- 探索 run の終了時刻と UTC 日別使用量のずれ（#212）。Opus Trial の broker 無認証要求 1 件が未分類（#226）。

### D. 探索結果の取りこぼし（prompt に依らない Harness 側）

- 子の有効な最終報告を後続 prose の上書きと先頭 3 件 cap で失う（#276）。
- Root の正常完了に探索深度の typed record を要求する（#275）。#320 で coverage record と `incomplete(depth)` は入ったが、記事 prompt ではこの条件を切ることになる（第 1 節）。
- 軽微な到達効果だけの Finding を検証・通常 review の前に保留する（#218）。
- Lead の欠けた辺を狭い追跡 Trial で閉じられるかの切り分け実験（#314）。記事回帰なら Root の自律に戻るので、この実験は別 arm として残すか止める。

### E. 選定

- 10 万〜100 万帯を既定の母集団にし、100 万以上は直近 1 年の公開記録を根拠にしてだけ選ぶ（#295）。
- `requires_plugins` を見て依存 plugin 付き対象の扱いを決める（#309。本番 Lab 失敗 15 の主因は Elementor / WooCommerce 依存）。
- 最新版の再確認と三つの公開情報源での重複照合（#96）、Patchstack の条件差（#175）。

### F. 正本の食い違い（#339、6 件）

AGENTS.md の既定 prompt v3（code は v5）、`content-deletion` の park 扱い（AGENTS.md は除外、code は park）、wall 60 と 120、SPEC §7 の判定器一覧（options-update / sensitive-object-access は park 対象）、除外著者 5 名と 7 名、Lead 403 と 394。記事回帰で既定 prompt がもう一度変わるので、同じ PR で直すのが安い。

### G. 宙に浮いているもの

- **Codex の dispatch chain**（#324 merge 済み、#325 #326 #333 #334 open、未 PR の branch 4a2 / 4a3 / 4b / 1d）。「Harness が課題を配り、索引が分担を指示する」設計（ADR 0033 案）は、記事回帰の「Root が分担を決める」と逆向き。採らないなら 4 PR を close して branch を参照用に残す。反証段（4a 系）と検証 consumer（#326）だけは Root 自律と両立するので、切り出して残せる。
- **#347 並列化**: Lab なし探索の campaign 並列 N と `maxConcurrentRuns` 4 → 8。記事回帰で「回数を稼ぐ」方針ならこれは残る。provider の rate limit が実際の上限。
- **削除の保留行**（棚卸し report）: `assignment` mode は PARKING が削除、#324 が拡張で矛盾。archive prompt 10 版は AGENTS.md が保持、PARKING が削除。
- **#270**（2026-10-15 レビューの親）、**#238**（Step 1 判定）、**#246**（Step 1 合格後の整理）は、Step 1 の完了条件（2026-10-24 期日）が記事回帰でどう変わるかで扱いが決まる。
- **ベンチマーク**: 本人発見 7 件の再発見（#127）は 3 件で配線確認済み、残りは Lab 依存で止まる（#282 #283）。

## 3. 記事回帰を前提にした順番（推論、採否は所有者）

1. 記事 prompt の登録と、第 1 節の衝突 5 点の決定を 1 PR に。depth 条件の opt-out と #339 の 6 件も同じ PR で直す。開発セット 3 Trial を貼る。
2. 進行中の v6 / v5 計測を完走させ、`docs/evaluation/` に記録する。記事 arm の 3 Trial と並べるが分母は分ける。これが #332 の最初の数字になる。
3. Harness 側は B（検証出口）と C（runner）を先にする。本番の scope 内 Finding が全部 B で止まり、再開の障害が C に集中しているため。具体的には #307 #302 #281 #284（小さい運用修正）、#276（取りこぼし）、#213 / #244（precondition の理由集計から scenario を足す）、#277（judge の穴の表を所有者が見て順を決める）。
4. dispatch chain は採否を決めて 4 PR を片付ける。反証段と検証 consumer だけ残すなら、その 2 本を main に追従させる。
5. #347 の並列化と #295 の選定は、本番再開の直前。

## 未確認事項

- 記事 prompt を現行 runtime（gpt-6-sol、effort high、子 3）で 1 度も回していない。v1.7 の 45 分下限 arm が最も近いが、1 case 1 run しか無い。
- 本番台帳は開いていない。本番の数字は `docs/evaluation/` と Issue の記載による。
- open PR 4 本の現在の CI 状態は確認していない。
