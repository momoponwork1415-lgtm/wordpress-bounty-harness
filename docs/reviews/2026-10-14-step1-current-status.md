# Step 1 の現状と実運転阻害（2026-10-14）

この文書はローカル checkout と今回の実測を照合した進捗記録であり、仕様の正本ではない。規則は [SPEC](../SPEC.md)、[ADR](../adr/)、[DEVELOPMENT](../DEVELOPMENT.md) 第 2 節に従う。GitHub に未送信の commit は「ローカル」と明記する。

## 到達点

| 経路 | 現在できること | 受入前に残ること |
| --- | --- | --- |
| 選定・既往 | WordPress.org から公開候補を列挙し、固定 Snapshot と選定 batch を作る。#227 の在庫は未探索 slug を複数 batch へ補充し、旧履歴が曖昧な slug を保留する。#215 は同じ slug の追加独立 Trial を 1 回ごとの承認に結び付ける。 | 旧 DB・アーカイブの全数監査 manifest は未取込。初回在庫の `coverage-incomplete(legacy-history-unverified)` は解除しない。#227 と #215 の追加 commit はローカルのみ。 |
| Lab・Snapshot | gVisor `runsc` の Lab、Snapshot 固定と再利用、判定器の nonce canary 経路がある。#222 の実 Lab 可読性確認は 1/1 成功。#223 は Snapshot 再利用を補強した。 | 実機で長い連続運転を測っていない。隔離を弱めた代替経路は設けない。 |
| 探索・検証・表示 | 対象ごとの v4 協調 Trial、独立 Verifier、scope 内 Finding の review queue / export がある。#185 は scope 内全件の受け渡しを Draft PR にした。 | #220 の実 provider は `cyber_policy` refusal を返したため `incomplete(provider)`。探索成果を 0 件の正常終了に数えない。探索変更の受入に必要な開発セット 3 Trial は未測定。 |
| 並列と継続 | campaign 内の対象並列、host 共通の対象・provider 資源 claim、#229 の親 run から複数 child batch を補充する経路をローカル実装した。`status`、停止要求、drain、再開前照合、review export 到達数を持つ。 | #229 は GitHub 未送信で実機 3 Trial も未測定。Opus の実 runtime / 枠をこの連続運転に接続していない。 |

## #229 の安全な停止点

- 固定された 24 時間の終了時刻は置かない。運転者の停止要求、候補枯渇、quota、版・Programme・設定の変化、証拠不足で状態を保存する。
- 追加投入するのは未探索 slug だけ。同じ slug の追加 Trial は #215 の事前承認なしに開始しない。候補が尽きたら `WAIT_REVIEW` とする。
- quota の時刻到来だけでは回復を証明できない。現状は 5 分後の確認を経て `WAIT_REVIEW(quota-readiness-unverified)` に止める。別 provider への切替、枠回復後の無人再開、総 token の厳密な上限は未実装。
- crash 復旧は、全 Trial 開始に終了記録があり、検証と export が揃った typed quota / cyber policy 待機に限る。未終了 Trial、資源 claim、欠損証拠は `RECOVERING` とする。
- 初回 slug の旧履歴照合、実 provider の拒否、quota 復帰を解消するまで、Step 1 の「quota 1 週分を人手介入 0」は達成していない。

## この時点の変更と確認

| Issue | 成果物 | 測定・状態 |
| --- | --- | --- |
| #185 | Draft PR #233 | ローカル品質ゲート通過。3 Trial 測定待ち。 |
| #220 | Draft PR #221 | 実 provider の拒否を約 15 秒で `incomplete(provider)` として記録。 |
| #222 | Draft PR #232 | 実 `runsc` Lab 可読性 1/1。 |
| #223 | Draft PR #234 | Snapshot 再利用の実装と回帰確認。 |
| #215 | Draft PR #216 とローカル追加 commit | 旧履歴の全数監査 manifest は未作成・未取込。 |
| #227 / #228 | ローカル commit | 候補在庫、host 共通 claim をそれぞれ実装・品質ゲート通過。GitHub へ未送信。 |
| #229 | ローカル branch `codex/issue-229-batch-pin`、`05775ee` | 複数 batch、停止・再開、鮮度・入力 pin、復旧条件。`pnpm check`: 802 成功 / 1 skip、`pnpm build` 成功。実 3 Trial 未測定。詳細は [#229 進捗レビュー](2026-10-14-issue-229-continuous-runner-progress.md)。 |
| #230 | 別のローカル commit `1bbaf3e` | install 数の上限を可変にする試作。Step 1 の選定方針構造は凍結中なので #229 には混ぜない。 |

GitHub への push / PR 更新は今回の自動承認審査で拒否された。したがって上表の「ローカル」はリモートに反映されたことを意味しない。受入判定には実 Trial の測定値と必要なレビューが残る。
