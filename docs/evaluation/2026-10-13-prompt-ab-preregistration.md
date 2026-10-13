# 探索 prompt の A/B 事前登録: `wp2shell-bounty-v3` 対 whitebox `bounded-wp2shell/v1.7` 系（2026-10-13）

事前登録。結果はまだ無い。正本ではなく、食い違えば [SPEC.md](../SPEC.md) 第 10 節と [ADR 0029](../adr/0029-single-wp2shell-cooperative-trial.md) が勝つ。所有者の言葉（2026-10-13）: 「bounded-wp2shell/v1.7 は結構いいと思う。ベンチマークをやれば解決する」。

## 1. 問い

公開 7 件の再発見 case（[2026-10-12-rediscovery-benchmark.md](2026-10-12-rediscovery-benchmark.md)）で、v1.7 系の本文は現行 v3 より多くの case に「公開記録と経路が一致する source 根拠付き候補」を出すか。

測るのは探索段だけ。判定器と Verifier は比較の対象にしない（#187 は先行条件でない）。既知事例の再発見は配線と本文の比較であり、未知の発見率を示さない（SPEC 第 10 節）。

## 2. arm

| arm | promptId | 本文 | 後ろに付く節 |
| --- | --- | --- | --- |
| A | `wp2shell-bounty-v3` | 現行既定（2,892 B） | Harness 生成の出力契約 v2、trust-boundary-v1、Programme Boundary、Lab、入口索引 |
| B | `wp2shell-whitebox-v1.7`（新規、比較 arm） | 所有者の P1 本文（[原文](../knowledge/imported/08-whitebox/bounded-wp2shell-v1.7-PROMPT.md)、[訳](../reviews/2026-10-13-source-prompts-ja.md) 第 3 節）から `leads.json` の節を外し、placeholder を第 5 節のとおり埋めたもの | A と同じ |

B の本文は所有者が書いた文章であり、AI は要素を足さない。外すのは出力契約の節だけ（ADR 0019: 出力契約は Harness が schema から生成する）。B は `src/profiles/wordpress/prompts/` に置き、`WORDPRESS_DISCOVERY_PROMPT_IDS` と `WORDPRESS_OBJECTIVE_ONLY_PROMPT_IDS` に登録して digest を pin する。gated path なので所有者が全文を読んで `owner-approved` を付ける。既定 promptId は変えない。

## 3. case と条件

| case | 状態 | 備考 |
| --- | --- | --- |
| Relevanssi 4.28.3 | 実行可 | v2 で 1 Trial 済み（同系統候補 1） |
| Simply Schedule Appointments 1.6.10.0 | 実行可 | 公開日が model cutoff 前。contamination 区間として別掲 |
| Brizy 2.8.11 | 実行可 | v2 で経路一致の候補あり |
| TranslatePress 3.3.1 | 実行可 | 開発セットと同じ対象。他 case と同列に比較しない |
| TranslatePress 3.2.6（記録 A / B） | 実行可 | 1 Trial を 2 記録で別々に照合 |
| Smash Balloon 4.13.0 | 停止 | Lab から外部 API に出られない。provider Trial を起動しない |
| Unlimited Elements 2.0.16 | 停止 | Elementor 依存の Snapshot が campaign CLI に未接続 |

共通条件: 既存の case 別 state dir（`benchmark-127/<case>/state`）と `work/campaign.json` を使い、`promptId` だけを arm ごとに変える。履歴なし、`entryIndex: true`、wall 60 分、Root＋子 3、WordPress 6.8.3（2026-10-12 の測定と揃える。#184 の 7.1.3 切り替え後は再測定しない限り混ぜない）、同じ scenarioId、同じ model と effort。campaign id は `rediscovery-ab-<arm>-<caseId>-<date>`。

## 4. 手順と判定規則

1. 第 1 段: 実行可 5 case × 2 arm × 1 Trial = 10 Trial。1 Trial 20〜35 分、非 cache 入力 約 50 万 token。直列で 4〜6 時間。
2. 第 2 段: 第 1 段で arm 間に差が出た case だけ、両 arm に +2 Trial（最大 +20 Trial）。差が無ければ追加しない。
3. 主指標（case ごと、arm ごと）: Finding または Lead のうち、`sourceTrace` が公開記録の経路と一致するものが 1 件以上あるか。照合は run 後に人間が行い、照合者には promptId を見せない（`review export` の JSON だけを渡す）。
4. 副指標: Finding / Lead 件数、Programme Boundary 内の件数、schema 失敗で `incomplete` になった Trial 数、Root wall 中央値、source 読取回数の下限、usage。`scripts/report-rediscovery-cases.mjs --state <case>/state --campaign <id>` で集計する。
5. 決定規則: B が一致 case 数で A 以上、かつ schema 失敗 Trial 数が A を超えないなら、#189 の v4 は B の本文を骨格にする。A が上回れば v3 の 5 段落を骨格にする。同数なら所有者が副指標を見て決める。どちらの場合も v4 の要素の採否は所有者が対照表で決め、AI は要素を足さない。
6. 比較に数えない: Lab 失敗、provider 上限、broker 制限、wall 到達の Trial（理由付き `incomplete`。再実行して分母を埋める）。停止 2 case。

## 5. 所有者が決める値（B を作る前に）

v1.7 の本文は run ごとに置換する placeholder と、whitebox の workspace 配置を前提にした語を含む。Harness の sandbox は `/workspace/main`（対象、読み取り専用）と `/workspace/wordpress`（core、読み取り専用）だけを mount し、書ける `research/` は無い。

| 箇所 | 原文 | 候補（所有者が選ぶ。候補は所有者の W1 / P1 の文言か Harness の既存値だけ） |
| --- | --- | --- |
| `{{PROMPT_SET_VERSION}}` | 版名 | `bounded-wp2shell/v1.7-harness` の文字列、または行ごと削除 |
| `{{PLUGIN_NAME}} {{VERSION}}` と `main/` | 対象名と版 | 「the pinned target in /workspace/main」に置換（対象固有名を prompt に入れない規則に合わせる） |
| `{{GOAL}}` | run ごとの目的文 | 空にする、または所有者が 1 文を書く |
| `{{AGENT_CAP}}` | 同時 agent 数 | `3`（Harness の上限） |
| `third_party/` | 依存 source の置き場 | `/workspace/wordpress`（core のみ。PHP source は無い） |
| `{{DEPENDENCY_NOTE}}` | 依存の説明 | 削除（Lab 節が core の path を伝える）、または 1 文 |
| `research/REGISTRY.md`、`research/` | 書ける作業 dir | (a) sandbox に書ける `/workspace/research` を足す（#189 の項目 2 を先に実装、Codex 向けの小さな task）、(b) 「自分用の registry」と読み替えて file を要求しない |
| `{{EFFORT_FLOOR}}` | 最低探索時間 | (a) W1 の「2 波連続で新 family も finding も無し、または時間上限」に置換、(b) `50 minutes`（wall 60 分の内側）、(c) 行ごと削除 |
| 群 3 の reflected XSS | 当時 scope 内 | そのまま残す（Harness が `reflected-xss` を `finding-parked` にする）、または削除 |
| `leads.json` 以降の節 | 出力契約 | 削除（Harness 生成の契約に置き換え）。これは所有者判断ではなく ADR 0019 の規則 |

所有者が候補を選んだら、B の本文を作って PR にし、所有者が全文（日本語訳付き）を読む。

## 6. この測定が示さないこと

- 未知の脆弱性の発見率。7 件は所有者が人手の検証を経て提出したもので、探索本文の差だけで有償になったわけではない。
- 判定器と Verifier の性能。別の問い（#187、#107）。
- 7 件の内訳の偏り（stored XSS 4、ATO 1、SQLi 1、options 1 相当）が本番 pool の分布を代表すること。

## 7. 記録先

結果は本文書の下に日付付きで追記せず、`docs/evaluation/2026-10-xx-prompt-ab-results.md` として別に置き、[docs/knowledge/experiments.md](../knowledge/experiments.md) に 1 行足す。candidate 本文、payload、HTTP 記録はどちらにも書かない。
