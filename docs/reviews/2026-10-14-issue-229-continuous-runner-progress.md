# #229 継続運転の実装・未達レビュー（2026-10-14）

## 今週の問い

AI セッションの逐次判断なしで、未探索候補の複数 batch を検証結果と review export の確認まで進め、停止・再開・異常を安全に表示できるか。

## 実装した経路

- 親 run と child campaign の永続 journal、host 共通 owner・resource claim、固定 config / policy / state directory の照合を経て、未探索在庫から次 batch を作る。選定済み Snapshot と selection batch を child に固定し、同じ child を再開する。
- WordPress.org の封印済み候補プールをページ間で照合し、選定直前の既往・適格性を検査する。プール期限は再観測・freeze・台帳追記の途中でも検査する。最終ページで残る 1〜2 件は短い最終 batch として扱い、0 件だけを候補不足とする。
- `continuous start|resume|status|stop` を接続した。停止要求を Trial 開始 receipt の直前にも読む。進行中 Trial は drain し、停止と実エラーの競合は `RECOVERING` に残す。`STOPPING` が quota / review 待ちで固着しないようにした。
- 再開時は台帳、claim、owner、検証完了、review export を照合する。過去の settled child の証拠もプロセス再開時に監査する。status は各 child の Trial・Finding・検証・export 到達数を読む。WordPress Finding は Private Evidence の厳格 schema と ID / run / Snapshot を再検査し、export の代替文字列を成功と数えない。
- `provider-cyber-policy` は quota と区別し `WAIT_REVIEW` に送る。候補取得失敗も枯渇に数えない。config 等の一時的な運用 hold からの明示再開では child 判定を再実行し、判定自体が review を要する場合は解除しない。

## 実測と限界

- 型検査、書式、`pnpm check`（102 test files / 778 tests 成功、1 file / 1 test skip）、`pnpm build`、`git diff --check` はローカル作業ツリーで通過した。
- 実 provider を使う Step 1 の 3 Trial 測定は未実施。候補数、completed、Finding、Lead、wall 中央値、usage、失敗理由について本番値はまだない。したがってこの差分は探索 PR の merge 条件を満たさない。
- quota の時刻到来だけでは回復を証明できない。現在は `WAIT_QUOTA` の後、読み取り専用 readiness がなければ `WAIT_REVIEW(quota-readiness-unverified)` に止める。別 provider への継続、回復後の無人再開、総 token 利用枠の硬い停止は未実装。
- Codex app-server の `account/rateLimits/read` を読み取り専用で実測した。`ordinaryUsageAllowed` は account 全体の通常利用可否で、要求 model / effort の開始可否や Opus の枠を証明しない。実運転への接続には broker が使う credential と account ID の一致、SPEC の broker 経由外向き通信境界との整合が必要。reset 時刻や残率から回復を推定しない。
- プール期限後に選定 event の一部または全部が残った未 binding child は `WAIT_REVIEW(expired-pool-with-selection-prefix)` とする。旧候補を無言で新プールへ差し替えないためで、無人復旧手順は未実装。
- resource claim 待ちが長引いた後の WordPress.org 最新版・install 数の再観測は未実装。Trial 直前の既往判定はあるが、候補鮮度の最終確認には別途対応が要る。

## 運転判定

現時点で Harness 単体の「停止まで無人運転」は未達。ローカルの複数 batch 経路と安全な停止・再開の主要条件は検証済みだが、quota 復帰、外側の起床、総利用枠、実 Trial 測定が残る。Codex heartbeat は状態変化の通知には使えるが、Harness の判定器と再開規則の代替にはしない。
