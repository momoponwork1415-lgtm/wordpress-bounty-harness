# 外部のハーネス実践との照合（2026-10-17）

調べて報告。正本ではない。所有者の「自分では正しくできているか分からないのでインターネットで調べて」（2026-10-17）を受け、バグバウンティの受理側（Wordfence、Patchstack）、大手の脆弱性発見ハーネス（Wordfence Argus、Anthropic Project Glasswing と Cloudflare の運用記録、XBOW、OpenAI Aardvark、Google Big Sleep、DARPA AIxCC）、論文（OpenAnt、Refute-or-Promote、AWS Deception Benchmark、Baselines Before Architecture）を本リポの設計と並べた。2026-10-13 の [prompt 出典対照表](2026-10-13-prompt-source-comparison.md) が扱った 5 本の公開 harness は繰り返さない。

## 0. 結論

1. **本リポの骨格は外部の慣行と一致している。** 探索と検証の分離、検証側だけが確定を出す、迷ったら記録して検証で落とす、人間の提出前レビュー。XBOW「創造的な AI が見つけ、決定論的な論理が本物かを決める」、Cloudflare の「validate agent は別 prompt で、新しい finding を出せない」、OpenAnt の敵対的検証、Refute-or-Promote の「殺す責務を持つ agent」、AWS benchmark の「exploit を証明させると false positive が 17〜74 ポイント減る」は、すべて SPEC 第 2 節の不変条件 3・4 と ADR 0018 の形。
2. **受理側は 2026 年に「実害の無い報告」を切る方向に動いた。** Patchstack は 2026-06-01 から受理種類を条件付きの 11 種に絞り、contributor を対象外にし、「AI の誤った前提」「実際の plugin で試していない報告」に即時 1 週間 ban、却下率 50% 以上で leaderboard から除外、「管理者が設定しないと成立しない」ものを除外（規約 4.1）。本リポが 2026-10-17 に 5 分類を park した判断はこの流れと一致し、むしろ遅い。
3. **最大の差は検証の到達点。** 外部は agent が sandbox で PoC を実行し、失敗を読んで直す（Cloudflare per-task scratch、OpenAnt 動的段 75.8% 再現、Argus は 6 段の chain を約 2 時間で PoC まで）。本リポの Verifier は「source 上は成立、Lab にその設定が無い」で止まり、本番 4 件が全部 `incomplete(precondition)`。ただし Patchstack 4.1 は管理者設定前提を却下するので、「設定を Lab に作って確定させる」より「既定設定で成立しないものは検証で落とす」が受理側の基準に近い。
4. **徹底的な探索の外部での形は「1 つの長い agent」ではなく「狭い課題を多数並列＋取り漏れの再投入」。** Cloudflare: 「狭い範囲が良い finding を出す」「並列の狭い課題が 1 つの網羅 agent に勝つ」、約 50 hunter 同時、recon が trust 境界と入口を文書化、gapfill が薄い領域を再 queue。XBOW: 「何千もの短命 agent、それぞれ狭い目的」。本リポの Root＋3 子・7 分は、この意味で浅い。[#310 の計画](2026-10-17-thorough-search-v6-plan.md) の「索引の全項目を observed / blocked にする終了条件」は方向が合うが、実装は Root の自己申告より Harness が入口ごとの課題を配る形の方が外部に近い。
5. **過去の既知脆弱性は探索ではなく選定で使うのが外部の結論と整合する。** Big Sleep「以前こういうバグがあった。似たものが他にもある」、Argus「弱点を発明したのではない」。ADR 0012（探索 agent に公開記録を渡さない）は維持し、#295（履歴で選定順位を付ける）は採る価値がある。
6. **安定性は技法より効く。** AIxCC の第一の教訓「安定性と正確性が順位を決めた」「ボトルネックは技法ではなく自律システムへの堅牢な統合」。#312（wall が効かず 5.5 時間停止）はこの種類。

## 1. 調べた範囲

- 取得できた一次資料: Patchstack 規約 2026 版と 2026-05-29 の変更説明、Anthropic Glasswing 初回更新、Cloudflare「Project Glasswing: what Mythos showed us」、XBOW blog 2 本、OpenAnt（arXiv 2606.19149）、Refute-or-Promote（arXiv 2604.19049 要旨）、AIxCC SoK（arXiv 2602.07666）、Baselines Before Architecture（arXiv 2607.13085 要旨）、Project Zero「From Naptime to Big Sleep」、AWS Deception Benchmark の報道、WordPress plugin 向け実践記録 1 本（night-wolf）、Intrudify の Patchstack 9 月首位の記事、VulnCheck の Glasswing 台帳分析、Wordfence Argus の二次報道 2 本。
- 取得できなかったもの: Wordfence の規約ページと月次報告（本文が取れない）、Argus の Wordfence 本文（403）、OpenAI Aardvark 本文（403）。これらは検索結果の抜粋だけで扱う。
- 「アルガス」は Wordfence の内製 AI 研究 agent **Argus**（2026-08 公表）と解釈した。

## 2. 受理側（Wordfence、Patchstack）の 2026 年の動き

### Patchstack（2026-06-01 改定、2026-10-01 に再更新の告知）

- 受理する種類は条件付きで 11: SQLi、XSS（サイト全体か reflected）、任意ファイル upload / delete / download（path と拡張子の完全制御）、RCE、PHP object injection、重要な option の変更、contributor 以上への権限昇格、LFI / RFI（path と拡張子）、重要 object（API key、password hash、backup / SQL）への broken access control、重大な影響のある IDOR、受理される書き込みに至る CSRF。
- 対象外: 管理者が設定しないと存在しない問題・期待どおりの機能（4.1）、AC:H、subscriber の軽微な影響、非公開 / 下書きコンテンツの大半、低影響の列挙、API key 露出で影響の無いもの、contributor 以上の stored XSS、open redirect、根拠の無い race / DoS / blind SSRF。contributor role は対象外（mVDP を除く）。管理者が明示的に付与する custom role は対象外。
- 報告品質: 「完全・正確・再現可能」、インストールから exploit までの文章 PoC と raw HTTP と payload を必須（6.3）。却下率 50% 以上で leaderboard から 1 か月除外（6.4）。「AI が生成した幻覚の前提」「実際の plugin / theme で明らかに試していない」報告は即時 1 週間 ban（6.7）。「非現実的な前提」「別の脆弱性を先に突かないと得られない秘密」は無効。
- 背景説明（2026-05-29）: 「規則を直すたびに研究者は適応し、技術的には条件を満たすが実害の無い報告を出す」、AI で 2026 年に低影響の報告が急増、1 件に 20 以上の重複報告、「AI の誤った前提が提出前に捕まっていない」（画像限定の upload を任意 upload と主張、nonce を生成できる前提の AJAX）。「高深刻度で実際に悪用されたものは、ほぼ全て未認証か subscriber / customer 以下」。
- zero-day（22.4）: 最新安定版、既定設定、一般的な環境、前提なし、追加の脆弱性もユーザー操作も不要、full site compromise。未認証で USD 250〜33,000、subscriber / customer で 125〜16,500。

### Wordfence

- 月間投稿数は 2026-01 約 900、02 約 1,080、03 約 1,720、04 約 1,290、06 約 1,070。Threat Intelligence team が triage してから vendor へ。
- 内製 agent **Argus**（2026-08 公表）: 「harness、prompt、model、orchestration の組み合わせ」、方針は「confine, constrain, focus, motivate, parallelize, hypothesize, verify, record, prioritize, iterate hard and fast」。model agnostic で設計・prompt・harness は非公開。Avada theme で 6 段の未認証 RCE chain を「無人で約 2 時間」で見つけ PoC まで生成（単独では RCE にならない「ささやかな trust と validation の失敗の連鎖」。「長い依存経路を見失わず、1 つの弱点で止まらない設計」）。Tutor LMS の subscriber からの PHP object injection、WPMU DEV Dashboard の認証回避も。
- WordPress 本体は AI 由来の報告が 15 倍に増え Core Security Initiative を立てた。Intrudify の自律 agent が 2026-09 の Patchstack leaderboard 首位（71 件、月間の 16%）。
- 取れなかったもの: Wordfence 規約の AI 条項（Annex A に AI による処理の記載があるらしい）、月次の受理 / 却下数。

### 本リポへの含意

- 2026-10-17 の park 5 分類（sensitive-object-access、content-deletion、options-update、privesc-to-contributor+、auth-bypass-non-admin）は Patchstack の除外とほぼ重なる。Patchstack は「重要 object への broken access control」と「重要 option の変更」は残しているので、Harness の分類をもう一段細かくすれば一部は戻せるが、現状の人手レビュー量では park が妥当。
- 本番の 4 件（管理者が特定の block / slider を公開している前提）は Patchstack 4.1「管理者が設定しないと存在しない問題」に当たる。Wordfence も「管理者の誤設定が前提のものは不可」（programme-scope.md）。**つまり検証で `incomplete(precondition)` になっている候補の多くは、前提を Lab に作っても受理されない。** 検証側は「既定設定か一般的な利用で成立するか」を判定の軸にすべきで、Verifier の `configurationPrecondition` はその判定の入力になる。
- 「試していない報告」への ban は、本リポの「runtime-confirmed だけを提出候補にする」「人間が提出前にレビューする」を支持する。`incomplete` を提出しないことは守る。

## 3. 大手・研究のハーネス設計で共通するもの

| 観点 | 外部の実践 | 本リポ | 差 |
|---|---|---|---|
| 発見と検証の分離 | XBOW「見つける agent と確定する系は別」。Cloudflare: validate agent は別 prompt、finding を新規に出せない、「2 つの agent を意図的に対立させる方が 1 つに注意深くさせるより効く」。OpenAnt: 敵対的検証で 49.5% を除去（WordPress は 67→20）。Refute-or-Promote: 171 候補の 79% を公開前に殺す、「10 人のレビュアーが支持した存在しない padding oracle を 1 回の実測が否定」 | Verifier（別 prompt、finder の結論を渡さない）＋ Harness 所有の決定論的判定器（SPEC 不変条件 3） | 同型。本リポは判定器が nonce 付き canary に限るので、外部より厳しい |
| 実行による証明 | AWS: exploit の証明を求めると FP が 17〜74 ポイント減（FN は 7〜44% に増）。OpenAnt: 確定 190 のうち 75.8% を container で再現。Cloudflare: 「動く PoC の無い疑いは推測」、hunter は scratch で PoC をコンパイル・実行し失敗を読んで直す。Argus: chain を PoC まで | Verifier が Lab で手順を試し、判定器が canary を観測 | 本リポは Verifier に管理者セッションやブラウザを渡さず（ADR 0026）、被害者操作は Harness の型付き手順。前提の設定ができず 4/4 が incomplete |
| 探索の単位 | Cloudflare: 「狭い課題を並列に」、hunter に 1 攻撃種類＋範囲の hint、約 50 並列、recon が trust 境界・入口・攻撃面の文書を先に作る、gapfill が薄い領域を再 queue、「coding agent は仮説を 1 つしか持たず context を使い切るので不向き」。XBOW: 「何千もの短命 agent、狭い目的、永続する coordinator が数百の課題に分解し個別に検証」 | Root＋最大 3 子、Root が分担を決める、入口索引はカタログ、7 分で閉じる | 外部は Harness（coordinator）が課題を配る。本リポは Root の自律に任せ、網羅の保証が無い |
| 到達可能性の先行 | OpenAnt: 入口から call graph を辿り 12,177 関数→393 到達可能（97% 削減）、費用 USD 244 / WordPress。Cloudflare: 攻撃者入力が到達するかの trace 段が「最も効く段」。Theori（AIxCC 3 位）: 静的解析で候補を大量に出し LLM で FP を落とす。night-wolf: 種類別 sink scanner（recall ≈ 100%）→ LLM triage（tool 呼び出し 10 回上限、file:line 必須、JSON 固定）→ wp-cli sandbox で role 別 HTTP 検証、524 候補→16 真陽性（SQLi 12） | 入口索引（AJAX、REST、shortcode、hook、upload）を Harness が生成して渡す | 索引はある。索引→課題→検証の配線が無い |
| 過去の脆弱性の使い方 | Big Sleep: 「以前のバグがあった。似たものが他にある」が open-ended より LLM に合う。Argus: 「弱点を発明したのではない」 | ADR 0012: 探索 agent に公開記録を渡さない。ADR 0030: 選定は履歴に依らない | 探索に渡さないのは外部の AI 報告品質問題（重複 20 件）を見ても正しい。選定での利用（#295）は未着手 |
| 深刻度の膨張と hedging | Glasswing: model が 91.5% を high / critical としたが maintainer は 51.3%。curl は 5 件中 1 件が本物。Cloudflare: 「hedged な finding が solid なものを圧倒的に上回る」、harness は意図的に over-report。Anthropic: 「独立した人間の triage が律速」 | v5「false negative の方が悪い」で候補を多く出し、Programme Boundary で park、人間がレビュー | 同じ選択。費用は人手レビュー量。park 5 分類で緩和したが、残る候補の質を上げるのは検証側 |
| 安定性 | AIxCC KF1: 「全 phase で動き続けた AT が勝った、他は止まった」。「ボトルネックは技法ではなく堅牢な統合」 | 26 batch 無人運転、ただし #312 で wall が効かず 5.5 時間停止 | 無人運転に戻す前に #312 |
| アーキテクチャの価値 | Baselines Before Architecture: 同じ model の素の coding agent が XBOW benchmark の大半を解き、新しい model で素の scaffold が大きく伸びる。「architecture に帰された性能の多くは model と単純な scaffold 由来」 | Root＋子の協調、prompt の版管理 | harness の作り込みより、検証・範囲・選定に投資する根拠 |
| 費用 | OpenAnt USD 244 / WordPress 全体。AIxCC: 7 team 中 5 が LLM 予算の 25% 未満しか使わず。night-wolf: 1 候補あたり tool 10 回上限 | 1 Trial 50〜100 万 noncache token | 外部は候補 1 件あたりの上限を置き、網羅は並列で稼ぐ |

## 4. 本リポがすでに正しくやっていること

- 発見・検証の分離、Verifier に finder の結論を渡さない、判定は決定論的、失敗は `incomplete`（棄却しない）。
- 公開記録を探索に渡さない。重複報告 20 件の問題を見ると、既知 CVE の再構成を防ぐ規則は受理側の信頼に直結する。
- 提出は人間レビュー後、runtime-confirmed のみ。Patchstack の ban 条項に対して安全側。
- 対象範囲の 10 分類 park は Patchstack 2026-06 の方向と一致。
- gVisor 隔離、broker 経由の egress。Cloudflare「model の拒否を安全境界と見なさない」とも整合。

## 5. 差から導く変更（優先順）

1. **検証を「既定設定で成立するか」の判定にする。** Finding の `configurationPrecondition` を Verifier が「既定／一般的な利用／管理者の特別な設定」に分類し、管理者の特別な設定が要るものは `incomplete(precondition)` のままではなく、Programme Boundary の「管理者設定前提」として park に回す（Patchstack 4.1、Wordfence の誤設定条項）。一般的な利用の範囲（投稿にブロックを置く、slider を 1 つ公開する）は Harness の型付き手順で Lab に作って判定器を回す（ADR 0026 の延長、#244）。これで review queue の 4 件のうち少なくとも 2 件は人手に回らなくなる。
2. **対象範囲の文を Patchstack 3.9 / 4.x と Wordfence の除外に合わせる。** #310 第 3 節の内容そのまま。加えて「path と拡張子の完全制御」「重要な option」「重要 object」の条件語を入れる。
3. **網羅は Harness が配る。** v6 の「索引の全項目を observed / blocked にする」（#310 第 4 節 #8）に加え、Harness 側で入口索引を「1 入口群 × 1 攻撃種類」の課題に分け、子 agent に配り、未処理の入口を gapfill で再投入する形を次の設計案にする。ADR 0029「索引は分担を指示しない」の改訂が要る。Cloudflare と XBOW の形に最も近い。Root の自律に任せる現行より網羅の保証が強く、1 課題あたりの上限（tool 呼び出し数や時間）で費用も読める。
4. **選定に履歴の prior を入れる。** 直近 1 年に SQLi / stored XSS / ATO が出た plugin と作者を上位に（#295、ADR 0030 の改訂）。探索には渡さない（ADR 0012 維持）。
5. **#312 を直してから無人運転に戻す。** wall 到達で `docker stop` まで行く、SIGTERM で止まる、broker が log を出す。
6. **候補ごとの上限と構造化出力を維持する。** night-wolf の「tool 10 回で verdict」「file:line 必須」「JSON のみ」、Cloudflare の「schema を満たすまで agent が自分で直す」は本リポの ADR 0019（出力契約は Harness が schema から生成）と同じ。変えない。

## 6. やらない方がよいこと（外部の結果から）

- 探索 agent に過去の CVE や changelog を渡す: 重複と再構成の報告が増え、受理側の信頼を失う。
- 検証無しで候補数を増やす: Glasswing の severity 乖離（91.5% 対 51.3%）と Patchstack の ban 条項。
- harness の構造だけを作り込む: Baselines Before Architecture が示すとおり、model 更新で消える差に投資しない。
- 1 Trial を単に長くする: Cloudflare は「1 セッションは大きな repo のごく一部しか見ず、compaction で先の finding を失う」。長さではなく並列の狭い課題。

## 7. 出典

- Patchstack 規約 2026 版: https://patchstack.com/articles/bug-bounty-guidelines-rules/
- Patchstack「The Future of the Patchstack Bug Bounty Program」（2026-05-29）: https://www.patchstack.com/articles/the-future-of-the-patchstack-bug-bounty-program/
- Wordfence 月次報告 2026-01〜04（投稿数）: https://www.wordfence.com/blog/2026/02/wordfence-bug-bounty-program-monthly-report-january-2026/ ほか
- Wordfence Argus（二次）: https://malware.news/t/wordfence-argus-moving-beyond-human-research-capability/125152 、 https://blacktree.nl/2026/08/27/an-ai-agent-chained-six-avada-bugs-into-zero-click-rce-in-two-hours/
- WordPress Core Security Initiative: https://www.therepository.email/wordpress-announces-core-security-initiative-as-ai-driven-vulnerability-reports-hit-record-levels
- Intrudify（Patchstack 2026-09 首位）: https://intrudify.com/blog/patchstack-number-1-ai-wordpress-vulnerabilities/
- Anthropic Project Glasswing 初回更新: https://www.anthropic.com/research/glasswing-initial-update
- Cloudflare「Project Glasswing: what Mythos showed us」: https://blog.cloudflare.com/cyber-frontier-models/
- VulnCheck「The Anthropic Glasswing Receipts」: https://www.vulncheck.com/blog/anthropic-glasswing-receipts
- XBOW「We Ran 1,060 Autonomous Attacks」: https://xbow.com/blog/we-ran-1060-autonomous-attacks 、 IDOR: https://xbow.com/blog/xbow-finds-idors-high-accuracy-ambiguous-context
- OpenAI Aardvark（抜粋のみ）: https://openai.com/index/introducing-aardvark/
- Project Zero「From Naptime to Big Sleep」: https://projectzero.google/2024/10/from-naptime-to-big-sleep.html
- AIxCC SoK（arXiv 2602.07666）: https://arxiv.org/html/2602.07666v2 、 Trail of Bits: https://blog.trailofbits.com/2025/08/07/aixcc-finals-tale-of-the-tape/
- OpenAnt（arXiv 2606.19149）: https://arxiv.org/html/2606.19149v2
- Refute-or-Promote（arXiv 2604.19049）: https://arxiv.org/abs/2604.19049
- Baselines Before Architecture（arXiv 2607.13085）: https://arxiv.org/abs/2607.13085
- AWS Deception Benchmark（報道）: https://www.helpnetsecurity.com/2026/09/14/aws-deception-benchmark-security-vulnerabilities/
- WordPress plugin 向け実践記録: https://blogs.night-wolf.io/ai-powered-vulnerability-hunting-in-wordpress-plugins-themes
