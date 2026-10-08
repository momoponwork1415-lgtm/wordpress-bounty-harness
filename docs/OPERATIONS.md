# 運用手引き（完成後に人間がすること）

対象読者: このHarnessを一人で回す運用者。正本は [SPEC.md](SPEC.md)。コマンド名は仮で、#7（縦断スライス）で確定する。

## 1. 一度だけやる準備

| やること | 中身 | 頻度 |
| --- | --- | --- |
| 実行環境 | gVisor（`runsc`）入りのDockerホスト。Codex CLI ≥ 0.161。ChatGPT Proにログイン | 初回とCLI更新時 |
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

## 5. 評価（Harnessを変えたときだけ）

```
harness eval score --set held-out --config <name>     # 鍵に対する location-overlap と盲検rubricの入力
harness eval compare <config-a> <config-b>            # 同じcase・同じ試行の対で差を出す
```

- 評価セットは第10節の構成。開発セット2件はprompt調整に使い、採点には使わない。
- held-outの結果を見てpromptを変えたら、そのcaseは開発セットへ移す。
- 本番Campaignの台帳は、後日公開されたadvisoryで後から採点できる（前向き評価）。これが最も信頼できる数字。

## 6. やらないこと

- 対象の承認、未検証候補の採否。
- 探索エージェントへのPoC・payload・再現手順の提供。評価runへのheld-out公開日以降の記録の提供。
- Harnessからの外部送信。
- payload、HTTP記録、画面画像、未公開の発見のGitへのコミット。
