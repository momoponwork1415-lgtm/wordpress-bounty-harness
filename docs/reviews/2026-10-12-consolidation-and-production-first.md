# 2026-10-12 文書・Issue の整理案と「本番 1 周を先に回す」計画

調べて報告の成果物。正本ではなく、食い違えば [SPEC.md](../SPEC.md) と [ADR](../adr/) が勝つ。対象は `origin/main` `5cbaab3`（2026-10-12 09:04 JST）と、同時点の GitHub Issue / PR / draft branch。

## 0. 所有者の決定（2026-10-12）

自動化が必要なのは「対象の選定」と「脆弱性の発見」の 2 つ。文書とコードの整理（第 4 節、第 5.3 節の一部）は、バグバウンティが回るようになってから行う。以下の第 4 節は記録として残すが、着手しない。

## 1. 要約

- リポジトリは 2026-10-08 開始の 5 日目。merge 済み PR 80 本、Issue 94 件（閉 74 / 開 20）、ADR 30 本、レビュー文書 17 本、prompt 版 21 ファイル。
- 最新版の実対象への探索は 0 回、提出候補は 0 件。本人発見 7 件の再発見で脆弱版 `runtime-confirmed` は 1 件（Brizy、2026-10-12）。TranslatePress 3.3.1 の ATO は新 Lab で 8/8 手順 `runtime-confirmed`。
- 配線は動く。動いていないのは「実対象で 1 周回して基準値を取る」こと。以下はそのための整理であり、新しい設計は足さない。

## 2. 現状の数字

| 項目 | 数 | 出典 |
| --- | --- | --- |
| merge 済み PR | 80 | `gh pr list --state merged` |
| Issue 閉 / 開 | 74 / 20 | `gh issue list` |
| src / tests 行数 | 27,415 / 21,664 | `git ls-tree origin/main` |
| ADR / reviews / evaluation 文書 | 30 / 17 / 2 | `docs/` |
| prompt 版ファイル | 21 | `src/profiles/wordpress/prompts/` |
| 主経路の変更回数（10/10〜10/11） | 2 | ADR 0025 → ADR 0029 |
| 最新版実対象の Trial | 0 | #100 未着手 |
| 再発見で脆弱版 confirmed | 1 / 7 | `docs/evaluation/2026-10-12-rediscovery-benchmark.md`（#155 branch） |
| 開発セット（TranslatePress 2 版）の `runtime-confirmed` | 全 PR で 0 | PR #146〜#151 の「測った数字」 |

開発セットの比較は、どの prompt 版・方式でも探索段階の `runtime-confirmed` が 0 のため、版の優劣を示す信号がない。比較のための Trial と prompt 版の追加はここで止める根拠になる。

## 3. 過剰と判断した箇所と、その理由

| 箇所 | 事実 | 判断 |
| --- | --- | --- |
| 主経路の往復 | #123 / #130 / #131 で screening と continuation を作り、翌日 #147 で削除 | 実測 1 回も無い段階の設計変更は次の実測で覆る。ADR は実測が矛盾を示したときだけ書く |
| 文書の量 | ADR 30、reviews 17、SPEC v0.19 を 5 日で | 読む側（Codex）の読み込みに毎回 1,500 行超。読み順の 7 文書を 3 文書に減らす |
| prompt 版 | 21 ファイル。開発セットの信号が 0 | v3 を既定にして止める。比較 arm は `short-objective-managed-v4` 1 本だけ残す |
| 修正版の負の対照 | #126 / #127 / #141 の 3 件が同じ壁で停止 | 本番では修正版が無く取れない指標。受入条件から外し結果表の一列にする（第 6 節） |
| ベンチマークの公正さ装備 | held-out 日付、contamination 区間、manifest digest、provenance（#177） | 所有者の定義では「配線の確認」。#100 の後に必要最小限だけ残す |
| plugin ごとの Lab scenario | 一晩で 6 本（#156〜#169） | 「plugin 非依存を優先」の規則と逆方向。#100 の対象 3 件分だけに限る |
| Issue の増殖 | Codex が #175〜#178 を自分で起票。開 20 件 | 起票は良いが milestone に入れず、#100 の 1 周後に triage |
| 巨大ファイル | agent runtime 50KB、CLI 45KB、台帳 43KB | 動いているので今は触らない。#100 の後に #142 の続きとして扱う |

## 4. 文書の整理案

原則: 正本は SPEC と ADR と GLOSSARY の 3 つ。それ以外は「日付付きの記録」か「運用手引き」のどちらかに分類し、分類できないものは消す。Codex の読み順は AGENTS.md → SPEC.md → OPERATIONS.md の 3 本に減らし、ADR は該当 Issue が参照するものだけ読む。

### 4.1 ルートと docs/ 直下

| 文書 | 行 | 現状の問題 | 案 |
| --- | --- | ---: | --- |
| AGENTS.md | 68 | 旧「二段構え」の語が 3 箇所残る | 第 6 節に沿って書き直し。読む順を 3 文書にする |
| docs/SPEC.md | 291 | 旧経路の語が 8 箇所。第 11 節「ADR 一覧」と第 13 節「移植一覧」と第 14 節「未確認事項」は役目を終えている | 第 11 / 13 / 14 節を削除し `docs/reviews/` へ移す。第 6 節と第 12 節の旧経路の注記を 1 行に圧縮 |
| docs/OPERATIONS.md | 211 | 旧経路の語が 6 箇所。評価節が運用手引きに混ざる | 第 6 節「評価」を `docs/evaluation/README.md` へ移す。残りは手引きとして維持 |
| docs/IMPLEMENTATION-PLAN.md | 73 | 2026-10-10 時点の棚卸しで ADR 0016 を正本と書く。現状と合わない | `docs/reviews/2026-10-10-implementation-plan.md` へ移動。新しい計画は立てず、本文書第 7 節を使う |
| docs/ARCHITECTURE.md | 109 | ADR 0016 を参照。図は有用 | 参照を ADR 0029 に直して維持 |
| docs/DESIGN-EVIDENCE.md | 97 | 本文に「2026-10-08 時点の調査記録」と自記 | `docs/reviews/2026-10-08-design-evidence.md` へ移動 |
| docs/DESIGN-WALKTHROUGH.md | 21 | 21 行で独立文書にする量でない | SPEC 第 3 節「流れ」に統合して削除 |
| docs/PILOT-2026-10-10.md | 23 | 測定記録 | `docs/evaluation/2026-10-10-pilot.md` へ移動 |
| docs/TRANSLATEPRESS-BENCHMARK.md | 106 | 測定記録 | `docs/evaluation/2026-10-09-translatepress-benchmark.md` へ移動。SPEC からのリンクを更新 |
| docs/TEST-STRATEGY.md | 28 | 問題なし | 維持 |
| docs/DEVELOPMENT.md | 59 | 問題なし | 第 6 節の「ADR を書く条件」を 1 行足す |
| docs/agents/*.md | 25 | 問題なし | 維持 |
| GLOSSARY.md | 16 | `reproduced`、`Lead`、`arm`、`campaign` が無い | 4 語を足す |

### 4.2 docs/adr/

| ADR | 現状 | 案 |
| --- | --- | --- |
| 0025 二段構え | status: accepted のまま | `superseded by 0029` に直す |
| 0016 Root＋3 縦断スライス | `superseded for the default discovery` | 本文は変えない。SPEC 第 12 節からの参照を「受入記録」の 1 行にする |
| 0026 汎用 scenario 主 | accepted | 維持。#156〜#169 の plugin 別 scenario との関係を 1 行追記 |
| 0028 役割分担 | proposed | #141 が draft で止まっている。第 6 節の判断後に accepted か withdrawn を決める |
| 0030 公開履歴は選定で中立 | proposed | #144 が merge 済みなので accepted にする |
| 0013 / 0014 / 0001 | superseded | 維持（消さない） |
| 新規 ADR | — | 向こう 1 週間は書かない。例外は「#100 の実測が現行 ADR と矛盾した」場合だけ |

### 4.3 docs/reviews/

17 本すべて残す（日付付き記録は消さない）。README に次の 3 区分を付ける。

- **設計元になった**: 2026-10-09 の 5 本、2026-10-11-thorough-design-review、overall-design-v1。
- **覆った**: implementation-plan-two-stage、two-stage-prompts-draft、issue-132-deep-dive-dependencies（ADR 0029 で無効）。
- **依頼文・比較**: codex-brief 2 本、comparison 2 本、harness-completeness-review、issue-119-real-lab-dependency、return-to-wp2shell-route。

Codex への依頼文（codex-brief）は今後 Issue コメントに書き、reviews には置かない。

### 4.4 docs/evaluation/

測定記録の置き場に統一する。PILOT、TRANSLATEPRESS-BENCHMARK、2026-10-12-rediscovery-benchmark、#100 の結果をここに日付付きで置く。README に「ここの数字は配線と判定能力の確認で、未知の発見率を示さない」を 1 行で書き、各文書で繰り返さない。

## 5. Issue の整理案

開 20 件を「本番 1 周に要る」「1 周の後」「閉じる・統合」に分ける。

### 5.1 本番 1 周に要る（この順）

| Issue | 状態 | 残り |
| --- | --- | --- |
| #143 prompt v3 | draft PR #151 | 今の数字で merge。3.2.6 の 0/3 は source 読取数で「読まずに終わった / 読んで出なかった」を追記 |
| #178 Lab image に `pdo_mysql` | needs-triage | Lab が立たない原因。先に入れる |
| #176 runsc agent の掃除漏れ | needs-triage | 連続運用で Lab network が残る。先に入れる |
| #100 最新版 3 対象の本番探索 | 未着手 | #144 の `select` が返す 3 件に v3 で 1 Trial ずつ |
| #95 英語レポート JSON と人間用 Lab | 未着手 | #100 で confirmed が出た Finding に対してだけ作る |
| #96 公開記録との重複照合 | 未着手 | 同上 |

### 5.2 1 周の後

#141（`reproduced`、判定器の変更は切り離す）、#126（週次 smoke）、#127 の残り case（TranslatePress 3 件、Smash Balloon、Unlimited Elements）、#175、#177、#107、#118、#120。#177 は不変条件 1 に触れるので、1 周の結果で「公式 ZIP に修正履歴文書を含む対象」が実際に選ばれたときに優先度を上げる。

### 5.3 閉じる・統合

| Issue | 理由 |
| --- | --- |
| #129 | ADR 0025〜0027 は書かれ、0025 は 0029 で覆った。close |
| #92 | 実機 preflight は #147 / #148 の実機 run で通っている。close |
| #93 | 協調 Trial の成果保存は #147 / #148 で実装。close |
| #94 | #126 / #127 と重複。close して両方へリンク |
| #97 / #98 | #100 の結果が出るまで決められない。#100 に統合し close |

これで開 Issue は 20 → 13 になり、milestone は 7 → 6（#126 を後に回すなら 5）。

## 6. 所有者の判断が要る点

Codex はこの 3 点で止まっている。決めないと #126 / #127 / #141 / #143 が動かない。

1. **修正版の負の対照を受入条件から外すか。** SPEC 第 10 節の負の対照は「判定器のテスト（安い）」と「再発見の補助指標」で、本番には修正版が無い。外して結果表の一列（成立 / 不成立 / 未測定）にし、代わりに判定器ごとに「同じ Lab で無害な入力だけを流して鳴らない」baseline を受入条件にする案。`contradicted` の定義は変えない。
2. **optionJudge を残すか。** nonce canary なしの option 差分で `runtime-confirmed` を出すのは不変条件 3 に反する（#167 の指摘）。該当経路を `incomplete(evidence)` に落とし、1 の baseline で検出する案。
3. **v3 を既定にするか。** TranslatePress 3.3.1 で wall 中央値 33.84 → 16.88 分、非 cache 入力は半分以下、Finding 数は同等。3.2.6 は両版 0/3。今の数字で既定にする案。

## 7. 計画: 本番 1 周を先に回す（1 週間）

問い: 最新版 3 対象で、候補 → `runtime-confirmed` → 人間が読む → 提出判断、の 1 周にいくらかかり、どこで落ちるか。

| 日 | すること | 測る数字 |
| --- | --- | --- |
| 1 | 第 6 節の 3 点を決める。#143 merge。#178 / #176 を小 PR で | `pnpm check`、Lab 起動成功 3/3 |
| 2 | #144 の `select` で 3 対象を固定。Snapshot digest を台帳へ | 選定 5 → 3 の除外理由 |
| 3〜4 | 各対象に v3 で 1 Trial。Verifier は全候補を回す（止めない） | Trial / completed / Finding / Lead / wall 中央値 / 非 cache 入力 / 失敗理由。候補ごとの検証結果と `incomplete` 理由 |
| 5 | confirmed があれば #95 / #96 を通し、所有者が再現パッケージを読む | 人間が開いた Finding 数、読んだ分数、提出判断 |
| 6 | 結果を `docs/evaluation/2026-10-19-production-round-1.md` に書く | 対象あたり費用、段ごとの歩留まり、0 件対象の「読んで出なかった / 読まずに終わった」 |
| 7 | 1 周の落ちた段階で開 Issue を再 triage | 13 件 → 本当に要る件数 |

停止規則: 1 対象の Trial と検証で非 cache 入力が 1,000 万 token を超えたら、その対象は止めて次へ。3 対象とも候補 0 なら、prompt や方式を変えず、まず「読まずに終わった / 読んで出なかった」を分けて記録する。

やらないこと: 新 ADR、新 prompt 版、新しい比較 arm、plugin 別 scenario の追加（#100 の 3 対象で前提が足りないときだけ 1 本ずつ）、Issue の新規起票は `needs-triage` のまま milestone に入れない。

## 8. Codex への依頼文（案）

```
方針を変える。設計と比較はここで止め、本番 1 周を先に回す。

1. 修正版の負の対照は #126 / #127 / #141 の受入条件から外し、結果表の一列として残す。contradicted の定義は変えない。代わりに判定器ごとに「同じ Lab で無害な入力だけを流して鳴らない」baseline を受入条件にする。optionJudge は nonce canary なしでは runtime-confirmed を出さず incomplete(evidence) にする。この 2 つは #141 とは別の小 PR。
2. #143 は今の数字で merge する。3.2.6 の 0/3 を source 読取数で分類して PR に追記してから review に出す。
3. #178 と #176 を小 PR で先に入れる。
4. #100 を始める。#144 の select が返す 3 対象に v3 で 1 Trial ずつ。Verifier の queue は止めない。1 対象の非 cache 入力が 1,000 万 token を超えたら止めて次へ。結果は docs/evaluation/ に日付付きで。
5. #129 / #92 / #93 / #94 は理由を 1 行書いて close。#97 / #98 は #100 に統合して close。
6. 1 周が終わるまで、新 ADR・新 prompt 版・新 scenario・新 Issue の milestone 追加はしない。見つけた問題は needs-triage で起票だけする。
7. 文書の整理は本文書第 4 節のとおり 1 PR で。SPEC の規則は変えず、移動・リンク修正・status 訂正だけ。
```

## 9. 消し方

この文書は記録であり、採用しなくても消すものはない。第 4 節の移動を実行した PR を revert すれば元に戻る。
