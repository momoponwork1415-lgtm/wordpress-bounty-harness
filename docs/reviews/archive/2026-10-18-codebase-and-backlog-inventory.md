# コードベースと backlog の棚卸し（2026-10-18）

調べて報告。正本ではない。所有者の「構造を把握しきれない。Issue と branch が増えて何が終わっているか分からない」に対し、origin/main `a3e8ab9` の規模、remote branch の状態、open Issue 26 件の分類を数字で出し、整理の順番を提案する。変更はしていない。

## 1. 規模

| 項目 | 値 |
|---|---|
| src | 119 file、36,099 行 |
| tests | 92 file、32,131 行 |
| docs | md 156 file。reviews 58、ADR 32、evaluation 11 |
| 800 行超の file | 12 本。`ledger/index.ts` 1,751、`cli/wordpress.ts` 1,721、`discovery/codex-native-agent-runtime.ts` 1,688、`cli/pipeline.ts` 1,606、`cli/index.ts` 1,497、`verification/judges.ts` 1,413 |
| Issue | open 26、closed 127（10-06 からの 12 日間） |
| remote branch | 14。open PR 2、PR の無い作業 branch 7、merge 済み残骸 2、archive 1、review 用 1 |

module 別（行）: cli 6,516 / discovery 6,913 + profile 側 2,220 / lab 4,288 / verification 1,146 + profile 側 3,386 / ledger 1,751 / review 1,964 / acquisition 2,635 / selection 1,287 / その他 2,000 弱。

読みにくさの出所は 3 つ。(1) 「制御」が `cli/` の 3 本（index、wordpress、pipeline）に 4,800 行で集まっている。(2) discovery の 9,100 行のうち gVisor・broker・proxy・runtime の基盤が 4,400 行で安定しているのに対し、索引・coverage・task-plan・storage-index の 1,500 行が 2026-10-18 の責務分離で削除対象になった。(3) 12 日で 127 Issue を 3 系統の AI（Codex、Opus、Mythos）が並列に閉じ、計測 arm ごとに設定 mode が足された。

削除は既に始まっている。#341〜#348 で replay Verifier、eval score / keys / rubric、Lab adapter 2 本、旧 arm の examples が消えた。#351（open）が 1,547 行を消す。#353 の削除一覧（索引の探索入力、coverage、dispatch、Verifier 指示の連鎖、scenario 正規表現、plugin 別 adapter）がさらに数千行。

## 2. branch

| 状態 | branch | 扱い |
|---|---|---|
| open PR | `codex/wp2shell-bounty-v7`（#350）、`opus/delete-campaign-modes`（#351） | #351 は merge 可。#350 は 3 Trial の数字待ち |
| PR 無し、Issue は open（2026-10-16） | `codex/issue-212-run-times`、`-276-child-reports`、`-277-coverage-matrix`、`-278-positive-evidence`、`-279-private-records`、`-281-campaign-id-limit`、`-284-lab-diagnostic` | 7 本とも main から 2 日遅れ。Issue ごとに「rebase して PR」か「削除して Issue に branch 名を記録」を決める。#276 は #350 が実質解消 |
| merge 済みの残骸 | `pr/342`、`pr/345` | 削除 |
| archive | `archive/2026-10-wbh-audit-discovery-depth` | 残す（規約） |
| review 用 | `claude/bug-bounty-harness-review-uj49qn`（10-14） | 削除か archive/ へ |

## 3. open Issue 26 件の分類

| 分類 | Issue | 扱い |
|---|---|---|
| 方針どおり次にやる | #352 検証 skill、#297 探索だけ mode（#321 で `verify next` は入った。残りは探索で止まる設定）、#353 ADR 0033 と削除、#339 正本の食い違い、#295 選定帯（履歴条件は後） | この順 |
| runner / provider の小さな修正 | #307 #302 #281 #284 #292 #212 #226 | runner 再開前に 4 本（#307 #302 #281 #284）。残り 3 本は後 |
| 判定器と証拠 | #120 #278 #279 #277 #218 | #352 の skill 化と一緒に見直す。#277 の matrix は所有者判断待ち |
| 方針で意味が変わった | #332 健全性指標（層 3 の再発見だけ残す）、#238 Step 1 判定（完了条件を書き直す）、#347 並列化（runner 再開後） | 本文を書き直すか close |
| 保留でよい | #271 wbh-tune、#175 Patchstack 条件、#96 三源照合、#309 requires_plugins、#127 7 件ベンチマーク（3 件済み、残りは Lab 依存） | PARKING に 1 行ずつ、Issue は close |

## 4. 提案する順番

リファクタの前に削除。消える code を読みやすくしても無駄になる。

1. **今日**: `pr/342` `pr/345` を削除。7 本の `codex/issue-*` は Issue ごとに採否を決める。#351 を merge。保留 5 件を close して PARKING に移す。
2. **#350 の数字が出たら**: merge し、#353 の削除 PR を順に出す（索引 → coverage / depth → dispatch 残骸 → Verifier 連鎖と scenario は #352 と同時）。
3. **所有者の「やりたいこと」を 1 枚に**: 7 段（選定・Snapshot・Lab・探索・検証・台帳・review）× 3 列（Harness が持つ / prompt と skill が持つ / 消す）の表 1 枚。AGENTS.md の責務の節を表にしたもので、新しい規則は増やさない。docs/reviews 58 本は final design（10-14）より前のものを `docs/reviews/archive/` へ移す。
4. **削除の後にリファクタ**: codebase-design skill で、2026-10-18 アーキテクチャ報告の候補 1〜4（Ledger `readAll`、campaign session、prompt registry の表、`planWordPressDiscovery` の profile 移動）と候補 9（CLI の command table）。目標は `cli/` 3 本と `ledger/index.ts` を各 800 行以下にすること。
5. **運転の規則を 1 つ足す**: AI 1 系統につき open PR は 1 本、PR の無い branch を作らない。3 系統並列が今回の増殖の原因。

## 未確認事項

- 7 本の `codex/issue-*` branch の中身は読んでいない。main との衝突の有無は不明。
- `#297` の残り（探索で止まる設定）が `pipeline.ts` にどこまで入っているかは grep で確認していない。
