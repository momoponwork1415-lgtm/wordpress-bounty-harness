# 公開ハーネスの新着と本 Harness の完成度（2026-10-13）

調べて報告。正本ではない。設計について食い違えば [SPEC](../SPEC.md) と [ADR](../adr/) が勝つ。調査時点は 2026-10-13 14:30 JST。公開物は発表日・リリース日・単なるコード更新を分け、各提供者の一次資料を確認した。ローカル評価は checkout `97f2b06` のソースと日付付きの実測報告に基づく。Private Evidence の中身と本番の稼働中の台帳は今回読み直していない。コード変更や対象実行は行っていない。

## 1. 10 月 13 日までに出たもの

| 公開物 | 時期と実体 | 本 Harness に関係する点 |
| --- | --- | --- |
| [Visa VVAH v1.5.0](https://github.com/visa/visa-vulnerability-agentic-harness/releases/tag/v1.5.0) | **10 月 9 日 UTC（日本時間 10 日）の既存 OSS ハーネスの新リリース**。 | [変更履歴](https://github.com/visa/visa-vulnerability-agentic-harness/blob/v1.5.0/CHANGELOG.md)によると、code graph、S1/S3/S5 と順位付けの決定論化、型付き `findings.json` からの SARIF、coverage と失敗状態の明示、17 detection skills を追加。機械的な処理を model から外し、失敗と出力を構造化する方向は参考になる。一方、[公式の制約](https://github.com/visa/visa-vulnerability-agentic-harness/blob/v1.5.0/docs/limitations.md)では通常の探索は対象を build・run・test せず、finding は人間確認を要する候補で、実行ツールの制限も OS sandbox ではない。v1.5.0 が WordPress バウンティの実発見率を高める比較データは確認できない。 |
| [Anthropic OSS Scanner](https://www.anthropic.com/research/launching-opt-in-vuln-finding-service-for-open-source) | **10 月 8 日の新サービス**。公開ハーネスのソースではない。 | opt-in した OSS 保守者への定期 scan と、希望した保守者への未査読報告の早期送付。報告受け手の同意が前提であり、本 Harness のバウンティ提出承認を緩める根拠にはならない。発表の「85/97」は選別された high/critical 報告の人間評価で、全出力の precision ではない。 |
| [AVRI 論文](https://arxiv.org/abs/2610.11602) | **10 月 8 日投稿の研究**。証拠を持続的に記録・再利用する推論インターフェースで、汎用の完成済み探索ハーネスの公開とは区別する。 | 20 課題で Codex の費用 18.0%、OpenCode 23.7% 減、観測された成功率維持と報告。ただし対象は C/C++ の CyberGym 課題で、WordPress の論理欠陥へ外挿できない。まず当地で source 読取・wall・費用の律速を測る材料。 |
| [Google Mantis](https://cloud.google.com/blog/products/identity-security/getting-started-with-the-mantis-harness-to-find-and-fix-bugs) | 公開紹介は **9 月 2 日**。[10 月 4 日の構造索引更新](https://github.com/google/mantis/commit/8cfcde8a98fd)などは既存ハーネスの改善。 | 索引の A/B は約 5.8 万行の Linux driver、各 6 run で precision 75% 対 22%、token 約半分と報告するが、双方に固有の発見があり、小さい対象への利得は未測定。当地の入口索引は所在のカタログであり、Mantis の code graph と同等と見なさない。 |
| [Microsoft MDASH の 10 月 7 日記事](https://www.microsoft.com/en-us/security/blog/2026/10/07/3-lessons-from-frontier-ai-vulnerability-research/) | 5 月に紹介済みの**非公開ハーネスの運用報告**。新規リリースではない。 | 候補の増加だけでは検証・修正が追いつかず、有用な単位は次工程へ渡せる再現可能な finding だと説明する。公表の 140 CVE は 5〜9 月の修正・告知 cohort であり、scan 当たりの発見率ではない。 |

前回挙がった [Anthropic Defending Code Reference Harness](https://github.com/anthropics/defending-code-reference-harness) は 5 月、[Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill) は [6 月 18 日の発表](https://blog.cloudflare.com/build-your-own-vulnerability-harness/)で、10 月に新規公開されたものではない。[Cloudflare の招待制 Vulnerability Discovery and Remediation](https://blog.cloudflare.com/vulnerability-discovery-remediation/) は 9 月 3 日、[Mandiant AVDH の内部設計紹介](https://cloud.google.com/blog/topics/threat-intelligence/staying-ahead-of-adversarial-ai-through-agentic-source-code-review)は 8 月 18 日。[GitHub Security Lab の Taskflow Agent](https://github.blog/security/community-powered-security-with-ai-an-open-source-framework-for-security-research/)も 1 月公開で、[9 月の fuzzing taskflow](https://github.blog/security/application-security/ai-powered-fuzzing-with-the-github-security-lab-taskflow-agent/)は C/C++ 向け。調べた一次資料の範囲では、10 月 1〜13 日に新規公開された、WordPress バウンティ探索と直接比較可能な OSS ハーネスは確認できなかった。

## 2. 設計を比較して言えること

| 軸 | 本 Harness の現状 | 公開設計との関係 |
| --- | --- | --- |
| 実行権限と証拠 | gVisor `runsc` を必須とし、nonce canary と Snapshot digest が一致した場合だけ決定論的な `runtime-confirmed` を出す。[SPEC §2](../SPEC.md)、[既知事例の縦断実測](../TRANSLATEPRESS-BENCHMARK.md)。 | Anthropic の公開例も [gVisor と独立 grader](https://github.com/anthropics/defending-code-reference-harness/blob/d3bea6b5793b5f3d59a75ebe69a58efa88383145/docs/pipeline.md)を使う。Mantis は [再現失敗を即座に否定とせず](https://github.com/google/mantis/blob/2b3bbdcbb8d259d1777b89dcfa3c8e87615ccc80/mantis-reproduce/SKILL.md)、Cloudflare は [fresh verifier と保留状態](https://github.com/cloudflare/security-audit-skill/blob/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/skills/security-audit/SKILL.md)を持つ。問題設定が異なるため verdict の件数や名称だけで優劣は付けられない。 |
| 候補の保持 | Finding/Lead の正規化・保留と追記台帳は実装済み。[SPEC §6](../SPEC.md)、[ADR 0018](../adr/0018-hold-and-normalize-discovery-candidates.md)。 | Mantis と Cloudflare の「再現不能時に必要な事実を残す」方向と整合する。ただし当地は scope 内 Finding の **`review export` 全件到達**が未実装で、人間への最後の受け渡しが弱い。[現行 ADR 0031](../adr/0031-review-report-dedupe-as-skills.md)。 |
| 探索の構造 | 対象ごとに Root＋最大 3 子の協調 Trial を 1 回。入口索引はカタログで、全入口の処理を終了条件にしない。[SPEC §6](../SPEC.md)、[ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md)。 | Mantis の多段構成、Visa の code graph、Cloudflare の coverage ledger は対象・予算・判定基準が違う。こちらで同予算の発見改善が測定されるまで輸入する根拠はない。 |
| 運用の再現性 | 縦断パイプラインと本番数周は実施済み。ただし週次 quota の無介入完走と人間の review batch は未実証。[DEVELOPMENT §2](../DEVELOPMENT.md)、[本番記録](2026-10-13-human-review-contract-and-parallel.md)。 | Microsoft の 10 月記事が強調する「次工程に渡る finding」という物差しでは、こちらの未完部分が明確。公開各社の社内成果数は、対象・投入資源・判定条件が違うため当地の完成率には変換できない。 |

## 3. 完成度の実測

現行 checkout では、[パイプライン](../../src/cli/pipeline.ts)が選定→Snapshot→Lab→探索→検証を接続し、既知の TranslatePress ATO 経路は gVisor Lab の nonce 判定器で確認、修正版で反証も確認した。[2026-10-10 の実測](../TRANSLATEPRESS-BENCHMARK.md)は配線と一部判定能力を示す。2026-10-13 に `pnpm check` を実行し、型検査・整形・70 test files／497 tests が通った。

[10 月 13 日の本番記録](2026-10-13-human-review-contract-and-parallel.md)では、完了した 3 周 15 対象で正常 Trial 11、Finding 14、Lead 28、`runtime-confirmed` 0。4 周目は記録時点で 3/5 対象まで進み、正常 Trial 3、Finding 6、Lead 7。これは記録時点の snapshot であり、後続の台帳状態ではない。`runtime-confirmed` 0 は未知候補がすべて偽という意味ではない。同記録では判定器の観測範囲外で `incomplete` になった候補もある。

公式の Step 1 完了条件に照らすと、以下の **3 条件はまだ成立が確認されていない**。コード作業が 0% という意味ではなく、運用受入の gate が未通過という意味である。

1. quota 1 週分を人手介入 0 で完走する。
2. Programme Boundary 内 Finding が全件 `review export` に届く。現行 [CLI](../../src/cli/index.ts) には `review export` がなく、レビュー用 3 skill もまだない。
3. 所有者が skill で 1 review batch を完了し、時間を記録する。上記本番報告時点で人間が開いた Finding は 0 件。

よって評価は、**設計契約は具体的で、既知事例の実機縦断は実証済み。本番の無人週次運用から人間の提出判断までの完成度は未実証**。公開ハーネスより「何割完成」と数値化する根拠はない。

## 4. 作り込みすぎと見える箇所

| 箇所 | 根拠 | 現時点の扱い |
| --- | --- | --- |
| 使用前に大きくなった review UI と判断補助 | [CLI](../../src/cli/index.ts)には `review dedupe`、`review scope`、draft 等がある一方、使用実績は 3 周で人間が開いた Finding 0 件。[ADR 0031](../adr/0031-review-report-dedupe-as-skills.md)は既存の scope/dedupe の拡張停止を決めた。 | 今は削除作業に時間を使わない。`review export` と対話 skill に実際の 1 batch を通し、その後で未使用機能を整理する。承認と提出状態の記録は残す。 |
| 比較 arm・prompt・評価の面積 | 現行 [prompt index](../../src/profiles/wordpress/prompts/index.ts)に 14 discovery ID、[campaign 配線](../../src/cli/wordpress.ts)に複数 mode、[CLI](../../src/cli/index.ts)に 5 種の `eval` コマンド。過去の比較軸を多数保持している。 | 新しい arm や prompt の追加は止める。旧版・旧 event は過去 Trial の digest 照合のため保持する。[ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md)。 |
| plugin 固有 Lab scenario の先行追加 | [scenario 実装](../../src/profiles/wordpress/lab/scenarios.ts)は plugin 固有条件を多く持つ。一方 [ADR 0026](../adr/0026-generic-lab-scenarios-no-verifier-browser.md)は通常機能の plugin 非依存 scenario を優先する。 | 頻出 `incomplete(precondition)` を見てから追加する。既存 scenario は既知事例の再現に必要なので今すぐ消さない。[PARKING](../PARKING.md)。 |

これは主に**保守対象が先行して増えた**という評価であり、gVisor 強制、nonce 判定、Snapshot 一致、`incomplete` の保持、外部送信の承認、Private Evidence 分離を削る提案ではない。これらは [SPEC §2](../SPEC.md) の不変条件である。今の優先は新しい graph、追加 verifier、追加モデルより、[DEVELOPMENT §2](../DEVELOPMENT.md)に既に書かれた #185 → `review export` と差分観測 → `lab up --finding` → 3 skill → quota 週の順を通すこと。

## 5. 推奨と未確認事項

- **推奨:** 10 月の公開物を根拠に探索構造を変えず、Step 1 の 3 gate と、本番の `incomplete` 理由・review 時間を先に測る。Visa の失敗・coverage 表示や Microsoft の次工程への受け渡しは、追加機能案ではなく現在の受入結果を読む視点として使う。
- **後で比較できる仮説:** WordPress plugin で source の所在特定が律速と実測された場合だけ、Mantis の構造索引や AVRI の証拠再利用を、同じ対象・予算・判定器の A/B で検討する。探索変更には [DEVELOPMENT §5](../DEVELOPMENT.md) の 3 Trial と agent 向け全文の所有者レビューが要る。
- **未確認:** 公開リポジトリを網羅したリリース監視ではないので、「新規公開物が絶対にない」とは言えない。公開各社の実行時の強制力や benchmark 数値は今回再現していない。当地の今後の未知候補の有効率・報奨額・review batch 時間も未測定。
