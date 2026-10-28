# いまの Harness に足りないもの（2026-10-28）

「調べて報告」の記録。正本ではない。所有者の問い（2026-10-28）: 探索をいろいろ試しているが、既存ハーネスと論文を集めた上で、いまの Harness に何が足りないかを認識したい。

読んだもの: 本番台帳（`~/.local/state/wordpress-bounty-harness/ledger.sqlite`、2026-10-28 16:06 JST の写し、読み取りのみ）、`docs/reviews/` の外部調査 20 本と archive 5 本、ADR 0039〜0042、GitHub Issue #629 / #631 / #633、web の追加調査（2026-09〜10 の公開物、約 30 ページ）。出典の信頼度は末尾に書く。

## 1. 結論

足りないのは探索の仕組みそのものではない。足りないのは次の 4 つで、どれも「探索の良し悪しを決めるための情報」と「発見の後ろの処理」に属する。

1. **成果が台帳へ戻る線が無い。** 提出 8 件、採否、重複、報酬は Wordfence のダッシュボードにしか無く、台帳の Finding と結ばれていない。だから版の比較はいまも Finding/Trial で行っていて、その代理指標はすでに一度（契約 v5）判断を誤らせた。
2. **同じ発見を束ねる仕組みが半分しか効いていない。** 群の鍵が無い Finding が 46%。群は campaign 内に閉じていて、同じ Snapshot を別 campaign で回した分は束ねない。Lead には鍵が 0 件。数が多く見えるのはこのためで、成立 88 件の実数はもっと少ない。
3. **比較に耐える分母が無い。** 1 Trial あたり 0.2〜0.8 件の事象を 20 Trial で比べて版を切り替えてきた。公開の計測論文も、この条件では順位が 2 割の確率で逆になると言っている。
4. **満足している設計（列挙役 → 区画ごとの追跡役）がまだ 1 度も動いていない。** コードと設定はあるが、Claude 専用で、Claude の token が無い。所有者決定（2026-10-28 夜）で Codex でも動かすことになった（#646）。

このほか、公開ハーネスの 2 つ以上に現れていて本リポジトリが採りも却下もしていない仕組みが 11 ある（第 4 節）。うち、いまの数字で効くのは「自分の確認済み Finding からの変種探索」「修正直後の再探索」「失敗の要約を次の試行へ渡す」「10 分で人が確かめられる報告の形」の 4 つである。

## 2. 内側の数字（本番台帳、2026-10-28）

| 項目 | 値 |
|---|---|
| 本番 Trial / slug / campaign | 631 / 462 / 118 |
| 2 回以上回した slug（3 回以上、5 回以上） | 118（30、5） |
| 同じ slug@版 が 2 つ以上の campaign にある | 100 |
| 開発セットの slug で本番にも出たもの | 33 / 54 |
| scope 内 Finding（parked を除く） | 429 |
| うち群の鍵が無いもの | 196（46%） |
| 同じ Snapshot に複数 campaign の Finding があるもの | 7 Snapshot、118 Finding、群 87（campaign をまたいで束ねても 84） |
| TranslatePress 3.2.6 | 58 Finding、群 58（鍵が無い） |
| Lead | 3,373（群の鍵 0） |
| 検証 finished | 305（incomplete 271、runtime-confirmed 33、contradicted 1） |
| review-decided | 235（accept 2、defer 51、reject 182） |
| 提出 event / 報酬 event | 0 / 0（実際の提出は 8 件、うち重複 2） |
| 検証・レビューの曜日 | 火 161、土 112、他 36〜73 |
| Finding/Trial の版比較 | v14-wide 0.76 対 v18-wide 0.20（20 Trial）、pass@3 6/38 |

区画分配型: `enumeration-recorded` 0 件、`partition-assigned` 0 件、`prod-part` の campaign 0 件。`prod-part` ランナーは 2026-10-28 02:28 JST 起動、02:30 所有者指示で停止（Claude token 切れ、#633）。one-shot run の実装は `claude-one-shot-runtime.ts` と Claude sandbox のみ。

## 3. 公開ハーネス・論文との対照

### 3.1 すでに採っているもの（確認のため）

発見役と検証役の分離、検証役に新しい Finding を出させない、制約はコードに置く、索引は道具として渡す（床にしない）、snapshot 不一致で判定しない、失敗を棄却に数えない、台帳が coverage の主張、短い子、Programme の規則で出口を振り分ける、人が提出する。これらは Anthropic / Cloudflare / Mantis / Shopify / AVDH / XBOW と同じ形で、ADR 0042 までに入っている。

### 3.2 公開物のほうが強いところ

| 仕組み | 公開物 | 本リポジトリ | 判定 |
|---|---|---|---|
| 根本原因での重複排除 | MDASH（patch 単位の意味的グループ）、AgentFlow（crash 署名）、Mantis（鍵で 1〜3 段、agent で 4 段）、Cloudflare（転置索引 + agent）、Ginder（build hash） | 鍵の重なりで群（#424）。鍵が無い Finding が 46%、campaign 内のみ、Lead は対象外 | **欠け**。鍵を正規化の必須項目にし、同じ snapshotDigest なら campaign をまたいで束ねる。同根の最終判断は段 1b の AI |
| 提出結果の還流 | Elastic（764 件の既知結果で 5 回較正、75→84%）、HoF-Bench（既知 CVE で採点） | `submission-recorded` event はあるが 0 件。#601（台帳外で提出済みの Finding を記録する手段が無い） | **欠け**。#601 を先に直し、8 件を手で結ぶ |
| 繰り返し run で揺れを見る | HoF-Bench（4 pass）、Neef（3 回、整合 50% の model あり）、ASR 論文（259 本中 58% が分散を報告せず、単一 run は 5 点差の順位を 21% 逆にする）、Wiz | pass@3 は 1 実験のみ、版の切り替えは 20 Trial 単位 | **欠け**。同じ対象で対にして k≥3、版の切り替えは月 1 回 |
| 自分の確認済み Finding からの変種探索 | Kinorth / stealthcopter / Carlucci（確認した bug ごとに規則を書いて corpus を掃く）、Night-Wolf（scanner 規則へ戻す）、Cloudflare、Anthropic、Trail of Bits | 無い。ADR 0012 が禁じるのは公開記録の投入であり、自分の Finding は対象外。Wordfence は同一 codebase の重複は払わないが別 plugin の変種は払う | **欠け**。提出済み 8 件と成立 88 件から規則を書き、選定ではなく探索の種として渡す腕を 1 本 |
| 新版の差分・修正直後の再探索 | Dhakal（SVN diff 監視）、Night-Wolf、Shopify（diff scan は full の 1/10 の費用）、Mantis CI、Aardvark、PRISM（change watch）、Argus（8 件中 2 件が fix bypass）、Denver Jackson | 選定の再訪（版が上がって 90 日）のみ。PA change 7 は未決（#528 / #520） | **欠け**。選定の中の規則 1 つで足りる |
| 失敗の要約を次の試行へ渡す | Satoki Tsuji、CyberGym-E2E、AVRI（証拠の持ち越しで費用 −18〜24%） | 区画の失敗は新しい箱で要約なし（決定 3）。再開区間は同じ会話 | 未決。区画の 2 回目にだけ前回の出力 digest を渡す案は #637 の延長 |
| 10 分で人が確かめられる報告の形 | PRISM（人の確認 10 分）、TrendAI（30〜60 分が隘路）、Patchstack（生の HTTP 要求が必須）、MDASH | wbh-report は提出先の様式向け。週末にまとめて見るための「群の代表 + 根拠 + Lab 準備済み」の列は無い | **欠け**。段 1b の自動化と作り置き |
| 複数 model の和集合 | DeepSec（14.3% が model 固有）、CSI、MDASH、Night-Wolf（Sonnet は間接経路を落とす） | Codex と Claude は別の腕。和は取らない | 未決。群の鍵が campaign をまたげば、和は台帳の読み方で出る |
| coverage critic | Cloudflare、Mantis | gapfill は却下（決定 1）。critic は議論なし | 未決。区画分配型の記録（読んだ区画外）が出てから |
| Lead・知識の run をまたぐ持ち越し | Mantis learnings、Cloudflare prior ledger、Ginder registry（93 件の既知から 5 仮説）、AVRI | 列挙は毎回やり直し（決定 4）。組合せ役は名指しのみ（決定 11） | 未決。Argus 型の深掘りをするなら、Harness が対象ごとの書類（Finding・Lead・検証記録）を渡す形 |
| 実行可能な検証を出す前に置く | MDASH、TrendAI（偽陽性 −80%）、VulnHunter、Strix、OpenAnt（敵対的検証で 49.5% 除去） | Lab と人の観測（ADR 0040）。判定器と canary は削除済み | 採っている。公開物より強い（logic bug の oracle を持つ公開実装は無い）。処理量だけが問題 |

### 3.3 公開物の数字で、本リポジトリの位置を測れるもの

- Cloudflare: 1 回の run で累積の約半分しか出ない。gapfill は初回の半分の費用。→ 本リポジトリの pass@3 6/38 と同じ現象。
- OpenAnt: 12,177 → 393 → 93 → 67 → 20 → 13。敵対的検証が 49.5% 落とす。→ 段 1b の 88 / 162 と同じ桁。
- TrendAI: 1 件あたり約 20 USD、人の確認 30〜60 分。Elastic: 分析 0.5〜1.2 USD、再現 0.8〜4.9 USD。→ 本リポジトリは token が実質無料なので、隘路は人の時間だけ。
- Patchstack: 月 1,124 → 2,141 件、受理率 66.5% → 13.5%、1 つの脆弱性に 20 件超の重複。Coinbase: 有効率 14% → 4%、閉じた報告の 44% が重複。→ 提出前の重複照合の価値が上がっている。
- Ginder（5 月）: Patchstack 10 受理 / 7 重複 / 5 却下（約 550 USD）、Wordfence 1 受理 / 6 重複。→ 本リポジトリの 8 件中 2 重複は同じ比率。

## 4. prompt の差で結果が変わるのは仕方ないか

仕方ない部分と、測り方で消せる部分がある。

- 公開の計測: Neef（2606.21397）は同じ model の 3 回で整合が 50% の場合がある。ASR 論文（2609.25173）は 259 本中 58% が分散を報告せず、n=100 で検出できる最小差は 18 点。DeepSec は 14.3% が model 固有。HoF-Bench は 4 pass で採点する。
- 本リポジトリ: 0.2〜0.8 件/Trial を 20 Trial で比べている。この条件では、同じ prompt を 2 回回しても同じくらいの差が出る。v14 → v16 → v17 → v18 → v14 の切り替えで分かったのは「契約 v5 の申告欄が Finding を減らす」の 1 点だけである。
- 消し方: (1) 数えるのを Finding ではなく段 1b を通った群にする。(2) 同じ対象で対にして k≥3。(3) 版の切り替えは月 1 回。(4) 区画分配型は追跡役 1 体の入力が固定されるので、区画ごとに「出た・出ない」を再現して比べられる。prompt の比較より粒度が細かい。(5) 機械で拾える分（hook → handler → sink）は道具で固定し、AI の揺れを「道具が拾えない分」に限る。

## 5. メタハーネス（自己改善の輪）について

- 公開物: AgentFlow（archive + 採点、Chrome で 10 件の zero-day。ただし crash oracle あり）、DGM（archive + 実測の検証）、VERSE（2610.02616: 実行による検証が無いと自己進化は効かない）。Meta-Harness / LangChain / Self-Harness は coding 課題。
- 本リポジトリ: 2026-10-15 に「自動の meta-harness は成り立たない」と判断した。理由は改善を測る数字が無いこと。token が無料になっても条件は変わらない。
- 回すなら、輪が読む信号を先に作る。信号は「段 1b を通った群 / Trial」と「提出 / 報酬 / 重複」の 2 つ。prompt の候補は AI が出し、採否は数字で決める（ADR 0032 の 2026-10-18 節の形のまま）。人の判断点は ⑥ の観測だけにする。

## 6. Git の状態

| 項目 | 値 |
|---|---|
| worktree | 36（`/home/dev/worktree` 7、`~/.codex/worktrees` 19、repo 内 `.claude/worktrees` 5、state dir 2、`/home/dev/wordpress-bounty-harness-*` 2、本体 1） |
| ローカル branch | 225（PR が merge 済み 89、PR が close 10、open 1、PR を開いたことが無い 125） |
| remote branch | 169（merge 済み PR の head が 157 残っている） |
| 本体の checkout | branch `wbh-verify-v8`（PR は merge 済み）、main より 116 commit 古い |
| 本体の untracked | `docs/reviews/` の報告 23 本が Git に無い（10-23〜10-26 の外部調査と 10-28 の依頼文 2 本）。17 本は main と内容が違い、うち `2026-10-21-monitor-report.md` は working tree のほうが 100 行多い |

いちばん危ないのは、外部調査の報告 23 本が untracked のまま本体の checkout にだけあることである。この報告が引用した `2026-10-23-public-vulnerability-harness-landscape.md` と `2026-10-24-*` の 4 本もそれに含まれる。

片付けの案（実行していない。消す操作は所有者の確認が要る）:

1. 23 本の untracked 報告を 1 本の docs PR で main に入れる（内容は変えない）。`2026-10-21-monitor-report.md` の差分は別 PR。
2. 本体の checkout を main に戻す。所有者の決定（2026-10-26）どおり worktree は `/home/dev/worktree` だけにし、merge 済み branch の worktree（上の表で `pr=merged` の 20 本）と repo 内 `.claude/worktrees` の 5 本を `git worktree remove` する。`prod26`（本番ランナーが使用中）と `codex-architecture-cleanup`（PR #645 open）は残す。
3. ローカル branch は、merge 済み 89 と close 10 を消す。PR を開いたことが無い 125 のうち 10-14〜10-16 の `codex/issue-2xx-*` 系 70 本は Step 1 当時の作業用で、内容は merge 済み PR に入っている。consolidate した上で `archive/` に名前を変えるか消す。
4. remote の merge 済み branch 157 本は、GitHub の「merge 後に head branch を自動削除」を有効にして、既存分は 1 回で消す。

## 7. 優先順

1. #601 を直し、提出 8 件を台帳の Finding に結ぶ（成果の線）。
2. 群の鍵を正規化の必須項目にし、同じ snapshotDigest なら campaign をまたいで束ねる。Lead にも鍵を付ける（重複）。
3. 選定が自分の台帳の Trial 数を読み、k に達した Snapshot を飛ばす（同じ plugin の繰り返し）。
4. #646 → #633（区画分配型を Codex で回し、v14-wide と対にして k=2 で測る）。
5. 段 1b の自動化と週末向けの作り置き（群の代表、根拠、Lab 準備済み）。
6. 変種探索の腕 1 本（自分の確認済み Finding から規則を書く）と、修正直後の再探索の選定規則 1 つ。
7. Git の片付け（第 6 節）。

1〜3 は Harness の「形」の修正で、1 本ずつの PR で消せる。6 は探索の数字を取ってから。

## 8. 出典と信頼度

repo 内の既存調査（`docs/reviews/2026-10-23-public-vulnerability-harness-landscape.md`、`2026-10-24-recent-ai-security-discovery-architectures.md`、`2026-10-24-validation-screening-patterns.md`、`2026-10-24-wordpress-concrete-hunting-methods.md`、`2026-10-25-wordfence-prism-argus-method-and-cases.md`、`2026-10-27-public-harness-repos-responsibility-split.md`、`2026-10-28-adopted-design-for-approval.md`）に載っている出典は再掲しない。今回の web 調査で足したものだけ書く。P = 一次ページを読んだ、V = vendor の自己申告、S = 二次記事、U = 検索結果の断片のみ。

- Microsoft MDASH（2026-05-12、V）: Prepare → Scan → Validate（debate）→ Dedupe → Prove。CyberGym 88.45%。
- AgentFlow（arXiv 2604.20801、P）: 型付き graph DSL の外側の輪、archive、Chrome 10 件。
- TrendAI / CHT AgentForge（Help Net Security 2026-05-22、S）: AI 静的解析 → Docker → DevTools MCP。約 20 USD/件、人の確認 30〜60 分。
- Kues の WordPress pre-auth RCE chain（XDA 2026-07-27、S）: 約 10 時間、約 25 USD、人が最後の連鎖を解いた。
- cablesandmore の hook-mapping 研究（2026-08-08、S）: 4,455 plugin 索引、PoC 8、scope 内 1、支払い約 0。
- Elastic AI triage（2026-08-04、V）: 8 段、764 件で人と 85% 一致、5 回の較正で 75→84%。
- Strix、Capital One VulnHunter、open·kritt、Clouditera VulnHunter（README、P / U）: 実行可能な exploit 付きの Finding だけを出す。評価数字なし。
- momoponwork1415-lgtm/wordpress-harness（README、P）: 本リポジトリの前世代。
- Plug 'n' Pray（arXiv 2609.17164、P 要旨）: 上位 300 plugin、81 件中 79 再現。
- Evaluating LLMs for Real-World Web Vulnerability Detection（arXiv 2606.21397、P 要旨）: Opus 4.6 63%、3 回で整合 50% の model あり、scoped prompt が勝つ。
- OpenAnt（arXiv 2606.19149、P 要旨）、VERSE（arXiv 2610.02616、P 要旨）、DGM（arXiv 2505.22954、P）、HoF-Bench（arXiv 2607.27030、P 要旨）、Where Do the Tokens Go?（arXiv 2610.11602、P 要旨）、Attack Success Rate Is Not a Number（arXiv 2609.25173、P）、After Cheap Discovery（arXiv 2609.03266、P）。
- 経済: Coinbase（Crowdfund Insider 2026-08、S）、curl の bounty 終了（S、数字は出典で食い違う）、HackerOne 2025 報告（P）、WordPress HackerOne 90 日で 2,004 件（The Repository、S）、Patchstack の月次（U）。
- 見つからなかったもの: 自動ハンターの月次報酬の一次数字、LLM 探索の run 単位の重複率の一次数字、Wordfence Argus / PRISM の 2026-10 以降の公開物、Patchstack AI triage の 2026 年の詳細。
