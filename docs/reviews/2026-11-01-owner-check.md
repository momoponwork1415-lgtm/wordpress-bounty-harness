# 所有者チェック用: 2026-11-01 に揃えた変更と、探索再開で変わること

開発計画（[2026-11-01-development-plan.md](2026-11-01-development-plan.md)）§2 の 5 項目と並走項目をすべて main に入れた。探索の再開はまだしていない。この文書は所有者が確かめるためのもので、正本ではない。確かめ終わって「再開して」と言えば、AI が §4 の手順を実行する。

## 1. 入れたもの（計画 §2 の順）

| 項目 | PR | 何が変わったか | 読む場所 | 確かめてほしいこと |
| --- | --- | --- | --- | --- |
| 2.1 外部サービス接続の検証 Lab | #759（Issue #758） | `verify next` / `review reverify` に `--egress-plan <json>`。宛先ごとの中継 container を Harness が置き、`setup-done` 直後に消して Lab の中から届かないことを確かめ、receipt と台帳に残す。公開入口の開閉と API キー入力は Harness の外のまま | ADR 0046 追記 1、OPERATIONS 第 3 節 | 「Harness が持つのは出口だけ、入口と鍵は人」の線でよいか |
| 2.2 目的文を 1 枚に | #757（Issue #756） | `wp2shell-bounty-v20-wide`（1 file、v19 の本文そのまま + スキルへの routing 1 段落）。v14/v15/v18/v19-wide は archived。v19 の 20 Trial 計測は取りやめ、ADR 0045 追記 1 に記録 | [全文と日本語訳](2026-11-01-wp2shell-bounty-v20-wide.md) | routing 段落の文面。v19 に残る判定器と canary の古い 2 文を消すか（ADR 0045 は「消すだけは許す」。別 PR） |
| 2.3 子を新しい文脈で | #753（Issue #752） | `wbh-recon` v2: 子は親の会話履歴を引き継がずに始める（`fork_turns: none`）1 文 | [全文](2026-11-01-exploration-skills-wbh-recon-v2.md) | 文面 |
| 2.4 重複の表示 | #755（Issue #754） | review 列の各 Finding に `seen before: group <id> <n> finding(s) snapshot <digest>`（同じ対象の別 Snapshot で同じ経路を見たとき）。判定はしない | ADR 0038 追記 17、`docs/agents/ledger-reading.md` | 表示だけでよいか |
| 2.5 plugin ごとの事実 | #761（Issue #760） | `discovery.priorResearch: same-target` で、同じ plugin の別の版の最新 Trial が封じた `recon-map.md` と `lab-setup.md` を `/workspace/research/prior/` に置き、節 `## Prior research` で場所と版を述べる。tsv と route file は渡さない。既定 none | ADR 0048、[節の全文と日本語訳](2026-11-01-prior-research-section.md) | 渡す単位（2 file だけ）と節の文面。本番で `same-target` を有効にするか（§3 で提案は有効） |
| #751 検証の前提の記録 | #762（Issue #751） | `wbh-verify` v12: `steps.md` の先頭に前提の部を `lab-setup.md` と同じ 6 節で書く。`<dir>/prior-lab-setup.md` を AI 操作役が置けば出発点に読む | [全文](2026-11-01-wbh-verify-v12.md) | 文面 |

今日それより前に入れたもの（計画 §1）: 選定 5,000 / タグ無し / batch 10（#740）、鮮度 180 日（#743）、Lab 基準 v3（#745、#747）、WordPress 本体を最新安定版に（#748、ADR 0047）、`wbh-setup` v1（#750）、Lead 入力 Trial（#730、ADR 0044）、bench30 v3（#736）。

## 2. 変えていないもの

- 不変条件 1〜8 と ADR 0045 の凍結 5 項目。ADR 0045 第 5 項（月 1 回、言い換えの新版なし）だけは所有者の言葉で改め、追記 1 に残した。
- Harness に判定器と canary は無い。2.1 の中継器の記録も、2.5 の節も、確定の根拠にしない。
- 探索の目的文の本文（v19 の 11 段落）。足したのは routing 1 段落だけ。
- 本番の Git 外の設定。§3 の変更はまだ当てていない。

## 3. 探索再開で変わる設定（提案）

`~/.config/wordpress-bounty-harness/campaign-production-codex-wide-5-skills-v19-latest-core-20261101.json` を写して新しい file にし、次の 3 か所だけ変える。host と selection の設定は用意済みのもの（`*-latest-core-20261101.json`）をそのまま使う。

| 鍵 | いま | 変更後 | 理由 |
| --- | --- | --- | --- |
| `promptId` | `wp2shell-bounty-v19-wide` | `wp2shell-bounty-v20-wide` | v19 は archived（#757） |
| `discovery.skills` | `["wbh-recon-v1","wbh-tools-v1"]` | `["wbh-recon-v2","wbh-tools-v1","wbh-setup-v1"]` | v2 の 1 文（#753）。`wbh-setup` は Lab 無しの本番では読まれないが、v20 の routing 段落が 3 つを名指すので揃える |
| `discovery.priorResearch` | （無し = none） | `"same-target"` | 2.5 を本番で測る。既定 none のままなら何も渡らない |

変えないもの: `mode: wide`、`maxChildren: 8`、`runWallTimeMinutes: 120`、5 並列、Lab なし、programmeBoundary。

再開後の数字は、選定母集団（5,000 / 180 日）と目的文（v20）と skills が同時に変わるので、v18 / v19 の数字と対になっていない。ADR 0045 の分母（Codex 1 時間あたりの Lab 発火数、Wordfence の結果）で v20 の基準線を新しく取る。

## 4. 再開の手順（所有者の go の後に AI が実行する）

1. `/home/dev/worktree/prod28` を origin/main（#762 merge 後）に合わせて `pnpm build`。
2. §3 の campaign 設定を新しい file に書く。`runtime check` を通す。
3. 停止マーカー `~/.local/state/wordpress-bounty-harness/continuous-prod-v19.stop` を消す。
4. `continuous run --config <campaign> --selection <selection> --campaign-prefix prod-v20 --resume` を prod28 から起動する。
5. 最初の batch の `selection-batch-discarded`（policy-changed）1 行と、最初の選定報告を Issue #739 / #741 に書く。

## 5. 所有者に決めてほしいこと

1. §3 の 3 つの設定変更でよいか。特に `priorResearch: same-target` を最初から有効にするか。
2. v20 に残る判定器と canary の古い 2 文（「Runtime confirmation belongs only to the later, independent Harness-owned deterministic judge…」と「Runtime confirmation is decided later by the independent Harness judge」）を消す PR を出すか。消すと byte が変わり v21-wide になる。ADR 0045 は「消すだけは許す」。
3. 開いている PR の扱い: #738 / #737（設計の文書 2 本）、#722（外部: 自前 bounty の plugin を除く）、draft #709（検証ループの道具）、draft #697（`wbh-trace`）。merge するか close するか。
4. `wbh-recon` に「`/workspace/research/prior/` があれば地図の出発点にする」の 1 文を足すか（今回は足していない。ADR 0048「数字を見てから」）。
