# MythOS 全体レビュー依頼（2026-10-15）

このリポジトリを独立レビューしてください。まず `AGENTS.md` の読み順に従い、`docs/SPEC.md`、`docs/adr/`、`docs/DEVELOPMENT.md`、`docs/LESSONS.md`、`docs/PARKING.md` を読み、コード・テスト・GitHub Issues/PR の現状と照合してください。作業開始時の remote `main` HEAD SHA を記録して基準にしてください。Issue #238 の最終設計を目的として扱い、閉じた #215/#227/#228/#229 とその PR branch は参照用であり新設計に merge しないでください。

事業目標は安定した報奨収益で、長期像は WordPress plugin 以外にも広げた 24時間365日のホワイトボックス診断です。人間は戦略、Harness改善、Finding の理解・検証・提出判断に集中します。直近 Step 1 は「選定から検証までの安全な自律ループ」と、scope 内 Finding が全件レビューへ届くことを実証する段階です。ログを AI と人間が見て改善するのであり、仕様や探索方式を Harness が無断で変更する設計ではありません。

重点は次の通りです。

1. 対象選定: 既往除外が「実際に開始した Trial」を正しく扱うか。選定だけ・Lab/Snapshot 失敗・provider の開始直後の拒否・観測欠落を区別できるか。旧研究 DB、旧 `--state`、旧 queue の履歴欠落や曖昧 slug をどう保留するか。版や prompt 変更による再候補化、候補不足、部分的な一覧取得、install 下限の別方針を確認する。
2. 並列実行: 単一 campaign の既存並列・quota/stop/skip と、複数 campaign・Codex/Opus 間の資源管理と重複防止を分け、実装済みと未実装を明記する。P0 で park した旧 #228 のコードを完成済み扱いしない。
3. 継続運転: `select → campaign run → Verifier → review` の実装到達点、複数 batch の補充、期限、異常停止、operator stop、quota 待機、検証結果の保全、再起動時の同一 campaign 続行を追う。台帳だけで復元できない連続空選定・例外回数、未束縛 batch、停止 marker、1 対象 probe を特に確認する。
4. 品質と証拠: gVisor、broker、nonce canary、Snapshot digest、`incomplete`、追記専用台帳、Private Evidence の境界を破る経路がないか。CI 緑・合成テスト・実 gVisor Lab・実探索 Trial を区別し、DEVELOPMENT §5 の3 Trial gate に照らして merge 可否を判定する。

PR #248〜#259 は P1〜P8 の一部として main に merge 済みの可能性があります。必ず GitHub の最新状態を確認してください。#260 は v4 prompt の未マージ PR です。Draft #261 は日付付き監査文書、#262 は旧履歴・既往選定の安全修正、#263 は検証上限後の再開、#264 は Lab cleanup 失敗の停止（#263 に積層）、#265 は operator 停止の永続化です。いずれも合成テストと実 Trial の証拠を分け、独立にレビューしてください。特に #253〜#257 の対象既往と継続 runner は、受入テストの緑と実運転の安全性を分けて評価してください。`reconsider` が開始済み slug を解除しないか、source 読取0の観測が下界値である点、旧履歴 JSON の内容と digest が campaign 起動時に固定されるかを確認してください。runner は再起動時の operator stop marker、全 Lab 清掃の範囲、ログイン期限と preflight の順序、`incomplete` 即時再試行、空選定などの連続回数の保存、日境界の status 件数を重点確認してください。Draft PR #232/#233/#234 と旧参照 PR #216/#235/#236/#237 も重複・状態を整理してください。ローカルにしかない修正は remote から見えないのでレビュー済みと主張しないでください。`docs/reviews/2026-10-14-final-design.md` が remote に存在するかを最初に確認し、無ければ参照された節の内容を推測しないでください。

出力は (A) 現状の機能と実証レベルを示す短い図、(B) P0/P1/P2 の順の具体的な不整合・故障条件（ファイルと行、根拠、影響、最小修正）、(C) 所有者が決める必要のある仕様と、AIがコードで解ける問題、(D) Step 1 を1週間無人で回すまでの依存順と計測項目。事実、推論、未確認を分けてください。対象固有の脆弱性、payload、Private Evidence、認証情報は出力しないでください。コード変更、実 Trial、外部送信は行わないでください。
