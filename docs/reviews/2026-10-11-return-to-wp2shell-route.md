# 2026-10-11: 探索主経路を WP2Shell 方式へ戻すための報告

## 所有者の新しい方針

二段構えの探索をいったん止め、以前の WP2Shell 方式で進める。screening は不要とする。この報告は実装変更ではない。既存の受入条件、台帳、prompt asset を書き換えない。

## 試したことと現在地

- ADR 0017 の同条件にした TranslatePress 3.2.6 の診断 1 組では、`short-objective-managed-v4` は約 4 分で Stored XSS 候補 0 件、`wp2shell-bounty-v2` は約 38 分で Stored XSS 候補 1 件だった。後者も Lab の通常機能と管理者側操作を再現できず `incomplete` で、両 arm の `runtime-confirmed` は 0 件だった。1 組だけで prompt の検出率は確定しない。
- 二段構えの #123（固定 source 由来の入口索引）と #130（単独 screening の既定化）はそれぞれ PR #136、#137 で merge 済み。#131 の継続実装は `issue/131-coverage-continuation` の commit `5741034` として push 済みだが、PR は作成しておらず merge されていない。#132 の二段目も未実装。
- #131 の最終構成で完了した開発セットのうち、TranslatePress 3.3.1 は 3/3 Trial、Finding 0、Lead 1、継続 3/3、継続後の候補増分 0。修正版 3.3 は 3/3 Trial、Finding 0、Lead 1、継続 3/3、候補増分 0。3.2.6 と修正版 3.3.2 の途中 run は今回の方針変更で新規 Trial の起動を止めた。全版の正式な比較値としては扱わない。
- この screening 結果から WP2Shell 方式の検出能力や Issue #127 の達成可否は判断できない。既知経路の判定器側にも別の課題があり、探索 0 件と判定器の `incomplete` を混ぜない。

## 現行設計と衝突する箇所

- ADR 0025 は単独 screening → 候補がある対象だけ Root＋最大 3 子の deep-dive を主経路とし、30 分未満の coverage 継続と 7:3 の予算配分を定める。これを新 ADR で置き換える必要がある。
- ADR 0017 は `short-objective-managed-v4` を旧既定、`wp2shell-bounty-v2` を比較 arm としており、WP2Shell を既定にする判断は別途記録すると明記する。ADR 0016 の Root＋最大 3 子の協調形は残っているが、主経路としては ADR 0025 に置き換えられている。
- SPEC 第 3、4、4a、5、6、10、12 節と AGENTS.md の探索 prompt 規則には、二段構え・screening 既定・段別の受け渡しと評価が記載されている。設計 PR で整合させる。第 2 節の隔離、探索への入力制限、独立した canary 判定、追記専用台帳の不変条件は維持する。
- 現行コードでは `screening-v1` が既定 prompt、入口索引が既定有効。旧 `wp2shell-bounty-v2` の asset と digest pin は残っている。stage 付きの既存台帳 event は消さず、旧 Trial として読み続ける。

## 実装前に決定として記録すること

1. 主経路を **単一の Root＋最大 3 子の協調 Trial、`wp2shell-bounty-v2` 既定、screening なし** に戻す。旧 prompt ID と digest pin は過去 Trial の再現用に保持し、WP2Shell 本文を変更するなら新 ID を作る。旧 WP2Shell の「脆弱性は必ずある」「最低 6 時間」は復活させない。
2. #123 の入口索引を新主経路でもカタログ入力として維持するか、以前の WP2Shell arm と同じく既定で無効にするかを ADR に明記する。両設定の Trial は同じ比較の分母に混ぜない。入口索引を使う場合も固定 source 由来のカタログ情報としてだけ渡す。
3. 1 対象あたりの Trial 数、wall 上限、停止規則を ADR に明記する。ADR 0016 は最初の縦断スライスで 1 Trial を使い、旧実装の上限 6・無成果連続 3 を新協調経路の最適値とは扱っていない。二段構えの 30/90 分、7:3、coverage 継続をそのまま流用しない。
4. #131 と #132 の既存 Issue の受入条件は書き換えない。新方針では停止した経路として理由を記録し、新 ADR → 既定経路の実装 → 開発セットで最低 3 Trial の測定、という独立 PR に切り替える。#125、#126、#127 の依存順と #127 の 7 件の実行方法も設計文書で更新する。#119 以降の判定器・Lab の課題は探索方式と独立に解く。

## 選択肢と推奨

- **推奨:** 新 ADR を単独 PR で先行し、SPEC / AGENTS.md を合わせる。次の別 PR で WP2Shell を既定の協調 Trial に戻し、screening 起動を外す。#130 の prompt と stage 付き台帳記録は過去 run の再現・読取に残す。これなら現在の実測を失わず、新旧 campaign を prompt digest と設定で分離できる。
- screening 実装そのものを削除する案もあるが、過去 Trial の再現能力と台帳互換を先に評価する必要がある。主経路から外すだけなら即時の削除は不要。

方針を受けた時点で #131 の新しい Trial 起動と PR 作成を止めた。最後の実行中 Trial は終了させ、Harness の cleanup 後に当該 Lab / broker / session コンテナが残っていないことを確認した。追加の二段目 Trial は開始していない。
