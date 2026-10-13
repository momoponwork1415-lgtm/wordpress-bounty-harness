# 過去の記録の棚卸しと集約案（2026-10-13）

調べて報告。正本ではない。対象は Windows 側の `D:\wordfence`、`D:\patchstack`、`D:\TranslatePress-Submission` と、WSL の `/home/dev` 配下に残る bug-bounty 関連ディレクトリ。読み取りだけで調べた。PoC、報告本文、動画、証拠、`.private`、`cases/` の中身は開いていない。案件名は書かない。

所有者の依頼: 「残っているファイルを確認して設計の判断に使う。コンテキストが散らばっているので参照しやすくまとめる。実験を repo ごとに最初からやり直さないようにする」。

## 0. 先に結論

1. **今も動いている依存が 4 つ**あり、消す前に外す必要がある。cron が 5 分ごとに `wp-bounty-deploy` の queue tick と `wordpress-harness/.private` の quota tick を回している。現 harness は `wp-bounty-workspace/intelligence/history.sqlite`（197 MB、今日も更新）を参照し、更新 script は `whitebox-harness/tools/refresh_wordfence.py`。
2. **一番濃い知識は `D:\wordfence\history`（= `wp-bounty-workspace/history`、31 本）と `wp-bounty-workspace/selection/*.md`（7 本）**で、どちらも本リポの docs に入っていない。提出 60〜80 件の結果分析、却下理由の分類、支払いの事前規則、選定シグナルの backtest（6 種とも効かず、効いたのは revisit availability だけ）が含まれる。
3. **提出パッケージには事実上の標準形がある**（37 件中 37 件が同じ 4 ファイル構成）。人間だけが行う最終工程は 9 項目で全件固定。これは #188 の skill と #186 の `review export` の仕様の素材になる。
4. **最大の欠落は追跡性。** 提出記録と探索 run を結ぶ field（run id、model、prompt digest、人間の作業時間）がどこにも無い。本リポの台帳にも無いので、Step 1 の計測で足す。
5. **ディスクは 190 GB 以上が回収できる。** Docker volume 98.5 GB、`wp-bounty-workspace` の source 複製 35 GB、`wp-bounty-assurance` 18 GB、game harness 16 GB、第三者 clone 8 GB。知識の文書は合計 10 MB 以下。

## 1. 現役の依存（消す前に外すもの）

| 依存 | 場所 | 状態 |
| --- | --- | --- |
| cron 5 分ごと | `/home/dev/wp-bounty-deploy`（whitebox の本番 clone）の queue tick | `wp-bounty-workspace/queue/queue.json` を今日 14:50 にも更新 |
| cron 5 分ごと | `/home/dev/wordpress-harness/.private/claude-quota-operator/tick.sh` | 動作中 |
| Wordfence ミラー | `/home/dev/wp-bounty-workspace/intelligence/history.sqlite`、`state.json` | 本リポの host 設定と `wordfence-history/README.md` が参照。今日 11:45 更新 |
| ミラー更新 script | `/home/dev/whitebox-harness/tools/refresh_wordfence.py` | `docs/OPERATIONS.md` が参照 |

## 2. 知識の所在

### 2.1 本リポに無く、統合する価値があるもの

| 場所 | 内容 | 本数 / 日付 |
| --- | --- | --- |
| `D:\wordfence\history` | 提出結果の分析。`payout-decision-rule.md`（権限 × 種別の支払い事前規則）、`rejection-reasons-verbatim.md`（却下理由 R1〜R10 と提出前スクリーン）、`self-profile-and-loss-modes.md`、`whitespace-analysis.md`（38,456 件から見た種別 × 権限の空白地帯）、`target-selection-doctrine-v2.PROPOSED.md`（G0〜G7 の gate）、`wordfence-description-template.PROPOSED.md`（712 行）、`wordfence-poc-template.PROPOSED.md`、`attested-form-options.md`（フォーム選択肢の実測）、`submission-ledger.json`（80 件、2026-02-20〜09-12）、`scored-candidates.json`（121 件） | 31 本、08-13〜09-12 |
| `wp-bounty-workspace/selection/*.md` | `target-pool.md`（選定シグナル 6 種の backtest）、`TARGET-QUEUE.md`、`superseded-20260820/SELECTION.md`（Gate 1〜4）、Wordfence / Patchstack の scope 取得記録（08-16 / 08-17） | 7 本、08-15〜08-20 |
| `wp-bounty-workspace/operations/IMPACT-ACCEPTANCE-GATE.md` | 静的検証の後、Lab の前にかける影響 / 受理 gate | 1 本、08 月 |
| `wp-bounty-assurance/campaigns` | 既知 CVE 再発見 38 attempt の RUN.json / leads.json / REGISTRY.md（結果の表だけ） | 08-23〜08-28 |
| `wp-bounty-workspace/archives/glm-discarded-20260813/glm-comparison/README.md` | Codex 再現済み 7 件を GLM が同じ snapshot で独立探索した一致度（結論だけ） | 08-12 |
| `wp-bounty-workspace/benchmarks/rejection-replays/*/audit.md` | 却下 5 件を offline で再判定した方法（方法だけ） | 08-28 |
| `D:\wordfence\campaigns\2026-09-08-daybreak-opus-three` | 9 月版の campaign 実行記録。model 2 種（claude-opus-5 / gpt-daybreak-blue）、run ごとの usage・terminal・validation disposition を sqlite に持つ | 09-08〜09-09 |
| `D:\wordfence\wp2shell-labs`、`/home/dev/wp2shell/toolkit` | WP2Shell prompt 3 本、起動 script（codex / opus / glm）、`make-discovery-lab.py` | 08-15〜08-19 |
| `/home/dev/wp-bounty-deploy/skills` | whitebox の skill 4 本（`discover-wordpress-target` PROMPT.md 12,260 B は v1.7 の後継、`verify-wordpress-leads` 13,154 B、`prepare-wordfence-submission` 5,123 B） | 08-22〜09-01 |
| `D:\wordfence\history\archive\glm-loop-runbook.md` | GLM 発見ループの runbook（日本語） | 08 月 |

### 2.2 既に分析済みの 4 repo（docs/reviews/2026-10-13-past-repos-lessons.md）

| repo | knowledge の量 |
| --- | --- |
| bug-bountgy-harness（07 月） | ADR 91 + 73、research 279 + 5、campaigns 759 + 28、skills 33、retired/research 1,083 |
| whitebox-harness（08 月） | ADR 3、design 2、agents 3、skills 61 |
| wp-bounty-verification（08 月） | ADR 7、design 7、specs 1 |
| wordpress-harness（09 月） | ADR 26、knowledge 12、domain 2、agents 4、prompts 4、skills 7、src/research 17 |

### 2.3 参照だけでよいもの

`harness/game-bugbounty/docs/methodology.md`（Satoki 由来の運用原則。Root + 子 3 の源流）、`development-harness/docs/research` 3 本（公開 harness の調査、本リポの 2026-10-11 比較と重なる）、`legacy-codex-.../codexidea-thin-harness-risk-audit-2026-07-24.md`、`OSWE/notes/wordpress-rce-checklist.md`。

### 2.4 Git の外に置くもの（名前だけ確認）

提出フォルダの報告本文・PoC・証拠・動画、`_work` / `_triage` の値、`verbatim-submitted-reports.md`、`wordfence-verdicts.md`、競合研究者のプロファイル、各 lab の `research/`、`wp-bounty-workspace` の `cases`（121）/ `verifications` / `verification-runs`、`give-lab`、`legacy-codex` の報告下書き。

## 3. 提出パッケージの標準形（#186 / #188 の素材）

Wordfence 向け 37 件のうち 37 件が同じ構成だった。

```
rg-<id>/
  report.md               Wordfence フォームの field 番号順の見出し
  wordfence-fill.json     schema wordfence-fill-only/2（fields[]、poc{}、human_verification{}、human_only{}）
  submission-package.json schema submission-package/v1（report / fill / attachments の sha256、human_only_remaining[]）
  human-verification.json schema human-verification/v1（required_checks[]、decided_at、status）
  poc/  evidence/  [attachments/video]
```

- **人間だけが行う最終工程は 9 項目で全件固定**: submit、researcher-identity、personal-poc-certification、other-cna-or-vendor-facts、legal-acceptance、final-review、disclosure-choices、captcha-or-2fa、ai-use-disclosure-review。Patchstack の 6 項目もほぼ同じ。program 非依存の定数にできる。
- **sha256 の相互参照**（report / fill / poc / video / verification-package）が全件で一貫している。版ずれの自動検査に使える。
- **揺れているもの**: `human-verification.json` の `required_checks` は 3 項目版と 5 項目版が混在、`status` の語彙は 6 種類。1 件だけ walk（card + state + steps_ticked）方式で人間がチェックを順に tick している。
- **Fill-Only の Chrome 拡張**（v0.4.0）: fill JSON を読んでフォームの入力欄だけを埋め、Other Details と Submit は触らない。`guard-lock.js` が fetch / XHR / submit を封じ、人間の最終レビュー後に `guard-unlock.js` で解除する。不変条件 7（Harness は送信しない）の実装例。
- **動画**: 37 件中 3 件だけ。`video_contract`（must_show、最小静止秒数）は 6 件だけ。
- **Patchstack**: 2 件で形式が揃っていない。自動入力は無く、`FORM-FIELDS.md` を人間が貼る。

## 4. 追跡性の欠落

- 提出 ledger にも submission-package にも、run id、model、prompt digest の field が無い。campaign 由来の finding が提出まで進んだかを機械的に追えない。
- 人間が検証に使った時間はどこにも記録されていない。
- 本リポの台帳も同じ。Step 1 の完了条件「所有者が 1 回のレビュー batch の所要時間を記録する」は、`review-decided` に `elapsedMinutes` を足すか、skill が書く記録で満たす必要がある。

## 5. ディスクの回収候補

| 場所 | 容量 | 中身 | 判定 |
| --- | --- | --- | --- |
| Docker local volume | 100.3 GB（98.5 GB 回収可） | 匿名 volume 1,076 個、`*-verify-*` 42 個 | `docker volume prune` の前に現役 Lab が無いことを確認 |
| Docker image / build cache | 10.4 GB（5.9 GB 回収可）/ 3.0 GB | | 同上。pinned image は残す |
| `wp-bounty-workspace/targets`、`recon`、`queues`、`labs` | 23 + 9.5 + 2.5 + 1.9 GB | plugin source 1,117 個、recon、失敗 queue、lab | 削除候補。`intelligence/`（243 MB）と `history/`、`selection/`、`operations/` は残す |
| `wp-bounty-assurance` | 18 GB | attempt ごとの core / plugin source 複製 | 結果の json / md を取り出した後に削除 |
| `harness`（game-bugbounty） | 16 GB | tools 6.1 GB、joern 4.4 GB、artifacts 4.8 GB | WordPress 外。未 commit 18 件、remote なし |
| `black-box-harness` | 8.0 GB | 第三者 clone 5 個（FreeToken の .venv 7 GB） | 削除候補 |
| `wp-bounty-archive`、同「- コピー」 | 2.2 + 2.6 GB | plugin source と node_modules | 削除候補 |
| `oss-bounty`、`mobile-security-lab`、`wp-bounty-target-shortlist - コピー`、`wp-bounty-labs(-retired)`、`bug_bounty`、`Documents` | 834 M、204 M、145 M、小 | 無関係または空 | 削除候補（`bug_bounty` は root 所有） |

## 6. worktree

本リポの worktree は 38 個 + `wbh-audit` + `~/.codex/worktrees` 3 個。未 commit の変更は 0。main にも remote にも無い commit を持つもの: `wbh-audit`（2）、`wbh-issue-20` / `-6` / `-7`（issue-54-chatgpt-oauth、6 commit）、issue-158 / 162 / 166 / 171 / 173。main に取り込み済みで消せるもの: issue-121 / 123 / 125 / 138 / 139 / 140 / 144 / 169。

## 7. 集約の案

`docs/knowledge/` を本リポに作る。

```
docs/knowledge/
  README.md                 索引。1 行 = 日付、世代、問い、結果、元 path、取り込み先
  imported/<generation>/    取り込んだ文書の写し。先頭に provenance（元 path、日付、取り込み日）
  experiments.md            実験の一覧表。問い、条件（model / prompt / 対象）、結果、どこに記録があるか
  submission-package.md     第 3 節の標準形と human_only 9 項目（値は書かない）
```

取り込むのは第 2.1 節の文書。payload、PoC、案件固有の値は写さず、索引に file 名と日付だけ書く。AGENTS.md の読む順に「新しい実験の前に `docs/knowledge/experiments.md` を検索する」を足し、Issue template に同じ 1 行を入れる。

## 8. 未確認の仮定

- cron の実行内容は crontab の行とログの更新時刻から判断した。止めてよいかは所有者が決める。
- `wp-bounty-workspace/history` と `D:\wordfence\history` は symlink で同一とみられるが、両方の inode は確認していない。
- 容量は `du` の値で、Docker の回収可能量は `docker system df` の値。
