# #227 候補在庫の最初の接続点

最初の接続点を調べた時点の報告。正本ではない。後続実装の到達点は末尾に追記する。

## 事実

- 現行の自動方針は WordPress.org の一覧から最大 500 slug を列挙し、`inspectBatch` で適格性とスコアを調べる。一方、`select` は最大 5 件に切る。
- CLI の `select` は選ばれた対象の Snapshot をその場で固定し、`target-selected` を記録する。選定だけで source 取得と固定が起きる。
- 既存の台帳除外は `target-selected` を既往の根拠にし、版・prompt の変化で再候補化できる。#215 が要求する「Trial 開始済み slug」と旧 DB・アーカイブの照合とは異なる。
- 現行の campaign は選定バッチと Snapshot digest に束縛される。継続補充にはバッチの読み方と起動直前の再検査が要る。
- WordPress.org の一覧観測は `available` / `stale` / `unavailable` と各ページの状態を返す。候補 0 件だけでは枯渇を証明できない。
- 全体が `available` でも一部ページの取得に失敗し得る。在庫は要求したページ群について `requestedListingCoverage` を残し、部分失敗を区別する。この値は WordPress.org 全体の枯渇を意味しない。

## この差分で答える問い

現行の方針と順位を変えず、5 件の選定上限より大きい候補メタデータを Snapshot なしで Private Evidence に固定し、再読込できるか。

`collectWordPressCandidateInventory` は `inspectBatch` だけを受け、全適格候補の公開メタデータ、方針 digest、取得時刻、一覧の状態と除外理由の件数を保存する。source / Programme の観測参照を候補から除き、保存した候補を `freeze` の入力型として再利用できないようにする。`readWordPressCandidateInventory` は digest と同じ方針による再読込を検査する。対象 source、Lab、Trial は操作しない。Git の台帳へ候補本文を書かない。

## 後続の接続順

1. #215: 全 state と旧記録の開始事実を照合し、不明 slug を保留する。版・prompt だけで初回に戻さない。旧 source の照合範囲が確定するまでは初回自動起動を fail-closed にする。
2. #228: 複数 process / provider 共通の原子的な対象 claim を取得する。
3. #227 の残り: 在庫 digest を運転状態へ結び、補充時には未探索だけを残す。各起動直前に WordPress.org と Programme を再観測し、claim 下で #215 を再照合してから Snapshot を固定する。取得失敗と真の枯渇を別の停止理由にする。

最初の接続点を調べた時点の列挙器は、方針で指定した同じページ群の先頭から最大 500 slug を返していた。補充にはページを先へ進める状態または候補源の拡張が必要で、同じ先頭集合を再保存するだけでは在庫は増えない。

今回の artifact は候補の提案であり、起動の許可ではない。現在の `select` と `campaign run` は変更していない。旧履歴の照合範囲が未確定な現状では、この artifact から初回 Trial を自動起動しない。#227 全体の受入条件や Step 1 の無人運転完了は、この差分だけでは満たさない。

## 未確認

- 数百件の本番観測時間、24 時間の消費数、補充閾値。実対象 Trial は実行していない。
- #215 の旧 DB・アーカイブの実監査結果と、#228 の claim を使った実運転。

## 後続実装の到達点（2026-10-14）

この branch は最初の保存 seam の後に、500件を超える listing の継続 cursor、各ページの coverage、封印した source pool、期限、在庫の読取 CLI を追加した。テストでは300候補の保存・再読込、500件を超える列挙、部分失敗と期限切れの区別を確認した。`pnpm check` は689テスト成功、`pnpm build` も成功した。

これらは公開候補 metadata の在庫であり、Trial の開始許可ではない。複数 child batch への補充、claim 下での既往・最新版・Programme 適格性の起動直前照合は #229 の統合経路にある。旧 source の全数監査 manifest は未取込なので、初回 Trial の実運転は保留のまま。開発セットと再開の実測もないため、この PR は Draft とする。
