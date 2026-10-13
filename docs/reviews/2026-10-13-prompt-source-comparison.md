# 探索 prompt v4 のための出典対照表（2026-10-13）

調べて報告。正本ではない。**この文書は prompt を書かない。** 所有者が最終列「採否」を埋め、採った行だけで v4 本文を組む（DEVELOPMENT.md 第 5 節、#189）。

対象の出典は 3 群。所有者の系譜（WP2Shell 記事、実績のある whitebox 版、wordpress-harness v7、現行 v3）、公開 harness 5 本（Anthropic Defending Code Reference Harness、Google Mantis、Cloudflare、Visa、Trail of Bits）、参考 3 本（Anthropic claude-code-security-review、Vercel deepsec、個人作 ai-vuln-harness）。各 repo の `.private/`、提出済み報告、Private Evidence は読んでいない。

## 0. 先に結論

1. **有償 7 件は wordpress-harness の prompt v1〜v9 では発見されていない。** 7 件のうち 2 件（SSA、Brizy）は 2026-03 の harness 以前、2 件（TranslatePress 3.2.6、Unlimited Elements）は 2026-07-29 / 07-31 の「source-only coordinator contract」（private）、1 件（Custom Facebook Feed）は 2026-08-31〜09-01 の **whitebox-harness `bounded-wp2shell/v1.7`**（`963d3bb:skills/discover-wordpress-target/PROMPT.md`、12,116 B）。TranslatePress 3.3.1（08-11）と Relevanssi は元 run を特定できない。wordpress-harness（09-01〜10-08）は 7 件を既知 CVE の再発見評価に使った側で、未知の発見実績は無い。
2. したがって **「実績のある prompt」の第一候補は whitebox v1.7**、第二候補は whitebox `382c139:skills/discover-wordpress-leads/assets/DISCOVERY.md`（2026-08-01、7 月末 2 件の contract に最も近い committed 形）。wordpress-harness v7 は「短縮・契約分離」の現行形として参考にする。
3. **公開 harness で本リポの不変条件と同型のもの**: 探索と検証の分離、Verifier に finder の結論を渡さない（A・C・D・F）、検証失敗に severity を付けず棄却もしない（A `CANNOT_VERIFY`、B `not_attempted`、C `needs_validation`）、snapshot sentinel（B）、nonce 付き untrusted block / minted markers（A・F）。
4. **本リポの規則と正面衝突する文言**: Anthropic A の「assume there *are* vulnerabilities」「Do Not Stop Until Done」、WP2Shell 記事原文の「vulnerability that can be exploited… to RCE」「Spend at least 6 hours」。所有者は 2026-10-13 に「脆弱性が必ずある / RCE 前提を見直す」と決めている。whitebox v1.7 は既にこの前提を外している（「paid-class vulnerability sweep」「Reporting zero leads… is a normal ending」）。
5. **ライセンス**: Trail of Bits は CC BY-SA 4.0（継承条項）。文言を取り込んだ prompt を公開するなら同ライセンスと帰属が要る。他は Apache-2.0 / MIT で帰属表示のみ。

## 1. 出典の一覧

### 1.1 所有者の系譜

| 記号 | 出典 | 日付 / bytes | 実績 |
| --- | --- | --- | --- |
| W0 | `/home/dev/wp2shell/toolkit/PROMPT.article.template.txt`（記事原文） | 2026-08-19 / 3,024 | WP2Shell 記事の RCE 発見。本リポの目的とは前提が異なる |
| W1 | 同 `PROMPT.template.txt`（所有者の改良: 80 tool call 上限、research/ file、2 波停止、3 時間） | 2026-08-19 / 3,961 | — |
| P1 | whitebox-harness `963d3bb` `PROMPT.md` = `bounded-wp2shell/v1.7` | 2026-08-31 / 12,116 | **Custom Facebook Feed 4.13.0（CVE-2026-93756）の発見時点の prompt** |
| P2 | whitebox-harness `382c139` `DISCOVERY.md` | 2026-08-01 / 13,419 | 7 月末 2 件（TP 3.2.6、UE 2.0.16）の private contract に最も近い committed 形。byte 一致はしない |
| H7 | wordpress-harness `prompts/wordpress-plugin-research-v7.md` | 2026-09-19 / 6,927 | 既知 CVE 再発見評価のみ。未知発見なし |
| V3 | 本リポ `wp2shell-bounty-v3.md` + 出力契約 v2 + trust-boundary-v1 | 2026-10 | 本番 4 周、scope 内 Finding 11、confirmed 0 |

発見日の根拠は Wordfence ミラーの公開日、whitebox-harness の provenance 文書（`34af667:docs/research/owned-finding-original-discovery-provenance-2026.md`、2026-08-27）、workspace の file 名と日時（中身は未読）。

### 1.2 公開 harness

| 記号 | 出典 | 組織 / ライセンス | 公開物 |
| --- | --- | --- | --- |
| A | [anthropics/defending-code-reference-harness](https://github.com/anthropics/defending-code-reference-harness) | Anthropic / Apache-2.0（2026-06、「not maintained」） | prompt .py 7 本、skill 5 本（threat-model / vuln-scan / triage / patch / customize）、`docs/prompting.md` `best-practices.md`、[blog](https://claude.com/blog/using-llms-to-secure-source-code) |
| B | [google/mantis](https://github.com/google/mantis) | Google / Apache-2.0（2026-07〜09） | 15 段の SKILL.md（history → structural-index → architecture → threat-model → plan → researcher → dedupe → review → critic → reproduce → chain → patch → calibrate → reflect → report）、schema.json |
| C | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | Cloudflare / MIT | SKILL.md + RECONNAISSANCE / HUNTING / ATTACK-CLASSES / VALIDATION-AND-REPORTING + schema + validator。[blog](https://blog.cloudflare.com/build-your-own-vulnerability-harness) |
| D | [trailofbits/skills](https://github.com/trailofbits/skills) | Trail of Bits / **CC BY-SA 4.0** | audit-context-building、fp-check、vulnerability-triage-brocards、goal-prompt、variant-analysis、differential-review、entry-point-analyzer |
| F | [visa/visa-vulnerability-agentic-harness](https://github.com/visa/visa-vulnerability-agentic-harness) | Visa / Apache-2.0 | lens SKILL.md 17 本（code-exploration、injection、access-control、logic-bug、sibling-instances…）、validation / verify prompt |
| E | [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) | Anthropic / MIT | `/security-review` 本文、FP 除外 17 + 判例 12、信頼度閾値 |
| G | [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) | Vercel Labs / Apache-2.0 | `prompt-samples/*.md`（Laravel/PHP 版あり） |
| H | [daedalus/ai-vuln-harness](https://github.com/daedalus/ai-vuln-harness) | 個人 / MIT | hunt / validate / independent_verify。評判未確立、文言の参考のみ |
| 参考 | Google Project Zero Naptime / Big Sleep | ブログのみ | 原則 5 点（reasoning の余地、専用ツール、完全検証、独立 trajectory）。prompt 非公開 |

**prompt 非公開のため除外**: XBOW、OpenAI Codex Security（旧 Aardvark）、Anthropic Claude Code Security、Project Glasswing、Google CodeMender。`anthropics/skills` に security skill は無い（`skill-creator` の書式指針のみ）。「Mantis」は `google/mantis` が公式で、`Seven-94/mantis` `moveeeax/mantis` は説明文のコピー。

## 2. 対照表 1: 所有者の系譜

セルは ✓ + 出典の言い回し（10 語以内）。空欄は該当なし。

| # | 要素 | W0 記事原文 | W1 所有者改良 | P1 whitebox v1.7（実績） | P2 whitebox 8/1 | H7 wph v7 | V3 現行 | 採否 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 課題文の前提 | 「vulnerability that can be exploited… to RCE」 | 同 | 「paid-class vulnerability sweep」前提なし | 「working prior… may exist」 | 「zero-day 前提禁止」 | 「脆弱性があると前提しない」 | |
| 2 | 成功条件 | 「/flag を読む」 | 同 | 「accepted class に着地する route」 | 「reportable-yield boundary」 | 「RCE 不要」 | impact 列挙 | |
| 3 | 攻撃者位置 | — | — | 「unauthenticated, default Subscriber or Customer」、Contributor 以上で始まる route は lead でない | 「attacker position 必須」 | 「未認証 / Subscriber / Customer」 | 同 + trust boundary | |
| 4 | 受理 class の列挙と順位 | — | — | 3 群（PHP file / options / RCE / admin → Stored XSS / SQLi → 他）、群内は source の裏付けで勝つ | 弱 terminal は chain 候補 | programme-eligible 8 項目 | 優先リスト（rce 先頭、stored-xss 7 番目） | |
| 5 | 弱形の除外 | — | — | 「Four classes have a weaker form」: self-XSS、nonce 付き reflected、path+拡張子の両方、options は何を決めるか | — | parkedProgrammeLead | — | |
| 6 | dropped class の明示 | — | — | DoS / SSRF / CSRF / IDOR / 非公開コンテンツ / 列挙 等「Spend no agent on them」 | — | — | 「それ以外の具体的効果も記録」（逆方向） | |
| 7 | 既知情報の禁止 | 「changelogs, git history, internet… diff」禁止 | 同 | + 「reports, PoCs, disclosure… do not reconstruct a known CVE from memory」 | 「報告検索・patch diff 禁止」 | 同 | test で禁止語 | |
| 8 | 探索の多様性 | 「genuinely diverse portfolio」 | 同 | + 「capability and ownership transitions, writer-storage-reader boundaries」 | 「root の自由」 | heuristics 7 項目 | ✓ | |
| 9 | 3 方向探索 | — | — | 「forward… backward… across persistence, deferred callbacks」 | — | — | — | |
| 10 | approach-family registry | 「explicit registry of approach families」 | + `research/REGISTRY.md` | `research/REGISTRY.md`、「absence from inventory is never clear」 | — | registry は Harness 状態でない | ✓（file なし） | |
| 11 | 一案支配の禁止・blocked の再開条件 | ✓ | ✓ | ✓ | — | ✓ | ✓ | |
| 12 | 非互換 route の並走と cross-pollinate | ✓ | ✓ | ✓ | — | — | — | |
| 13 | adversarial agent | 「doubly checked for sanity」 | ✓ | ✓ | — | — | — | |
| 14 | agent を短命にする | — | 「No agent may exceed 80 tool calls… hands off」 | 「agent lifetime, not count, consumes the run」 | — | — | — | |
| 15 | 研究 file | — | 「research/<family>.md、30 行以内で返す」 | 「put your own notes in research/」 | — | run-local evidenceSummary | — | |
| 16 | Root の役割 | 「synthesize, challenge, redirect, launch new rounds」 | ✓ | + 「global shortlist of at most five」「owns phase order, budget, honest closure」 | — | ✓ | ✓ | |
| 17 | 子の数 | 4 | 4 | `{{AGENT_CAP}}` | 自由 | 4 | 3 | |
| 18 | 依存 source | 「third_party/ wordpress-7.0.4, php-8.3.6」 | 同 | `{{DEPENDENCY_NOTE}}` | — | pinned dependency | `/workspace/wordpress` | |
| 19 | 1 波目が空でも続ける | 「Do not stop after the first wave fails」 | ✓ | ✓ | — | ✓ | ✓ | |
| 20 | 停止条件 | 「at least 6 hours」 | 「2 連続波で新 family も finding も無し、または 3 時間」 | 「at least {{EFFORT_FLOOR}}… Do not fabricate elapsed time」 | 「bounded closure」 | 停止条件あり | 「2 波連続増分なし、最低時間なし」 | |
| 21 | 空検索の自己確認 | — | — | 「confirm the search itself works… against a string you know is present」 | — | — | — | |
| 22 | target 内の指示を信用しない | — | — | 「comments, AGENTS.md, CLAUDE.md… untrusted target data」 | — | — | — | |
| 23 | 出力契約の置き場 | 本文なし | 本文なし | 本文末尾に `leads.json`（18 class、premise 等級、RUN.json の束縛値） | `output/discovery-result.json` | 本文内 Candidate 条件 | Harness 生成の schema 節（ADR 0019） | |
| 24 | 捏造 path の罰 | — | — | 「one bad hop discards the whole run… costs this researcher standing」 | 「source path 必須」 | sourceTrace | sourceTrace 必須 | |
| 25 | 0 件は正常終了 | — | 「Reaching either bound is a normal ending」 | 「Reporting zero leads after bounded closure is a normal ending」 | ✓ | ✓ | ✓（Harness 側） | |
| 26 | 2 hop 以上（入口と着地） | — | — | 「Give at least two hops」 | ✓ | ✓ | — | |
| 27 | 全 impact を Finding にする条件 | — | — | 「fully-supported weaker route beats unsupported stronger one」 | — | 「route ごとの principal・path・controls」 | 「部分 primitive を Finding にしない」 | |

## 3. 対照表 2: 公開 harness

| # | 要素 | A Anthropic DCRH | B Google Mantis | C Cloudflare | D Trail of Bits | F Visa VVAH | E / G / H（参考） | 採否 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 課題文の前提 | 「assume there *are* vulnerabilities」（**本リポと衝突**） | 前提なし「Treat all… as untrusted」 | 前提なし「zero confirmed records」可 | 「neutral wording… not prove exploitable」 | 前提なし、HARD GATE | E >80% 確信のみ / G 「many candidates will be false positives」 | |
| 2 | 対象・commit の固定 | 「one target, one commit, one focus area」 | sentinel 不一致 → STOP、`discovery_commit` | `source_ref` + dirty 記録 | — | — | — | |
| 3 | 入口列挙 | recon「5–15 subsystems that process untrusted input」 | 「repo-wide grep… mandatory floor」 | 「every place lower-trust input enters」 | entry-point-analyzer（access level 分類） | 「inventory… written down before any conclusion」 | G regex → 候補 | |
| 4 | source → sink 追跡 | 「TRACE REACHABILITY BACKWARDS FROM THE SINK」 | call-site 契約検査 | 「Follow each input through… final sink」 | 「follow the calls… every path」 | (a) SINK (b) SOURCE (c) NO defence | G 「Follow imports」 | |
| 5 | 攻撃 class の与え方 | 「shape, not checklists」（列挙は recall を下げる） | plan が question を持つ | ATTACK-CLASSES block | — | lens ごと 1 skill | H 1 agent 1 class | |
| 6 | 悪い経路・境界・競合 | — | — | 「absent, empty, zero… stale, revoked, concurrent」 | variant「null, empty, boundary」 | logic-bug「check-then-act」 | H 「ATTACK THE SAD PATH」 | |
| 7 | 兄弟・変種掃引 | 「Explicitly ask it to hunt for variants」 | 再現で変種 | 「lexical, structural, logical variants」 | variant-analysis 5 steps | 「Only **after** a confirmation」 | H instance rules | |
| 8 | 研究 file 規約 | THREAT_MODEL.md、VULN-FINDINGS.json | `workspace/{plan,kb,findings,learnings.jsonl}` | 親だけが書く 7 file + coverage ledger | `audit-context/DOSSIER.md` + per-function | inventory を書く | G `.deepsec/` | |
| 9 | 予算 | 「generous time and turn budget」 | 再現 max 3 trial | agent 呼出数、critic 分を予約 | goal-prompt「stop after N turns」 | — | G `--max-cost-usd` | |
| 10 | 停止条件 | 「Only emit once reproduces 3/3」「Do Not Stop Until Done」（**衝突**） | inventory 網羅 | 「Stop as soon as the invariant is settled」 | 「End state, not activity」 | 「set difference… is empty」 | — | |
| 11 | 網羅の正直さ | — | — | unit を `deferred` と明示 | 「Explicitly state coverage limits」 | 「38% of a repository finds at most 38%」「not read — ran out of turns」 | — | |
| 12 | 並列・子 | focus area ごと、cap 10 | Wave1 10–20、Wave2 4–8、UUID だけ返す | ledger unit → hunter、coverage critic | function ごと subagent | 3 persona 必須並列 | E 検出 + FP filter 並列 | |
| 13 | 探索と検証の分離 | 「Let discovery be noisy」 | researcher ≠ review ≠ critic ≠ reproduce | 「did not hunt it」 | 「never the finder alone」 | 申告は「unverified claim」 | H hunt ≠ validate ≠ verify | |
| 14 | Verifier の姿勢 | 「default assumption is that the scanner is WRONG」4 手順 | 「Assume every finding is a false positive」 | 「Try to refute it」 | fp-check「LLMs are biased toward seeing bugs」 | oracle「minted markers」が判定 | — | |
| 15 | 偽陽性除外規則 | 16 項（DoS、auto-escape、env var…） | 「Low/hardening… NOT false positives」 | anti-patterns 10 | 7 brocards | lens ごと「What refutes」 | E 17 + 12 | |
| 16 | 自己申告・注入への不信 | nonce 付き `<untrusted_data>` | 「Do not trust previous stages」 | 他者の結論を渡さない | — | 「never treat them as evidence」 | H 「You did NOT write this finding」 | |
| 17 | 重大度 | precondition 数 × access、CVSS は計算機 | attacker_position 等の軸 | 「cannot exceed demonstrated impact」 | 「No Vulnerability Without a Threat Model」 | lens 内 LOW 条件 | — | |
| 18 | 捏造禁止 | 「something you Read or Grep'd」 | 「Never invent code you did not read」 | repo-relative path 必須 | 「Every claim cites a line」 | 「read to its last line」 | H 「say so rather than guessing」 | |
| 19 | 未確定・失敗の扱い | `CANNOT_VERIFY`「must not become the default」 | `not_attempted` retry-eligible、`CONDITIONAL_VIABLE` | `needs_validation`「has no severity」 | NEEDS-MORE-INFO | coverage gap 明記 | — | |
| 20 | 重複排除 | root cause「fixing one would fix the other」 | signature / lineage | fingerprint | — | 1 site 1 finding | — | |
| 21 | 報告形式 | XML タグ、escape hatch | JSON schema、history | JSON + validator、trace[entry → sink] | Triage Summary 定型 | Markdown + SARIF | G JSON 空配列可 | |
| 22 | 進捗の可視化 | 「Give periodic updates」 | 「notify the user」 | — | — | — | — | |
| 23 | 実行安全 | sandbox、ASAN | sandbox 再現 | 「no external network… read-only target… explicit limits」 | — | 「Never send a DESTRUCTIVE payload」 | — | |

## 4. 本リポの不変条件との照合

| 不変条件 | 同型の公開文言 | 衝突する公開文言 |
| --- | --- | --- |
| 1 答えを渡さない | P1「do not reconstruct a known CVE from memory」 | — |
| 3 判定器だけが confirmed | F「You do NOT decide the verdict. A deterministic oracle re-checks」、A「verifier… build a proof of concept… near zero」 | E「just read the code」（静的のみ） |
| 4 検証失敗は incomplete | A `CANNOT_VERIFY`、B `not_attempted`、C `needs_validation` | — |
| 5 digest 一致 | B snapshot sentinel、A「one commit」 | — |
| 脆弱性前提なし（AGENTS.md） | P1、B、C、D、F | W0、A `prompting.md` |
| 最低実行時間なし（ADR 0029） | W1、C「Stop as soon as settled」 | W0「6 hours」、P1 `{{EFFORT_FLOOR}}`、A「Do Not Stop Until Done」 |

## 5. 所有者への問い（採否の前に）

1. **実績版 P1 を骨格にするか。** P1 は唯一、未知発見の時点が特定できる committed prompt。長さ 12 KB は #189 の 7,000 bytes 上限を超える。骨格に採るなら上限を上げるか、class 列挙（表 1 の行 4〜6）を Harness 生成の節へ移す（ADR 0019 の延長）か、所有者が決める。
2. **class の列挙を本文に戻すか。** P1 は accepted / weaker / dropped を本文で列挙し、Anthropic A は「列挙は recall を下げる」と言う。本リポは #185 で出力境界に gate を持ったので、本文の列挙は「探索の向き」の指示としてだけ要るか。
3. **研究 file と整形 run（#189）。** W1・P1・B・C はいずれも研究 file を持つ。B の「子は file に書き UUID だけ返す」と W1 の「30 行以内で返す」は同じ狙い。
4. **Trail of Bits の文言を採るか。** 採るなら prompt は CC BY-SA 4.0 で公開する義務が出る。本リポは private なので配布しなければ問題は無いが、記録に残す。
5. **Verifier v7（#187）への流用。** A の 4 手順と F の「oracle が判定、自分の入力の反射は証拠でない」は Verifier 側の候補。探索 v4 とは別に表を作るか。

## 6. 確定できなかったこと

- 7 月末 2 件の prompt 本文は private hash のみで、tracked file に byte 一致するものは無い。
- TranslatePress 3.3.1（08-11）と Relevanssi の元 run・prompt は特定できない。
- Anthropic の red.anthropic.com にある技術文書、Clearwing の sourcehunt モード、`VulnHunter-White` は未調査。
- 公開 harness の文言は 2026-10-13 に取得したもの。版が進めば変わる。
