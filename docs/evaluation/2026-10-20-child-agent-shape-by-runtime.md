# 探索の子 agent の形は runtime で何が違うか（2026-10-20）

本番台帳 `~/.local/state/wordpress-bounty-harness/ledger.sqlite` の 2026-10-18T16:00Z〜2026-10-20T04:30Z を読んだ実験記録。prompt は両 runtime とも `wp2shell-bounty-v8` で同じ。Root と子のモデル・effort は host 設定の `runtimeProfile` で、Codex が `gpt-6-sol` / `high`（子も同じ）、Claude が `claude-opus-5-5` / `high`（子も同じ）。本文、payload、手順は読んでいない。台帳の件数と観測値だけである。設計課題の全体は [reviews/2026-10-20-design-issues-from-production-results.md](../reviews/2026-10-20-design-issues-from-production-results.md)。

## 1. 問い

同じ prompt、同じ上限（同時に子 4 体まで、最低 60 分）で、Codex と Claude の Trial は同じ形になるか。ならないなら、何が違いを作っているか。

## 2. 結果

### 2.1 Trial の形（completed の Trial だけ）

| | Codex（`codex-native/v1`、runtimeShare 導入前の無印 33 件を含む） | Claude（`claude-code/v1`） |
| --- | ---: | ---: |
| Trial | 43 | 21 |
| Root の wall（中央値） | 61 分 | 61 分 |
| Root が読んだ file（`uniqueFilesRead` 中央値） | 75〜90 | 1（観測できていない。第 4 節） |
| 1 Trial の子の数（中央値） | 4 | 18（最大 25） |
| 子 1 体の wall（中央値） | 54〜55 分 | 3 分 |
| 子 1 体が読んだ file（中央値） | 99〜114 | 6 |
| 子 1 体の tool 呼び出し（中央値） | 287〜316 | 34 |
| 子 1 体の出力 token（中央値） | 57〜69k（推論 24〜29k を含む） | 14k（推論は provider が返さない） |

### 2.2 成果の出どころ（Finding 42 件、Lead 465 件）

| 出どころ | Finding | Lead |
| --- | ---: | ---: |
| Codex の Root | 11 | 98 |
| Codex の子 | 7 | 44 |
| Claude の Root | 8 | 162 |
| Claude の子 | 16 | 210 |

Codex では Finding の 4 割、Claude では 3 分の 2 が子から出た。schema に外れて保留になった Finding 6 件と Lead 30 件は、どちらの runtime でも全部子の出力である（子は本文で答えるので schema に外れやすい）。

### 2.3 子 run の失敗

子 run 686 件のうち 72 件（10.5%）が `child-final-message-not-report` で報告を失った。Codex 側の 55 件は 2026-10-19T02 台の 1 時間に 40 件が集中し、Claude 側は 10-19 以降も 1 日 8 件前後続く（#276）。

## 3. 違いを作っているもの

主因は Harness 側の「子の作り方」で、モデルの性格の差はその上に乗っている。

| | Codex | Claude |
| --- | --- | --- |
| 子の実体 | Codex ネイティブの `thread_spawn`。常駐するスレッドで、Root が後から続けさせられる | Claude Code 組み込みの汎用 `Agent` ツール。1 回の依頼に 1 回答えて終わる |
| 続行 | できる | できない。Opus runtime を入れたとき、子への `SendMessage` 続行と専用 worker の説明文は「agent に渡る文章が増える」ので外した（[reviews/2026-10-19-opus-runtime-plan.md](../reviews/2026-10-19-opus-runtime-plan.md)「捨てるもの」） |
| 文脈 | 子は Trial の間ずっと自分の文脈を持つ | 子は毎回まっさらで始まり、答えたら消える |
| 「同時 4 体」の効き方 | 常駐なので総数も 4 | 1 体が 3 分で返るたびに枠が空くので、同じ上限で総数が 20 を超える（`src/discovery/claude-runner.ts` の `MAX_CHILDREN` は同時数） |

Codex の子は Root と同じ規模の「もう 1 本の探索者」で、1 時間かけて 100 file 以上読む。Claude の子は短命なので広い探索を任せられず、仕事を小さく切って何度も投げる形になる。SPEC §6 の「Root＋最大 4 子」は Codex の挙動を前提に書かれ、Claude ではコードが「同時 4」になっている（設計課題 3.5）。

「ツールの形」と「モデルの癖」はこのデータでは分離できない。分けるなら、Claude 側に子の続行を戻して Trial を 3 本回し、子の数と wall が Codex に寄るかを見る。prompt 本文は変えず、runner の配線だけで試せる。

## 4. 観測の欠け

- Claude の Root は Read ツールで source を読むが、`observed.filesRead` は command 記録（Bash）から数える（`observedFromCommands`）。`toolCalls: 48` でも `filesRead: 0` と記録され、Opus の Root が読んだ量は台帳に無い。
- Claude の `usage.inputTokens` は 100 前後で、実体は `cachedInputTokens`（1 run で 300〜900 万）に入る。runtime をまたいで input token を足すと Claude が過小に見える。
- `childThreadsObserved` は全 run で未記録（#332）。

## 5. 所有者の決定（2026-10-20）

- この記録をリポジトリに残す。
- 所有者が求める探索の形は **Claude 側（短命な子を多数使う形）**で、これを主経路にしたい。
- その上で Root と子のモデルを変えて比べたい。所有者の言葉は「luna max」と「sonnet 5.5 high」。

今の設定とコードで何が要るか:

| 組み合わせ | 必要なもの |
| --- | --- |
| Codex `gpt-6-luna` / effort `max` | host 設定の `runtimeProfile` だけ。`gpt-6-luna` と `max` は `agent-runtime-profile.ts` の enum にある。profile digest が変わるので台帳で区別できる |
| Claude `claude-sonnet-5-5` / `high`（Root、子、または子だけ） | コード変更が要る。Claude の profile schema は `requestedModelId` と `subagent.modelId` を `claude-opus-5-5` の literal に固定しており、broker も結び付けたモデル以外を `model-not-admitted` で断る。enum を広げ、子のモデル検査（transcript のモデル名照合）を profile に合わせる PR 1 本 |
| 「短命な子」を Codex 側で | 今の配線では不可。Codex の子は常駐スレッドで、one-shot にする配線は無い |

比較の分母は runtime とモデル profile で分け、Codex の子 4 体と Claude の子 20 体を同じ列に数えない。

## 6. この記録で決めていないこと

- 短命な子と常駐の子のどちらが未知の発見に効くかは、confirmed の数が出るまで分からない。confirmed 3 件（Codex 2、Claude 1）は分母が小さすぎる。
- Claude の confirmed が子由来か Root 由来かは数えていない。
- 子のモデルを 1 段安くしたときに Finding と confirmed が落ちるかは未測定。
