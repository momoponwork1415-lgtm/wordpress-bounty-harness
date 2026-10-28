# 探索プロンプトの分解と、Trial の中で誰が何をしたかを読む観測（2026-10-25）

「調べて報告」の記録。正本ではなく、SPEC・ADR・prompt・skill・コードを変えない。事実（コードと台帳、公開一次資料）と、この文書の提案を分けて書く。未公開 Finding の本文、payload、HTTP 記録は扱わない。

## 問い

所有者の問い（2026-10-25）は 3 つに分かれる。

1. 探索が `wp2shell-bounty-v8` という 1 本のプロンプトに依っていて、Root と子がそれぞれ何をしているかが外から見えない。Google Mantis のように複数の skill に分けるか、プロンプトの一部を Harness の制御に移せないか。
2. 子の寿命。Claude の子は 1 回 3 分ほどで終わるが、Codex の子は 50〜60 分同じスレッドが続く。1 子 1 仮説の短い寿命の方が探索の多様性が出るのではないか。
3. ただし wp2shell の記事は GPT-5.6、有償の実例は両 runtime にある。寿命の長短より、Root と子の役割分担がログから読めないことが問題で、改善に使える情報がまとまっていない。

## 先に答え

**まず「Trial の中身を読む観測」を足し、プロンプトの分解はその数字を見てから選ぶ。** 理由は 3 つ。

- 寿命が成果を左右するという対照実験は、公開資料にも本番台帳にも無い。wp2shell の記事は GPT-5.6、Elementor Pro の Austin Ginder 氏は Opus 4.8 で、有償の実例は長命スレッドの runtime と短命 one-shot の runtime の両方にある（[10-24 の整理](2026-10-24-wp2shell-article-first-deep-exploration.md)）。
- 「子が何をしたか」の記録は無いのではなく、封じてあるのに読む手段が無い。Root と子の全 transcript は Private Evidence にあり、Claude の Root transcript には子への委任文が平文で入っている。欠けているのは読取器と、役割名・委任文 digest の 2 項目である。
- 公開ハーネス 6 本は、どれも「orchestration・予算・schema・sandbox はコード、どこを読むか・どう判断するかは文章」で分けている。これは本リポジトリの [AGENTS.md「Harness と AI の責務」](../../AGENTS.md)と同じ線で、分解の仕方の参考にはなるが、入口の分割（partition）や dispatch を Harness に戻す根拠にはならない（[ADR 0034](../adr/0034-harness-control-only-deletions.md)、[LESSONS 14](../LESSONS.md)）。

## 1. 現状（事実）

### 1.1 Root に渡る文章

1 Trial で Root が受け取る文章は、[`wordPressDiscoveryPromptText`](../../src/cli/wordpress.ts) が 5 節を結合したものである。

| 節 | 出どころ | 版と digest |
| --- | --- | --- |
| 目的文 | [`wp2shell-bounty-v8.md`](../../src/profiles/wordpress/prompts/wp2shell-bounty-v8.md)、27 行 | `promptDigest` |
| Finding / Lead の出力契約 | Harness が Zod schema から生成（[ADR 0019](../adr/0019-generated-output-contract.md)、[`output-contract.ts`](../../src/profiles/wordpress/discovery/output-contract.ts)） | `contractDigest` |
| trust 境界 | 人間が書いた `trust-boundary-v1` | 固定 digest |
| Programme Boundary | 方針の写し | 方針の版 |
| ソースの場所 | 対象、WordPress core、PHP、依存プラグインの read-only mount。`/workspace/research` の書込可能な notes ディレクトリ | — |

目的文の最終段落「Before giving up, …」は、早く終わった Root を再開するときの固定の再開段落になる（[ADR 0036](../adr/0036-operator-resume-after-provider-refusal.md)）。

v8 の目的文は、記事原文（W0）の探索指針をほぼそのまま持つ。「多様な着眼点」「approach family の registry を持て」「停滞した経路は blocked」「非互換の経路を並走」「反証役を使う」「Root が統合・挑戦・方向転換・新ラウンド」は、すべて W0 の行である（[出典対照表](2026-10-13-prompt-source-comparison.md) 第 2 節 #8〜#16）。

### 1.2 子の形

| | Claude runtime | Codex runtime |
| --- | --- | --- |
| 子の起こし方 | Agent SDK の `Agent` tool。種別は全件 `general-purpose`。報告して消える one-shot | `spawn_agent` で永続スレッド。Root が `followup_task` で同じスレッドに追依頼 |
| 同時数と深さ | hook で同時 4 まで（[`claude-runner.ts`](../../src/discovery/claude-runner.ts)） | `agents.max_threads=4`、`agents.max_depth=1` |
| 子ごとの寿命（本番、10-20 監査） | 中央値 3.3 分、tool call 34、ファイル 6 | 中央値 53.9 分、tool call 229、ファイル 87。同一スレッドの `task_started` 中央値 19 回 |
| Root あたりの子 | 44 Root で 432 子（28 Root が累積 4 超） | 37 Root で 163 spawn、`followup_task` 2,706 回 |
| 子の役割の指定 | 無し（SDK の `agents` 定義も `.claude/agents` も渡していない） | 無し（`.codex/agents/*.toml` も渡していない） |

出典: [multi-agent 監査](2026-10-20-multi-agent-discovery-audit.md)、[短命の子の調査](2026-10-20-short-lived-discovery-agents.md)。

Codex CLI には子ごとの turn・時間・token の上限も one-shot の選択肢も無く、寿命は Root の追依頼の仕方で決まる（2026-10-21 に公式設定表で確認）。Claude の子は構造的に one-shot である。

### 1.3 子ごとに残る記録、読めない記録、取れていない記録

**残っているもの。** 子ごとの `discovery-run-started / finished`（親 run、Trial、wall、usage、読んだファイル数、tool call 数、結果と理由）、封じた transcript（Claude は `<session>.jsonl` と `subagents/agent-*.jsonl`、Codex は rollout）、子の最終報告（Finding / Lead を Root と独立に保存）、`/workspace/research` の内容の封印と再開時の復元（[`recover-agent-reports.ts`](../../src/discovery/recover-agent-reports.ts)、[`native-run-receipts.ts`](../../src/discovery/native-run-receipts.ts)、[`resume-trial.ts`](../../src/discovery/resume-trial.ts)）。

**残っているのに読む手段が無いもの。** Claude の Root transcript には `Agent` tool の呼び出し入力、すなわち子への委任文が平文で入っている。しかし「Root の判断 → 委任文 → 子の報告 → Root の次の判断」を 1 Trial の時系列として並べる読取器が無い。`ledger runtime` は Root の `requestedModelId` を集計するだけで、子を単位にした集計も無い。

**取れていないもの。** hook は `agent_type` を拾って `harness.child-start` に出すが、receipt にも台帳にも書いていない（`claude-native-agent-runtime.ts` に `agentType` の記録は無い）。委任文の digest も無い。Codex の初回委任文は rollout 内で暗号化されており、現在の回収器では取り出せない（監査の「判定不能 30 件」）。

**指示が無いので書かれないもの。** v8 は「approach family の registry を持て」と言うが書き先を指定しない。所有者改良版 W1 にあった「各 agent は `research/<family>.md` に書き、30 行以内で返す」「registry は `research/REGISTRY.md`、毎 wave の終わりに更新」（出典対照表 #10、#15）は、v7 で記事原文に寄せたときに落ちた。ディレクトリの用意、封印、再開時の復元は Harness 側に残っている。

### 1.4 `filesRead` の限界

Claude の `filesRead` は Read tool を十分に数えておらず、Root は 0 のままの run がある（[子 agent 形状の評価](../evaluation/2026-10-20-child-agent-shape-by-runtime.md)）。読取数を理解の深さや網羅率と呼ばない。

## 2. 公開ハーネスの分解の仕方（一次資料、2026-10-25 に repo の file を直接読んだ）

| 名称 | 分解の単位 | コードが持つもの | 文章が持つもの | 子の観測 | 子への受け渡し |
| --- | --- | --- | --- | --- | --- |
| [google/mantis](https://github.com/google/mantis) | 19 の method skill（`history → structural-index → architecture → threat-model → plan → researcher → dedupe → review → critic → reproduce → chain → patch → calibrate → reflect → report` ほか）。各 SKILL.md は同じ形で、`## Input/Output Contract` に `workspace/` の読む file と書く file を列挙 | 参照 harness（ADK）は SKILL.md を読まない。`workflow.json` の 19 node と決定論的な classifier で経路を決め、予算（`--max-time`、`--token-budget`、`--max-steps`）、node ごとの tool allow-list、Pydantic の verdict、SQLite の campaign / coverage 台帳、harness fingerprint を持つ | どこを読むか、何を critic するか、重複をどう束ねるか | `transcript.py` が 1 行 1 JSONL（prose / tool_call / tool_response / error、8,000 字で切る）。`reflector` は「finding id か trajectory の時点」を引用しないと書けない | node 内の fan-out は無い。並列は同じ逐次 campaign のコピー（`--parallel N`）。文脈は `get_plan` 等の tool と `workspace/` blackboard 経由。campaign の seed は `Evaluate {filepath}` の 1 行 |
| [anthropics/defending-code-reference-harness](https://github.com/anthropics/defending-code-reference-harness) | pipeline は Build → Recon → Find → Grade → Judge → Report → Patch。prompt は 1 段 1 Python module。skill は `threat-model / vuln-scan / triage / verify / patch` | `run_agent()` が `claude -p` を turn 上限付きで回し、429 は `--resume` で再試行。出力は XML tag を後ろから走査。PoC file が空なら「書いていない path を語った」として成果にしない。Grader は別 container で PoC bytes だけ受け取る | `find_prompt.py` の Environment / Task / Instructions / Out of scope / Output Format。`FOCUS_AREA_SECTION` 等の差し込み節 | run ごとに `find_transcript.jsonl`（CLI の stream-json、tool_result は切る）と `result.json`。「`"type":"tool_use"` で filter すれば子が打った command が見える」と `docs/pipeline.md` に明記 | Recon が `<focus_areas>` を 1 行ずつ出し、各行を「ここに集中」として find agent に**そのまま**渡す。`found_bugs.jsonl` を read-only で mount し、提出前に読ませる |
| [capitalone/vulnhunter](https://github.com/capitalone/vulnhunter) | `vulnhunt/SKILL.md` と `phases/phase1_recon.md`、`phase2_hunt.md`（dispatch 手順）、`phase2_shared.md`、class 別 3 file、`phase2b_verify.md`、`phase3_*`、`phase4_report.md` | tool 境界と I/O だけ。`scan.py` が `claude -p` に `--tools Read,Write,Edit,Grep,Glob,Agent` と結果 dir 限定の `--allowedTools` を渡し、`VULNHUNT_DIR` 等の metadata を prompt に注入 | fan-out の手順そのものが文章。「あなたは ORCHESTRATOR。結果 file を読むな。子の返答は 20 語以内」「partition × class group ごとに 1 子」「6 体ずつの wave」「失敗した子は『候補なし』ではなく『網羅不明』」 | 子の transcript は分けない。子が書く結果 file と 20 語の返答だけ。driver は stream-json 全体を 1 log に流す | 子は短い prompt で起こし、自分で `phase2_shared.md` と class file と partition data を読む。「orchestrator は内容を補間しない」 |
| [visa/visa-vulnerability-agentic-harness](https://github.com/visa/visa-vulnerability-agentic-harness) | S0 seed（コード）→ graph（コード）→ S1 前処理（コード）→ S2 threat model（LLM）→ S3 decompose（コード）→ S4 deep dive（LLM、unit ごと 1 session）→ S5 enrich（コード）→ S6 verify（LLM）→ S7 dedup（LLM 補助）→ S8 chain / rank → S9 report（コード） | 「決定論的な段が繰り返せる仕事、agent の段が判断」。S4 は `parallel` 12、`max_turns` 15、tool 予算。schema に外れた返答は有限回の再依頼か JSON 修復 | 17 の lens skill は「prompt の知識であり検出器ではない。skill 自体は finding を増やさない」。S4 は lens を 1 つまで読む | session ごとに JSONL（`transcript_open` → 連番 message → `transcript_close`）。段ごとの費用、unit ごとの結果 enum（`completed / error / guardrail / skipped / uninvestigated / failed / halted`）、報告に `## Scan Health` | 検出の段は委任しない。「各 unit は 1 session で走り、sub-agent の list は渡さない」。unit は S3 のコードが作る型付き `InvestigationUnit` |
| [Cloudflare VDH / VVS](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)（blog のみ） | Recon（3 並列、`architecture.md`）→ Hunt（攻撃 class ごと 1 task）→ Validate（決定論的な pass 1、反証だけする agent の pass 2）→ Gapfill → Dedup → Report | SQLite を `(run_id, repo, stage)` で持ち、候補 0 件の hunt を「shallow」として再投入、速すぎる hunt は crash 扱い。Validator は finding を出せない | hunter の scope は「repo × 攻撃 class」。threat model を先に書かせる順序を出力 schema で強制 | funnel の件数（raw 20,799 → validated 約 12,057 …）。transcript の記述は無い | 文章の task。worker 50〜200、repo ごとの task 上限 |
| [aws-samples/…steering-file](https://github.com/aws-samples/sample-ai-vulnerability-harness-steering-file) | `CLAUDE.md` 1 本（`.kiro/steering` と skill に同じ文の写し） | コード無し | 構造的な確認 4 点、triage の 5 手順、信頼度の重み、P0〜P3。「LLM の自己申告は confidence にしない」 | 無し | 無し（子を使わない） |

Shopify の記事と Night-Wolf の記事は今回取れなかった。Cloudflare の `security-audit-skill` repo も未読。

### 6 本に共通する形と、本リポジトリとの関係

| 共通点 | 本リポジトリの今 | 読み方 |
| --- | --- | --- |
| orchestration・予算・schema・sandbox はコード、「どこを読むか・どう判断するか」は文章 | 同じ線（AGENTS.md）。Mantis は参照 harness が skill を読まない極、VulnHunter は fan-out 手順まで文章の極 | 分解するなら文章側（prompt、skill、役割定義）で行う |
| fan-out の前に partition し、子には狭い brief を渡す。Root の transcript を子に渡す例は無い | v8 は partition を Root に任せる。Harness の partition・dispatch は ADR 0034 で削除済み | Harness に partition を戻さない。Root がどう brief を切っているかを**観測**する対象になる |
| run 中の blackboard（`found_bugs.jsonl`、`workspace/findings/`、`results/`、SQLite） | `/workspace/research` が同じ役。ただし v8 は使い方を指示しない | W1 の registry 行がこれに当たる |
| 子の記録 = CLI / ADK の JSONL transcript と構造化された結果 file 1 つ。`tool_use` で filter して子の行動を見る | transcript は封印済み。結果は最終報告の JSON。filter する読取器が無い | 読取器を足す |
| 反証だけする verifier を別文脈に置く。決定論的な事前確認（schema、引用 path の存在）を先に | 判定器と handoff skill（ADR 0035）。自己申告は証明にしない（不変条件 3） | 既に同型。変えない |
| 失敗は「候補なし」ではなく「網羅不明」 | `incomplete`（不変条件 4） | 既に同型 |

公開例のうち本リポジトリの規則と**衝突する**部分は、Harness 側の task queue と partition（Cloudflare、Visa S3、Mantis の campaign 分割）、validator agent の再現報告を確定にすること、候補を最終報告から隠す gate である。これらは [10-21 の整理](2026-10-21-public-harness-alignment.md) 第 3 節と同じ判断で採らない。

## 3. 寿命の問いについて

事実として言えるのは次のとおり。

- Claude の子は 3 分、Codex の子は 54 分という差は、runtime の構造（one-shot か永続スレッドか）と Root の追依頼の仕方の差であり、v8 が寿命を指定した結果ではない。
- Codex の 19 回の `task_started` が「同じ仮説への執着」か「別の仮説を 19 回渡した」かは、委任文が暗号化されているため台帳から判別できない。
- 有償の実例は両方の形にある。wp2shell（GPT-5.6、最大 4 子、6 時間超）と Elementor Pro（Opus 4.8、連鎖仮説 5 本を並走）。どちらも 1 事例で、寿命を変数にした比較ではない。
- 子を短くする行の出典は W1 の「80 tool call を超えない。近づいたら状態を書いて新しい子に渡す」（出典対照表 #14、whitebox v1.7 にも同じ趣旨）。Codex でこれを実現する手段はこの行だけで、Harness の設定では切れない。Claude では PreToolUse hook で子ごとの tool call を数えて止める形があり、これは「子の数・制限時間」と同じ数値の制御なので Harness 側に置ける。
- 逆の懸念も記録されている。複数 file や状態をまたぐ経路では、子の交代で文脈が落ちる（監査第 4 節）。Naptime も 16 step と 32 step で有利な条件が分かれる。

したがって寿命は、観測で「同一スレッドの追依頼が同じ仮説を繰り返している」と見えたときに、W1 の行を新しい版として開発 Trial で測る順にする。

## 4. 選択肢

### A. 観測を足す（Harness の制御の内側、agent に渡る文章は変えない）

**A1 読取器。** Private Evidence の transcript から 1 Trial の時系列を組み立てる読み取り専用の手順。並べるのは、Root の turn 番号、`Agent` tool の委任文の digest と長さ、子 id、子の wall・tool call・読んだファイル数、子の最終報告の Finding / Lead 件数、Root の次の turn がその子の報告を参照したか。Codex は委任文を `unavailable` とし、`followup_task` の回数だけ出す。報告書には件数と digest だけを書き、委任文の本文は Private Evidence の外に出さない。最初は `src/` に入れず、[本番監視の手順](../agents/production-monitoring.md)や [mirror 先例の集計 script](../../review-notes/) と同じく手順と scratch script で 10 Trial 分を読む。3 回同じ作業をしたら CLI にする（LESSONS 8）。

**A2 捕捉時の記録。** 子の receipt と `discovery-run-started.configuration` に役割名（Claude の `agent_type`、Codex は spawn 時の role 名）と委任文の digest を足し、委任文の本文を Private Evidence に封じる。Claude は hook が既に `agent_type` を出しているので経路は短い。Codex は暗号化のため `unavailable`。これは AGENTS.md の「観測は Harness が取る」に当たる。Step 1 の凍結（Harness 変更はバグ修正と削除）には追加なので、#424 と同じく所有者の例外が要る。

**A3 registry を書かせる行。** 目的文に W1 の 2 行を戻す。「各 agent は `/workspace/research/<family>.md` に書き、短く返す」「registry は `/workspace/research/REGISTRY.md`、毎 wave の終わりに更新」。これで approach family の一覧、blocked の理由、子ごとの結論が Trial 後に読める file になる。封印と再開時の復元は既にある。agent に渡る文章の変更なので新しい版（v9）、digest、出典対照、owner-approved、開発 Trial 3 回が要る（[DEVELOPMENT 第 5 節](../DEVELOPMENT.md)）。増えるのは 2 行で、LESSONS 2 の膨張には当たらない。

### B. 子に役割の名前を付ける（agent に渡る文章、owner-approved）

Claude Agent SDK の `agents` オプション、または Codex の `.codex/agents/*.toml`（`developer_instructions`）で、名前付きの子を定義する。名前は v8 が既に区別している 2 種、探索の子と反証の子（W0 #13「adversarial agents」）に限り、要素を足さない。Root がどちらを起こすかは Root が決める。効果は、`agent_type` が役割名になり、A2 の記録と合わせて「この Trial で反証の子が起きたか、いつ起きたか」が台帳から読めること。費用は、役割定義が agent に渡る文章になること、Claude と Codex で定義の置き方が違うこと、入力全体の digest が変わるので役割定義の digest を `contractDigest` と同じく別に記録する必要があること。SDK 0.3.296（pinned image）で `agents` が使えるかは実機確認が要る。

### C. 目的文を skill 群に分ける（Mantis / VulnHunter 型）

Root が sandbox 内の SKILL.md（たとえば recon、仮説、反証、報告）を読みながら進め、各段の成果を `/workspace/research` の file に置く形。各段の出力が file になるので可読性は上がる。ただし次の理由で今は選ばない。

- Mantis の参照 harness は skill を読まず、1 file 1 campaign で fan-out も無い。本リポジトリの Root＋4 子の動的な協調とは構造が違う。
- Eye Security は 12 段の技能書が最新モデルの agent を妨げ token を浪費し得ると書く（[10-23 の調査](2026-10-23-discovery-efficiency-review.md)）。LESSONS 1・2 も prompt を増やすと候補が減ると記録する。
- skill の順序を Harness が決めれば dispatch の復活になる。Root が選ぶ形に限る。
- PARKING に「Google Mantis など探索手法の切り替えを比較可能な戦略として扱う。再開条件は既定手法の実測分母と、比較する問い 1 つ」の行が既にある。A の数字がその分母になる。

### D. 採らないもの

Harness 側の partition・task queue・段の classifier（Cloudflare、Visa、Mantis）、validator の自己申告を確定にすること、候補を隠す gate、プロンプトへの対象固有名の追加。いずれも ADR 0034、不変条件 3、ADR 0018 に当たる。

## 5. 進める順番と測る数字

| 順 | 問い | 種別 | ゲート |
| --- | --- | --- | --- |
| 1 | 本番 10 Trial（Claude 5、Codex 5）で、Root は子に何を渡し、子の報告を次の判断に使ったか。委任文の digest の一意数 / 子の数、反証に当たる委任の有無、同一スレッドへの追依頼が別仮説だったか | A1。手順と scratch script。コード無し | 今日から。報告は件数と digest だけ |
| 2 | 役割名と委任文 digest を捕捉時に残すと、1 の集計が台帳だけで出るか | A2。Harness の観測の追加 | 所有者の凍結例外。PR 1 本 |
| 3 | registry と系統別メモを書かせると、Trial 後に approach family と blocked の理由が file で読めるか。候補の数と質は動くか | A3。v9、2 行 | owner-approved、開発 Trial 3 回、出典対照 |
| 4 | 1 で「同一スレッドの追依頼が同じ仮説の繰り返し」と出たとき、W1 の寿命の行で Codex の子は短くなり、source 根拠付きの重複しない経路は増えるか | 寿命の行。v9 とは別の版 | 同上。1 の結果が条件 |
| 5 | 1 で「反証の子が起きていない」「役割が区別できない」と出たとき、名前付きの子で変わるか | B | owner-approved、SDK の実機確認、開発 Trial 3 回 |
| 6 | skill 群への分解 | C | PARKING の既存行。1〜5 の分母ができてから |

測る数字は、Trial ごとの子の数、委任文 digest の一意率、役割の分布、子の wall と tool call の中央値、子由来の Finding が handoff と判定器の結論に届いた数、Root の最終報告が子の結論を引いた数。runtime と子の model で分母を分け、`incomplete` を候補 0 件に混ぜない。生の Finding 数は診断値にとどめる。

## 6. 未確認

- Claude Agent SDK 0.3.296 で `agents` オプションと `agent_type` の対応が実機で取れるか。
- Codex の rollout で委任文の暗号化を避ける保存経路があるか（公式設定表には見当たらない）。
- Shopify の Hunter / Verifier の分割と Night-Wolf の WordPress 記事は今回取得できず、表に入れていない。
- 寿命・役割名・registry のどれも、未知の有効な経路を増やす証拠はまだ無い。1 の集計が最初の分母になる。

## 7. 深掘りとロングテール（所有者の追加の問い）

所有者の見立て: wp2shell 型は、記事や Austin Ginder 氏の事例のように 1 対象を深く掘るのに向くが、多数のプラグインを薄く広く見るロングテールには向かないのではないか。

**事実。**

- 本番の形は 1 対象 1 Trial、最低 60 分・上限 120 分、同時 4 対象。10-21 時点で選定 136 対象のうち 130 が Root に到達し、正常完了 116 Trial だった（[選定から探索の確認](2026-10-21-selection-to-discovery-check.md)）。処理量は 1 日あたり数十対象が上限で、provider quota がそれを下回る日がある。
- ロングテールを歩いているのは探索ではなく選定である。install 帯の cascade（≥1M → 50k → 30k）と履歴の採点で対象を順に出す（[ADR 0037](../adr/0037-selection-uses-advisory-history-counts.md)）。候補の母集団の大きさと、1 週に消費できる対象数の比はまだ数字にしていない。
- 公開例では、広域と深掘りは別の仕組みとして置かれている。Wordfence は PRISM（広域）と Argus（単一対象の深掘り）を分けて説明する。WordPress プラグインの大量探索を公開した研究者（Dutafi、Eddie Zhang、hakluke、Kinorth）は、静的な規則や正規表現で候補行を集め、人が順に確かめる形で、深い多段の経路は取りこぼすと本人が書く（[10-24 の整理](2026-10-24-recent-ai-security-discovery-architectures.md)）。Carlucci 氏と stealthcopter 氏は、1 件の監査で理解した仕組みを多数のプラグインへ横展開する循環を説明する。
- 本リポジトリは、単独 screening で候補が出た対象だけを深掘りへ進める二段構えを ADR 0029 で退けた。未検証の一次陰性で協調探索の機会を失い、比較の分母も変わるため。`screening-v1` は archived のまま残っている。
- LESSONS 9: 量を増やしても報酬は増えなかった（Snapshot 483、選定 110、提出 1）。LESSONS 13: harness を作っている間は報酬が止まる。

**この文書の提案（採否は所有者）。**

| 案 | 中身 | 規則との関係 |
| --- | --- | --- |
| 7-a 処理量を先に数える | 候補の母集団（cascade の各帯に残る対象数）と、1 週に完了する Trial 数、provider 停止の割合を同じ表にする。ロングテールのどこまで届いているかを数字にしてから、探索の形を論じる | 読み取り専用。今日からできる |
| 7-b 横展開を skill にする | 判定器が確認した Finding の仕組みを、操作者が skill で手元のプラグイン群に横断検索し、当たった対象を選定の候補に足す。探索 agent には渡さない。Carlucci 氏・stealthcopter 氏の循環に当たる | 人間が回す skill。agent に渡る文章ではない。選定の入力を足すので、所有者の決定が要る（完了条件の「報酬が出るまで新しい選定・探索の仕組みを作らない」） |
| 7-c 広域 arm を別に置く | 対象ごとに短い Trial で Lead だけ集め、Lead のある対象を深掘り Trial へ優先する。二段構えに見えるが、陰性で深掘りを止めない点が ADR 0029 の退けた案と違う | 探索の仕組みの追加。6 段が通った後、比較の問いを 1 つ定めてから。分母は v8 と混ぜない |

順番は 7-a → 7-b → 7-c。7-a の数字が出るまで、深掘り型が向かないとも向くとも決めない。

## 8. model と effort（所有者の追加の問い: xhigh と Sol は要るか、Luna は使えるか）

本番台帳（連番は 2026-10-25 06:02 UTC まで）と Private Evidence の receipt を読み取り専用で集計した。Finding の本文は読んでいない。impact、攻撃者位置、`sourceTrace` の段数と file 数、前提文の有無、判定結果、run の model と effort だけを数えた。script は session の scratchpad にあり、Git には置かない。

**事実: 本番の effort は `high` で、xhigh は一度も使っていない。** host 設定 v5〜v8 の Codex profile はすべて `gpt-6-sol / high`、子も `gpt-6-sol / high`（`codex-sol-high-daybreak-blue-*`）。Claude は Root `claude-opus-5-5 / high`、子は 10-21 から `claude-sonnet-5-5 / high`。Luna が走ったのは 10-09〜10-11 の archived な短い prompt（`short-objective-v1`、`screening-v1`）だけで、v8 の協調 Trial では 0 回。

**scope 内 Finding 198 件の形。**

| 項目 | Codex Sol/high（143 件） | Claude Opus/high（53 件） |
| --- | ---: | ---: |
| impact 上位 | stored-xss 38、sensitive-object-access 44、other 19、account-takeover 14、options-update 11 | stored-xss 51、account-takeover 2 |
| `sourceTrace` 段数の中央値 | 8 | 13 |
| 関与 file 数の中央値 | 4 | 8 |
| core / PHP / 依存 source を引いた件数 | 82 | 48 |
| 前提文が「既定のまま」と読める件数 | 52 | 43 |
| 判定器 `runtime-confirmed` | 18（うち 12 は 10-10 の開発セット再発見、v8 では 6） | 7（Opus 子 2、Sonnet 子 5） |

段数は agent が書いた経路の frame 数であり、推論の難しさの尺度ではない。impact の 7 割が stored-xss と sensitive-object-access で、公開先例でも 1 関数の escape や capability 確認の欠落が多い種別である。所有者の「高い推論力を要する脆弱性には見えない」という読みと矛盾する数字は無い。ただし v8 で判定器まで届いた経路は、どちらの runtime でも 8〜25 frame、4〜16 file をまたぐ。見つける難しさは 1 関数の判断ではなく、読む幅と Root の統合にある。

**Root の run の usage（v8、completed の中央値）。**

| profile | run / completed | wall | 出力 token | うち reasoning | 入力（cache 込み） |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex Sol/high、子 Sol/high | 227 / 119 | 61 分 | 82k | 39k | 38.1M（cache 37.6M） |
| Claude Opus/high、子 Sonnet/high | 65 / 35 | 63 分 | 69k | 取れない | cache 5.25M |
| Claude Opus/high、子 Opus/high | 47 / 26 | 61 分 | 72k | 取れない | cache 5.96M |

Codex は subscription 認証なので、Luna への変更を API 料金の削減に換算しない（[監査 第 4 節](2026-10-20-multi-agent-discovery-audit.md)）。効くのは provider quota 下で完走する対象数である。

**Luna を使うための制約（コード）。** [`admitCooperativeRuntimeProfile`](../../src/discovery/agent-runtime-profile.ts) は、子を持つ run の Root を `codexModelCatalog.production`（`gpt-6-sol`）に固定し、`daybreak_blue` を要求し、子の model と effort が Root と同じことを要求する。したがって、Root Luna も、Root Sol + 子 Luna も、設定だけでは通らない。effort の `high → medium` は設定だけで変えられる。Codex 側の Root / 子の分離は PARKING（2026-10-21）に「6 段が通った後、token を下げる問いを 1 つ定めたとき」として置かれている。Luna と Daybreak Blue の併用可否は preflight が要る（監査 第 7 節 段階 1）。

**この文書の提案。** Claude 側で子を Sonnet に下げても Finding 数は落ちなかった（[子 model 実験](../evaluation/2026-10-21-child-model-experiment.md)。7 対象、各 1 Trial、検証未実施）。同じ形の問いを Codex に立てるなら、変える軸は 1 つずつにする。

| 順 | arm | 変更 | 測るもの |
| --- | --- | --- | --- |
| 1 | Sol/high → Sol/medium（Root・子とも） | 設定のみ | 完走数、wall、provider-limited、handoff に届いた Finding、confirmed |
| 2 | Root Sol/high + 子 Luna/high | admission の緩和（PARKING 行）と `agents.default_subagent_model` | 同上。子由来の Finding の confirmed を分けて見る |
| 3 | Root Luna + 子 Luna | `codexModelCatalog` の制約を profile の明示値に変える。Daybreak Blue の preflight | 同上 |

開発セットで対象 6、arm ごと最低 3 Trial（DEVELOPMENT 第 5 節）、同じ slug の反復は所有者の事前承認（ADR 0032 Q6）。分母は v8 Sol/high と混ぜない。「寿命を短くすれば Luna で足りる」は、Codex では寿命の行（第 3 節）と model の軸が同時に変わるので、別々に測る。

## 9. 最低 60 分の下限は要るか（所有者の追加の問い）

[ADR 0033](../adr/0033-minimum-exploration-and-pinned-dependency-sources.md) は「60 分の下限は所有者の運用判断であり、発見率の改善を証明した値ではない」と書く。台帳と receipt で分かる範囲は次のとおり（v8、first segment、2026-10-25 06:02 UTC まで）。

**下限は実際に効いている。** completed した first segment の wall は、Codex 79 件がすべて 55〜65 分、Claude 56 件のうち 36 件が 55〜65 分、20 件が 65〜90 分。55 分未満で正常終了した Trial は 0。下限の無かった v5 は中央値 7 分だった。Root は許されれば早く終える。

**下限の前後で何が増えたかは記録が無い。** Root の早い最終報告の後の継続は同じ run の中で起きるので、台帳には「最初の最終報告が何分に出たか」「その後に受理した Finding が何件か」が残らない。[10-20 の報告 3.10](2026-10-20-design-issues-from-production-results.md) が同じ欠落を指摘し、receipt への 2 項目の追加を提案している。未実施。

**子由来の Finding の時刻（Claude だけ読める）。** 子の receipt の完了時刻を Root の開始からの分で見ると、Finding を返した子 29 体の完了は中央値 19 分、p75 29 分で、45 分以降は 0。判定器が確認した子由来 4 件も全部 45 分より前。Codex の子は 54 分前後まで生きて最後に報告するので、この時刻は読めない。Root 自身の Finding はどちらの runtime でも最終報告にしか無く、時刻は不明。

**同じ Codex Sol/high での prompt 版ごとの比較（confound あり）。**

| prompt | completed Trial | wall 中央値 | 出力 token 中央値 | Finding / Trial | confirmed / Trial | Lead / Trial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v5（下限なし、10-16〜17） | 111 | 7 分 | 15k | 0.04（parked 42 は別） | 0 | 3.5 |
| v8（下限 60 分、10-18〜25） | 79 | 61 分 | 74k | 0.32 | 0.051 | 2.1 |

v5 と v8 は目的文、source pack（PHP と依存の追加）、対象、parked 振り分けの時期が違うので、下限の効果とは言えない。10-10 の開発セットで 5 分の短い prompt が confirmed を出した行は、既知の再発見であり分母が違う。

**下限を外すときに触るもの。** 下限は campaign 設定ではなく [`wordpress.ts`](../../src/cli/wordpress.ts) の定数 `WORDPRESS_DISCOVERY_MINIMUM_ACTIVE_MS`。目的文の最終段落「Before giving up, use at least one hour」は、ADR 0036 の再開でも使う固定の再開段落なので、下限を外す版は再開段落の扱いも決める必要がある（prompt v9 とコードの両方）。

**この文書の提案。**

1. 先に観測を足す。receipt に「Root の最初の最終報告の時刻」と「その後に受理した Finding / Lead の数」を残す（10-20 の 3.10）。Harness の観測であり、agent に渡る文章は変えない。10 Trial 分で、継続区間が候補を足しているかが初めて分かる。
2. 数字が「継続区間の候補はほぼ 0」なら、下限を外した v9 と下限 0 を開発セットで測る。軸は下限 1 つ。arm ごと 3 Trial、分母は v8 と混ぜない。
3. LESSONS 3（時間をかけても成果は増えない）と、子由来の確認済み Finding が 45 分以内に出ている事実は、下限を短くする方向と矛盾しない。ただし Root の統合と反証が終盤で起きるかは 1 の観測が無いと言えない。

## 10. 探索を 3 つの mode にする（所有者決定 2026-10-25「それでいこう」）

所有者は、探索方式を置き換えるのではなく、既存の v8 を 1 つの mode として残し、大量探索向きの mode を足す形を選んだ。切り替えの実装は Google Mantis に倣い、agent が途中で方式を選ぶのではなく、外側の設定値・構造化された数・前段が書いた file で決める（Mantis の scan mode flag、verdict だけで分岐する classifier node、`mantis-plan` が書き `mantis-researcher` が読む `workspace/plan.json`）。

| mode | 目的文 | 下限 / wall | 入口 | 状態 |
| --- | --- | --- | --- | --- |
| `wide` | 新版（短い。出典対照表の行だけで組む） | 下限なし / 20 分程度 | 選定が出した新規対象の既定 | 新規。owner-approved と開発 Trial 3 回 |
| `deep` | `wp2shell-bounty-v8` のまま。digest も変えない | 60 分 / 120 分 | 再訪列から | 現行 |
| `sweep` | prompt ではなく操作者が回す skill | — | 判定器が確認した 1 件の後 | 新規 skill。選定への入力は所有者決定 |

**切り替えの 2 段。**

1. 機械的な規則（選定の層、数だけで決める）: `wide` の Trial が Lead を N 件以上残した対象、`sweep` で当たった対象、confirmed を出した対象の次版を `deep` の再訪列に入れる。閾値は選定方針の数値（cascade と同じく変えてよい数字）。
2. 名指し（運用）: 所有者か運用の AI が `campaign run --mode deep` で対象を名指しし、理由を Issue のコメントに残す。

Trial の途中で mode は変えない。mode は Trial の属性として `configuration` に残し、比較の分母を混ぜない。

**`wide` の目的文の組み方。** 本文は PR で owner-approved の審査に出す。この文書には要素の出典だけを書く（[出典対照表](2026-10-13-prompt-source-comparison.md) 第 2 節の行番号）。

- v8 から残す行: #1 前提なし、#7 既知情報の禁止、#8 多様な着眼点（短い形）、#11 一案支配の禁止、#13 反証の確認、#17 子の数 4、#18 依存 source、#26 入口と着地の 2 hop 以上。
- W1 から足す行: #14 子を短命にし状態を書いて引き継ぐ、#15 `research/<family>.md` と `REGISTRY.md`、#20 停止条件「2 wave 連続で新しい系統も候補も無ければ終える」、#25 0 件は正常終了。
- v8 から外す行: #12 非互換経路の複数ラウンドと cross-pollinate、#20 の最低 1 時間の段落。
- 本文に書かないもの（Harness が節として渡す）: 出力契約（ADR 0019）、trust 境界、Programme Boundary、source の場所。対象固有の名前は入れない。

**要る変更。** campaign 設定の mode 値と台帳の `configuration` への記録、`wide` の目的文（新版・digest・出典対照・owner-approved・開発 Trial 3 回）、下限なし mode で再開段落（最終段落「Before giving up,」）を要求しない経路（ADR 0036 の拒否後再開との整合）、再訪列への機械的規則（選定方針の数値、ADR 0037 の追記）、`sweep` skill。v8 本文と digest は触らない。

**所有者決定が要る 2 点。** Lead を再訪 score に入れること、`sweep` の結果を選定候補に足すこと。どちらも選定の入力を足す（完了条件「報酬が出るまで新しい選定の仕組みを作らない」の例外）。Issue に起こす。

## 参照

- 正本と規則: [SPEC §2・§6](../SPEC.md)、[AGENTS.md](../../AGENTS.md)、[ADR 0019](../adr/0019-generated-output-contract.md)、[ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md)、[ADR 0034](../adr/0034-harness-control-only-deletions.md)、[ADR 0036](../adr/0036-operator-resume-after-provider-refusal.md)、[LESSONS](../LESSONS.md)、[PARKING](../PARKING.md)、[DEVELOPMENT §2・§5](../DEVELOPMENT.md)
- 先行する報告: [出典対照表](2026-10-13-prompt-source-comparison.md)、[multi-agent 監査](2026-10-20-multi-agent-discovery-audit.md)、[短命の子](2026-10-20-short-lived-discovery-agents.md)、[公開ハーネスの共通点](2026-10-21-public-harness-alignment.md)、[公開ハーネスの横断調査](2026-10-23-public-vulnerability-harness-landscape.md)、[探索効率の調査](2026-10-23-discovery-efficiency-review.md)、[wp2shell 記事からの深掘り案](2026-10-24-wp2shell-article-first-deep-exploration.md)
- コード: [`wordpress.ts`](../../src/cli/wordpress.ts)、[`claude-runner.ts`](../../src/discovery/claude-runner.ts)、[`claude-native-agent-runtime.ts`](../../src/discovery/claude-native-agent-runtime.ts)、[`codex-native-agent-runtime.ts`](../../src/discovery/codex-native-agent-runtime.ts)、[`recover-agent-reports.ts`](../../src/discovery/recover-agent-reports.ts)、[`native-run-receipts.ts`](../../src/discovery/native-run-receipts.ts)、[`output-contract.ts`](../../src/profiles/wordpress/discovery/output-contract.ts)
- 公開一次資料: 上の表の各リンク。読んだ file は repo の `HEAD` の raw file（2026-10-25）
