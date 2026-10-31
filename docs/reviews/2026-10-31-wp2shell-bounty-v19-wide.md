# wp2shell-bounty-v19-wide の本文と出典対照表（2026-10-31）

v19-wide の本文は v18-wide（[本文と数字](2026-10-28-wp2shell-bounty-v18-wide.md)）とバイト単位で同じで、最後の段落（`coordination/stop-wide-v13` → `coordination/stop-wide-v14`）だけが違う。契約は v4。v19-wide を名指しする campaign 設定は、`discovery.skills` に `wbh-recon-v1` と `wbh-tools-v1` の両方を名指しする（ADR 0039 追記 16）。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。

## 問い

Issue #714。wide の Root は中央値で約 16 分で閉じ、120 分のうち 100 分以上を使わない（[構造調査](2026-10-31-exploration-structure-investigation.md)）。停止文を tools の一覧（`/workspace/research/tools/hooks.tsv`）の残りの行に結び付けると、Root の分と開く file は増え、段 1 を通る Finding と 5 項目を通る Lead は増えるか。

## 本文（変わった段落）

旧（`stop-wide-v13`）:

> Stop when the registry shows that the entry points of every sink have been worked through, or when the Trial wall is reached, whichever comes first. Do not fabricate elapsed time. Reaching either bound is a normal ending: report the registry, every route that reached a sink with its exact remaining gap, and the entry points left unread. Reporting zero candidates after bounded closure is a normal ending.

新（`stop-wide-v14`）:

> Keep in the registry, for each sink class, how many rows of the hook listing at /workspace/research/tools/hooks.tsv its specialists have read and how many remain. Do not close while any sink class has rows remaining. Stop when no sink class has rows remaining, or when the Trial wall is reached, whichever comes first. Do not fabricate elapsed time. Reaching either bound is a normal ending: report the registry with those counts, every route that reached a sink with its exact remaining gap, and the rows and entry points left unread. Reporting zero candidates after bounded closure is a normal ending.

## 出典対照表

| # | 文 | 出典 |
| --- | --- | --- |
| 1 | 登録簿に sink 種別ごとに一覧の読んだ行数と残りの行数を書く | #714 受入条件 1 |
| 2 | 残りがある間は閉じない | #714 受入条件 1 |
| 3 | 残りが無いか制限時間に達したら閉じる。どちらも正常な終わり | #714 受入条件 1（制限時間に達したら従来どおり閉じる）、`stop-wide-v13` |
| 4 | 報告に数と読み残した行を含める | `stop-wide-v13`（読み残した入口を報告する）を一覧の行に広げたもの |
| 5 | 経過時間を作らない。候補 0 件も正常な終わり | `stop-wide-v13` のまま |

## 変えない要素

- 他の fragment すべて（task、first-principles、sinks-v16、shapes、research、handover、sources、fixed-v14）。
- v18-wide の行、本文、digest。`wide` の `current`（v14-wide）、v15-wide、`deep` の v11、campaign 設定。
- Harness の code、探索スキルの本文、出力契約 v4。
- 制限時間と子の数は本文に書かない（ADR 0039 追記 4）。

## 測り方

ADR 0039 追記 16。本番の同じ選定帯で v18-wide と交互に 20 Trial ずつ回し、Root の分（中央値）、固有 file 数 / プラグインの PHP file 数、段 1 を通った Finding / Trial、Lead の 5 項目を通った数 / Trial を並べる。
