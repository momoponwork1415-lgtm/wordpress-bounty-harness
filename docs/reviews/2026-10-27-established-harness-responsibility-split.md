# 実績のある Harness は「決定論」と「AI」をどう分けているか（2026-10-27）

「調べて報告」の記録。正本ではない。所有者の問い（2026-10-27）: 「中身は AI、形は Harness」という分け方は、Anthropic、OpenAI、Google、Cloudflare の実績ある Harness ではどうなっているか。公開資料だけを読んだ。OpenAI の一次資料 2 本（Aardvark 紹介、harness engineering）は 403 で直接読めず、公式ヘルプと二次資料で補った。

## 1. 結論

4 社 5 系統（脆弱性発見 3 つ、汎用 agent 基盤 2 つ）を並べると、分け方はほぼ同じ線で引かれている。

| 決定論（Harness が持つ） | 非決定論（AI が持つ） |
|---|---|
| 隔離（container、sandbox、network なし） | 仮説を立てる、どこを読むか、どの順で読むか |
| 作業の単位を固定する（file、commit の diff、entry point、区画） | 単位の中の探索、道具の使い方 |
| 出力の形（schema、構造化出力。壊れていれば落とす） | 出力の中身 |
| 判定の oracle（ASan、assert、sandbox での再現、test、compiler） | oracle が無いときの自己再点検（別の体が「本物か」を読み直す） |
| 状態の保存、再試行、timeout、checkpoint、追跡記録 | 分解（orchestrator 型のときだけ）、効果の見積もり |
| 人間の関門（提出前、適用前） | 報告の文、重大度と確度の自己申告 |

どの系統も、Harness が「AI が出すべき中身」を先に作ることはしていない。AI の自由文を Harness が読んで分類することもしていない。中身は AI、形と oracle と関門は Harness、という分け方は実績ある系統と一致している。

記事の範囲では、脆弱性発見の 3 系統（Anthropic Mythos、Google Big Sleep、OpenAI Codex Security）は**作業の単位を Harness が機械的に決め、AI は単位の中の順位付けまで**にしているように読めた（Mythos は file、Big Sleep は commit の diff、Codex Security は threat model の entry point）。**訂正（同日午後、[repo を読んだ報告](2026-10-27-public-harness-repos-responsibility-split.md)）:** 区画の切り方を AI に提案させる形には Shopify、Anthropic 参照 harness の recon、Cloudflare skill の recon の 3 つの先例がある。今回の設計は公開系統より先に出ているわけではない。「script の行を単位にして AI が順位を付けるだけ」の腕は、効果を測るための比較の分母として残す（§3）。

## 2. 系統ごとの分け方

### 2.1 Anthropic — Mythos Preview の脆弱性発見（2026-04）

一次資料: [Mythos Preview research](https://www.anthropic.com/research/mythos-preview)。

- **足場は最小。** 隔離 container（network なし）に project のソースを置き、Claude Code に「このプログラムの脆弱性を 1 つ見つけて」という 1 文で起動する。仮説を立て、動かして確かめ、PoC と再現手順を付けた報告か「無し」で終わる。
- **単位は file。** AI が先に全 file を 1〜5 で点数付けし、点数順に file ごとに 1 体を起こす。「同じ bug を何百回も見つける」のを避ける唯一の重複対策がこれ。
- **oracle は ASan。** memory bug では crash が「本物と幻覚をほぼ完全に分ける」。logic bug には oracle が無く、「ほぼ完全な検証ができなくなる」と明記している。
- **再点検は別の体。** 最後に別の agent が「この報告は本物で面白いか」を読み直し、小さい・曖昧なものを落とす。
- **人間は全件を見る。** 外部に送る前に契約した検証者が全報告を確かめる。198 件の手動 review で重大度が一致した割合は 89%。
- 規模: OSS-Fuzz の約 1,000 repo、約 7,000 entry point、各 1 run。OpenBSD は約 1,000 run で 2 万ドル未満。

今回の設計への含意: 探索の足場は薄くてよい。効いているのは「単位の固定」「oracle」「別の体による再点検」「人間の関門」で、これはすべて Harness 側。logic bug には oracle が無いと書いているので、WordPress の Lab と canary はまさに「無い oracle を作っている」部分であり、そこに投資する意味がある。

### 2.2 Anthropic — agent 設計の指針（2024-12、2025-06、2025-11、2026-02）

- [Building effective agents](https://www.anthropic.com/research/building-effective-agents): workflow（コードが流れを決める）と agent（LLM が流れを決める）を分け、「できるだけ単純な形から始める」。段と段の間に「programmatic checks」を関門として置く。並列化には「sectioning（独立した小仕事に分けて並列）」と「voting（同じ仕事を複数回）」がある。orchestrator-workers は「中央の LLM が動的に分解する」型で、分解が入力ごとに変わるときだけ使う。
- [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system): 分解と子の数は lead agent（AI）が決める。system が持つのは状態の保存、checkpoint からの再開、rainbow deployment、追跡記録。各子には「目的、出力の形、道具の指針、仕事の境界」を必ず渡す。効果の見積もりは「agent は苦手なので prompt に規則を埋めた」とある。
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): 初期化 agent と作業 agent は prompt だけが違い、Harness は同じ。feature 一覧は JSON にして agent は `passes` 欄しか触れない（Markdown より上書きされにくい）。状態は file に置く。
- [Claude Code Security](https://www.anthropic.com/news/claude-code-security): Finding ごとに Claude 自身が「証明するか反証するか」を試みて偽陽性を落とす。重大度と確度を付け、人間が承認するまで何も適用しない。

含意: 今回の「Root を置かず、区画ごとに体を起こす」は sectioning 型に当たり、orchestrator 型（Root）より単純な側。Anthropic 自身が「分解を AI に任せる orchestrator 型は、分解が入力ごとに変わるときだけ」と書いている。WordPress plugin は入口の形が plugin ごとに違うので、分解の一部を AI に残す理由はある。出力の形を JSON で固定し AI が触れる欄を限定する、というのは「形は Harness」の実例。

### 2.3 OpenAI — Aardvark / Codex Security（2025-10〜）

一次資料: [Codex Security ヘルプ](https://help.openai.com/articles/20001107)、[threat model の改善](https://learn.chatgpt.com/docs/security/threat-model)。紹介記事（[Introducing Aardvark](https://openai.com/index/introducing-aardvark)）は 403 で、[Hacker News](https://thehackernews.com/2025/10/openai-unveils-aardvark-gpt-5-agent.html) と [SD Times](https://sdtimes.com/ai/openai-announces-agentic-security-researcher-that-can-find-and-fix-vulnerabilities/) で補った。

- **段は固定で 4 つ。** threat model → 検出（commit 単位） → 検証（sandbox で再現してから表に出す） → 修正案（人間が review、適用後に再検証）。段の順は Harness が決め、各段の中身は AI。
- **threat model は AI が下書きし、人間が編集する成果物。** 「entry point と信頼できない入力、trust 境界と認証の前提、機微な経路、先に見てほしい領域」を書く。編集は以後の scan の文脈になる。「結果がおかしければ、まず threat model を直す」と案内している。
- **検証は sandbox での再現。** 「表に出す前に isolated 環境で再現して exploitability を確かめる」。再現できないものは表に出ない。
- [Harness engineering](https://openai.com/index/harness-engineering)（[The Neuron の要約](https://www.theneuron.ai/explainer-articles/openais-harness-engineering-playbook-how-to-ship-1m-lines-of-code-without-writing-any/)、[調査記事](https://yage.ai/share/harness-engineering-survey-en-20260312.html)）: 「agent が文脈で見られないものは存在しない」。AGENTS.md は 100 行程度の地図。守らせたい構造は注意書きではなく custom linter で機械的に禁じる。崩れは定期的な agent の掃除 PR で戻す。

含意: threat model は、今回の「列挙役が出す inventory」と「人間が書く trust 境界宣言」を 1 つの編集可能な成果物にしたもの。inventory を対象ごとに残して次回の文脈にする（AI が書き、人間が直せる）のは、公開されている形に沿っている。「守らせたい構造は linter で」は、prompt で agent 構成を頼まず Harness で強制する、という所有者の方針と同じ。

### 2.4 Google — Big Sleep（2024-10）と CodeMender（2025-10）

- [From Naptime to Big Sleep](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html): 単位は「最近の commit の diff」。Harness は commit message と diff を渡し、「関連する未修正の問題を探せ」と指示する（variant analysis）。道具は code browser、debugger、report。build は debug assert 有効（oracle）。何を読むか、どんな入力を作るかは AI。確認は debugger 上の crash（SIGABRT と assert の出力）。瑣末な commit は Harness が先に除く。
- [CodeMender](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/): 決定論の道具（静的・動的解析、fuzzing、差分 test、SMT solver、compiler、既存 test）と、AI（根本原因の推論、修正、別の LLM による critique、機能等価の LLM judge）を組む。自動検証を通った修正だけを人間に見せ、人間が全件 review してから upstream に出す。

含意: Big Sleep の「diff を種にする」は、Harness が単位と出発点を固定して AI に中の探索を任せる形。CodeMender は「決定論の道具は oracle と検証、AI は推論と critique」で、今回の段 1b（別の体が読み直す）と Lab（oracle）の組と同じ。

### 2.5 Cloudflare — Agents の harness と Workflows（2026）

一次資料: [Harnesses](https://developers.cloudflare.com/agents/harnesses/)、[Think + Workflows](https://developers.cloudflare.com/agents/harnesses/think/workflows/)。

- harness の定義: 「agent を単なる model 呼び出しでなく agent らしく振る舞わせる loop」。持つのは prompt の組み立て、model の実行、道具の呼び出し（承認の流れを含む）、message の保存、stream と復旧、turn / step / tool call の前後の hook。
- Workflows: 決定論の処理は `step.do()`、model の処理は `step.prompt()`。model の処理には schema を渡し、返りを schema で再検査する。「Think は不正な model 出力を黙って直さない」ので、壊れていれば例外で落ちる。timeout で打ち切る。idempotency key で同じ step を 2 度やらない。人間の承認は `waitForEvent()` で待つ。「段が複数ある、長く待つ、人間の承認がある、のどれかなら Workflows」。

含意: 「Harness は出力の構造を強制する」の最も素直な実装例。model の段は schema 付きの 1 関数で、形が合わなければ落とす。今回の正規化は「直せる崩れは直して記録、直せないものは保留」で、Cloudflare より寛容だが、直した内容を記録しているので同じ線の上にある。

### 2.6 参考: Cursor の数百体の構成（2026-01〜02）

[Self-driving codebases](https://cursor.com/blog/self-driving-codebases)。脆弱性ではなくコード生成だが、所有者の問い（構成を prompt で頼まず Harness で持つ）に直接当たる。

- 対等な agent が共有 file と lock で協調する形は失敗した（20 体が 1〜3 体の速度に落ちる。agent は小さく安全な変更ばかり選ぶ）。
- 最終形は planner → subplanner → worker。worker は自分の repo 複製で 1 仕事だけをし、他の体と話さない。結果は handoff で上に返す。judge は「単純さのため」外した。
- Harness が機械で持つのは、体ごとの複製、handoff の配送、timeout と process の資源管理（agent は leak や deadlock に自分では気付かない）、文脈上限での要約。何に取り組むか、どう分けるかは AI。
- 「指示より制約」。禁止の境界（TODO 禁止、部分実装禁止）は注意書きより効く。曖昧な量は臆病な出力になるので「20〜100 件」のように範囲で言う。

含意: 今回の「追跡役は自分の区画だけ読み、他の体と話さず、結果は Harness に返す」は Cursor の worker と同じ形。judge を外した判断は、所有者の「判定器は要らない、人間が Lab で見る」と同じ方向。

## 3. 今回の設計との対応

| 今回の設計 | 実績ある系統での対応 | 一致 / 相違 |
|---|---|---|
| 隔離、固定ソース、broker | 全系統の container / sandbox | 一致 |
| 列挙役（AI）が入口・出口を洗い出し、script は道具 | Codex Security の threat model（AI が下書き、人間が編集）。Mythos は AI が file を点数付け | 一致。inventory を対象ごとに残して次回の文脈にする案は Codex Security の形 |
| 区画の切り方を AI が提案し、Harness は形と上限だけ見る | 記事の 3 系統は単位を Harness が固定（file、diff、entry point）。repo では Shopify、Anthropic recon、Cloudflare recon が AI に切らせている | 一致（同日午後に訂正）。「script の行を単位にし AI が順位だけ付ける」腕は効果測定の分母として残す |
| 追跡役は区画だけ読み、Finding / Lead を schema で返す | Cursor の worker、Anthropic の「目的・出力の形・道具・境界」を渡す子 | 一致 |
| Harness は出力の形を検査し、直した内容を記録 | Cloudflare の schema 再検査（直さず落とす）、Anthropic の JSON の欄の限定 | 一致（寛容さの差だけ） |
| 同じ経路を 1 つにまとめる（群） | Mythos は「file ごとに 1 体」だけが重複対策 | 今回の方が厚い |
| 組合せ役に Lead の全件を渡し、組むかは AI | 対応する公開例なし（PRISM / Argus の hypothesize に近い） | 測って決める |
| 段 1b で別の体がソースを読み直す | Mythos の最後の agent、Claude Code Security の自己反証、CodeMender の critique | 一致 |
| Lab と canary（logic bug の oracle） | Mythos「logic bug には oracle が無い」、Codex Security の sandbox 再現 | 一致。公開系統が持たない oracle を作っている |
| 人間が Lab で見て提出 | 全系統が人間の関門を最後に置く。Mythos は契約検証者が全件 | 一致 |

## 4. 持ち帰るもの

1. 分け方の線はそのままでよい。公開されている 5 系統すべてが「中身は AI、形と oracle と関門は Harness」で、Harness が中身を先に作る例は無い。
2. 区画の提案を AI に任せる形には先例がある（同日午後の訂正）。段階 1 の比較で「script の行を単位にし、AI は順位だけ」の腕を並べるのは、効果を測るためである。
3. inventory（列挙の結果）は使い捨てにせず、対象ごとに残して次回の文脈にし、人間が直せる形にする（Codex Security の threat model）。
4. Harness が agent 構成を持つことは、Cursor の worker と Anthropic の sectioning の実例がある。prompt で構成を頼む形（Root）より単純な側にある。
5. 効果の見積もり（どれだけ掘るか）は Anthropic も prompt に規則を埋めている。ここは今回も上限（時間、体数）を Harness に置くだけで、prompt に「最低 60 分」のような文を残さない方が公開例に近い。

## 出典

- Anthropic: [Mythos Preview research](https://www.anthropic.com/research/mythos-preview)、[Building effective agents](https://www.anthropic.com/research/building-effective-agents)、[Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)、[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)、[Claude Code Security](https://www.anthropic.com/news/claude-code-security)、[Project Glasswing](https://www.anthropic.com/glasswing)
- OpenAI: [Codex Security ヘルプ](https://help.openai.com/articles/20001107)、[Improving the threat model](https://learn.chatgpt.com/docs/security/threat-model)、[Introducing Aardvark](https://openai.com/index/introducing-aardvark)（403、二次資料: [The Hacker News](https://thehackernews.com/2025/10/openai-unveils-aardvark-gpt-5-agent.html)、[SD Times](https://sdtimes.com/ai/openai-announces-agentic-security-researcher-that-can-find-and-fix-vulnerabilities/)）、[Harness engineering](https://openai.com/index/harness-engineering)（403、二次資料: [The Neuron](https://theneuron.ai/explainer-articles/openais-harness-engineering-playbook-how-to-ship-1m-lines-of-code-without-writing-any/)、[調査記事](https://yage.ai/share/harness-engineering-survey-en-20260312.html)）
- Google: [From Naptime to Big Sleep](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html)、[CodeMender](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)
- Cloudflare: [Harnesses](https://developers.cloudflare.com/agents/harnesses/)、[Think + Workflows](https://developers.cloudflare.com/agents/harnesses/think/workflows/)
- Cursor: [Self-driving codebases](https://cursor.com/blog/self-driving-codebases)、[Simon Willison の要約](https://simonwillison.net/2026/Jan/19/scaling-long-running-autonomous-coding/)
