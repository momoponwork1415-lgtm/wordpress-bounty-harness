# 公開 repo 3 本と運用記事から読む「決定論と AI」の分け方（2026-10-27）

「調べて報告」の記録。正本ではない。所有者の問い（2026-10-27）: 「中身は AI、形は Harness」という分け方は、実績のある公開 harness ではどう実装されているか。記事だけでなく repo を読む。過去に調べた資料も合わせる。

## 0. 過去の調査との関係

同じ対象を別の問いで読んだ資料が 6 本ある。今回はそれらを繰り返さず、**どこを code が強制し、どこを model に任せているか**の 1 点だけを repo の行で確かめた。

| 資料 | 問い | 今回との関係 |
|---|---|---|
| [2026-10-11 公開ハーネス比較](2026-10-11-comparison-with-public-harnesses.md) | 当時の設計のどこが厚く、どこが薄いか | 公開例が投資する 4 点（独立で安い run を多数、model の外の判定、同根の重複を畳む、人間が最後）。今日も変わらない |
| [2026-10-13 Anthropic・Mantis・Cloudflare の source notes](archive/2026-10-13-anthropic-mantis-cloudflare-source-notes.md) | 3 repo から今役立つ事実 | 当時の commit（Anthropic d3bea6b、Mantis 2b3bbdc、Cloudflare c1c8a8c）。今回 Mantis だけ f3162c0（10-25）に進んでいた |
| [2026-10-17 外部ハーネス実践との照合](archive/2026-10-17-external-harness-practices.md) | 大手・研究で共通するもの | 「網羅は Harness が配る」を提案し、ADR 0034 で採らなかった。今日の設計はこれを **AI が列挙し Harness は形と割り当てだけ** という形で再び入れる（§4） |
| [2026-10-21 公開ハーネスの共通点](2026-10-21-public-harness-alignment.md) | 共通点 5 つを設計へ | 短命の子、発見と検証の分離、重複排除、model の階層化、検証が律速 |
| [2026-10-23 横断調査](2026-10-23-public-vulnerability-harness-landscape.md) | 公開コードと運用の全体像 | Visa VVAH、VulnHunter、Shannon、Crucible、GCP reference-harness など。今回は触れない |
| [2026-10-24 Intruder 以降の構成](2026-10-24-recent-ai-security-discovery-architectures.md)、[2026-10-24 候補選別の分担](2026-10-24-validation-screening-patterns.md) | model 分担と選別の位置 | Shopify、AVDH、Night-Wolf、Quarkslab、HackerOne、AWS。Shopify と AVDH は今回一次資料を読み直した |

前世代の知識（[reference-harness-observability.md](../knowledge/imported/09-wordpress-harness/knowledge/reference-harness-observability.md)、2026-09）も同じ 3 repo を読んでいる。

## 1. 結論

5 つの公開実装（Anthropic 参照 harness、Google Mantis、Cloudflare skill と VDH / VVS、Shopify、Mandiant AVDH）はどれも、**判断は model、形・同一性・上限・oracle・記録は code** で分けている。所有者の規則と同じ線である。repo の行で確かめた分、10-27 午前の[記事ベースの報告](2026-10-27-established-harness-responsibility-split.md)より 3 点を訂正・補強する。

1. **「区画の切り方を AI に提案させる」には先例が 3 つある。** 午前の報告では公開系統より一歩先と書いたが、誤りだった。Shopify は agent が file を「context の 20〜30%」「関連する domain・目的・機能」で group にして JSON を出す。Anthropic 参照 harness の recon は agent が「信頼できない入力を処理する 5〜15 の subsystem」を出し、Harness は round-robin で割り当てるだけ。Cloudflare skill は recon の 4 体が「入口 × 信頼境界 × subsystem × 攻撃分類」の単位を出し、親は形を検査して割り当てる。**AI が切り、code は検査と割り当てだけ**は確立した形である。
2. **機械の索引や床は「HINT であって verdict ではない」と明記され、agent の道具として置かれる。** Mantis の構造索引は `find_symbol` などの tool で、「索引は HINT。呼び出し元なしは索引済みの呼び出し元なし、の意味」。Anthropic の決定論の dedupe key は「決定の入力ではない。agent が raw ASAN から意味的重複を判断する」。所有者の「script は AI の道具、床は渡さない」と同じ扱いである。
3. **重複と組合せは別物として扱われている。** 同一性（dedupe）は code が候補一覧を作り agent が最終判断する（Cloudflare VVS の転置索引、Mantis の Tier 1〜3 key、Anthropic の「判断は agent、判断が行われたことの強制は pipeline」）。組合せ（chain）は Mantis でも agent が仮説を書き、code は鎖の各環の verdict を決定論で settle するだけ。**同一性の候補は code、組の候補は AI**、という所有者の切り分けと一致する。

## 2. repo ごとの分け方（行で確認）

clone は 2026-10-27 に取った。Anthropic `d3bea6b5793b`（2026-08-06、保守終了）、Mantis `f3162c039ecd`（2026-10-25）、Cloudflare skill `c1c8a8c14710`（2026-09-14）、Anthropic review action `0c6a49f1fa56`（2026-02-11）。読んだだけで実行していない。

### 2.1 Anthropic defending-code-reference-harness

| code が強制する | model が決める |
|---|---|
| gVisor で `claude -p`、sandbox 無しなら起動拒否（`harness/sandbox.py:117-138`）。「制約は prompt でなく code で強制する」（`docs/security.md:33-34`） | recon: 「5〜15 の subsystem」の切り方（`harness/prompts/recon_prompt.py:25-33`） |
| 割り当て: focus area を run 番号で round-robin（`harness/cli.py:560-566`）。体数は操作者の `--runs` | find: どこを読むか、入力の作り方、PoC の構築と最小化。prompt は「形」を言い「bug の型の一覧」は言わない（「列挙すると recall が下がる」`docs/prompting.md:23-32`） |
| 段の境界: 「image tag が trust 境界。段をまたぐのは PoC の byte だけ」（`harness/grade.py:3-9`） | grade: PoC を走らせて PASS / FAIL を出すのは agent。code は parse だけ（`grade.py:86-99`） |
| 出力の形: XML tag を parse、`<dup_check>` が無ければ run を却下 | dedupe: find の `<dup_check>`、judge の NEW / DUP、compare の正本選び。「agent が判断する（根本原因を知っているのは agent で、regex ではない）。pipeline は判断が行われたことを強制する」（`cli.py` 付近 296-299） |
| oracle: ASan。3/3 再現、OOM / timeout 不可（`find_prompt.py:51-55`）。patch の確認は実行の梯子、「ASAN が決める、agent ではない」（`patch_grade.py:13`） | 重大度（report agent）。triage skill では前提の数と到達権限の固定表から導く（`triage/SKILL.md:708-724`） |
| checkpoint、resume 上限 20 回、`found_bugs.jsonl` を兄弟に見せる | threat model の下書き（bootstrap の並列調査 → 合成）。人間は interview で直す。「model は code の文脈は持つが、我々の文脈は持たない」（`docs/blog-post.md:52`） |

数字: 「敵対的 verifier を足すと悪用不能の報告が約半分に。verifier に PoC も作らせると偽陽性はほぼ 0」（`blog-post.md:112`）。「発見は並列化が簡単になり、律速は検証・triage・patch に移った」（`:3`）。logic bug は「PoC でなく論理で証明するので、より高い基準の 1 人の reviewer に回す」（`docs/pipeline.md:196-199`）。

### 2.2 Google Mantis

| code が強制する | model が決める |
|---|---|
| graph の順（history → 索引 → architect → threat model → planner → researcher → gate → dedupe → reviewer → critic → reproducer → chainer → patcher → …、`reference/workflow.json:24-171`）。「agent が critic を呼び忘れて飛ばせない、より決定論的な critic 段の方が良い結果になる」（`README_AGENTS.md:632-659`） | KB・architecture・threat model の文、plan の対象と問い、campaign の中で何を読むか、仮説、Finding（`reference/core/prompts.py:50-78`） |
| surveyor の順位付けは「LLM を呼ばない。5 つの測れる信号の重み付き式」（`surveyor.py:15-19`）。構造索引は tree-sitter で決定論、agent には tool として渡す。「索引は HINT」（`structural_index.py:27-29`） | reviewer / critic の verdict（「前段の推論を信用するな」「finder の文は無視しろ」`skills/mantis-review/SKILL.md:62-66`）。snapshot のずれは NEEDS_RESEARCH で、FP にしない |
| 各 node は前段の返答しか見ない（`include_contents="none"`、`graph_loader.py:1877-1879`）。verdict は Pydantic schema で終端 | 再現の設計、Tier 1〜3 の登り方、chain の仮説、patch と再攻撃の変種 |
| 上限: 12 h / 10 M token、campaign あたり 500 step、node あたり tool 200 回（`budget.py:15-36`） | calibrate: impact と likelihood の 1〜5 |
| 証拠の階層: `code` 階層だけが verdict 欄を書ける（`evidence.py:61-85`）。切れた trace の沈黙は `EVIDENCE_TRUNCATED` で負ではない | opt-in の LLM 計画は「対象選定と仮説の文にだけ流れ、ほかには流れない」（`planner.py:58-99`） |
| dedupe Tier 1〜3 は key（`sha256(fp|cwe|symbol)` など）、Tier 4 だけ agent。correlator は「HINT であって verdict ではない」。却下は「意見」で、機械検証の証拠を上書きしない（`database.py:1201-1222`） | |
| oracle: sandbox 内の sentinel file `MANTIS_REACHED_ENTRYPOINT` か、sink を名指しする backtrace 付きの crash（`sandbox_tools.py:113-155`）。「text だけでは crash ではない」。chain は端から端まで実行せず構成要素から `statically_confirmed` | |

数字: 構造索引の A/B で precision 75% 対 22%、token 約半分（`README_AGENTS.md:519-527`）。評価は「公開された脆弱 app を LLM 段の対象にしない」（`evals/README.md:53-56`）。不変条件 INV-1〜6 は「prompt の柵でなく決定論で強制」（`AGENTS.md:167-194`）。

### 2.3 Cloudflare security-audit-skill と VDH / VVS

skill（単一 repo の種）:

| code / 親が強制する | model が決める |
|---|---|
| 親だけが共有 file を書く（`SKILL.md:56-66`）。hunter / verifier は scratch に書き、親が 11 段の手順で証拠を昇格 | 信頼境界が何か、どの単位があるか、攻撃分類の選択（「recon が trust に敏感な境界を見つけたから選ぶ」`RECONNAISSANCE.md:88`） |
| 単位 = 入口 × 信頼境界 × subsystem × 攻撃分類。`validate-coverage-ledger.cjs` が id の再計算、同じ組の二重登録、状態機械（planned / blocked / covered / candidate）、owner の新鮮さ、artifact の置き場を検査 | 経路が本物か（fresh verifier）、重大度の根拠、coverage critic の抜けの判断、fingerprint |
| `validate-findings.cjs` が 3 状態の排他（confirmed に blockers 無し、needs_validation に severity 無し）、trace の形（先頭 entrypoint、末尾 sink）、severity ≤ impact、path の安全を検査。「validator の成功は形と台帳の整合だけを証明する」（`VALIDATION-AND-REPORTING.md:118`） | |
| 予算 = agent 起動回数。recon 4、critic、候補あたり verifier 1〜2 を先に予約し、hunter を予約に入れない（`SKILL.md:119-134`） | |
| sandbox: network 無し、env 空、read-only、scratch だけ書く、資源上限。満たせなければ対象を実行せず needs_validation の blocker に書く（`SKILL.md:33-40`） | |
| verifier は候補と検査の記録だけを受け取り、他の verifier の結論は受け取らない。「あなたはこの候補を書いていない。反証しろ」（`VALIDATION-AND-REPORTING.md:5-12`）。壊れた出力は直さず捨てて別の fresh verifier で再実行（`:89`） | |

VDH / VVS（[本文](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)、128 repo、worker 50〜200）:

- 決定論: schema と path の存在検査、patch と test の parse、SQLite の状態（run × repo × stage）、dedupe の転置索引で候補を短い一覧にする、run をまたぐ安定 key、repo ごとの task 上限、fail → pass の回帰 gate と merge 禁止、浅い run の検出と再 queue、report の描画。
- model: recon の threat model と分類（3 体並列で `architecture.md`）、hunt と PoC、validate の反証（「hunter に自分の宿題を採点させると、出したもの全部を自信をもって validate する」）、dedupe 候補一覧の中の判断、本番到達性の判断。
- model は交換部品: VDH と VVS は別 model で、「出した model と違う重みで判断する」。「残るのは harness の方」。
- 数字: 候補 20,799 → 検証通過約 12,057。validation の却下率は recon の文脈を足して 40% → 11%。1 run は反復の累積の約半分。gapfill は初回 hunt の約半分の費用で「費用対 coverage の lever」。Semgrep は 1 か月で 0 回呼ばれ、wishlist が最も使われた tool。

### 2.4 Anthropic claude-code-security-review（PR 差分の review action）

比較のための軽い例。schema validator も sandbox も coverage も無い。差分取得と regex の除外（DoS、rate limit、`.md`）は決定論、「脆弱性か雑音か」は全部 LLM（監査 1 回 + Finding ごとの偽陽性 filter 1 回、既定の HARD EXCLUSIONS 16 と PRECEDENTS 17）。**判断を全部 prompt に置くと、除外規則の表が prompt の中で増える**。これは契約 v5 で起きたことの対照例として読める。

### 2.5 Shopify と Mandiant AVDH（記事）

- [Shopify](https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model): 分割は agent（「context の 20〜30%」「関連する domain」で group、JSON を出す）。hunter は区画ごと並列。verifier は別 model で逐次、既存 test suite に test を書いて実行（「test が oracle」）。Ruby の runner が dedupe、重大度の計算、保存、差分 scan を持つ。「boolean や生の ID は Low に落とす」。80 超の app、全量 scan 50〜300 ドル、差分 5〜50 ドル。「model は良くなるが、最も重要な部品は harness のまま」。
- [AVDH](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review): 順序は「厳密に決定論」。入口の抽出は Gemini Flash Lite の Discovery agent が file ごと並列（安い model で列挙）。入口ごとに Enrichment agent が文脈を集め、Access Control か Data Flow かへ回す。仮説は「広く brainstorm」、validation は高 temperature の複数体 + synthesis 1 体、最後は人間が PoC を動かす。threat model は人間が承認してから進む。

## 3. 5 実装に共通する線

| 層 | code（決定論） | model（判断） |
|---|---|---|
| 隔離 | 全員。sandbox 無しなら起動しない（Anthropic）か実行せず保留（Cloudflare） | — |
| 単位 | 検査と割り当て、id、状態機械、上限（Cloudflare 台帳、Anthropic round-robin、Mantis campaign） | 切り方そのもの（Shopify、Anthropic recon、Cloudflare recon、AVDH の入口抽出） |
| 索引・床 | 作る。ただし tool として渡し「HINT」と明記（Mantis）。verdict の入力にしない（Anthropic dedupe key） | 索引を使うか、何を足すか |
| 出力 | schema で検査。直さず落とす（Cloudflare、Mantis）か parse だけ（Anthropic） | 中身 |
| 同一性 | key と転置索引で候補一覧（Mantis Tier 1〜3、Cloudflare VVS、Anthropic post-hoc） | 候補の中で同根かの判断（全員） |
| 組合せ | 鎖の各環の verdict を settle（Mantis chains.py） | 仮説と組の選択（Mantis planner、Austin の chain skill） |
| 検証 | oracle: ASan、sentinel file、test の fail → pass、未変更 code 上の PoC | oracle が無い logic bug は別の体の反証と「正確な不足事実」（Cloudflare needs_validation、Mantis statically_confirmed、Anthropic「論理で証明、高い基準の 1 人」） |
| 記録 | 全員 SQLite / JSONL。失敗は負にしない（Mantis `not_attempted`、`EVIDENCE_TRUNCATED`） | — |
| 人間 | 最後の関門（全員）。AVDH は threat model の承認も | — |

## 4. 今回の設計への写像（10-27 午前の表の改訂）

| 今回の設計 | 先例 | 判定 |
|---|---|---|
| 列挙役（AI）が入口・出口を洗い出し、script は道具 | AVDH の Flash Lite 入口抽出、Cloudflare recon の 4 体、Anthropic recon、Mantis の索引 tool（HINT） | 一致 |
| 区画の切り方を AI が提案、Harness は形と上限と割り当て | Shopify の group、Anthropic の 5〜15 subsystem + round-robin、Cloudflare の単位 + 親の割り当て | **一致（午前の「一歩先」を訂正）** |
| 上限超えは差し戻し、切り分けはしない | Cloudflare の validator は形だけ検査、Shopify は token 目安を prompt で | 一致 |
| 追跡役は区画だけ読み、他と話さず、schema で返す | Cursor worker、Mantis の `include_contents="none"`、Cloudflare hunter の 1 JSON | 一致 |
| 出力の形を検査し、直した内容を記録 | Cloudflare / Mantis は直さず落とす | 寛容さの差だけ |
| 同じ経路を群にまとめる（Lead にも） | Mantis Tier 1〜3 + Tier 4、Cloudflare 転置索引 + agent | 一致。候補一覧は code、最終判断を AI に残す余地あり |
| 組合せ役に Lead の全件を渡し、組むかは AI。輪には入れず名指し | Mantis chainer（仮説は agent）、Austin の chain skill（人間が起動） | 一致 |
| 段 1b で別の体がソースを読み直す | Mantis reviewer / critic、Cloudflare fresh verifier、Anthropic grader | 一致 |
| Lab と canary（logic bug の oracle） | Mantis の sentinel file が最も近い。Shopify の test oracle | 一致。他社は logic bug の oracle を持たず「論理で証明」に落としている |
| 人間が Lab で見て提出 | 全員 | 一致 |
| 探索 prompt に基準や分類の表を置かない | Anthropic「型を列挙すると recall が下がる」、review action の対照例 | 一致（契約 v5 の教訓） |

ADR 0034 で消した「索引・dispatch・coverage」との違いは 1 点: 当時は Harness が索引を作って Root に渡し、Root の文章で分担を頼んだ。今回は AI が列挙し、Harness は検査・割り当て・記録だけで、Root がいない。公開 5 実装はすべて後者の形である。

## 5. 持ち帰るもの（午前の 5 点の改訂）

1. 線はそのままでよい。repo の行でも、判断は model、形・同一性・上限・oracle・記録は code。
2. 区画の AI 提案には先例が 3 つある。比較の分母に「script の行を単位に AI は順位だけ」の腕を残す理由は、先例が無いからではなく、効果を測るためだけになる。
3. 索引や script は「HINT、verdict の入力にしない」と文書に明記し、tool として渡す（Mantis、Anthropic）。
4. 検証の出力は「直さず落として別の体で再実行」が 2 社。今の正規化（直して記録）を変える必要はないが、直した回数を測る。
5. logic bug の oracle を持つ実装は無い。Lab と canary はそのまま投資先。他社の代替は「別の体の反証 + 正確な不足事実」で、段 1b の 2 問と `incomplete` の理由がそれに当たる。
6. 数字で覚えておくもの: 検証の却下率は recon の文脈で 40% → 11%（Cloudflare）、敵対的 verifier で悪用不能が半減、PoC 要求でほぼ 0（Anthropic）、索引の tool 化で precision 22% → 75%（Mantis）、1 run は累積の約半分（Cloudflare）、全量 scan 50〜300 ドル（Shopify）。

## 出典

- repo（2026-10-27 clone）: [anthropics/defending-code-reference-harness](https://github.com/anthropics/defending-code-reference-harness) d3bea6b、[google/mantis](https://github.com/google/mantis) f3162c0、[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) c1c8a8c、[anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) 0c6a49f
- 記事: [Cloudflare: Build your own vulnerability harness](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)、[Shopify: Building an agentic harness that outlasts the model](https://shopify.engineering/building-an-agentic-harness-that-outlasts-the-model)、[Mandiant: AVDH](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)、[Google Cloud: Getting started with Mantis](https://cloud.google.com/blog/products/identity-security/getting-started-with-the-mantis-harness-to-find-and-fix-bugs/)、[InfoQ: Google Mantis](https://www.infoq.com/news/2026/09/google-mantis-vulnerability-scan/)
- 本リポの過去調査: §0 の表
