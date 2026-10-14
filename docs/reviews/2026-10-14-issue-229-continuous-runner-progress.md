# #229 継続運転の実装・未達レビュー（2026-10-14）

## 今週の問い

AI セッションの逐次判断なしで、未探索候補の複数 batch を検証結果と review export の確認まで進め、停止・再開・異常を安全に表示できるか。

## 実装した経路

- 親 run と child campaign の永続 journal、host 共通 owner・resource claim、固定 config / policy / state directory の照合を経て、未探索在庫から次 batch を作る。選定済み Snapshot と selection batch を child に固定し、同じ child を再開する。
- WordPress.org の封印済み候補プールをページ間で照合し、選定直前の既往・適格性を検査する。プール期限は再観測・freeze・台帳追記の途中でも検査する。最終ページで残る 1〜2 件は短い最終 batch として扱い、0 件だけを候補不足とする。
- `continuous start|resume|status|stop` を接続した。停止要求を Trial 開始 receipt の直前にも読む。進行中 Trial は drain し、停止と実エラーの競合は `RECOVERING` に残す。`STOPPING` が quota / review 待ちで固着しないようにした。
- 再開時は台帳、claim、owner、検証完了、review export を照合する。過去の settled child の証拠もプロセス再開時に監査する。status は各 child の Trial・Finding・検証・export 到達数を読む。WordPress Finding は Private Evidence の厳格 schema と ID / run / Snapshot を再検査し、export の代替文字列を成功と数えない。
- status は各 child の対象ごとに Snapshot digest、Trial の開始・終了数、quota / 未開始 / review 保留の状態を表示する。Private Evidence の照合を省いた呼び出しでも、Finding がある quota 停止を export 不明で隠さない。export 到達数だけを不明として表示する。
- `provider-cyber-policy` は quota と区別し `WAIT_REVIEW` に送る。候補取得失敗も枯渇に数えない。config 等の一時的な運用 hold からの明示再開では child 判定を再実行し、判定自体が review を要する場合は解除しない。
- 自動在庫から固定した対象は、資源 claim の取得後、Lab / Trial の前に WordPress.org の安定版と Programme 適格性を再観測する。版・対象範囲が変化または確認不能なら claim を解放して `WAIT_REVIEW` に置き、固定済み child binding と Snapshot は維持する。手動 pin はこの鮮度条件の対象外。
- 完了済みの子 run が失敗していれば Root の成功だけで batch を完了扱いにしない。再開時は直近と過去の確定済み batch の Root / 子 Trial 系譜を照合し、不一致は保留する。
- 旧履歴が未照合の slug と再観測が不確かな slug は候補枯渇に数えず、それぞれ `candidate-history-unverified` と `candidate-observation-unverified` で保留する。

## 実測と限界

- 型検査、書式、`pnpm check`（808 tests 成功、1 test skip）、`pnpm build`、`git diff --check` は #228 上の専用ブランチで通過した。
- 実 provider を使う Step 1 の 3 Trial 測定は未実施。候補数、completed、Finding、Lead、wall 中央値、usage、失敗理由について本番値はまだない。したがってこの差分は探索 PR の merge 条件を満たさない。
- quota の時刻到来だけでは回復を証明できない。現在は `WAIT_QUOTA` の後、読み取り専用 readiness がなければ `WAIT_REVIEW(quota-readiness-unverified)` に止める。別 provider への継続、回復後の無人再開、総 token 利用枠の硬い停止は未実装。
- 硬い総 token 枠は、現行の事後 usage と broker の byte / request 上限からは保証できない。[実装可能性と必要契約](2026-10-14-issue-229-hard-usage-cap-feasibility.md)を決定待ちとして分離した。
- readiness probe だけを足しても再開は完成しない。現行 child assessment は既存の provider-limited receipt を毎回 `wait-quota` と判定する。回復確認を receipt sequence / provider / account に結び付けて永続化し、消費済み `incomplete` Trial と未開始 target を別々に扱う必要がある。現行 receipt には provider key がなく、broker は rate-limit 読取を転送しない。認証 token の期限切れも quota と区別する必要がある。
- Codex app-server の `account/rateLimits/read` を読み取り専用で実測した。`ordinaryUsageAllowed` は account 全体の通常利用可否で、要求 model / effort の開始可否や Opus の枠を証明しない。実運転への接続には broker が使う credential と account ID の一致、SPEC の broker 経由外向き通信境界との整合が必要。reset 時刻や残率から回復を推定しない。
- プール期限後に選定 event の一部または全部が残った未 binding child は `WAIT_REVIEW(expired-pool-with-selection-prefix)` とする。旧候補を無言で新プールへ差し替えないためで、無人復旧手順は未実装。
- resource claim 待ちの後の最新版と Programme 適格性は再観測する。固定済み child の古い Snapshot を自動で新しい版へ差し替える経路はないため、変化時は人間の確認を要する。
- この専用ブランチの base は #228 で、既定探索 prompt はまだ v3。#214 の v4 主経路は別 PR であり、統合後の実 Trial をこの差分の測定結果として扱う必要がある。

## 運転判定

現時点で Harness 単体の「停止まで無人運転」は未達。ローカルの複数 batch 経路と安全な停止・再開の主要条件は検証済みだが、quota 復帰、外側の起床、総利用枠、実 Trial 測定が残る。Codex heartbeat は状態変化の通知には使えるが、Harness の判定器と再開規則の代替にはしない。
