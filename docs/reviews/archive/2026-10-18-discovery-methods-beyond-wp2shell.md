# WP2Shell 以外の探索手法をどう見るか（2026-10-18）

## 問いと結論

問い: WordPress プラグインの未知脆弱性を見つける探索法として、現行の `wp2shell-bounty-v3` に加えて何を調べる価値があるか。

**結論（推論）:** 最初に比較する価値が高いのは **GitHub Security Lab の Web 監査 Taskflow**。PHP の WooCommerce で認可ロジックの未知の問題を発見した一次資料があり、探索の手順と中間記録も公開されている。次点は **Mandiant AVDH の「入口ごとに access control と data flow の仮説を別に作る」方式**。ただし AVDH の内部実装と対象別の費用・見逃し数は公開されていない。どちらも現行の固定 Snapshot、scope、Lab、判定器で優位と示されたわけではない。今は方式を切り替えず、Step 1 の既定方式の実測分母を先に作る。[GitHub Security Lab の方法と WooCommerce 事例](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)、[Mandiant AVDH](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)、[DEVELOPMENT 第2節](../../DEVELOPMENT.md)、[PARKING](../../PARKING.md)。

この報告は探索方法の調査であり、prompt、Trial、判定器、正本は変更しない。既存の[公開ハーネス比較](2026-10-13-anthropic-mantis-cloudflare-source-notes.md)と[参考方式の観測点](../../knowledge/imported/09-wordpress-harness/knowledge/reference-harness-observability.md)は構成・隔離・検証を扱った。ここでは **何を次の調査対象とするか**、すなわち探索の frontier と比較可能性に焦点を当てる。

## 手法の地図

```text
                         次に調べるもの
WP2Shell（現行）       Root が仮説を更新し、子を動的に分担
GitHub Taskflow        機能 → 入口 → 通常権限 → 仮説 → 個別監査
Mandiant AVDH          入口 → 権限制御 / 入力の流れ → 仮説
Mantis / Visa VVAH     構造・脅威モデル → 計画した単位 → 複数 lens
XBOW                   実サイトの操作 → 小さな観測 → 次の操作
Big Sleep              過去の修正 → 同類の未修正箇所
Code-Augur             安全という仮定 → 実行で反証
```

現行方式は、対象ごとに Root＋最大3子の協調 Trial を1回、既定上限60分で回し、固定 source 由来の入口索引をカタログとして渡す。Root が分担と仮説を決め、全入口の処理や最低実行時間は終了条件ではない。`wp2shell-bounty-v2` などは別 arm であり、過去の二段構え・索引なし Trial を同一分母に混ぜない。[SPEC 第6節](../../SPEC.md)、[ADR 0029](../../adr/0029-single-wp2shell-cooperative-trial.md)。元の wp2shell は WordPress Core の一つの成功例で、途中の人間による確認・追加の問いを含む。多数の未知プラグインを無人で回した比較実験ではない。[発見者の記録](https://www.slcyber.io/research/exploit-brokers-pay-500000-for-a-wordpress-rce-i-found-one-with-gpt5-6#the-story-of-wp2shell)、[既存の出典照合](../../knowledge/imported/09-wordpress-harness/knowledge/wp2shell-current-research-gap.md)。

## 1. GitHub Security Lab Web 監査 Taskflow — 最も近い比較候補

**公表日:** 2026-03-06、03-10更新。公開 framework / taskflow の説明と実例がある。[GitHub Security Lab 公式記事](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)、[taskflow の公式 repository](https://github.com/GitHubSecurityLab/seclab-taskflows)。

- **frontier:** repo を機能別 component に分け、入口・Web の HTTP 経路・通常の利用者ができる操作を記録する。そこから問題の種類を広く提案し、各提案を独立した source 監査 task として処理する。中間結果は DB に渡す。記事は、大きな単一 prompt で手順が抜けることを避けるための taskflow と説明する。[手順の解説](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)。
- **公開された成果:** 著者らは主に複数利用者の Web アプリ40 repoで、問題の提案1,003件 → agent が脆弱とした139件 → 重複を除いた91件 → 人間が重大で報告に値するとした19件を報告した。91件のうち20件は手動再現できず、52件は影響が低いとして除外した。別に報告済み80件超という累積値も示すが、40 repo の19件と同じ分母ではない。WooCommerce では通常のログイン済み買物客が guest order の個人情報を見られる問題を発見した。[実績と WooCommerce 事例](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)。
- **限界:** 同じ repo を平均数回実行してから重複排除しており、1 Trial の yield ではない。公開記事は miss 数、対象あたり token 費用、Wordfence / Patchstack の受理率を示さない。低 severity filter は境界上の報告候補も低く判定したと著者ら自身が書く。提案を早く落とす部分を現行の Finding / Lead 保存規則にそのまま移すと偽陰性の危険がある。[著者らの集計と filter 評価](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)、[LESSONS 1・10](../../LESSONS.md)、[ADR 0018](../../adr/0018-hold-and-normalize-discovery-candidates.md)。
- **現行との接点（推論）:** WP2Shell の Root も入口索引を見られるが、Taskflow は「通常の権限で許される操作」を先に明示し、仮説を小さい監査単位として保持する。この差を比較できる。WooCommerce 事例は PHP / WordPress 系コードでの適合例である一方、現行の選定方針は Automattic を対象外作者として扱うため、この WooCommerce 自体をキャンペーン対象にする根拠にはならない。[選定方針](../../../src/profiles/wordpress/policy/selection.json)、[Taskflow の手順](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)。

## 2. Mandiant AVDH — 権限とデータの二つの仮説

**公表日:** 2026-08-18。内部の point-in-time architecture を Mandiant が説明した。公開実装は示されていない。[Mandiant 公式記事](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)。

- **frontier:** threat model → 全 in-scope file の入口抽出 → 入口に必要な周辺コードの収集 → Access Control agent と Data Flow agent が別の仮説を広く作る → 複数 Validation agent が反証し、人間が動的再現する。入口ごとの周辺関数、権限 checks、値の変換、保存先を結ぶのが探索単位。仮説段階では minimal self-validation とし、consultant が設定する confidence filter が数を制御する。[AVDH の入口・仮説・検証](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)。
- **公開された成果:** Mandiant は10か月の運用で多数の調査、公開 OSS / Web extensions に関する12件の CVE 付与、ある事件対応で2日間に critical true positive 100件超と自己報告する。対象・予算・未検出分母が違うため現行 Harness の発見率には換算できない。[Mandiant の実績説明](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)。
- **現行との接点（推論）:** WordPress の `current_user_can` 等の制御と、入力→保存→表示の経路は異なる観点なので、二種類の仮説を独立に残す構造には意味がある。ただし「全 file を処理済み」「confidence が低いから棄却」を未知の脆弱性不存在や安全な早期除外とみなせない。現行の入口索引はカタログで、全入口処理を終了条件にしない。[SPEC 第6節](../../SPEC.md)、[AVDH 方法](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)。

## 3. Mantis と Visa VVAH — 計画・構造索引を前面に置く

**Mantis:** Google の公開 reference guide は、履歴・構造索引・architecture / threat model / plan を作り、file ごとの調査、重複排除、review、critic、再現、chain 等へ渡す。reference implementation は `file-by-file` の後に `cross-functional` を選べる。著者は coverage は絶対保証でないと明記する。[Mantis reference guide](https://github.com/google/mantis/blob/main/README_AGENTS.md)、[reference implementation](https://github.com/google/mantis/blob/main/reference/README.md)。**推論:** 横断的な保存→表示の chain は比較する価値があるが、段数や索引だけから発見率は読めない。履歴 stage の CVE 詳細や将来時点の情報を現行 discovery に渡すことは、公開履歴をカタログかつ時点で切る [SPEC 第2・6節](../../SPEC.md) と [ADR 0012](../../adr/0012-time-cut-known-vulnerability-history.md) に反する。

**Visa VVAH:** 2026-06に open source 公開。現行 docs は、脅威モデルで優先順位を付けた investigation unit を source / code graph の文脈で調べ、adversarial review で候補を絞る S0–S9 を示す。source の実行証明と model verifier の `TRUE_POSITIVE` は別で、発見精度・再現率の公表値はまだ無い。v1.4 の任意の exploit verification は API collection と localhost の稼働対象を要する beta と説明される。[Visa 公式発表](https://corporate.visa.com/en/sites/visa-perspectives/security-trust/visa-cybersecurity-mythos-project-glasswing.html)、[VVAH README](https://github.com/visa/visa-vulnerability-agentic-harness)、[features](https://github.com/visa/visa-vulnerability-agentic-harness/blob/main/docs/features.md)。**推論:** code graph を索引として使う点は参考になるが、現行の gVisor Lab と nonce canary 判定器を代替する検証方法ではない。比較対象にするなら detection 部だけを別 arm とし、後段の判定器は共通にする。[SPEC 第2・7節](../../SPEC.md)。

## 4. XBOW — ライブ Web 操作からの反復

**公表日:** 実運用の説明は2025-06-24、段階的検証の説明は2026-04-08。XBOW は多数の実サイトを対象に、scope と到達可能な endpoint 等から対象を順位付けし、発見ごとに validator を使う。例として endpoint の存在、object reference、ログアウト時のアクセス可否を小段階で確認してから次へ進む。2025年の記事は1,060件近い提出、resolved 130件、triaged 303件、duplicate 208件等を自己報告するが、異なるプログラムと live black-box 対象を集計している。[XBOW の運用記録](https://xbow.com/blog/top-1-how-xbow-did-it)、[小段階の検証方法](https://xbow.com/blog/ai-pentesting-strengths-weaknesses-xbow-fills-gaps)。

**推論:** 「一つの観測が成立したら次の仮説へ」は有用な探索の考え方。ただし今の Harness は固定 source / Lab に限定し外向き通信を broker API に限るため、XBOW の公開 bug bounty サイト向け探索をそのまま実行できない。scope の解析・live domain 拡張・多数同時 scan の成果を、WordPress プラグイン1対象1 Trial の効率と比べるのも不適切。[SPEC 第2・6節](../../SPEC.md)、[XBOW の運用記録](https://xbow.com/blog/top-1-how-xbow-did-it)。

## 5. Big Sleep、Code-Augur、dataflow — 強い着想と入力制約

- **Project Naptime / Big Sleep:** Google Project Zero は code browser・script・debugger・実行判定を持つ反復型研究と、複数の独立 trajectory を説明する。Big Sleep の SQLite 実例は、過去の修正 commit message と diff を種に、同類の未修正箇所を探した variant analysis である。著者は単一実例を高度に実験的とし、専用 fuzzer の方が少なくとも同程度に有効かもしれないと明記する。[Naptime、2024-06-20](https://projectzero.google/2024/06/project-naptime.html)、[Big Sleep、2024-11-01](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html)。**推論:** 「既知修正から類例を探す」は有望だが、評価対象の答えや修正差分を探索 agent に渡すと leakage になる。現行の公開履歴は時点で切ったカタログに限定されるため、この方式をそのまま現在の arm にできない。[SPEC 第2節](../../SPEC.md)、[ADR 0012](../../adr/0012-time-cut-known-vulnerability-history.md)。
- **Code-Augur:** 著者の2026-06-17論文は、agent が安全とみなす条件を局所 invariant として明文化し、guided fuzzer で反証し、誤った invariant と実際の欠陥を区別して更新する。未知22件、うち16件は開発者が修正または確認したと報告する。prospective な7 project の成果だが、WordPress / PHP と同一対象・判定器の比較ではない。[Code-Augur 論文](https://arxiv.org/html/2606.18619)。**推論:** 低権限ユーザーが満たしてはいけない状態変化を性質として記述する発想は近い。一方、PHP Web アプリのセッション・DB・被害者操作を含む stateful な fuzzer と、現行判定器にない oracle を作る費用は未測定。Step 1 中の実装対象にはしない。[SPEC 第7節](../../SPEC.md)、[DEVELOPMENT 第2節](../../DEVELOPMENT.md)。
- **Code graph / 静的 dataflow:** source→sink の経路をモデル化して候補入口の優先順位を付ける手法は、AVDH と VVAH に含まれる。source、sink、sanitize、権限、通常の振る舞いのモデルが不正確なら未知の論理バグを消したり偽候補を増やしたりする。[CodeQL dataflow の説明](https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/)、[AVDH 方法](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)。なお **CodeQL の現行サポート言語に PHP はない**。CodeQL query をそのまま WordPress profile に持ち込む案は成立しない。[GitHub の対応言語一覧](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning)。

## 別の運用目的として見るもの

OpenAI の Aardvark / Codex Security は、repo の threat model に基づき **commit 差分を継続監視**し、可能なら隔離環境で候補を試すと説明する。これは固定した配布版を多数選んで探索する現行の問いと異なる。公開記事には大規模 commit scan の件数があるが、WordPress プラグインの対象ごと1回の未知発見率はない。[Aardvark、2025-10-30（2026-03更新）](https://openai.com/index/introducing-aardvark/)、[Codex Security、2026-03-06](https://openai.com/index/codex-security-now-in-research-preview/)。

Wordfence は PRISM を広い対象の浅めの経路、Argus を一対象で長い chain を追う方式と説明し、Argus による Avada の6段 chain の発見・隔離環境での再現を報告した。WordPress 固有の実例として重要だが、同じ公式記事は Argus の構築方法を公開しないと明記する。探索 prompt、分担、対象ごとの失敗分母を再現できないため、方式比較の実験 arm を設計する材料としては弱い。[Wordfence PRISM の公開例](https://www.wordfence.com/blog/2026/05/200000-wordpress-sites-at-risk-from-critical-authentication-bypass-vulnerability-in-burst-statistics-plugin/)、[Argus の breadth / depth 説明](https://www.wordfence.com/blog/2026/08/wordfence-argus-finds-complex-6-step-critical-rce-in-avada-theme-with-1-million-sales/)。

## 何を測ってから比較するか

**提案（推論、現時点の実装依頼ではない）:** [PARKING](../../PARKING.md) が指定する通り Step 1 の既定方式に実測分母ができ、探索構造が律速だと分かった場合、問いを **「同じ WordPress 対象・費用で、Taskflow 型の component / normal-action 仮説が WP2Shell にない scope 内 Finding を増やすか」** の一つに絞る。[DEVELOPMENT 第2・3節](../../DEVELOPMENT.md)、[ADR 0029](../../adr/0029-single-wp2shell-cooperative-trial.md)。

現行 WP2Shell の prompt に観点を追加する改訂と、component ごとに独立した調査単位・状態を持つ Taskflow 方式の比較は別の問いである。前者の効果を後者の効果として数えない。[現行 Trial の契約](../../adr/0029-single-wp2shell-cooperative-trial.md)、[GitHub Taskflow の工程](https://github.blog/security/how-to-scan-for-vulnerabilities-with-github-security-labs-open-source-ai-powered-framework/)。

先に探索が律速かを切り分ける理由もある。2026-10-13 の[本番4周の読解](../2026-10-13-human-review-contract-and-parallel.md)では、scope 内で本物らしい2件が判定器の観測外で `incomplete` となり、既知7件のうち当時走った4件では探索が3経路へ到達した一方、確認は複数回の Verifier 試行と人手を要した。これは当時の局所観測で、現在の発見率の推定ではない。探索 arm を追加しても出口の歩留まりが低ければ報奨までの効果を測りにくい。[DEVELOPMENT 第1・2節](../../DEVELOPMENT.md)。

| 固定するもの | 理由 |
| --- | --- |
| 同じ Target / Dependency Snapshot、trust 境界、Programme Boundary、Lab、公開履歴 cutoff、入口索引の有無 | 正解漏れと対象条件の違いを避ける。[SPEC 第2・6節](../../SPEC.md) |
| 同じ model、provider、wall / token 上限、探索への権限 | 手法と資源量を混同しない。[ADR 0017](../../adr/0017-compare-wp2shell-bounty-and-short-prompts.md) |
| 同じ Finding / Lead 受理と独立 Verifier、nonce canary 判定器、人間 review | source 上の提案数と成立・報奨可能性を区別する。[SPEC 第5・7節](../../SPEC.md) |

測る値は対象ごとの `completed / incomplete`、scope 内 Finding と Lead、`runtime-confirmed / incomplete / contradicted`、新規の独立 Finding 数、レビューに要した時間、provider 費用、提出先の転帰。特に **scope 内の本物を早期 filter が落とした数**を、保留・原文を保持したうえで確認する。報奨までの結果が出る前には、`runtime-confirmed` と人間が採った件数を中間指標とする。[SPEC 第1・9・10節](../../SPEC.md)、[LESSONS 1・5・10](../../LESSONS.md)。開発 PR の最低3 Trial は運用上の gate であり、方式の優位性を統計的に証明する標本数ではない。[DEVELOPMENT 第5節](../../DEVELOPMENT.md)。

既知7件の再発見は配線と判定器の確認に使えるが、未知の発見率とみなさない。公開後の修正差分や PoC を agent に渡さず、prospective 対象を混ぜて結果を見る。[SPEC 第2・6節](../../SPEC.md)、[ADR 0029](../../adr/0029-single-wp2shell-cooperative-trial.md)。比較 arm を実際に作る段階では、探索に触る変更の3 Trial と、agent に渡る全文・日本語訳・出典対照表・版と digest pin などの gate を適用する。[DEVELOPMENT 第5節](../../DEVELOPMENT.md)。

## 未確認事項

- 本報告は公式記事・論文・公開 docs の読解であり、各方式をこの repo の gVisor Lab で動かしていない。Mandiant / XBOW / Wordfence の非公開内部実装は確認できない。
- 各組織の「verified」「true positive」「reported」は確認段階と scope が異なる。ここでの `runtime-confirmed`、Wordfence / Patchstack 受理、支払済みを同義にしない。[SPEC 第7・8節](../../SPEC.md)、[Mandiant の人間検証](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)、[VVAH の限界](https://github.com/visa/visa-vulnerability-agentic-harness)。
- 公開された成果は各著者の自己報告で、対象選定・費用・運用条件の統一比較ではない。優先順位は WordPress / PHP への近さと手順の公開度に基づく**本報告の推論**であり、検出能力の順位ではない。
