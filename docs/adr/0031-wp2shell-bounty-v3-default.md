---
status: accepted
date: 2026-10-12
supersedes: 0029 for the default prompt version only
---

# WP2Shell 協調 Trial の既定目的文を v3 にする

探索の主経路は ADR 0029 の Root＋最大3子、単一 Trial、入口索引、60分の wall 上限を維持し、既定目的文を `wp2shell-bounty-v3` にする。v3 は v2 の複数仮説、wave ごとの統合と反証、経路の接続を引き継ぐ。最低探索時間の指示と手書きの Finding / Lead 出力契約を目的文から外し、ADR 0019 の schema 生成契約を Harness が別節として一度だけ渡す。v3 には生成契約 v2 を使い、Root に子の起動・追加質問時にも最終4キー JSON を求めさせる。旧生成契約 v1 は過去 Trial の照合用に残す。

v2 の本文・ID・digest は変更せず、明示的な比較 Trial と過去の台帳照合に使えるよう残す。目的文と生成契約の digest は別々に記録する。v2 / v3 の同条件比較は開発セットの両対象でそれぞれ3 Trialを測り、結果を #143 の PR に記載する。
