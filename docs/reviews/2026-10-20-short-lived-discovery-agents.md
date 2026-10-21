# 探索の子を短命の独立試行にするか（2026-10-20）

正本ではない。公開された一次資料と、本番台帳のメタデータを基にした調査報告。「短命」は、限定した仮説や領域を調べて結果を返し、必要なら次の子に引き継ぐ構成を指す。何分・何 tool call で切るべきかは、この報告では決めない。

## 公開資料で確認できること

| 実例 | 構成と結果 | この問いへの限界 |
| --- | --- | --- |
| [Google Project Zero の Naptime](https://projectzero.google/2024/06/project-naptime.html) | 複数仮説を一つの長い軌道で追うより、独立した試行を使う。仮説をコード閲覧・実行で調べ、検証器の結果を受けて修正する。 | 主に C/C++ の variant analysis。16 step の試行を基本としつつ、32 step が有利な条件も報告しており、一律の短い上限は支持しない。 |
| [Anthropic の Mythos Preview による探索](https://www.anthropic.com/research/mythos-preview) | 隔離した Claude Code agent を多数並列に動かし、異なるファイルに注目させて重複を減らす。別の agent が発見の実在性と重要性を確認し、専門家がレビューする。 | 子の適切な寿命や WordPress での発見率は示していない。 |
| [Anthropic Research の multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system) | lead が調査を分け、並列の子の結果を統合する。Opus lead と Sonnet 子の構成を評価した。 | 一般調査の例。脆弱性探索における Luna や短命化の効果は測っていない。 |
| [OpenAI の multi-agent 指針](https://developers.openai.com/api/docs/guides/agents-api/multi-agent) | 独立して境界を明確にできる仕事に子を使い、依存関係の強い短い仕事は親が行うという構成を案内する。 | 実装の指針であり、診断業界での採用率や最適な子の寿命を示す調査ではない。 |

公開事例では、独立した仮説・領域を並列に調べ、得た候補を別の検証にかける構成が見られる。ただし、**AI 診断全体で最も普及している方式は、これらの資料からは分からない**。本 Harness の判定器は agent の自己申告を根拠にしないため、事例の「別 agent による確認」をそのまま採用する話でもない。[SPEC §2](../SPEC.md)

構成自体を比較した[2026 年の制御実験](https://arxiv.org/html/2604.18718)では、20 個の小さな web/API・binary 対象、600 run、5 構成のうち、通信せず独立に調べる 3 agent 構成の確認済み検出率が 64.2%、単独 agent が 50.8% だった。一方、確認 1 件当たりの API 費用はそれぞれ $0.143 と $0.058 で、単独 agent の方が低かった。各対象に主たる脆弱性を 1 件置く小規模ベンチマークなので、本リポジトリの未知 WordPress 脆弱性探索への効果は推定できない。この実験も子の寿命そのものは比較していない。

## 本番で観測できること

本番台帳の連番 7915 までを読み取り専用で集計した。2026-10-19 00:00 UTC 以降の `discovery-run-started` のうち、`parentRunId` があり、`configuration.runtime` が明示された子を、`(campaignId, runId)` で終了イベントと結合した。旧イベントの runtime 未記載分は除外し、終了イベントの `wallTimeMs` の中央値を取った。集計値は台帳イベントだけから算出した。

| Runtime | 子 run | completed | failed | wall 中央値 |
| --- | ---: | ---: | ---: | ---: |
| Claude Code / Opus | 432 | 399 | 33 | 3.34 分 |
| Codex-native | 151 | 147 | 4 | 53.94 分 |

これは**現行の Claude Code / Opus の子が実際に短い**ことを示す。Opus というモデルの性質だけで短くなったことは示さない。runtime、Root の委譲、対象、時期、provider が揃っていない比較であり、両群の後続検証にはまだ `runtime-confirmed` の比較材料がない。`incomplete` を陰性として数えない。[SPEC §6](../SPEC.md)

過去に取り込んだ [WP2Shell の原文](../knowledge/imported/wp2shell/PROMPT.template.txt) は子を 80 tool call 以下にし、状態を記録して引き継ぐよう明示する。現行 [v8 目的文](../../src/profiles/wordpress/prompts/wp2shell-bounty-v8.md) は Root が wave を繰り返すが、子の寿命を数値で固定していない。したがって本番の短い子は v8 が「80 call 上限」を実施した結果ではない。

## 判断と比較順

Root が経路の統合と反証を続け、子には範囲の明確な探索を委ねる方式は試す価値がある。複数ファイルや前提状態をまたぐ経路では、子の交代で重要な文脈が落ちる可能性もある。まず Root・子の役割と v8 を固定し、子の `gpt-6-sol` と `gpt-6-luna` を別の開発 Trial で比べる。現行 profile は Root・子の model 一致を要求するため、この比較にも runtime profile と契約の変更が要る。次に子の寿命・委譲粒度を変えるなら、モデル、Snapshot、対象、総 wall、判定基準を揃えて別の問いとして測る。[子モデルの評価](2026-10-20-discovery-child-model-assessment.md)

短命化を子への指示として固定する場合は、現行 v8 の文面と digest を保ったまま混ぜない。新しい prompt 版と出典対照、開発 Trial の数字が必要になる。Harness に探索順序や交代の判断をコード化しない。現在の Step 1 第 2 週の問いはレビュー batch の時間と件数なので、この案はその問いと混ぜず調査段階に置く。[SPEC §6](../SPEC.md)、[DEVELOPMENT §2–5](../DEVELOPMENT.md)

## ログと比較可能性

子ごとの `discovery-run-started/finished`、親・Trial、結果と理由、wall、usage、tool / source 観測、receipt digest は既に残る。Finding / Lead も生成した `runId` に結び付く。[子 report の回収](../../src/discovery/recover-agent-reports.ts)、[ledger schema](../../src/ledger/index.ts)。まずこれらを読む**子単位の読み取り専用集計**を作れば、Trial ごとの子数、寿命の分布、並列数、usage、schema / provider 失敗、子由来候補の後続判定を、runtime と子用 model ごとに比較できる。`completed` と各種 `incomplete` を分母で分け、観測値が `unavailable` の run を明示する。Finding / Lead の生件数だけでは、質や報奨への寄与を表せない。

集計前に次の意味のずれを解消する必要がある。

1. 子の start と finish の台帳 `occurredAt` は同じ Root 側の時刻で記録される。wall は `wallTimeMs`、重なりは Private Evidence の receipt の `startedAt/completedAt` を使う。[子 report の回収](../../src/discovery/recover-agent-reports.ts)、[台帳の読み方](../agents/ledger-reading.md)。
2. receipt の時刻にも、Codex の終了イベント欠落時や Claude transcript に時刻が無いときの代用値がある。並列度を出す際はその信頼性を表示し、代用値を正確な開始・終了として扱わない。[Codex runtime](../../src/discovery/codex-native-agent-runtime.ts)、[Claude runtime](../../src/discovery/claude-native-agent-runtime.ts)。
3. 現行 `ledger runtime` は receipt の `requestedModelId` を集計し、`subagent.modelId` を表示しない。Root Sol・子 Luna の比較では子の実モデルで群を分ける。[runtime 集計](../../src/discovery/recorded-runtimes.ts)、[receipt](../../src/discovery/native-run-receipts.ts)。
4. `observed.filesRead` は tool/command からの推定値で、実際に理解した source の網羅率ではない。両 runtime で Read・search・shell の数え方を確認してから、読取量を補助指標に使う。[観測器](../../src/discovery/codex-native-agent-runtime.ts)、[Claude tool 変換](../../src/discovery/claude-native-agent-runtime.ts)。

さらに比較で必要になるのは、子に与えた仕事と引き継ぎ内容の識別、同じ経路を複数子が重複したかの判断、後続の判定とレビュー結果までの lineage である。文章・payload・未公開候補・実行記録は Git 外の Private Evidence に置き、台帳には digest 参照と比較に必要な型付きメタデータだけを残す。探索方針の分類や候補の真偽を Harness が推測しない。[SPEC §2・§12](../SPEC.md)
