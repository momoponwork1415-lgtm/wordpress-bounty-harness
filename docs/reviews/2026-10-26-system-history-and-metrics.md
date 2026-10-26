# システムの変遷と、世代ごとに測れた数字・測れなかった数字（2026-10-26）

調べて報告の成果物で、正本ではない（正本は [SPEC](../SPEC.md) と [ADR](../adr/)）。所有者の問い（2026-10-26）は「これまでのシステムの変遷が知りたい。実験は積み重なっているが、私の知見にしかなっていなくて、測定可能な数値になっていない気がする」。

この文書では、世代ごとに何を変えたのかと、そのとき台帳や記録に残った数字を並べる。数字が残っていないところは「記録なし」と書く。数字にはすべて出典（ファイルの path か台帳への問い合わせ）を付けた。件別の報酬額、Finding の本文、経路、payload は書かない。対象は slug・版・分類だけで示す。リポジトリの文書は origin/main `32e7489` の時点、台帳は 2026-10-26 08:43Z 時点の読み取り専用の読み出しである。

## 1. 要旨

- 報酬が出たのは 2026-03（harness 以前、859 USD）、07-25〜08-11（2,854 USD）、08-30〜09-01（371 USD）の 3 期間で、どれもこのリポジトリより前である（有償 18 件、4,076 USD）。09-02 以降は、どの世代でも提出の記録が無い。
- このリポジトリでは、探索の形を 4 回大きく変えた。短い管理 prompt と索引（〜10-17）、v8 deep（60〜120 分、10-18〜25）、判定器の削除（10-25）、wide（10-25〜、v13-wide と v14-wide）の順である。
- 台帳から数えられるのは、Trial 数、結末、wall、Finding・parked・Lead の数、判定器時代の確認数である。開発セット 6 case の「1 件以上の scope 内 Finding」は、v13-wide で 4/6、v14-wide で 6/6 だった。
- 台帳に一度も記録されていない数字がある。提出・報酬・人間による確認（判定器を消した後）の event はどれも 0 件である。公開記録との経路一致は、台帳の外で手作業で照合している。同じ prompt を同じ対象で繰り返した揺れの幅は、ほとんど測っていない（各 case 3 run を回したのは v5 の 3 case だけ）。
- 世代の比較を数字にするには、新しい仕組みは要らない。開発セットの OK 率から報酬までの 6 指標を、毎回同じ問い合わせで出せば足りる（第 4 節）。提出と報酬の 2 つは、記録する event はすでにあり、使われていないだけである。

## 2. 変遷の表

行は世代か、大きな prompt の系統である。「測れた数字」の出典の略号は第 5 節にある。開発セットの 6 case は次のとおり（[docs/agents/measurement.md](../agents/measurement.md) の開発セットのうち、所有者が発見者のもの）。brizy 2.8.11、relevanssi 4.28.3、simply-schedule-appointments 1.6.10.0（ssa）、translatepress-multilingual 3.2.6（tp326）、custom-facebook-feed 4.13.0（cff）、unlimited-elements-for-elementor 2.0.16（ue）。

### 2.1 このリポジトリより前（4 世代）

| 世代・期間 | 探索の形 | 検証の形 | 主な設計決定 | 測れた数字 | 測れなかったもの |
| --- | --- | --- | --- | --- | --- |
| harness 以前（2026-03） | 記録なし | 人間 | — | 提出 8、有償 6（却下 1、対象外 2）、859 USD [S1] | 探索の手順と試行数 |
| 07 Satoki 系 thin harness（2026-07） | Claude と運用規則。選定は手動 | 手動 | 探索と検証の分離、Trial の凍結を提案（risk audit） [K1] | 数字は無い。設計監査 1 本だけ | 試行数、候補数、時間 |
| 08 whitebox 前期（07-25〜08-11） | source-only の coordinator contract（非公開。最も近い公開版は whitebox `382c139`）。Root と子、研究 file、飽和で停止 | V0〜V3 の skill、使い捨ての Docker Lab、人間の再現 | 出力側の gate で絞る（commit `cddce91`） | 提出 9、有償 9、2,854 USD [S1]。報酬が出た Lab は 2.1 時間、5 時間を超えた Lab は全部成果なし。100 行の prompt は Lab あたり Lead 1.1、65 行は 12.4 [L1] | Trial・対象の総数（分母）。repo に残っていない |
| 08 whitebox `bounded-wp2shell/v1.7`（08-30〜09-01） | v1.7（12,116 B、45 分の下限） | 同上 | — | 提出 3、有償 3、371 USD [S1] | 同上 |
| 08 wp-bounty-workspace / verification（08-11〜08-20） | GLM と Codex の比較、選定 Gate 1〜6 | V0〜V3 | barbell（選定と検証を厚く、探索は触らない）、却下理由 R1〜R10 | GLM の source-only 先行検知は 7 件中 3 件と部分 1 件。提出 47 件の分析では認可系 20 件が報酬の 1% 未満。Snapshot 483、選定 110、提出 1。再現済み 30 件と候補 12 件が放置。Lead の 58% が scope 外 [K1][L1] | 検証の転換率 |
| 09 wordpress-harness v1〜v9（09-01〜10-08） | agent 主導の Root と子 3、checkpoint からの自動継続、条件付き 3 試行、受理時の allowlist | Root が recipe を書き、gVisor で 1 回再生 | ADR 144 本（初日 108 本、3 日目に 92 本削除）。prompt は 13.7 KB → 6.9 KB → 7.4 KB | 既知の陽性 4 件すべてで候補を回収、ATO 1 件を確認。Opus 5 は r2 が 35 分・79 USD・候補 8、r3 が 24 分・54.6 USD・候補 12。DeepSeek と v7 で TranslatePress 3.2.5 の既知 8 件のうち 4 件（3 試行の和集合）。未知の提出 0 [K1][L1] | 未知の発見率（0 件なので率を出せない）、試行ごとの揺れ |

### 2.2 このリポジトリ（2026-10-05〜）

| 世代・期間 | 探索の形 | 検証の形 | 主な設計決定 | 測れた数字 | 測れなかったもの |
| --- | --- | --- | --- | --- | --- |
| 初期の比較（10-08〜10-11）。short-objective v1/v2、managed v1〜v5、screening-v1、wp2shell-bounty v1/v2 | Codex。Root と子 3、Lab あり。対象は TranslatePress が中心 | Verifier agent と判定器（自動） | ADR 0013、0016、0017、0025 を経て ADR 0029（10-11、単一協調 Trial に戻す） | 台帳 [P]。managed-v4 は 8 Trial で Finding 33（確認 6）、managed-v5 は 3 Trial で Finding 11（確認 5）、v2 は 3 Trial で Finding 8（確認 1）。3 対象の pilot は Finding 2、確認 0 [R1] | 対象が 1〜2 種に偏り、他の対象には一般化できない |
| v3 本番 4 周（10-12〜10-13） | Codex、Root と子 3、wall 60 分、入口索引あり、Lab あり | 自動 Verifier と判定器 | ADR 0030〜0032（選定で公開履歴を採点しない、skill の境界、所有者の制約） | 21 Trial（completed 19）、Finding 36（other 13、sensitive-object-access 14、options-update 6、csrf-to-write 3）、確認 0、Lead 47 [P]。周ごとの raw Finding は第 1 周 2、第 3 周 8 [E1] | 当時の scope 内の件数（park の規則が後から入ったので、今の基準では大半が対象外） |
| v4（10-13〜10-16） | v1.7 を骨格に組み直したもの（#189）。索引あり | 同上 | — | Codex 14 Trial（Finding 2、確認 2）[D2]、Opus 57 Trial（Finding 0、Lead 239）[D3]。配線計測の 7 run で確認 5 [E2] | Codex と Opus を同じ対象で比べた記録 |
| v5 本番（10-16〜10-17） | Codex、Root と子 3、索引あり、wall 60 分、下限なし、Lab あり | 自動 Verifier と判定器 | PR #293 で既定に。10-17 に 5 種を出口で park（ADR 0032） | 117 Trial（completed 111）、Root wall 中央値 6.8 分、Finding 4、parked 42、Lead 403、確認 0 [P]。開発セットでは sink 型の stored-xss が候補になったのは v5 だけ（relevanssi 2/3 run、tp326 2/3 run）[E3] | 本番の Finding 4 件が本物かどうか（全件 incomplete(precondition) のまま reject） |
| v6 / v7（10-17〜10-18、開発のみ） | v7 は WP2Shell 記事に寄せた本文。Root と子 4、wall 120 分、索引なし | 同上 | ADR 0034（索引と coverage の削除） | v7 の 3 Trial で、tp326 は Finding 5（ATO 4 件確認）、relevanssi は 0、brizy は 1 [E4] | v6 の数字。provider の拒否で 9/9 run が 20 秒以内に終わった [E5] |
| v8 deep 本番（10-18〜10-25） | Codex `gpt-6-sol` と Claude `opus-5-5`。Root と子 4（Claude の子は使い捨てで 1 Trial に 18〜25 体）、最低 60 分・上限 120 分、Lab なし、依存 source を固定 | 10-21 までは自動の verifier-v8。以後は handoff（wbh-verify skill、Opus の操作者）と判定器 | ADR 0033、0035〜0038 | 本番 244 Trial（completed 158）、Root wall 中央値 60.7 分、Finding 148（うち 66 件は 10-26 に子の報告を回収して追記）、parked 15、Lead 1,628、検証を受けた Finding 78、一度でも確認 16 [P] | Codex と Claude の探索の質の差。Claude の Finding は 10-20 まで handoff に届いていなかった [M3] |
| 判定器の削除（10-25 決定、10-26 merge） | — | 確定は人間が Lab で観測する（`review observe`、`review decide --reproduced`） | ADR 0040（#541） | 判定器時代の確認は、台帳全体で 32 Finding（33 event）、本番 campaign では 18 Finding [P]。削除後の検証は 0 件 | 人間による確認。event はあるが 0 件 |
| wide の導入（10-25）。v10-wide（本番）と v11-wide（開発） | Codex、Root と子 4、wall 20 分、最低時間なし | 検証なし | ADR 0039（deep と wide の 2 mode） | v10-wide は本番 24 Trial（completed 24）、Root wall 中央値 6.3 分、Finding 0、Lead 17 [P]。v11-wide は開発セット 6 case のうち 5 case で Finding が 1 件以上、合計 22（tp331 を含む。provider-limited の再開区間を含む）[D4] | v11-wide の公開経路一致 |
| v10 / v11 deep（10-25〜26） | 本文は main にあり、v11 が現行の deep | — | ADR 0039 の追記 | どの台帳にも run が無い | すべて |
| v13-wide（10-26） | Codex、wall 120 分、子の上限を設定値に（#537）、Lab なし | 検証なし | #537、#538 | 本番 5 Trial、Finding 0、Lead 6 [P]。開発セット 6 case で Finding 9、OK 4/6、公開経路一致 4 [D5] | 揺れ。各 case 1 run |
| v14-wide（10-26、現行の wide） | v13-wide の sinks と fixed の 2 fragment だけを差し替え | 検証なし | #556 | 開発セット 6 case で Finding 36、OK 6/6、公開経路一致 5 [D6] | 揺れ、検証、本番での数字（本番の 3 Trial は集計時点で実行中） |

v12-wide は本文が main にあるが、どの台帳にも run が無い。

所有者の判断（2026-10-26、v13-wide と v14-wide の比較を見て）は「プロンプトの差もありそうだが、確率的な揺れもありそう。とりあえずしばらくはこのプロンプトで行こう」である。各 case 1 run なので、差が揺れの範囲に入るかどうかは今の数字では決められない。

## 3. 数字の一覧

### 3.1 台帳の prompt 版ごとの集計

本番台帳 `~/.local/state/wordpress-bounty-harness/ledger.sqlite` を読み取り専用で集計した。Root run は `discovery-run-started` の `runKind = explore`（初期の short-objective-v1 には runKind が無いので、agentRole も runKind も無い run を Root とした）。子の run も `configuration.promptVariant` を持つので、Finding・parked・Lead は run の版で数えた。Finding は `findingId` で重複を除いた。確認は `verification-finished` の `result.status = runtime-confirmed` が一度でもある Finding、review は Finding ごとの最新の `review-decided` である。

v5 以降は `campaign_id LIKE 'prod-%'` に限った数字である。それより前の版は、同じ台帳にある開発用の campaign（`dev`、`tp326`、`issue*` など）を含む。

| 版 | 期間 | Trial（Root run） | 結末 completed / provider-limited / failed | Root wall 中央値 | Finding | parked | Lead | 検証を受けた Finding | 確認（一度でも） | review の最新判断 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| short-objective-v1 | 10-09 | 39 | 20 / 0 / 19 | 1.7 分 | 0 | 0 | 0 | 0 | 0 | — |
| short-objective-managed-v3 | 10-10 | 2 | 1 / 0 / 1 | 3.2 分 | 3 | 0 | 1 | 3 | 0 | — |
| short-objective-managed-v4 | 10-10 | 8 | 7 / 0 / 1 | 4.6 分 | 33 | 0 | 7 | 33 | 6 | — |
| short-objective-managed-v5 | 10-10 | 3 | 3 / 0 / 0 | 4.0 分 | 11 | 0 | 0 | 11 | 5 | — |
| wp2shell-bounty-v1 | 10-10 | 1 | 1 / 0 / 0 | 5.3 分 | 1 | 0 | 1 | 0 | 0 | — |
| wp2shell-bounty-v2 | 10-10 | 3 | 1 / 0 / 2 | 37.9 分 | 8 | 0 | 5 | 5 | 1 | — |
| screening-v1 | 10-11 | 48 | 45 / 0 / 3 | 2.6 分 | 2 | 0 | 13 | 2 | 0 | — |
| wp2shell-bounty-v3 | 10-12〜13 | 21 | 19 / 0 / 2 | 13.3 分 | 36 | 2 | 47 | 36 | 0 | reject 36 |
| wp2shell-bounty-v5 | 10-16〜17 | 117 | 111 / 0 / 4 | 6.8 分 | 4 | 42 | 403 | 4 | 0 | reject 4 |
| wp2shell-bounty-v8 | 10-18〜25 | 244（319） | 158 / 119 / 36 | 60.7 分 | 148 | 15 | 1,628 | 78 | 16 | accept 1、reject 14、defer 11 |
| wp2shell-bounty-v10-wide | 10-25 | 24（32） | 24 / 8 / 0 | 6.3 分 | 0 | 0 | 17 | 0 | 0 | — |
| wp2shell-bounty-v13-wide | 10-26 | 5 | 5 / 0 / 0 | 9.7 分 | 0 | 0 | 6 | 0 | 0 | — |
| wp2shell-bounty-v14-wide | 10-26 | 3 | 集計時点で実行中（`rerun-v14-*`、prod 外） | — | 0 | 0 | 0 | 0 | 0 | — |

読み方の注意:

- 「結末」は Root run（再開区間を含む）の数で、Trial の数ではない。v8 は 244 Trial に 319 の Root run がある。provider-limited の run は、正常な候補 0 件に数えない（ADR 0033）。
- v8 の Finding 148 件のうち 66 件は、10-26 の #539 で子の報告を回収して後から追記したものである（stored-xss 65、lfi 1。最初の `child-report-recovered` は sequence 14204 で、それより後の `finding-recorded` を数えた）。追記前の数字で書かれた文書（10-20 の報告の Finding 42 など）とは合わない。
- v3 以前の Finding には、今の Programme Boundary では park される分類（other、sensitive-object-access、options-update、csrf-to-write など）が含まれる。park の規則が入ったのは 10-16〜17 なので、v5 より前と後の Finding 数は比べられない。
- run の版が分からない本番 Finding が 4 件ある（ATO 2、stored-xss 2、うち確認 2）。最新版の再検証など、別の経路で作った派生 Finding とみられる。
- ADR 0040 は「既存の `runtime-confirmed` 26 件」と書いている。上の 32 Finding（33 event）は台帳全体、18 は本番 campaign で数えた値で、ADR とは数えた時点と範囲が違う。

台帳にある v4 は、別の state にある。

| 版・state | 期間 | Trial | 結末 completed / failed | Root wall 中央値 | Finding | Lead | 確認 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| v4、`~/.local/state/wordpress-bounty-harness-codex-24h-20261014` | 10-14 | 14 | 12 / 0（2 件は終了 event なし） | 9.0 分 | 2（stored-xss） | 10 | 2 |
| v4、`~/.local/state/wordpress-bounty-harness-opus-20261014/state` | 10-14〜16 | 57 | 42 / 12 | 16.6 分 | 0 | 239 | 0 |

### 3.2 v8 本番の runtime 別

本番 campaign に限った値。Trial は `trialId` で数えた。再開区間で runtime の表記が変わる Trial は両方の行に入るので、合計（252）は 244 より多い。

| runtime | Trial | Root run の結末 completed / provider-limited / failed | Finding（うち回収で追記） | 確認 | Lead |
| --- | ---: | --- | ---: | ---: | ---: |
| Codex（runtime の記録なし、runtimeShare の導入前） | 46 | 27 / 16 / 5 | 24（5） | 5 | 91 |
| Codex（`codex-native/v1`） | 120 | 81 / 68 / 16 | 82（61） | 4 | 762 |
| Claude（`claude-code/v1`） | 86 | 50 / 35 / 15 | 42（0） | 7 | 775 |

Codex の Finding は、回収の前は 40 件、回収の後は 106 件で、数字が 2.6 倍に変わった。Claude の子の形（使い捨てで、1 Trial に 18〜25 体）と Codex の子の形（常駐で 4 体、1 体あたり 55 分）の違いは [E6] にある。Claude の Root が読んだ file 数は観測できていない（[E6] 第 4 節）。

### 3.3 開発セット 6 case の推移

「1 件以上」は、その版の Programme Boundary で scope 内の Finding が 1 件以上出た case の数である（所有者の OK 基準、2026-10-26）。v5 より前の Finding は当時の境界で数えている（3.1 節の注意を参照）。「—」は実行していない。

| 版・日付 | brizy | relevanssi | ssa | tp326 | cff | ue | 1 件以上 | 公開経路一致 | 出典 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v2（10-12） | 8 | 6 | 12 | — | Lab 前提が不成立 | 固定 source が無い | 3/3（実行できた case のみ） | brizy 一致（後日確認） | [E7] |
| v4 索引あり（10-16） | 1 | 0（初回は provider 拒否） | 4 | 2 | — | — | 3/4 | 記録なし | [E2] |
| v5（10-16、各 3 run） | 3/3 run が同系統 | 2/3 run が同系統 | — | 2/3 run が同系統 | — | — | 3/3 | 「同系統」は AI が照合したもの | [E3] |
| v7（10-18） | 1 | 0 | — | 5 | — | — | 2/3 | 記録なし | [E4] |
| v8（10-18〜19） | 1 | 1（Root は schema error） | 6 | 6 | — | 0 | 4/5 | brizy の r2 だけ照合 | [E8] |
| v11-wide（10-25、再開区間を含む） | 2 | 2 | 2 | 8 | 0 | 2 | 5/6 | 記録なし | [D4] |
| v13-wide（10-26、各 1 run） | 1 | 2 | 4 | 2 | 0 | 0 | 4/6 | 4 | [D5] |
| v14-wide（10-26、各 1 run） | 8 | 2 | 6 | 4 | 8 | 8 | 6/6 | 5（cff が増え、ssa の sqli が消えた） | [D6] |

wall も版ごとに違う。v4 は 60 分、v8 は最低 60 分・上限 120 分、v13-wide と v14-wide は 120 分（v11-wide の開発セットは wall が台帳に残っておらず、Root wall の実測は 2〜9 分）（Root wall の実測は v13 で 13〜21 分、v14 で 12〜34 分）。model と effort も v8 で `high` と `xhigh` が混ざっている [E8]。行ごとに複数の変数が動いているので、prompt の差だけを読み取ることはできない。

### 3.4 報酬の推移

所有者の Wordfence ダッシュボード（2026-10-13 に貼付）の期間ごとの合計。件別の金額は Git に置かない [S1]。

| 期間 | 使っていたもの | 提出 | 有償 | USD |
| --- | --- | ---: | ---: | ---: |
| 2026-03-03〜03-21 | harness 以前 | 8 | 6 | 859 |
| 2026-07-25〜08-11 | bug-bountgy-harness → whitebox 前期 | 9 | 9 | 2,854 |
| 2026-08-30〜09-01 | whitebox `bounded-wp2shell/v1.7` | 3 | 3 | 371 |
| 2026-09-02〜10-13 | wordpress-harness、wp-bounty-verification、このリポジトリ | 0 | 0 | 0 |
| 2026-10-13〜10-26 | このリポジトリ | 記録なし（台帳の `submission-recorded` は 0 件） | 記録なし | 記録なし |

分類ごとの有償 18 件は、Stored XSS 5 件で 1,083 USD、SQLi 4 件で 1,301 USD、ATO 1 件で 975 USD、Reflected XSS 7 件で 667 USD、価格操作 1 件で 50 USD である [S1]。Reflected XSS は今の Programme Boundary の外にある。

### 3.5 台帳に一度も記録されていないもの

本番台帳の event 種別を `SELECT event_type, COUNT(*) FROM ledger_events GROUP BY 1` で数えると、次の種別はスキーマにあるのに 0 件だった（スキーマは `src/ledger/index.ts`）。

| event | 書くコマンド | 意味 | 件数 |
| --- | --- | --- | ---: |
| `manual-observation-recorded` | `review observe` | 人間が Lab で観測した match / mismatch | 0 |
| `human-reproduction-recorded` | `review decide --reproduced` | 人間の再現 | 0 |
| `external-action-authorized` | `review authorize` | 送信の承認 | 0 |
| `submission-recorded` | `review submitted` | 提出した | 0 |
| `submission-outcome` | `review outcome --reward` | 結果と報酬額 | 0 |

`manual-observation-lab-ready`（観測用の Lab が立った）は 1 件ある。`human-effort-recorded` は 72 件で、すべて `read`、合計 26 分である。review の最新判断は 66 Finding で、accept 1、reject 54、defer 11 だった（10-22 には 54 件を一度に reject した記録がある）。

このほか、次の数字は記録の形そのものが無い。

- **未知の発見率。** 提出も報酬も台帳に無いので、Finding から報酬までの転換率は出せない。
- **公開記録との経路一致。** 台帳の `publicRecordMatch` はすべて `unassessed` である。v13-wide と v14-wide の一致数（4 と 5）は、台帳の外で照合した結果である。
- **同じ条件での揺れ。** 同じ版・同じ対象・同じ設定で 3 run 以上回した記録は、v5（3 case × 3 run）だけである。v13-wide と v14-wide の差が揺れかどうかは、今の数字では決められない。
- **費用。** `costUsd` は全 run で `unavailable` である。代わりに token と wall で見るしかない。
- **所有者の時間。** Step 1 の完了条件にある「レビュー batch の所要時間」は、`read` の 26 分しか記録されていない。

## 4. 測定可能にするための最小の指標

実験のたびに、次の 6 つを同じ問い合わせで出す。新しい探索の仕組みは足さない。Harness がすでに記録している event だけを読む。不足があるところは、足りない event や field の名前だけを書く。

どの問い合わせも、次の 1 行で読み取り専用で実行できる（`query.sql` に SQL を置く）。

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare(require("fs").readFileSync(process.argv[2],"utf8")).all())' <state>/ledger.sqlite query.sql
```

分母は、版（`configuration.promptVariant`）、mode、runtime ごとに分ける。provider-limited と failed は候補 0 件に混ぜない（SPEC 第 6 節）。

### M1 開発セットの OK 率（6 case）

scope 内 Finding が 1 件以上出た case の数を 6 で割る。campaign の接頭辞は実験ごとに変える。再試行（`-r2` など）は別の行に出るので、初回だけで数えるか、和集合で数えるかを先に決めて書く。

```sql
SELECT c.campaign_id,
       COUNT(DISTINCT json_extract(f.event_json, '$.findingId')) AS findings
FROM (SELECT DISTINCT campaign_id FROM ledger_events
      WHERE campaign_id LIKE 'dsw14-%') AS c
LEFT JOIN ledger_events AS f
  ON f.campaign_id = c.campaign_id AND f.event_type = 'finding-recorded'
GROUP BY c.campaign_id;
```

- 今の台帳で出せる。`~/.local/state/wordpress-bounty-harness-devset-wide-v14-20261026` では 6 行すべてが 1 以上だった。
- 公開経路一致は台帳に無い。今は報告に手で書いている。台帳で数えるには、`finding-recorded` に対する人間の照合結果を記録する event（たとえば公開記録の参照と match / mismatch）が要る。
- 揺れを見るには、同じ版で各 case 3 run を回す。DEVELOPMENT 第 5 節の「最低 3 Trial」と同じ数である。

### M2 Trial あたりの scope 内 Finding と、incomplete の率

```sql
WITH runs AS (
  SELECT campaign_id,
         json_extract(event_json, '$.runId') AS run_id,
         json_extract(event_json, '$.trialId') AS trial_id,
         json_extract(event_json, '$.runKind') AS kind,
         json_extract(event_json, '$.configuration.promptVariant') AS variant
  FROM ledger_events WHERE event_type = 'discovery-run-started'),
fin AS (
  SELECT json_extract(event_json, '$.runId') AS run_id,
         json_extract(event_json, '$.outcome') AS outcome
  FROM ledger_events WHERE event_type = 'discovery-run-finished'),
fnd AS (
  SELECT json_extract(event_json, '$.findingId') AS finding_id,
         MIN(json_extract(event_json, '$.runId')) AS run_id
  FROM ledger_events WHERE event_type = 'finding-recorded' GROUP BY 1)
SELECT r.variant,
       COUNT(DISTINCT CASE WHEN r.kind = 'explore' THEN r.trial_id END) AS trials,
       COUNT(DISTINCT CASE WHEN r.kind = 'explore' AND fin.outcome = 'completed'
                           THEN r.trial_id END) AS completed_trials,
       COUNT(DISTINCT fnd.finding_id) AS findings
FROM runs AS r
LEFT JOIN fin USING (run_id)
LEFT JOIN fnd USING (run_id)
WHERE r.campaign_id LIKE 'prod-%'
GROUP BY r.variant;
```

- 今の台帳で出せる。本番では v5 が 117 Trial で 4、v8 が 244 Trial で 148、v10-wide が 24 Trial で 0、v13-wide が 5 Trial で 0 だった。
- runtime 別に分けるときは、`runs` に `json_extract(event_json, '$.configuration.runtime')` を足す。mode 別は `$.configuration.mode`（10-25 より前の event には無い）。
- 後から追記した Finding（#539 の回収）を区別するには、`child-report-recovered` の最小 sequence より後の `finding-recorded` を別に数える。

### M3 通常利用の前提の割合（common-usage）

```sql
SELECT json_extract(event_json, '$.preconditionClass') AS precondition_class,
       COUNT(DISTINCT json_extract(event_json, '$.findingId')) AS findings
FROM ledger_events
WHERE event_type = 'finding-recorded' AND campaign_id LIKE 'prod-%'
  AND json_extract(event_json, '$.occurredAt') >= '2026-10-18T16:00:00Z'
GROUP BY 1;
```

- 今の台帳で出せる。v8 以降の本番では common-usage 88、unknown 60、記録なし 4 だった。
- 記録時の分類である。後から `finding-precondition-classified`（30 件）で付け直した分は、その event の最新値で置き換えて数える。

### M4 Finding 10 件あたりの確認数

ADR 0040 の後は、確認は人間の観測と再現だけである。判定器時代の値（`runtime-confirmed`）は、別の列として残す。

```sql
SELECT event_type,
       CASE event_type WHEN 'verification-finished'
            THEN json_extract(event_json, '$.result.status')
            ELSE json_extract(event_json, '$.result') END AS result,
       COUNT(DISTINCT json_extract(event_json, '$.findingId')) AS findings
FROM ledger_events
WHERE event_type IN ('manual-observation-recorded', 'human-reproduction-recorded')
   OR (event_type = 'verification-finished'
       AND json_extract(event_json, '$.result.status') = 'runtime-confirmed')
GROUP BY 1, 2;
```

- event はあるが、人間の側は 0 件である。今の値は、判定器時代の `runtime-confirmed` 32 Finding だけになる。v8 本番では 148 Finding のうち 16、検証を受けた 78 のうち 16 だった。
- 分母は「検証列に入った Finding」と「全 Finding」の 2 つを並べる。検証しなかった Finding を不成立に数えない。
- 足りないのは仕組みではなく記録である。所有者が Lab で確かめたときに `review observe` を 1 回打てば数字になる。

### M5 提出数

```sql
SELECT event_type,
       json_extract(event_json, '$.outcome') AS outcome,
       COUNT(*) AS events,
       SUM(COALESCE(json_extract(event_json, '$.rewardUsd'), 0)) AS reward_usd
FROM ledger_events
WHERE event_type IN ('review-decided', 'external-action-authorized',
                     'submission-recorded', 'submission-outcome')
GROUP BY 1, 2;
```

- event はあるが、提出は 0 件である（`review-decided` 115 件だけが出る）。
- `review submitted` は Submission Candidate（`review scope` → `review draft` → `review authorize`）を前提にする。wbh-submit の対話で提出したものを数えるには、最後に `review submitted` を打つ必要がある。打たなければ、提出は所有者のダッシュボードにしか残らない。

### M6 報酬

M5 と同じ問い合わせの `submission-outcome` の行と `reward_usd` で出す。`ledger funnel --since <ISO>` の `outcomes` 行と `reward $` にも同じ値が出る（`src/cli/index.ts` の `formatFunnel`）。

- event はあるが 0 件である。報酬は今、所有者のダッシュボードにしかない（3.4 節）。
- `review outcome --candidate <id> --outcome resolved --reward <usd>` で記録すれば、世代と報酬を台帳の上で結べる。09-02 以降の空白を、Harness の数字として示せるようになる。

### 6 指標の対応

| 指標 | 今の台帳で出るか | 足りないもの |
| --- | --- | --- |
| M1 開発セットの OK 率 | 出る | 公開経路一致の記録（新しい event か field）、各 case 3 run |
| M2 Trial あたりの Finding | 出る | なし。runtime と mode で分母を分けるだけ |
| M3 common-usage の割合 | 出る | なし（付け直しの event を反映する） |
| M4 確認数 / Finding 10 件 | 判定器時代の分だけ出る | `review observe` と `--reproduced` を打つ運用 |
| M5 提出数 | event はあるが 0 件 | `review submitted` を打つ運用 |
| M6 報酬 | event はあるが 0 件 | `review outcome --reward` を打つ運用 |

M1〜M3 は探索の比較、M4〜M6 は報酬までの道のりの比較に使う。どの実験報告にも 6 つを同じ順で貼れば、「手応え」で決めた採否を後から数字で読み直せる。

## 5. 出典

リポジトリの文書（origin/main `32e7489`）:

- [L1] [docs/LESSONS.md](../LESSONS.md)、[docs/reviews/2026-10-13-past-repos-lessons.md](2026-10-13-past-repos-lessons.md)
- [K1] [docs/knowledge/README.md](../knowledge/README.md)、[docs/knowledge/experiments.md](../knowledge/experiments.md)
- [S1] [docs/reviews/2026-10-13-prompt-source-comparison.md](2026-10-13-prompt-source-comparison.md) 第 6 節（所有者の Wordfence 履歴の期間・分類ごとの合計）
- [R1] [docs/reviews/2026-10-11-harness-completeness-review.md](2026-10-11-harness-completeness-review.md) 第 2 節
- [E1] [docs/evaluation/2026-10-12-production-v3-cycle-01.md](../evaluation/2026-10-12-production-v3-cycle-01.md)、[…-cycle-03.md](../evaluation/2026-10-12-production-v3-cycle-03.md)
- [E2] [docs/evaluation/2026-10-16-wiring-gate-measurement.md](../evaluation/2026-10-16-wiring-gate-measurement.md)
- [E3] [docs/evaluation/2026-10-16-prompt-v5-comparison.md](../evaluation/2026-10-16-prompt-v5-comparison.md)（arm ごとの集計の節）
- [E4] [docs/evaluation/2026-10-18-v7-dev-set.md](../evaluation/2026-10-18-v7-dev-set.md)
- [E5] [docs/evaluation/2026-10-18-index-baseline.md](../evaluation/2026-10-18-index-baseline.md) 補足
- [E6] [docs/evaluation/2026-10-20-child-agent-shape-by-runtime.md](../evaluation/2026-10-20-child-agent-shape-by-runtime.md)
- [E7] [docs/evaluation/2026-10-12-rediscovery-benchmark.md](../evaluation/2026-10-12-rediscovery-benchmark.md)
- [E8] [docs/evaluation/2026-10-19-v8-five-target-rediscovery.md](../evaluation/2026-10-19-v8-five-target-rediscovery.md)
- その他の参照: [docs/evaluation/2026-10-21-child-model-experiment.md](../evaluation/2026-10-21-child-model-experiment.md)、[docs/evaluation/2026-10-24-verify-handoff-acceptance.md](../evaluation/2026-10-24-verify-handoff-acceptance.md)、[docs/reviews/2026-10-20-design-issues-from-production-results.md](2026-10-20-design-issues-from-production-results.md)、[docs/reviews/2026-10-23-verification-status.md](2026-10-23-verification-status.md)、[docs/reviews/2026-10-25-exploration-architecture-redesign.md](2026-10-25-exploration-architecture-redesign.md)、`docs/reviews/2026-10-26-discovery-prompts-japanese.md`（作業ツリーにだけある）
- ADR: [0029](../adr/0029-single-wp2shell-cooperative-trial.md)、[0032](../adr/0032-owner-decisions-on-constraints-2026-10-13.md)、[0033](../adr/0033-minimum-exploration-and-pinned-dependency-sources.md)、[0034](../adr/0034-harness-control-only-deletions.md)、[0035](../adr/0035-verification-as-a-skill.md)、[0036](../adr/0036-operator-resume-after-provider-refusal.md)、[0038](../adr/0038-verification-phases-and-submission-flow.md)、[0039](../adr/0039-discovery-launch-modes.md)、[0040](../adr/0040-human-lab-observation-replaces-judges.md)
- prompt の一覧と digest: `src/profiles/wordpress/prompts/index.ts`。各版の追加日は `git log origin/main --diff-filter=A -- <file>` で見た（merge の日付なので、branch 上で作った日とは 1 日ずれることがある）。

台帳（Git 外。どれも読み取り専用で読んだ）:

- [P] 本番台帳 `~/.local/state/wordpress-bounty-harness/ledger.sqlite`。3.1 節と 3.2 節、第 4 節の問い合わせ
- [M3] AI の作業メモ `~/.claude/projects/-home-dev-wordpress-bounty-harness/memory/project-multi-agent-judgment-2026-10-20.md`（Claude の Finding が 10-20 まで handoff に届いていなかった件。元の数字は同じ本番台帳）
- [D2] `~/.local/state/wordpress-bounty-harness-codex-24h-20261014/ledger.sqlite`
- [D3] `~/.local/state/wordpress-bounty-harness-opus-20261014/state/ledger.sqlite`
- [D4] `~/.local/state/wordpress-bounty-harness-devset-wide-20261025/ledger.sqlite`（v11-wide、campaign `devset-wide-v11-*` と `dsw11-*`）
- [D5] `~/.local/state/wordpress-bounty-harness-devset-wide-20261026/ledger.sqlite`（v13-wide、campaign `dsw13-*`。`-r2` と `-r3` は別セッションの再試行で、表には入れていない）
- [D6] `~/.local/state/wordpress-bounty-harness-devset-wide-v14-20261026/ledger.sqlite`（v14-wide、campaign `dsw14-*`）
- 公開経路一致の 4 と 5、所有者の判断の引用は、2026-10-26 の比較のセッションで所有者に示した結果である（台帳には無い）。
