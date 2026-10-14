# MythOS 全体レビュー依頼（2026-10-15 更新）

このリポジトリを独立レビューしてください。まず `AGENTS.md` の読み順に従い、`docs/SPEC.md`、`docs/adr/`、`docs/DEVELOPMENT.md`、`docs/LESSONS.md`、`docs/PARKING.md` を読み、コード・テスト・GitHub Issues/PR の現状と照合してください。作業開始時の remote `main` と各 branch の HEAD SHA を記録してください。Issue #238 の最終設計を目的として扱い、閉じた #215/#227/#228/#229 とその PR branch は参照用であり新設計に merge しないでください。`docs/reviews/` は監査記録であり正本ではありません。

事業目標は安定した報奨収益で、長期像は WordPress plugin 以外にも広げた 24時間365日のホワイトボックス診断です。人間は戦略、Harness改善、Finding の理解・検証・提出判断に集中します。直近 Step 1 は「選定から検証までの安全な自律ループ」と、scope 内 Finding が全件レビューへ届くことを実証する段階です。ログを AI と人間が見て改善するのであり、仕様や探索方式を Harness が無断で変更する設計ではありません。

## 作成時点の公開状態

- remote `main` は `a07efa7367ccff21e940676bbce038c8ef8356fc`（#259 まで）。この PR #261 にある `2026-10-15-step1-main-readiness.md` は旧 `dfc9c9f` 基準の記録なので、現 main の判定に転用しないでください。
- #262（既往・旧履歴）、#263→#264（P4 検証再開・Lab cleanup）、#265→#266→#267（P6 停止・待機復元）は Draft で、main には未統合です。P4/P6 を接続した remote branch `codex/issue-240-p4p6-integration` は HEAD `68736432529e5f9461c7cca9d5dc3fe0f1463073` で公開済みですが、merge 済みではありません。branch 内の `docs/reviews/2026-10-15-p4-p6-preflight-integration.md` の出自表とコードを照合してください。
- #268 は P6 `continuous.json` の原子的保存・破損停止を加える別 Draft で、base は #267 の branch です。P4/P6 統合 branch には入っていません。#268 が未解決とする複数 runner の排他、台帳に対する memo の完全な再照合を P0 候補として検査し、#268 と統合 branch の併用時の競合を確認してください。
- P9 の #260 は v4 目的文・既定 prompt の未 merge PR です。#217 の目的文と開発 3 Trial を移植したという主張を出典対照表、prompt digest、campaign/selection 方針、Trial 記録と照合してください。作成時点で #260 に `owner-approved` ラベルはなく、`adr-guard` check は失敗しています。`DEVELOPMENT.md` §5 と ADR 0032 の本人承認 path と AI 委任 path を分けて、P9 の gate を判定してください。
- 運用 host の `systemctl --user` の一時観測（2026-10-15 02:05 JST）では、Opus の選定 driver 1 unit は active、Codex 24h の 3 unit と別の Opus 1 unit は failed でした。ログ本文は未読で原因は未確認です。cloud から実機を見られなければ、その限界を明記し、unit の状態だけで故障原因や Harness の実機完成度を断定しないでください。

重点は次の通りです。

1. 対象選定: 既往除外が「実際に開始した Trial」を正しく扱うか。選定だけ・Lab/Snapshot 失敗・provider の開始直後の拒否・観測欠落を区別できるか。旧研究 DB、旧 `--state`、旧 queue の履歴欠落や曖昧 slug をどう保留するか。版や prompt 変更による再候補化、候補不足、部分的な一覧取得、install 下限の別方針を確認する。#262 の修正範囲と、未 merge の main で残る経路を分ける。
2. 並列実行: 単一 campaign の既存並列・quota/stop/skip と、複数 campaign・Codex/Opus 間の資源管理と重複防止を分け、実装済みと未実装を明記する。P0 で park した旧 #228 のコードを完成済み扱いしない。
3. 継続運転: `select → campaign run → Verifier → review` の実装到達点、複数 batch の補充、期限、異常停止、operator stop、quota 待機、検証結果の保全、再起動時の同一 campaign 続行を追う。P4/P6 統合 branch で自動再開と明示 `--retry-incomplete` の分離、再試行枯渇後の不要な Lab 再供給、`incomplete` の review queue 保持、teardown 故障時の実 Lab ID と fail-closed 停止、読取専用残骸検査、停止 marker と終了コード、待機 `until` の復元をコードと合成試験で確認する。台帳だけで復元できない連続空選定・例外回数、未束縛 batch、1 対象 probe、#268 の memo 破損時を重点確認する。
4. 認証と実機 P0: `src/cli/wordpress-host.ts` の `loginMarginMinutes` は `maximumTargets × (wall + 30 × 3 + 15)` であり、`continuous.ts` は batch 前にその残存ログイン時間を要求する。broker 自身は token を refresh しない。ChatGPT OAuth の実際の残存時間は未測定なので、24/7 起動不能の可能性として、算式、判定順序、認証の更新経路、測るべき値を評価する。確定障害とは断言しない。複数 runner の排他と memo/台帳のずれ、Lab 残骸があるときの再開も故障注入の観点で調べる。
5. 品質と証拠: gVisor、broker、nonce canary、Snapshot digest、`incomplete`、追記専用台帳、Private Evidence の境界を破る経路がないか。CI 緑・合成テスト・実 gVisor Lab・実探索 Trial を区別し、`DEVELOPMENT.md` §5 の異なる slug の初回 3 Trial gate と、P9 の agent 入力変更に必要な別の 3 Trial・承認 gate に照らして merge 可否を判定する。

特に #253〜#257 の対象既往と継続 runner は、受入テストの緑と実運転の安全性を分けて評価してください。`reconsider` が開始済み slug を解除しないか、source 読取 0 の観測が下界値である点、旧履歴 JSON の内容と digest が campaign 起動時に固定されるかを確認してください。Draft #232/#233/#234 と旧参照 #216/#235/#236/#237 の重複・状態も整理してください。remote に無い修正はレビュー済みと主張しないでください。

**仕様追跡性の P0 候補:** 親 Issue #238 が採用済み正本として参照する `docs/reviews/2026-10-14-final-design.md` は、依頼時点の remote と Git 履歴で見つかっていません。参照された節の内容を推測せず、実際に辿れる SPEC/ADR/Issue と照合し、欠落が実装・承認判断に与える影響と最小の復旧策を評価してください。名前が近い `docs/reviews/2026-10-14-autonomous-verification-loop-design-proposal.md` は作業 host の untracked local file であり cloud から読めないため、存在や同一性を前提にしないでください。

出力は (A) `main`・各 Draft・統合 branch の機能と実証レベルを示す短い図、(B) P0/P1/P2 の具体的な不整合・故障条件（対象 branch、ファイルと行、根拠、影響、最小修正）、(C) 所有者が決める仕様と AI がコードで解ける問題、(D) Step 1 の安全な実機検証から 1 週間無人運転までの依存順と計測項目。事実、推論、未確認を分け、再現できない点は未確認としてください。対象固有の脆弱性、payload、Private Evidence、認証情報は出力しないでください。コード変更、実 Trial、外部送信は行わないでください。
