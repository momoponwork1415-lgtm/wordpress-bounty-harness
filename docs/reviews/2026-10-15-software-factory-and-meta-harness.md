# software factory と meta-harness の考え方を取り入れる（2026-10-15）

調べて報告。正本ではない。食い違えば [SPEC](../SPEC.md) と [ADR](../adr/) が勝つ。所有者の依頼は「software factory の考え方やメタハーネスの考え方をこのリポジトリに取り入れたい」。この文書は、2 つの語が外で何を指すかを一次資料で確かめ、この repo に既にある部分と無い部分を分け、取り入れ方の選択肢と推奨を出す。コードと正本は変えていない。実機、provider、`pnpm check` は動かしていない。

## 要約

- **software factory** は 2026 年の用法では「Issue を作業列にし、agent が 1 工程ずつ実装・検証して証拠を残し、人間が憲章（charter）と merge を持つ運用モデル」を指す。この repo の開発の流れ（[DEVELOPMENT](../DEVELOPMENT.md)、PR テンプレート、CI の 3 ゲート、`owner-approved`、triage ラベル、skill）は **既にこの形をほぼ満たしている**。足りないのは、所有者の読む量に対する逆圧（WIP 上限）と、運転結果から改善案を出す「monitor / tune」工程の形の 2 つだけ。
- **meta-harness** は Stanford の論文（Lee et al., 2026-03）が指す「harness のコードを外側ループで探索し、過去候補の score と trace を proposer に読ませて改善する」仕組み。この repo で同じことを自動で回すには、評価 1 回が 60 分の協調 Trial と gVisor Lab と本番 quota を消費し、未知脆弱性の当たり率という信号が 9 世代で 0 件のまま弱い。**自動最適化は今は成立しない**。成立するのは「台帳の運転記録を読んで、週に 1 つの変更案を数字付きで出し、人間が採否を決める」人間ゲート付きの形で、これは [PARKING](../PARKING.md) の 2026-10-14 行「運転ログを AI が分析し、人間と協調して Harness を改善する」と同じ。
- **推奨**: Step 1 の間は正本もコードも変えない。(1) 本報告で「既にある factory 要素」を名前付きで固定し、(2) Step 1 判定（runner 起動＋8 日）の後に、提案だけを出す skill `wbh-tune` を 1 本の問いとして足し、(3) 未知の `runtime-confirmed` が初めて出たときに、それを週次の実 Lab smoke へ加える規則を書く。自動 prompt 探索、自己改変する harness、第 2 の orchestrator は作らない。

## 1. 語の意味（一次資料）

### 1.1 software factory

| 出典 | 定義と要素 |
| --- | --- |
| [Factory「What is a software factory」](https://factory.com/articles/what-is-a-software-factory-architecture) | intake、context、planning、execution、review、delivery、observability の 7 責務。「人間は要求される振る舞い、許す権限、release 条件を決める」。残す記録は report、開始 revision、patch、環境定義、test 出力、review 判断、release 成果物。本番で漏れた case は「regression test と instruction の更新につなげる。log を溜めるだけでは駄目」 |
| [Augment「What Is a Software Factory?」](https://www.augmentcode.com/guides/what-is-a-software-factory) | 「agent が pipeline の中でコードを書き、test し、出荷し、spec と merge 承認は人間が持つ運用モデル」。OpenAI Symphony（Issue 1 件 ＝ agent 作業場 1 つ）、Kiro（requirements / design / tasks の 3 file）を例示 |
| [addyosmani/factory](https://github.com/addyosmani/factory)（Claude Code / Codex 向け参照実装） | 「GitHub Issues が作業列」。triage → spec → implement → verify → review → ship（人間だけが merge）→ monitor（週 1 の点検で見つけた事を Issue に戻す）。人間が持つ **charter**（自律度、守る path、完了定義、停止条件）。gate script は fail-closed（必須 gate が無ければ `MISCONFIGURED`）。独立 verifier が diff を冷たく読み、fix を戻して新 test が落ちることを確かめる。review 待ちが多いと implement を止める逆圧 `STOP_IF`。月 1 の `/factory-tune` は制約の変更を **提案するだけ**で、人間が採否 |
| [Spec-Driven Development 論文（2609.00252）](https://arxiv.org/pdf/2609.00252) | agent は実装を速めるが、大 repo での context 過多と、spec とコードの乖離という 2 つの構造的な失敗を持ち込む |

共通する骨格は 5 つ。**作業列（Issue）**、**人間所有の憲章と守る path**、**fail-closed なゲートと run ごとの証拠**、**人間だけが merge**、**運転結果を Issue と regression に戻す monitor / tune**。

### 1.2 meta-harness

| 出典 | 中身 |
| --- | --- |
| [Meta-Harness: End-to-End Optimization of Model Harnesses（arXiv 2603.28052）](https://arxiv.org/abs/2603.28052) | harness ＝「何を保存・取得・提示するかを決めるコード」。外側ループが harness コードを探索し、proposer は「過去候補すべての source、score、実行 trace」を filesystem で読む。文章最適化器は「feedback を圧縮しすぎる」と批判。結果は text 分類 +7.7 点・context 4 分の 1、IMO 級数学 +4.7 点、TerminalBench-2 で手設計を上回る。abstract は費用と過学習に触れない |
| [LangChain「Better Harness」](https://www.langchain.com/blog/better-harness-a-recipe-for-harness-hill-climbing-with-evals) | 「eval が harness engineering の訓練データ」。手書き・本番 trace・外部 dataset から eval を集めて行動別に tag、最適化集合と holdout に分け、baseline を取り、**1 回の実験で 1 変更**、回帰を次に戻す、人間が過学習した指示を見る。数値の lift は非公開 |
| [Self-Harness（bdtechtalks 2026-07）](https://bdtechtalks.com/2026/07/13/ai-agents-self-improving-harness/) | 失敗 log から弱点を見つけ、小さな編集を提案し、既存の通過 task を壊す編集を regression で拒否する 3 段 |
| [Lilian Weng「Harness Engineering for Self-Improvement」（2026-07）](https://lilianweng.github.io/posts/2026-07-04-harness/) | 再帰的自己改善は weights より先に harness から始まる、という枕。ADAS、Darwin Gödel Machine、AlphaEvolve を系譜に置く |
| 別義 | [ruvnet/metaharness](https://github.com/ruvnet/metaharness) は repo から harness を「鋳造する」scaffolder、[Omnigent 系の解説](https://www.mindstudio.ai/blog/what-is-meta-harness-ai-agents-omniagent)は複数 agent の上に乗る orchestrator。いずれも最適化ではない。この repo は stock の Codex / Claude Code と skill で動いており（addyosmani/factory も「custom orchestrator なし」）、この別義の道具は要らない |

共通する骨格は 4 つ。**score と trace を持つ評価集合**、**候補ごとの安価な評価**、**holdout と 1 変更 1 実験**、**回帰で拒否**。論文の設定では評価は数百 task × 短時間で、1 候補の評価が数分で済む。

## 2. この repo に既にあるもの（対照表）

| factory / meta-harness の要素 | この repo の現状 | 根拠 |
| --- | --- | --- |
| 作業列 | GitHub Issues。5 つの triage ラベル（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。#238 の子 Issue が P0〜P13 の依存順を持つ | [docs/agents/triage-labels.md](../agents/triage-labels.md)、#238 |
| 憲章（charter） | DEVELOPMENT 第 2 節の凍結一覧、第 5 節の PR 規則、最終設計 第 8 節「変更禁止の線」と第 13 節「やらないこと」、P0（#239）で adr-guard に守る path を列挙 | [DEVELOPMENT](../DEVELOPMENT.md)、#239 |
| fail-closed なゲート | CI `check`（型・prettier・vitest 497 件）、`build` と CLI smoke、`private-guard`、`adr-guard`。main の ruleset は strict で 3 check 必須 | [.github/workflows/check.yml](../../.github/workflows/check.yml) |
| run ごとの証拠 | PR テンプレート 5 項目。探索に触る PR は開発セット 3 Trial の数字（Trial / completed / Finding / Lead / wall 中央値 / 失敗理由）。台帳は run ごとに model・effort・CLI 版・usage・digest を記録（ADR 0007） | [PR テンプレート](../../.github/pull_request_template.md)、[SPEC 第 6 節](../SPEC.md) |
| 人間だけが merge・承認 | `owner-approved` ラベル（agent に渡る文章、ADR、policy、判定器）。2026-10-13 に採否とラベル付与を AI に委任、委任を PR comment に残す。外部送信は Harness が実行しない（不変条件 7） | DEVELOPMENT 第 5 節、ADR 0032 |
| 独立 verifier | Finding には Verifier container ＋ Harness 判定器（不変条件 3）。コードには `code-review` / `security-review` skill があるが必須ではない | [TEST-STRATEGY](../TEST-STRATEGY.md) |
| 逆圧（back-pressure） | 人間レビュー batch は上限 3 件（最終設計）。runner は `no-progress` / `errors` 等 7 種で止まる。**開発側の PR 待ち数には上限が無い**（2026-10-14 は 1 日で #248〜#260 の 13 本） | #238 comment、#242 |
| monitor | 週末に見る数字（DEVELOPMENT 第 7 節）。設計レビューは手動で `docs/reviews/` に置き、#270 のように Issue へ戻す。**定期の形にはなっていない** | [#270](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/270) |
| tune（制約の変更は提案だけ） | 報告 → 所有者の決定 → ADR → PR の順。ADR は週 1 本まで。止めた案は PARKING に 1 行 | DEVELOPMENT 第 6 節、[PARKING](../PARKING.md) |
| 評価集合（score ＋ trace） | 既知 7 件の再発見 catalog、TranslatePress 開発セット、週次の実 Lab smoke（3.3.1 ATO 1 件）。台帳の funnel / usage / 停止理由 | [docs/evaluation/](../evaluation/README.md)、[OPERATIONS 第 2 節](../OPERATIONS.md) |
| 1 変更 1 実験、holdout | 「週の問い 1 つ、PR 1 本」。実験軸は opt-in 設定 1 つと profile file 1 つに閉じる。holdout に相当するのは**翌週の本番**しか無い | DEVELOPMENT 第 3・5 節 |
| 失敗から学ぶ | LESSONS 13 項、experiments.md に世代横断で 1 行ずつ | [LESSONS](../LESSONS.md)、[experiments.md](../knowledge/experiments.md) |

結論: software factory の 5 要素のうち 4 つは名前が違うだけで既にある。無いのは「開発側の逆圧」と「monitor / tune を定期の工程として持つこと」。meta-harness の 4 要素のうち「評価集合」と「1 変更 1 実験」は粗い形であり、「安価な評価」と「holdout」が無い。

## 3. meta-harness をそのまま回せない理由（数字）

| 論文の前提 | この repo の実測 |
| --- | --- |
| 1 候補の評価が数分、数百 task | 1 評価 ＝ 1 協調 Trial ＝ wall 上限 60 分、非 cache token 約 50 万（第 3 周の対象あたり）、gVisor Lab 1 式。探索に触る変更は最低 3 Trial。候補 20 × 3 Trial ＝ 60 Trial で、週 quota を超える |
| 評価は開発用の予算で回せる | 費用は ChatGPT Pro の購読 quota で、最終設計 第 13 節は「Codex の quota を開発作業に使わない」と決めている。LESSONS 13「harness を作っている間は報酬が止まる」 |
| score が密で安定 | 主指標は未知脆弱性の `runtime-confirmed` と提出転帰。9 世代で未知の発見 0、本番 3 周 15 対象で `runtime-confirmed` 0。信号がほぼ 0 と 1 の間で動かない |
| 代替 score に benchmark を使える | 既知 7 件の再発見は「配線と判定器の確認であり、未知の発見率を示さない」（ADR 0027）。これを目的関数にすると、既知事例への過学習と、ADR 0012 の時点切りの境界を侵す誘因が生まれる |
| harness コードを機械が書き換える | agent に渡る文章は `owner-approved` と出典対照表を要し、AI は要素を足さない（LESSONS 12）。判定器の成功条件と不変条件は凍結 |

つまり、自動の外側ループは「安価な評価」と「信号」の両方を欠く。回せるのは **人間ゲート付きの手動 1 周**（LangChain の recipe の step 4〜6 を人が担う形）で、それは DEVELOPMENT 第 3 節「週の問い 1 つ」と同じ速度になる。

## 4. 選択肢

| 案 | 中身 | 費用 | 条件 | 反する規則 |
| --- | --- | --- | --- | --- |
| A（推奨） | **名前を付けて固定し、足りない 2 つだけを後で足す。** (A1) 本報告を置き、PARKING の「運転ログを AI が分析」行の再開条件を数字で書き直す。(A2) Step 1 判定後に skill `wbh-tune`（台帳 export を読み、週 1 つの変更案を数字付きで出す。Harness を変えない）。(A3) 未知の `runtime-confirmed` が初めて出たら、同じ Finding を週次 smoke の case に足す規則を OPERATIONS に 1 行 | A1 は文書のみ。A2 は skill 本文 1 本（Harness コード 0 行、ADR 0031 の「判断は skill」と同形）。A3 は 1 行 | A2 は runner が 1 週回り Trial 10 件以上、review batch 1 回の記録が出た後。A3 は未知の confirmed 1 件 | なし。Step 1 の凍結の外側 |
| B | **開発側に factory の逆圧を入れる。** 所有者が読んでいない PR が N 本（例 3）を超えたら新しい実装 PR を出さない、を DEVELOPMENT 第 5 節に 1 行 | 文書 1 行。P0 の PR に同乗できる | 所有者が N を決める | DEVELOPMENT 第 2 節「Step 1 完了まで §2〜§4 と ADR は変えない」の外（§5 は P0 で改訂予定） |
| C | **monitor を定期工程にする。** 週末の数字（第 7 節）と #270 型のレビューを、週 1 の skill か scheduled agent が `docs/reviews/` に出し、blocker を Issue に戻す | skill 1 本。既存 `ledger funnel` / `usage` / `continuous status` を読むだけ | runner 起動後 | なし。ただし「同じ手動作業を 3 回してから道具にする」（LESSONS 8）には、まだ 2 回目 |
| D（採らない） | **自動 meta-harness。** prompt、scenario、judge 条件を候補生成 → 3 Trial → score で選ぶ外側ループ | Harness コード、評価 runner、quota | 第 3 節の前提が揃うまで不可 | 不変条件 1・3、ADR 0012・0027、LESSONS 1・2・12・13、最終設計 第 13 節 |
| E（採らない） | **第 2 の orchestrator / scaffolder**（ruvnet/metaharness、Omnigent 型）を入れる | 新しい依存と運用面 | — | LESSONS 8。既存の Claude Code / Codex ＋ skill で足りている |

## 5. 推奨

1. **今週は A1 だけ。** 本報告を置く。PARKING の 2026-10-14 行「運転ログを AI が分析し、人間と協調して Harness を改善する」の再開条件を「`continuous run` が 1 週回り、Trial 開始 10 件以上と review batch 1 回の `decide --minutes` が台帳にあるとき。出力は提案だけで、1 週に 1 変更」に書き直す。これは 1 行の変更で、所有者が決めたら PR にする。
2. **B は P0（#239）に同乗させる。** 第 5 節の改訂は P0 で予定されているので、「所有者が読んでいない PR が 3 本を超えたら新しい実装 PR を出さない」を 1 行足す。所有者の時間が律速になっている現状（13 本 / 日）への唯一の逆圧になる。
3. **A2 は Step 1 判定の翌週の問いにする。** 「台帳の 1 週分から、人間が採れる変更案を skill が 1 つ出せるか。所有者が読むのに何分か」。skill は `review export` と `ledger funnel` / `usage` / `continuous status` の出力だけを読み、Harness へは書かない。出力の形は「問い、数字、変更案 1 つ、holdout（翌週）で見る数字、消し方」の 5 項目にし、PR テンプレートと同じにする。
4. **A3 は未知の confirmed が出た日に 1 行。** 「`runtime-confirmed` かつ最新版で確認した Finding は、Snapshot と Lab Setup を保持し、週次 smoke の case に加える」。Better Harness の「通った eval は regression になる」と、factory の「本番で漏れた case は regression test へ」をこの repo の語で書いたもの。
5. **D と E はやらない。** 理由は第 3 節。所有者が後で自動化を望むなら、先に「1 評価の費用を 60 分・50 万 token から下げられるか」という別の問いを立てる必要があり、それは探索の構造を触る Step 2 以降の話。

## 6. 変えないもの

- SPEC 第 2 節の不変条件、モジュール境界、判定器の集合、既定 prompt v4、Step 1 の順序と判定条件。
- 本報告で名付けた「factory 要素」は既存の文書を言い換えただけで、規則は増やしていない。AGENTS.md と DEVELOPMENT.md に新しい節は足さない。
- 評価の目的関数に既知 7 件の再発見を使わない（ADR 0027）。

## 7. 未確認の仮定

- Meta-Harness 論文の数値は abstract と二次資料からで、本文の費用・過学習の記述は読んでいない。
- addyosmani/factory の記述は README に基づく。実運用の数字は無い。
- 「1 Trial ≈ 50 万 non-cache token」は第 3 周の記録からの外挿で、v4 と runner 起動後の値は未測定。
- 2026-10-14 の 13 本の PR が所有者の読む量を超えていたかは、所有者の記録が無いので推測。B の N は所有者が決める。
- 本報告はローカルの作業ツリー（branch `codex/critical-high-discovery-focus`、未コミットの 2026-10-14 の報告 4 本）で書いた。`main` との差分は読んでいない。

## 8. 消し方

報告なので消すものはない。A1〜A3、B を採る場合は、それぞれ 1 行または skill 1 本で、消すときはその行と file を消す。
