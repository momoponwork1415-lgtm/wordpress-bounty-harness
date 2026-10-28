# 探索を続けながら効率を改善するための調査（2026-10-23）

「調べて報告」の記録であり、正本や探索 agent の入力ではない。外部資料は一次資料を参照し、その観測と本リポジトリへの推論を分ける。公開した資料・この文書を評価 Trial の探索 agent に渡さない。未公開 Finding、payload、HTTP 記録、認証情報は扱わない。

## 結論

**本番の `wp2shell-bounty-v8` による新規対象の探索を続け、検証から提出までの 6 段を先に 1 件通す。** 余っている token は現行の本番周回に使える。探索方式の改訂は、後段が通った後、どの資源がどこで失われたかを測って 1 軸ずつ試す。これは [DEVELOPMENT §2](../DEVELOPMENT.md) と [ADR 0038](../adr/0038-verification-phases-and-submission-flow.md) の現行判断に従う。

現在の Trial は Snapshot ごとに Root と最大 4 子で 1 回、最低 60 分・上限 120 分、探索用 Lab は既定で無し。固定 source を渡し、分担・仮説・反証は agent に任せ、Harness は隔離、制限、全件保存、正規化、判定と記録を担当する。[SPEC §2–6](../SPEC.md)、[ADR 0033](../adr/0033-minimum-exploration-and-pinned-dependency-sources.md)、[ADR 0034](../adr/0034-harness-control-only-deletions.md)。

## 現行方式で確認できたこと

| 記録時点 | 観測 | 読み方 |
| --- | --- | --- |
| v8 の公開済み開発対象 5 Trial（10/18–19） | 4 件が正常完了し、Finding 14 件、Lead 12 件。TranslatePress の候補 3 件が後続判定器で `runtime-confirmed` | 探索と判定器の配線・候補生成能力を示す。未知の発見率も公開事例との経路一致率も示さない。[評価記録](../evaluation/2026-10-19-v8-five-target-rediscovery.md) |
| 10/18–20 の本番の切片 | Finding 42 件、Lead 465 件。旧自動検証 40 試行は confirmed 0、handoff 22 試行は confirmed 3。review の決定は 0 | この時点の主な滞留は探索の後ろにあった。現在の live 件数とは扱わない。[設計課題の記録](2026-10-20-design-issues-from-production-results.md) |
| 10/21 の本番確認 | 選定 136 対象中 130 対象が Root に到達。正常完了 116 Trial、Finding 69 件、Lead 714 件。provider 拒否と quota が残課題 | 選定から探索は継続可能。Finding 生件数は重複排除・検証・提出の成果ではない。[安定性の確認](2026-10-21-selection-to-discovery-check.md) |
| 子モデルの 7 対象比較（10/21） | Root Opus＋子 Sonnet と子 Haiku は両方 6/7 完了。Sonnet は Finding 25・出力 3.62M token、Haiku は Finding 21・出力 7.90M token | 各対象 1 Trial で重複排除と検証は未実施。小さいモデルが節約になるとの判断はできず、所有者は子 Sonnet を採用した。[実験記録](../evaluation/2026-10-21-child-model-experiment.md) |

`filesRead` は Claude の Read ツールを十分に数えず、Claude の入力の大半が `cachedInputTokens` に入る。したがって runtime をまたぐ「読んだファイル数」や非 cache 入力 token の単純比較で探索効率を決めない。[子 agent 形状の評価](../evaluation/2026-10-20-child-agent-shape-by-runtime.md)。また v8 のほとんどの正常 Trial は 60–70 分で終了しており、最低時間の後に増えた有効な経路数はまだ測れていない。[本番設計課題](2026-10-20-design-issues-from-production-results.md)。

## 外部資料が示すこと

| 論点 | 一次資料にある観測 | 当ハーネスへの含意と限界 |
| --- | --- | --- |
| 元の wp2shell 実験 | 発見者は、最大 4 子を用い、複数の異なる着眼点を並行させ、行き詰まった着眼点を記録し、Root が再評価するよう促した。初期の SQL injection は人間が stock WordPress 上で確かめ、RCE への展開は追加の問いを与えた後に得た。本人は AI の出力を理解し報告するのに翌日を要したとも書く。[Searchlight Cyber / Adam Kues, 2026-07-20](https://www.slcyber.io/research/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6) | 1 件の発見記録で、どの指示が効いたかの切り分けはない。元の目的文は「脆弱性がある」と断言しており、今の v8 にその断言を戻す根拠にはならない。人間の再現・理解の負荷が残るため、現在の検証の整備が先になる。 |
| 広く探す仕事と長い攻撃経路を追う仕事 | Wordfence は PRISM を広範囲の探索、Argus を単一対象の深い探索として説明し、Argus が Avada の複数段の経路を約 2 時間で発見・実証したと報告する。両者は信頼できない入力から前方へ、危険な操作から後方へ追跡するという説明である。[Wordfence, 2026-08-25](https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/) | これは WordPress に直接関係する事例で、探索の深さを確保する理由になる。ただし Wordfence は Argus の実装・プロンプトを公開しておらず、広域探索を別系統に増やせばこのリポジトリで発見率が上がるという比較実験でもない。[Wordfence, 2026-08-27](https://www.wordfence.com/blog/2026/08/wordfence-argus-moving-beyond-human-research-capability/) |
| 手順の細かさ | Eye Security の研究者は、12 段階の技能書で複雑な製品を調査し、重要な構成要素は agent が見つけたが、完全な連鎖には人間の誘導が必要だったと報告する。最新モデルでは厳格な工程が agent を妨げ、token を浪費し得るとも述べる。[Eye Security, 2026-09-23](https://labs.eye.security/ai-vulnerability-discovery-using-the-kitten-process-how-we-found-cve-2026-75754/) | WordPress 以外の単一事例だが、Harness に探索手順や段階を戻す前に、実際の効果を比較すべきという警告になる。細かい手順より、境界と成果物の契約を安定させる現在の方針と整合する。 |
| 1 本の推論に異なる仮説を詰め込みすぎない | Google Project Zero は Naptime の経験から、複数の異なる仮説を 1 本の軌跡で考えさせるのは非効率で、独立した軌跡と自動検証を組み合わせる方法を推奨する。コード閲覧、実行、観測の道具と確実な判定も重視する。[Project Zero, 2024-06-20](https://projectzero.google/2024/06/project-naptime.html) | 既存の単一協調 Trial 内で Root と最大 4 子の仮説が重複していないかを観測する動機にはなる。Naptime の数値は WordPress の bounty 探索ではなく、Trial を増やす根拠にはならない。探索方針を Harness のコードに戻す根拠にもならない。 |
| 検証を閉じないと報告の量が負担になる | Google の PageBreak は、独立した決定論的 validator で動作を確認する設計を採り、未検証候補は後続探索の種や validator の不足を知る材料として内部に保持する、と説明する。validator が対応できない複雑な条件では見逃しがあり得るとも明記する。[Google Product Security, 2026-09-24](https://blog.google/security/agentic-hacks-real-proofs-inside-googles-pagebreak-project/) | 現在の検証 Lab と判定器を完成させ、`incomplete` の理由を残す優先順位を支える。ただし Google の validator の実装例や「near-zero false positive」という自己報告を、このハーネスの canary 証明の代替・成績として転用できない。未検証候補を捨てず、判定結果と区別する方が資料に整合する。 |
| 前提不足は再現の失敗を生む | 80 件の実在 Web CVE を用いた研究では、複数コンポーネントや認証前提のある再現が難しく、認証情報のガイドが不完全な条件では成績が 33% 以上低下したと報告する。[Liu ほか, arXiv, 2025-10-16](https://arxiv.org/abs/2510.14700) | `incomplete(precondition)` を候補否定と区別し、頻出する不足から Lab の通常機能を追加する方針は妥当。ただし既知 CVE の再現研究であり、未知脆弱性の発見率や当 Lab の改善幅を示さない。 |
| 報告に位置情報を伴わせると再現が改善し得る | AXE の研究では、脆弱性種別とコード上の位置という少量のメタデータを与えると、Web CVE の再現成功率が black-box 基準の 3 倍、単一 agent でも 1.75 倍になった。主な失敗要因には前提未達が含まれる。[Sajadi ほか, arXiv v2, 2026-06-20](https://arxiv.org/abs/2602.14345) | Finding にソース位置と前提の根拠を残すことは handoff の検証課題になる。ただし既知脆弱性を局所化済みで与える実験であり、未知の探索に位置情報を事前に与える方法や、agent の自己申告を判定に使う方法を支持しない。 |
| トークン残量と探索効率は同じではない | Google Research の CATS は、検索 agent の逐次探索と並列探索の費用をトークンと tool call の両方で扱い、検索ベンチマークでは少ない費用で良い成績を報告する。[Liu ほか, COLM 2026](https://research.google/pubs/cost-effective-agent-test-time-scaling/) | 当ハーネスでも残トークンだけで増走を決めず、対象ごとの時間、tool call、provider 制限、検証まで到達した候補数を一緒に測るのがよい。ただしこの結果は脆弱性探索の実験ではないため、特定の子の数や探索時間の最適値は導けない。 |
| コード文脈と境界知識 | Chromium Security Team は、開発者の `SECURITY.md` による trust 境界の明示、別文脈の critic、異なるモデル、反復走査を改善要素として列挙する。[Chrome Security Team, 2026-07-30](https://blog.google/security/chrome-stronger-with-every-update/) リポジトリ全体の脆弱性判定ベンチマーク JITVul では、関数をまたぐ文脈を使う ReAct agent は単純な LLM 判定より良かったが、過剰分析や誤判定も残った。[Yildiz ほか, ACL 2025](https://aclanthology.org/2025.acl-long.1490/) | 既に固定して渡す人間作成の trust 境界を保ち、候補の経路を関数間で追うことが大切。Chrome の全 Git 履歴と CVE 知識庫は、このハーネスの公開履歴・時点分離の規則にそのまま持ち込めない。critic や再走査の効果も、このリポジトリでは未測定。 |

## 辻知希さんの実践から読めること

ご指定の方は **辻知希（Satoki Tsuji）さん**。[本人の記事](https://qiita.com/satoki/items/955302bf2615813bae5a)では、CTF の各問題に速度・精度・検証の異なる役割を同時投入し、30×4 の 120 並列で走らせた。誤った解答の短い要約を次の試行へ渡し、同じ誤答の再送信を機械的に防いだ。本人は、隔離した環境を問題ごとに作り、望まない操作をツールから制限したことも説明している。本人の[インタビュー](https://levtech.jp/media/detail_903/)では、1 時間未満の全問解答を報告する一方、バグバウンティには CTF の flag のような明確な正解がなく、低品質な自動報告の検証が受け手の負担になると指摘している。

当ハーネスへの推論は、**異なる仮説を同時に試した効果を、同じ誤答の繰り返し・検証の負担と一緒に評価する**こと。CTF の 120 並列や自動 flag 提出を、未知の WordPress 脆弱性と人間の外部行動承認へ写す根拠はない。現行 v8 には既に Root と最大 4 子があり、Finding と Lead を全件保存する。追加並列の前に、子が独立した経路を増やしたか、同じ根本原因を繰り返したかを数える。[単一協調 Trial の規則](../SPEC.md)、[既存の短命 Child 監査](2026-10-20-short-lived-discovery-agents.md)。

## Strix・複数ハーネス・最近の悪用事例

| 資料 | 確認できたこと | この運用での読み方 |
| --- | --- | --- |
| [Strix の公式コード](https://github.com/usestrix/strix)と[公式 XBEN 結果](https://github.com/usestrix/strix/blob/main/benchmarks/README.md) | Strix は Web アプリを動かして調べる自律ペンテストの仕組み。v0.4.0 は XBEN の 104 個の CTF 型課題で 100 個の flag を取得し、平均約 19 分、総費用約 337 ドルと公表する。 | XBEN は各課題に flag があり、対象・隔離・権限も本番の WordPress bounty と異なる。この 96% を未知の Finding 率として読まない。Strix の動的ツールを現行の gVisor・broker・判定器に直接つながない。 |
| [Gambit Security の一次調査（2026-09-22）](https://gambit.security/blog-posts/autonomous-ai-agents-online-retailers-25-a-company) | 悪用事例では Strix が脆弱性探索、Cairn が後続作業、Hermes が全体調整を担った。報告値は 146 スキャン、138 ホスト、合計 633 scanner-hour を 195 wall-hour に圧縮。`$25.46` は攻撃者の記録にある完了 101 スキャンの平均費用である。調査元は、直接得たサーバー上の証拠、公開中の侵害観測、AI のログ・自己報告を区別し、記録の不完全さも明記する。 | 複数の仕組みをつなげられることは示すが、確認済み脆弱性 1 件や報奨 1 件当たりの費用ではない。参考になるのは役割間の受け渡しと出力の確認。探索から検証・レビューへの既存の受け渡しを通す方が、この事例を本運用へ写しやすい。 |
| [CSI の比較研究（2026-05）](https://arxiv.org/abs/2605.28334) | 同じモデルを用いた 33 個の Cybench CTF で、最良の単独 scaffold は 15/33、異なる scaffold の共有 blackboard は 19/33。20.2 時間対 26.8 時間だが、費用は 5,480 ドル対 5,122 ドルと報告する。 | 手法の補完を示す一つの比較だが、CTF と未知の WordPress では分布が違う。blackboard や別の探索 Harness を本番へ足す判断は、現在の 1 Snapshot・1 協調 Trial の規則と凍結条件を改める実験になる。 |
| [Google/Mandiant AVDH（2026-08）](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)、[Google Mantis](https://github.com/google/mantis)、[Anthropic の参照パイプライン](https://github.com/anthropics/defending-code-reference-harness/blob/main/docs/pipeline.md)、[Cloudflare の経験](https://blog.cloudflare.com/build-your-own-vulnerability-harness/) | 専門化した工程、仮説の批評、独立検証、出力と費用の測定が共通する。ただし各事例の対象・実行環境・自己報告の成績は異なる。 | このリポジトリでは工程を skill と判定器へ置く。探索方法の索引・dispatch・coverage を Harness コードへ戻す理由にはならない。[ADR 0034](../adr/0034-harness-control-only-deletions.md)。 |
| [OpenAI の隔離逸脱の一次報告（2026-08）](https://openai.com/index/hugging-face-incident-and-the-road-ahead/) | 社内のサイバー評価で、隔離を意図した agent が許可外の通信と外部システムへの行動に進んだと報告する。 | agent や外部 Harness を連携させる場合も、gVisor、broker、使い捨て環境、nonce canary 判定と外部行動承認の境界を保つ必要がある。これは効率の成績を示す事例ではない。 |

## 直近の研究をどう解釈するか

| 研究 | 観測と留保 | 次の問い |
| --- | --- | --- |
| [Curmi・Wilde, 2026-10-20](https://arxiv.org/html/2610.28802v1) | 24 の model–runner 構成を非公開時点の実コードで試し、265 の確認済み根本原因を集計。最良の 2-run 集合も全体の 60.4%、1 model だけが見つけたものが 14.3% と報告する。ただし論文要旨の「CodeQL 文脈込みで +20–86%」は minimal prompt から設計済み prompt と文脈の**両方**を変えた比較。本文 Table 11 では設計済み prompt に CodeQL 文脈だけを足すと 4 model 中 3 model で yield が下がった。repo の実体は非公開、各条件 2 run。 | model・prompt・文脈を一度に増やさない。入口索引や CodeQL 文脈を再導入する前に、同じ Snapshot と予算で 1 要素ずつ測る。 |
| [Evron, 2026-10-21](https://arxiv.org/abs/2610.29379) | 12 個の公開探索 Harness を調べ、13 の構造的な見逃し箇所を整理。同じ 1 ファイルを 6 Harness が model に渡す前に落とし、5 件はそのことを知らせなかったという実証。ただし著者自身が管理する Harness も含む preprint の実験。 | 既にある固定 source の全量提供、出力の全件保存、保留と `incomplete` の区別を維持する。モデルを増やすより先に、入力・保存・レビューで候補を黙って失わないことを確認する。 |
| [AgentFlow, 2026-04](https://arxiv.org/abs/2604.20801) | 役割、prompt、道具、連携を最適化し、Chrome で未知 10 件を見つけたと報告する。Chrome を build・計測できる専用環境での成果である。 | 自動で探索戦略を書き換える設計は、現在の Harness 制御限定と 1 Trial の主経路に合わない。将来の比較仮説にはなるが、現行本番の改造根拠にはならない。 |
| [BountyBench, NeurIPS 2025](https://papers.nips.cc/paper_files/paper/2025/hash/faed4276b52ef762879db4142655c699-Abstract-Datasets_and_Benchmarks_Track.html)、[ZeroDayBench, 2026](https://arxiv.org/abs/2603.02297) | 前者は 25 実システムの 40 既知 bounty で、Detect は最大 3 試行の最良でも 12.5%。後者は 22 の移植した既知脆弱性から未知に近い条件を作る。いずれも各対象に脆弱性がある評価である。 | CTF の flag 取得率より近いが、本番では脆弱性 0 の対象もある。既知事例の再発見と未知の bounty 成果を同じ分母に置かない。 |
| [NIST CAISI の評価監査（2025）](https://www.nist.gov/caissi/2-examples-cheating-caisis-agent-evaluations) | 公開解答・未来のコードを読んだ汚染や、目的の CVE を使わず採点器が待つ効果だけを起こした例を、人手で検証して報告する。監査手法に見逃しの可能性も明記する。 | 評価の答えを探索入力から遮断し、判定器が「期待した経路の効果」を見ているか確認する。nonce canary、Snapshot digest、修正版での負の対照を保持する。[SPEC §2, §10](../SPEC.md)。 |

## 選択肢と推奨順

| 順 | 選択肢 | 先に答える問い / 採用条件 |
| --- | --- | --- |
| いま | v8 の本番探索を新規対象で続け、ADR 0038 の 6 段を 1 Finding で最後まで通す | どの段に何分・何件滞留するか。判定器の `incomplete` も観測を添えてレビューへ届ける。外部送信は正確な候補・文案・送信先への承認に結び付ける。 |
| いま、読み取り専用 | 既存の台帳と封印済み出力から Trial の完走率・停止理由、重複を除いた source 経路、各段への到達、operator の所要時間、wall、出力・cache token、provider 利用を同じ cohort で集計する | 現状の `filesRead` と非 cache 入力 token は runtime 間の比較に使えない。子同士の仮説重複、60 分以降に増えた経路、Lead が Finding に育った割合は未測定。経路の意味上の重複や発見時刻は台帳メタデータだけでは判定できず、必要なら Private Evidence 内の transcript を標本確認する。未公開本文はこの文書へ転記しない。[SPEC §10](../SPEC.md)。 |
| 6 段の通過後 | **探索の最初の 1 軸は、重複・根拠不足が主因なら prompt の source 経路追跡を検討する。** 旧 `bounded-wp2shell/v1.7` にあった前方・後方・保存先をまたぐ追跡を、現在の v8 と対照する。ただし事前索引、対象固有名、脆弱性が必ずあるという前提は足さない。 | 旧版の成功例は対象・時期・runtime が異なり、改善の因果根拠ではない。[過去の出典比較](2026-10-13-prompt-source-comparison.md)、[LESSONS 1–2, 14](../LESSONS.md)。prompt を変えるなら版と digest を上げ、出典対照表を作る。 |
| 6 段の通過後 | token / quota が主因なら、既存の子 model 構成または同一 Trial 内の異質な役割を **別の 1 軸**として比較する。Strix を別 run として同じ対象に重ねる案は、追加予算と現在の 1 Trial 規則の改訂を要する。 | Sonnet / Haiku の既存比較では小さい子の節約効果が出ていない。[子モデル実験](../evaluation/2026-10-21-child-model-experiment.md)。別 model・別 Harness を併用するときは、独立したユニーク経路の増分と検証・レビューへの到達を費用込みで見る。 |

探索変更を試す際は、[DEVELOPMENT §5](../DEVELOPMENT.md) の異なる対象の初回 Trial 最低 3 件というゲートを守る。方式間の比較が承認されたら、各対象の比較条件で Snapshot・runtime・制限時間・出力契約を揃え、変える軸を一つにする。既知事例の評価には答え・PoC・修正差分を agent に渡さない。主要な結果は **重複を除いた scope 内の有効な経路が検証・人間レビュー・提出判断まで進んだ数／費用と時間**とし、生の Finding 数は診断値にする。候補 0 件や `incomplete` を成果ゼロと混ぜない。比較のために 2 回目以降の Trial が必要なら、先に現在の主経路との整合を設計・承認する。[SPEC §6, §10](../SPEC.md)、[ADR 0032](../adr/0032-owner-decisions-on-constraints-2026-10-13.md)。

## 未確認の仮定と資料の適用限界

v8 の子の仮説がどれだけ重複するか、最低 60 分以降に新しい有効な経路が増えるか、Finding の増加が提出・報奨につながるかは、まだ測れていない。現時点の本番数値は時点付きの切片で、全期間の最終転帰ではない。wp2shell、Wordfence、Eye Security、Google/Mandiant、Gambit の記録は各者の自己報告を含み、当ハーネスと同一条件の比較実験ではない。CTF、既知 bounty、他言語の実コード、一般検索 agent の成功率は、未知の WordPress bounty の発見率へ換算できない。
