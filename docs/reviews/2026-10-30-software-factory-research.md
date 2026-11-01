# Software factory の一次資料と適用候補（2026-10-30）

調べて報告。確認日は **2026-10-30**。対象は、この WordPress bounty Harness を開発・保守する工程である。
本書は正本ではなく、調査と提案の記録である。規則、権限、承認条件を追加しない。
正本は [SPEC](../SPEC.md)、[ADR](../adr/)、[DEVELOPMENT](../DEVELOPMENT.md)。[LESSONS](../LESSONS.md) とも照合した。
実装、製品の導入、外部サービスの変更、自動運転の開始、対象プラグインの実行は行っていない。
ローカル設定の照合時点は HEAD `7cf799a72dd1d6ce28bc4914336b62b28606319d`。同時作業の未コミット変更は本書の変更に含めない。

## 1. 結論と読む順

新しい factory 製品を重ねる前に、**既存の検査が失敗を見逃さず、レビューした変更だけを取り込める状態**を作る。
GitHub Issues、既存 skill、CI、正本、AI への merge 委任が既にあるため、別の作業列や orchestrator は直近の不足を解決しない。

読む順は、Anthropic のコードレビュー運用、OpenAI の harness engineering、Stripe の Minions、HumanLayer の設計・文脈管理、評価の資料とする。
O’Reilly の記事は全体の見取り図として読む。実装候補の README は、記事の主張と製品の実際の機能・費用・成熟度を区別するために読む。

- **今**: 古い手順の同期、失敗する検査の確認、レビュー対象 commit の記録、再レビューの収束、機密検出時のログを直す候補を具体化する。
- **後**: 既存工程で残る欠陥や作業の停滞を測り、追加レビュー製品や orchestration の必要性を判断する。
- **見送り**: 新しい人間承認段階、無制限の修正ループ、未知の発見数を proxy だけで最適化する仕組み、factory の一括移植。

## 2. 既存メモから増えたこと

| 既存文書 | 本書との関係 |
| --- | --- |
| [10/30 開発環境整備の一次資料メモ](2026-10-30-development-environment-primary-sources.md) | 2 記事の原則と既存工程の対応が出発点。本書は周辺の一次資料、公開実装の制約、着手候補の確認方法を足す。 |
| [10/30 AI 開発の用語と関係](2026-10-30-ai-terms-and-relations.md) | harness、workflow、orchestration、eval、meta-harness の意味はここを参照し、本書で別の定義を作らない。 |
| [10/15 software factory と meta-harness](2026-10-15-software-factory-and-meta-harness.md) | 同じ問いの履歴。既存 factory 要素の確認は引き継ぐが、当時の発見件数、判定器、測定条件を現在の事実として使わない。 |

10/15 の「未知 0 件」「60 分と Lab が固定」「runtime-confirmed を次の smoke へ」といった前提は、現在の運用へ引き継げない。
Meta-Harness の評価費用も一律に数分とはいえない。[公開 TerminalBench 例](https://github.com/stanford-iris-lab/meta-harness/blob/main/reference_examples/terminal_bench_2/README.md)は、1 iteration を約 4〜6 時間・約 $500 と説明している。
これはその例の構成による費用であり、この Harness の予算見積もりではない。

## 3. 優先して読む一次資料

日付は記事の公表日。更新型のドキュメントは確認日現在の内容を使う。

| 優先 | 資料・日付 | 確認できる内容 | この repo での使い道 |
| --- | --- | --- | --- |
| 1 | [Anthropic: How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/) — 2026-10-15 | 別文脈のレビュー、指摘の検証、再レビューの収束、回帰・revert による評価。 | 既存レビュー手順の改善。社内の人間承認人数は写さない。 |
| 2 | [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/) — 2026-02-11 | 短い AGENTS から正本へ辿る構造、設計境界の機械検査、agent から読める実行結果。 | 新基盤より、正本と手順の同期、既存境界検査の利用を優先する。 |
| 3 | [Stripe: Minions Part 1](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents)、[Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2) — 2026-02-09、02-19 | 必須の決定的処理と agent の判断を組み合わせ、人間と共通の開発環境・検査を使う。 | 検査の省略防止と修正回数の上限を考える。大企業の内製運用を丸ごと再現しない。 |
| 4 | [Addy Osmani: Software Factories, Light and Dark](https://addyosmani.com/blog/software-factories/) — 2026-07-20。[O’Reilly 再掲](https://www.oreilly.com/radar/software-factories-light-and-dark/) — 09-18 | 検証能力に自律性を合わせることと、長期の理解・保守性の問題。 | 既存の小さい PR と逆圧の意味を確認する。 |
| 5 | [Dex Horthy: Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md) — 2026-07-22 | 問題・成功条件、構成、プログラム設計、縦断スライスを実装前に見える形にする。 | 曖昧な依頼を受入条件へ変える。4 段の人間承認は増やさない。 |
| 6 | [HumanLayer: Advanced Context Engineering](https://www.humanlayer.dev/blog/advanced-context-engineering) — 2025-08-29 | 調査・計画・実装で必要な文脈を圧縮し、検索を子へ分離する。 | 現在の research / code-review skill で根拠付きの引き渡しを作る。 |
| 7 | [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) — 2026-01-09 | 本番失敗を評価へ戻し、能力評価と回帰評価、自己申告と最終状態を区別する。 | まず実際の制御上の不具合を、小さい回帰試験へ戻す。 |
| 8 | [Meta-Harness 論文 v1](https://arxiv.org/html/2603.28052v1) — 2026-03-30 | 過去候補のコード・score・実行 trace を proposer に読ませる外側の探索。 | 結果から原因を調べる参考。現在の未知脆弱性探索を自動最適化する根拠にはしない。 |

Anthropic、OpenAI、Stripe の速度や品質の数値は当事者の内部事例であり、この repo で同じ効果が出る比較実験ではない。
O’Reilly と HumanLayer の保守性に関する主張も、普遍的な失敗率や全モデルの限界を証明したものとして扱わない。
Dex の公表日は [HumanLayer の資料一覧](https://www.humanlayer.dev/blog/humanlayer-resources)で確認した。

## 4. 一次資料の事実と、この repo 向けの推論

### 4.1 レビューは指摘数だけでなく収束を見る

**資料の事実**: Anthropic は 3 巡で方法を再考し、その後の差分に絞り、既出指摘を繰り返さないよう変更した。
過去の incident と revert を評価材料にし、正しい変更への誤指摘も調べている。コードベースの理解には、変更する部分の説明を都度作る方法も使う。

**適用案**: 初回は Issue の意図・正本・周辺実装を読む。修正後は未解決項目と新差分を中心に見る。
3 巡は自動承認や不具合の無視ではなく、同じ修正を続ける前に方針を見直す目安とする。
同じ指摘の言い換え、実装前からある問題、好みだけの修正を分ければ、AI 同士の不要な往復を減らせる。

### 4.2 文脈を増やすより、正本へ戻れるようにする

**資料の事実**: OpenAI は AGENTS を大きな手引きではなく、repo 内の詳しい文書への地図にした。
HumanLayer は検索の過程を子の文脈に分離し、親へ調査結果を圧縮して戻す。
[12-factor agents の該当章](https://github.com/humanlayer/12-factor-agents/blob/main/content/factor-10-small-focused-agents.md)も、小さい担当範囲を勧める。

**適用案**: Issue の受入条件、該当する SPEC/ADR、根拠の file:line、確認コマンドを短く渡す。
常に長い計画を作る必要はない。新しい用語集や知識 DB より、現在の [GLOSSARY](../../GLOSSARY.md) と正本への参照を保つ。
Issue → PR → 検査・レビュー対象 SHA → 稼働版 → Trial → 人間観測 → 転帰を辿れる参照を残せばよく、graph DB や ontology 基盤は前提にしない。
「3〜10 step」などの経験則を、WordPress 探索 Trial の固定停止条件として追加しない。

### 4.3 必須検査と判断の置き場を分ける

**資料の事実**: Stripe は devbox、既存の規則、lint、CI を再利用し、CI は最大 2 回としている。
検査は確実に通る経路に置き、agent はその間で必要な判断をする。Minions は公開された導入製品ではない。

**適用案**: 必須の `pnpm check` と既存 CI を、agent の「確認した」という文章で置き換えない。
実装中の検査は変更に合わせ、最終状態で必要な検査を通す。失敗時は対象 commit・失敗内容・次の行動を残す。
worktree はファイルの分離であり、権限やネットワークの隔離ではない。対象実行の gVisor 要件は変わらない。

### 4.4 生成量と理解・成果を混同しない

**資料の事実**: O’Reilly は、検証できる範囲を超えた生成と、コードを理解できなくなる負債を問題にする。
Dex は作業の大きさに応じて、直接実装、短い計画、複数の縦断スライスを使い分ける。

**適用案**: この repo の追加 500 行の目安、open PR が 3 本を超える間の新規実装停止を使う。
報告を増やすのではなく、変更の理由、どの契約を守るか、検査が何を見逃すか、戻し方を短く説明できるようにする。
開発 PR の逆圧を、対象範囲内 Finding の供給件数を勝手に削る規則へ転用しない。

## 5. 公開実装・公式機能の比較

| 資料・実体 | 成熟度・費用・統合上の事実 | 判断 |
| --- | --- | --- |
| [addyosmani/factory](https://github.com/addyosmani/factory) | MIT の参照テンプレート。確認した main は `8af1165`（2026-08-19）、release はなし。別ラベル群、契約、gate、skill、run 文書を導入する。 | **一括導入は見送り**。[ADVICE](https://github.com/addyosmani/factory/blob/8af116567166a0a16588b7ab1b9934ece0b775bc/ADVICE.md) の段階導入と検証予算を参考にする。 |
| [Claude Code Review](https://code.claude.com/docs/en/code-review) | Team/Enterprise 向け。静的にコードを読み、指摘と check を投稿する。build/run、承認、merge block は行わない。 | **後**。既存レビューで残る欠陥と比較できる場合に限定する。 |
| [Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/) — 2026-04-27 | Apache-2.0。[SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) は Draft v1、[Elixir 実装](https://github.com/openai/symphony/blob/main/elixir/README.md)は評価用 prototype。 | **後**。既存工程が安定し、dispatch の負担が実際の制約になってから小試行を考える。 |
| [Meta-Harness ONBOARDING](https://github.com/stanford-iris-lab/meta-harness/blob/main/ONBOARDING.md) | 反復課題、一貫した成功評価、固定モデルでの改善余地を前提に、評価固定・予算・停止条件を求める。 | **自動探索は後**。制御コードの限定課題で評価条件が用意できた場合の参考。 |
| [GitHub CLI merge](https://cli.github.com/manual/gh_pr_merge)、[Vitest](https://vitest.dev/config/passwithnotests)、[Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) | 現在使っている道具に、head 一致確認、空テスト失敗、権限・依存固定・ログ保護の手段がある。 | **今**。新しい製品なしで、下記の候補を検査できる。 |

Factory の [spec skill](https://github.com/addyosmani/factory/blob/main/template/.claude/skills/factory-spec/SKILL.md) は 4 回の人間承認を要求する。
[契約](https://github.com/addyosmani/factory/blob/main/template/docs/factory/CONTRACT.md)は全 merge の人間実行、既存テスト編集への承認も要求するため、この repo の AI 委任と衝突する。
インストーラは既存ファイルを skip する。既存 AGENTS・settings への統合を自動で解決するものではない。
[smoke test](https://github.com/addyosmani/factory/blob/main/tests/run.sh)は存在するが、今回実行しておらず、本番効果を保証する材料にもしていない。

公開 Code Review は、Anthropic 社内記事にある承認 classifier や merge 運用そのものではない。
[料金](https://code.claude.com/docs/en/code-review-costs)はプラン内使用量と別の usage credits による従量課金で、固定の無料レビュー枠として見積もらない。
自動レビューの頻度、変更の大きさ、検証する候補数で費用が変わる。check は失敗状態にならず、既存 gate の代用品にはならない。

Symphony は Issue ごとの workspace、並行数、retry、終了処理、ログを扱う。
現在の Elixir 実装には Linear、GitHub Issues、Jira Cloud、Asana、GitLab の adapter があるため、Linear 専用とは扱わない。
sandbox の強制は仕様の非目標である。導入しても対象実行の隔離要件は満たしたことにならず、既存 CI・レビュー・権限設定との接続も必要になる。

[StrongDM の software factory](https://factory.strongdm.ai/)（2026-02-06）は、仕様・シナリオから非対話実装と検証を行い、シナリオを codebase 外の holdout とする参考例である。
ただし、全コードの人間 review 不要や token 消費目標を規則にしない。LLM judge による Finding 確定、削除済みのプラグイン別シナリオの復活にも使わない。

## 6. この repo で確認した不足

| 読み取った状態 | 意味と限界 |
| --- | --- |
| [vitest.config.ts](../../vitest.config.ts) に `passWithNoTests: true` がある。 | 検出 0 件でも成功し得る設定。現在の通常実行で 0 件だった、という観測ではない。 |
| [PR 手順](../agents/pr-review-merge.md)と[PR テンプレート](../../.github/pull_request_template.md)に旧「開発 6 case × 3 run」が残る。 | DEVELOPMENT §5 の本番比較と、開発セットへ戻す限定条件へ同期する必要がある。 |
| PR 手順の merge コマンドは `gh pr merge --squash`。 | レビューした head と取り込む head の一致条件が手順にない。`owner-approved` ラベルだけでは新 push 後の再読を示せない。 |
| [check.yml](../../.github/workflows/check.yml) の private-guard が検出本文の先頭 120 文字を出力する。 | 混入を止める際に、その内容を CI ログへ再表示する経路。実際の漏洩を確認した主張ではない。 |
| Actions は `@v4` 参照で、workflow に `permissions` 宣言がない。 | 依存固定と最小権限を明示できる余地がある。現在の実効 token が write だと断定はしていない。 |
| [package.json](../../package.json) と [境界試験](../../tests/architecture/module-boundary.test.ts)に dependency-cruiser と architecture test がある。 | 境界を守る基盤は既にある。新しい解析製品を入れる前に現在の検査を使う。 |

`pnpm check` は型検査・Prettier・Vitest の組み合わせで、`lint` は整形検査である。既存の境界試験には空 graph の拒否や import 種別の負の対照もあり、境界試験全体が不足しているとは判断しない。
10/30 の GitHub 読取では public・個人所有 repo、strict な required checks は `check` / `adr-guard` / `private-guard`、必須承認数は 0 だった。
これは照会時点の設定であり、各 PR に独立レビューが実行された証拠ではない。
[GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)は organization 所有が要件なので、この repo へ直ちに追加する案にはしない。

`pnpm check` は型検査・Prettier・Vitest であり、`lint` は整形の確認である。境界試験には空の依存グラフを拒否する検査と、禁止した type import・re-export・dynamic import を検出する負の対照が既にある。検査を追加するときは、既存の検査が扱う契約と重複させない。

public repo の標準 GitHub-hosted runner は無料だが、larger runner は有料である（[公式料金説明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)）。無料でも、hosted job は 6 時間、同時実行はプラン別の上限がある（Free なら標準 runner 20 job。現在の契約プランは未確認。[Actions limits](https://docs.github.com/en/actions/reference/limits)）。AI API や上記のレビュー製品の料金は別途考える。
public repo の標準 hosted runner は [無料の範囲](https://docs.github.com/en/billing/concepts/product-billing/github-actions)に入るが、[job 6 時間・プラン別並行数などの上限](https://docs.github.com/en/actions/reference/limits)は残り、大きい runner や保存領域も含めた無制限無料ではない。

## 7. 次に具体化する小さな作業候補

以下は情報収集から得た候補であり、Issue の作成や実装の開始を意味しない。既存の問い・作業と重複すれば、そちらへ統合する。

### 候補 1: 空の検査を成功させず、失敗を回帰試験へ戻す

問いは「検査対象が消えた場合と、既知の制御上の失敗を、検査が確実に止められるか」。
空テスト成功の設定を見直し、実際に起きた制御上の不具合を 1 件だけ小さい fixture へ落とす。
対象例は resume の重複、子の成果保存、schema 正規化、digest 不一致などであり、未発生の問題を一度に試験化しない。

最低限の確認は、存在しない対象のテスト実行が非ゼロで終わること、選んだ不具合が修正前に失敗・修正後に成功すること、通常の `pnpm check` が通ること。
fixture は合成した制御記録を使い、対象プラグインをホストで実行せず、Private Evidence の本文を Git へ移さない。

### 候補 2: 正本とレビュー対象 commit を揃える

問いは「正しい受入条件でレビューした変更を、同じ commit のまま取り込めるか」。
旧測定手順を DEVELOPMENT §5 へ同期し、既存レビュー comment に対象 head・確認した検査・未解決項目を残す形を具体化する。
`--match-head-commit` を使う merge 手順と、修正後の再レビュー対象・巡回数を検討する。新しい人間承認は置かない。

最低限の確認は、レビュー後に head が変わった場合に古い SHA を指定した merge が拒否されること、新 push 後は対応する差分と検査を再確認すること、指摘が修正または理由付きで解消されたこと。
1 件の小さい PR で、受入条件→検査→独立レビュー→既存の委任による merge→適用後の確認まで、記録を辿れるかを見る。
コードの revert と追記専用台帳の互換性を区別し、merge 済みと本番適用済みも別の状態として記録する。

### 候補 3: 機密を検出してもログへ出さない

問いは「Private Evidence の混入を止めながら、CI 自身が検出内容を公開しないか」。
private-guard の出力を分類・場所などの必要な情報に絞り、Actions の必要権限と依存固定を同じ実行経路で確認する。
最低限の確認は、合成した検出対象で guard が失敗し、stdout/stderr に合成の値が残らず、正常入力は通ること。

Actions の固定には full SHA が使える。2026-10-28 の [workflow lockfiles の GA 告知](https://github.blog/changelog/2026-10-28-github-actions-workflow-lockfiles-are-generally-available/)は Free を含む提供を明記している。参照 tag を読みやすいまま、推移依存も含め実行 commit を固定できる。ただし確認時点の[導入 docs](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies)には対象プランの表示差が残るため、採用時に利用可否を再確認する。現状の 3 種の Action には、まず full SHA 固定を使う小さい変更も選べる。
[Secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning) は対応する secret を扱うもので、未公開 Finding・HTTP・payload の private-guard を置き換えない。合成データで guard の検出力を確認しても、あらゆる機密の検出を保証したことにはならない。

追加の公式機能では、[Dependency Review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)は public repo で依存変更の既知脆弱性を調べられる。[pnpm lockfile は対応対象](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems)なので、依存グラフと alerts の現設定を確認してから候補にする。[CodeQL default setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning) は後の小試行候補とし、有効表示だけでなく対象 SHA の解析成功と有用な指摘を確かめる。これらの実設定とこの repo での効果は、今回確認していない。

## 8. 改善を評価するときの境界

開発工程では、PR の待ち時間・再レビュー回数・修正時間に、merge 後の不具合・revert・復旧時間を添える。
[DORA](https://dora.dev/guides/dora-metrics/)の現在の 5 指標も参考になるが、まず既存 Issue・PR から読める数字を使い、計測基盤を先に作らない。
provider 停止は deployment 起因の失敗と分け、PR 数や token 消費量だけを成果にしない。

製品側は、運転の completed・停止・wall・使用量、候補の Finding・検証待ち、成果の人間 match・提出・報奨を分ける。
未観測、環境・手順不足の `incomplete` を不成立や 0 点にしない。費用が取得できなければ unknown とする。
探索入力の比較は DEVELOPMENT §5、Trial の分母と再開区間の扱いは [measurement](../agents/measurement.md)に従う。
`partitioned` の分母は `runKind: enumerate` で、追跡役の run と再開 segment を別の Trial に足さない。旧 `explore` だけの集計を全 mode へ流用しない。

改善の記録は、Issue → PR → 検査・レビュー対象 SHA → 実際に稼働する版 → Trial → 人間の観測 → 提出転帰を辿れる形が有用である。これは参照の持ち方の提案であり、新しい ontology 基盤や graph DB を必要とするものではない。

Meta-Harness の論文では TerminalBench の探索と最終評価に同じ 89 問を使う。漏洩監査は独立 holdout の代わりにはならない。
[公開 TerminalBench 例](https://github.com/stanford-iris-lab/meta-harness/blob/main/reference_examples/terminal_bench_2/README.md)は 89 問×2 trials、並行 50、高い API throughput を想定する。timeout の環境要因を推論失敗と分ける必要がある。
[分類の公開例](https://github.com/stanford-iris-lab/meta-harness/blob/main/reference_examples/text_classification/README.md)も test を同梱し、分離は運用上のものでアクセス制御ではないと説明する。
自動最適化を将来試すなら、評価を固定し、候補選択に使わない test、総予算・候補別予算、停止条件を先に置く。未使用 test がなければ探索的結果として扱う。

これらの評価方法を、WordPress Finding の成立判断に流用しない。
確定の根拠は [ADR 0040](../adr/0040-human-lab-observation-replaces-judges.md) と現行 SPEC が定める、名指した人間の同じ Target Snapshot digest・attempt に結び付いた `review observe` の match と `review decide --reproduced match` である。
評価の答え、後日の公開履歴、Private Evidence を探索へ渡さず、探索の舵取りを Harness のコードへ戻さない。

## 9. 調査の範囲と未確認

一次記事、公式ドキュメント、公開 repo の README・契約・一部実装、ローカル設定を読んだ。公開コードの導入・実行はしていない。
ローカル設定の確認対象は commit `7cf799a72dd1d6ce28bc4914336b62b28606319d`。本書は文書の整形を確認し、製品コードの変更・テスト実行はしていない。
製品価格・機能・GitHub 設定は変わり得るため、実際の採用時に再確認する。
レビューの誤指摘率、待ち時間、復旧所要時間、現台帳の成果件数は本調査では集計していない。
各社の実績をこの repo の期待効果へ外挿せず、まず候補 1〜3 の必要性と確認結果から次の一手を決める。
