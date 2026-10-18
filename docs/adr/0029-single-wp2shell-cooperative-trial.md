---
status: accepted
date: 2026-10-11
supersedes: 0025 for the default discovery route; 0017 for the default prompt
---

# 探索の主経路を単一の WP2Shell 協調 Trial に戻す

## 決定

対象の固定 Target Snapshot ごとに、Root と最大3子の協調 Trial を1回だけ起動する。既定の目的 prompt は版・digest を固定した `wp2shell-bounty-v2` とし、`short-objective-managed-v4` は比較 arm に残す。単独 screening、候補の有無による二段目、Harness の続行差し込みは主経路に置かない。分担と仮説は Root が決め、Harness は人数、隔離、証拠保存、停止を管理する。子が出した有効な Finding / Lead は Root の最終 JSON と独立して保存する。

固定 source から生成した入口索引を、既定で Root にカタログ情報として渡す。索引は入口の所在を示すだけで、攻撃経路や子の分担を指示せず、全入口の処理を正常終了の条件にしない。索引を渡さない比較 Trial は明示して別 arm として記録し、索引ありの Trial と同じ比較分母に混ぜない。

1 Trial の wall 上限は既定で60分とする。Root の最終報告が早く返ればその時点で正常終了し、Harness は最低実行時間を強制しない。既存の `wp2shell-bounty-v2` 本文には30分の探索指示が残るが、#143 で新しい版へ移すまで本文と digest は変えない。wall 到達、provider 上限、broker 制限、実行または schema の失敗は理由付きの `incomplete` として記録し、候補0件の正常完了に数えない。観測済みの子の成果と Private Evidence は保持する。自動 continuation、同一対象の自動追加 Trial、段別予算配分は行わない。provider 上限では新しい Trial の開始を止め、未消費の対象は同じ campaign から再開できるよう記録する。

正常完了で Finding と Lead が0件でも「脆弱性なし」とは判定しない。source 読取、最終 JSON 到達、wall、usage を記録して、読み切らずに終わった場合と読んだうえで候補が無かった場合を区別する。開発セットでの3回反復は独立した Trial として別に測り、本番の対象ごと1回という既定を変えない。

## 理由

旧方式の同条件診断1組では、短い `short-objective-managed-v4` が約4分で Stored XSS 候補0件、`wp2shell-bounty-v2` が約38分で候補1件だった。後者も独立検証は `incomplete` であり、1組から検出率の優劣は確定しない。しかし旧 WP2Shell 方式で報奨に至った経験と、所有者が主経路へ戻すと決めたことを優先し、7件の再発見と本番台帳で評価する。60分は実測約35〜38分に対する余裕を持つ暫定の上限であり、二段構えの30/90分や7:3から導いた値ではない。上限到達時の結果を正常な0件にしないことで、途中打ち切りを陰性と誤認しない。

根拠: [探索主経路の復帰報告](../reviews/2026-10-11-return-to-wp2shell-route.md)、[TranslatePress ベンチマーク](../TRANSLATEPRESS-BENCHMARK.md) 第7節、[全体詳細仕様 v1](../reviews/2026-10-11-overall-design-v1.md) 第6節。

## 採らなかった選択肢

- 単独 screening で候補が出た対象だけを協調 Trial へ進める: 未検証の一次陰性で協調探索の機会を失い、旧方式との比較の分母も変わる。
- 入口索引の全項目処理を要求して続行を差し込む: 索引はカタログであり、網羅を agent の報告から強制する根拠がない。
- 旧 WP2Shell の「必ず脆弱性がある」「最低6時間」を prompt に戻す: 存在の断定と長時間指示は観測された成果を改善する根拠がなく、途中結果の喪失を招く。
- 旧単独 Trial の上限6・無成果連続3、または二段構えの30/90分・7:3を流用する: 新しい協調主経路の実測に基づく値ではない。

## 既存決定との関係と帰結

- [ADR 0025](0025-two-stage-discovery-with-harness-continuation.md) の二段構えと Harness continuation を主経路として置き換える。[ADR 0016](0016-root-plus-three-first-vertical-slice.md) の Root＋最大3子、隔離、独立検証は維持する。[ADR 0017](0017-compare-wp2shell-bounty-and-short-prompts.md) の比較規律を維持し、既定 prompt だけ更新する。
- `screening-v1` を含む過去の prompt `.md` と digest pin、過去 Trial の `stage` / `continuationOf` 付き台帳 event は残して構成を照合できるようにする。旧screeningを現行modeで新規起動しない。新しい書き込み経路から段・continuation を外しても、追記専用台帳の既存 event を変更しない。
- 探索に渡すもの、安全境界、Harness 所有の判定器、同一 Snapshot digest、提出前の人間判断と外部行動の承認、Private Evidence の配置は SPEC 第2節の不変条件8項目のまま。目的 prompt の本文を変えるときは旧版を残して新 ID と digest を登録する。
- 開発セットの各変更は、独立した3 Trial の completed、Finding、Lead、wall 中央値、失敗理由、usage と検証結果を報告する。既存の二段構え Trial と新主経路 Trial は同じ比較の分母に混ぜない。
- 2026-10-14 追記（所有者決定）: Root が source を 1 件も読まず、子を起動せず、broker 転送が 1 以下で終わった run は Trial に数えず、その対象は次の選定で戻る。「同一対象の自動追加 Trial はしない」は途中まで走った Trial に適用し、未開始の run には適用しない。provider 上限と対象単位の失敗の扱いは SPEC §6 のとおり runner が再開・skip する。

2026-10-17: 深度の記録を正常完了の条件にする。網羅の要求ではなく記録の要求。
Root は固定入口索引の各 id の状態を typed coverage record で報告し、Harness が検証する。
記録が無効、または完全な索引で未訪問が設定閾値を超える場合は `incomplete(depth)` とする。最低時間と wall 上限は変えない。
