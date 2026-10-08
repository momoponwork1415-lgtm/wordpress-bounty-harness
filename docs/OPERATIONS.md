# 運用手引き（完成後に人間がすること）

対象読者: このHarnessを一人で回す運用者。正本は [SPEC.md](SPEC.md)。コマンド名は仮で、#7（縦断スライス）で確定する。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りのDockerホスト。Codex CLI ≥ 0.161。ChatGPT Proにログイン。費用は購読の月額固定で、Harnessは金額でなく使用量（rate limit / quota）を見る | 初回とCLI更新時 |
| 認証 | provider認証情報をegress brokerへ登録する。エージェントには渡らない | 初回と失効時 |
| 選定方針 | `profiles/wordpress/policy/selection.*` を編集する（インストール数の下限、更新の鮮さ、除外slug、週の対象数） | 月1回程度 |
| trust境界宣言 | profileの雛形をそのまま使う。特殊なロールを持つpluginだけ1〜2行足す | ほぼ変えない |
| 対象範囲の方針 | `profiles/wordpress/policy/programme-scope.md` を公式ページで見直す | 提出前と月1回 |
| 答えの鍵 | 評価用。Git外に置く。開発セッションに見せない | 鍵を増やすとき |

## 2. 週の流れ

```
harness select                 # 方針から今週の対象を出す。承認は不要
harness campaign run --all     # 選定済み対象を順に: snapshot → lab → discovery → verification → ledger
harness review                 # 検証済みの列を見る
```

`campaign run` は無人で回る。1対象あたり、短命のdiscovery runを最大40回（同時4）、新規Findingなしが4回続いたら止まる。各Findingは別コンテナのVerifierと判定器を通り、`runtime-confirmed` / `contradicted` / `incomplete` として台帳に入る。

人間が触るのは `review` だけ。並ぶのは次の2種類。

| 種類 | 付いてくるもの | 人間がすること |
| --- | --- | --- |
| `runtime-confirmed` | 再現パッケージ（手動手順、Pythonスクリプト、Lab再構築情報、判定器の証拠） | 自分の手で再現する。影響が意味を持つか、意図された動作でないか、重複でないかを判断する |
| `incomplete` | 理由コードと次の手 | 環境・手順の不足なら再検証を指示する。`no-judge`（判定器がない種別）なら手で確かめる |

`contradicted` は件数しか出ない。

## 3. 提出までの操作

```
harness review decide <finding> --admit|--reject --reason <code>
harness review scope <finding>            # Wordfence / Patchstack ごとに in-scope / out / ambiguous
harness review dedupe <finding>           # ローカルWordfence履歴DBと照合
harness review draft <finding>            # AIが文案を作る。版が付く
harness review authorize <candidate> --draft <rev> --to wordfence
harness review outcome <candidate> triaged|resolved|duplicate|informative|rejected
```

- `authorize` は「この文案のこの版を、この送信先へ出す」ことの記録で、送信はしない。送信は人間がWordfence / Patchstackの画面で行う。
- 提出後の転帰を `outcome` で台帳に戻す。選定方針と判定器の改善材料になる。探索へは戻らない。
- Reflected XSSはWordfence向けの候補にならない。authz / IDORは乗っ取り・権限昇格・サイト全体への影響に届くときだけ in-scope。

## 4. 見るべき数字

```
harness ledger funnel --campaign <id>     # raw → verifier通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome
harness ledger funnel --month 2026-11     # 月単位
```

収益の式は「対象数 × 当たり率 × in-scope率 × 平均報奨 − 月費用」。funnelの各段がこの各項に対応する。

| 細い段 | 直す場所 |
| --- | --- |
| raw Findingが少ない | prompt変種の比較（第5節）、分担単位 |
| verifier通過が少ない | 判定器の成功条件、Lab構成（`incomplete` の理由コードを見る） |
| in-scopeが少ない | 選定方針（対象外になりやすい種別・tierを避ける） |
| duplicateが多い | 選定方針（公開履歴の多いpluginを避ける）、履歴DBの鮮度 |

## 5. 評価

主指標は本番から得る。追加費用はかからない。

```
harness eval compare --axis history [--campaign <id>]   # 本番A/B: arm別の当たり率（Clopper-Pearson 95%）と費用
harness eval prospective --advisories <file> [--campaign <id>]   # 後日公開されたadvisoryで本番台帳を再採点
harness eval score --set held-out --cases <slugs> --trials 1   # 任意。大きな設計変更時だけ、予算内で
```

- 本番A/B: 同じ対象でrunを構成A / Bに分担して回す。どちらが見つけても提出できる。現在の軸は履歴有無だけ。campaign設定に `"ablation": {"axis": "history", "armBFraction": 0.5}` を書くと、runnerが各runへarm a（履歴なし）/ b（履歴あり）を割り当てて台帳のrun記録に残し、`ledger funnel --campaign <id>` の `by arm:` にarm別のrun数・Finding数・confirmed数を出す。`eval compare` は両armのrunがある対象だけを台帳の全campaignからプールし、runtime-confirmedのFindingを出したrunを当たりとして数える。区間が重なれば「判定不能」と出す。片方のarmしかない対象は除外して行に示す。履歴は安定版の公開日時（WordPress.orgの最終更新）より前の公開記録だけで、版を固定した対象やmirrorが使えない対象は全runがarm aとして記録される。
- 前向き評価: 四半期ごとに、公開されたadvisoryで本番台帳を再採点し、見逃しを数える。advisoryファイルはGit外に置く私的データで、1件ごとに `{schemaVersion: 1, advisoryId, slug, affectedVersions: [{fromVersion, fromInclusive, toVersion, toInclusive}], publishedAt, impact, allowedLocations: [{file, function?}]}` を書く。公開カタログには変更ファイルがないため、`allowedLocations` は公開パッチを読んで人間が書く。結果は `found` / `missed` / `unscorable`（読めないFindingだけで採点失敗、見逃しに数えない）/ `predates-run`（選定前に公開済み、数えない）/ `not-searched`（その版を探索していない）に分かれる。`blind rubric pairs:` の (advisory, Finding) 対だけを、armや検証結果を見ずに人間がtarget-hit / partial / non-targetで採点する。
- held-out: 既定では回さない。回すならcutoff後の補助4件を優先し、試行数は予算で決める。
- held-outの結果を見てpromptを変えたら、そのcaseは開発セットへ移す。

## 6. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへのPoC・payload・再現手順の提供。評価runへのheld-out公開日以降の記録の提供。
- Harnessからの外部送信。
- payload、HTTP記録、画面画像、未公開の発見のGitへのコミット。
