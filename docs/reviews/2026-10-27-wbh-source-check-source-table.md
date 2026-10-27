# wbh-source-check v1 の出典対照表（2026-10-27）

## 対象と結論

段 1b の skill `wbh-source-check` v1 を足した。本文の要素は、2026-10-27 の段 2 実験で agent に渡した brief と、その結果、所有者決定 2026-10-27 から取り、足していない。

## 出典対照表

| 節 | 要素 | 出典 |
| --- | --- | --- |
| 冒頭 | 段 1 の後、Lab の前にソースだけで読み直す。決めるのは 2 つの問いだけで、重複・impact・市場性・公開済み照合は決めない | 所有者決定 2026-10-27（「あの形式で fp や到達できない脆弱性をはじきたい」）。実験の一致表（Private Evidence `stage2-screening-experiment-2026-10-27.md`。人間が同根・影響・市場性で外した 19 件はこの段で成立） |
| 入力と境界 | review export の欄、Snapshot の `target.sourceDigest` と `dependencies[].sourceDigest`、読み取り専用、通信なし、Snapshot に無い依存は読めない、対象ごとに 1 agent・10 件まで、Opus 級、ペイロードを書かない | 実験の brief（read-only、frozen source、core 7.1.3、JSON の形、no payload strings）と分担（31 単位、10 件ずつ、Opus）。`review export` の欄名は `review-export/v1` の出力 |
| 2 つの問い | 入力支配（unauthenticated / Subscriber / Customer、ベンダー・管理者・公式 feed は no）、到達性（もっともらしい設定は yes で設定名を書く、管理者が安全でない形で書くものは no） | 実験の brief の問い 1・2。本体のブロック配置を yes に数える扱いは、実験で agent が一律にそう扱い、人間の選別と一致した結果 |
| 判定 | 両方 yes で成立、どちらか no で不成立、必要なソースが無ければ未決。重複の候補は名を並べるだけ | 実験の brief の verdict 規則。重複は agent の注記（判定は各 Finding に出した） |
| 出力 | JSON の要素、対象ごとの表、件数と no の内訳、次の一手（不成立は `review decide ... --reason source-check:<input|reach> --by ai`、成立は何も打たない、未決は欠けているソースを名指し） | 実験の出力形式（`{findingId, inputControl, reachability, verdict, precondition, reason}`）。`review decide` の形と「skill は台帳に書かない」は `wbh-screen` v4.2 と `wbh-dedupe` v2 に揃えた |
| 測った数字 | 162 件で成立 88・不成立 67・未決 7、一致 159 / 162 | 実験の集計（scratchpad `stage2/aggregate.py` の出力）と一致表 |
