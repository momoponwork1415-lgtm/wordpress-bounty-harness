# #229: quota 中に保存した Finding の検証と再開

対象: `codex/issue-229-continuous-pr` の `2e0b4b9`。これは実装判定の記録であり、SPEC/ADR の変更ではない。Private Evidence や対象の内容は含めない。

## 観測

- 通常の `campaign run` は、provider 上限を受けた Root Trial を使い切ったものとして数える。**同じ campaign の次の呼び出し**ではその Trial を開始し直さず、既に保存した Finding を検証できる。`tests/cli/cli.test.ts` の「verifies a child Finding on resume」がこの経路を検査している。
- 継続親の `WAIT_QUOTA` は期限前に返り、期限後は `WAIT_REVIEW(quota-readiness-unverified)` へ移るだけで、子を呼ばない（`src/cli/continuous-runner.ts:264-279`）。この review 理由は再開対象の一覧にもない（同:242-251）。子の assessment も、provider-limited の終了 receipt を確認すると、検証数に先立って `wait-quota` を返す（`src/discovery/continuous-child-assessment.ts:191-210`、`src/discovery/continuous-restart-reconciliation.ts:405-412`）。従って親の定期起動だけでは保存済み Finding の検証も次の未開始対象も進まない。
- これは単に親から通常の `runCampaign` を再実行して直せない。1 child に未開始対象が混在し得るため、新しい Trial まで進む可能性がある。新しい provider 上限の直後は Verifier も同じ購読を使うため、現在の pipeline は即時検証を避ける（`src/cli/pipeline.ts:530-546`）。回復が未確認のまま Verifier を呼ぶと、失敗は `incomplete(provider)` として記録される。`review export` 自体は読み取り専用で `verification: null` の材料も出せるが、それは検証完了の証拠ではない。
- 現在の `preflight:root-three` は無害な fixture、runsc、broker を使う**実際の provider 呼び出し**であり、Root と3子を起動する（`scripts/preflight-root-three.mjs`）。Root だけに減らした probe は実行時点の接続可否を測る選択肢になる。ただし読み取り専用の quota 検査ではなく、使用枠を消費し得る。後続の Verifier が使う account・model・認証・枠の同一性と、将来も十分な枠があることまでは証明しない。現行 broker の許可 API を広げたり、ホストから対象を実行したりする理由にはならない。

一時的な再現テストでは、終了済み provider-limited Trial と保存済み Finding を持つ子について、親へ仮の「quota 回復済み」入力を加えても子の検証呼び出しは **0回**だった（期待1回、`pnpm exec vitest run tests/cli/continuous-runner.test.ts -t 'drains a captured Finding after positive quota readiness'`、失敗）。仮の入力は実装されておらず、テストは診断後に除去した。既存の quota 待機と通常 campaign の Finding 検証テストは2件成功した。したがって現在の gap は parent の再開契約にある。

## 安全に実装するための契約

1. **回復証拠**: 対象 Trial の provider・認証 account の非秘密識別子・探索 model と Verifier model・runtime profile・最後の上限 receipt sequence を結び付けた、短寿命の肯定的な capacity 証拠を定義する。期限到来や古い別 account/model の成功だけでは解除しない。probe を使うなら gVisor と broker の既存経路で、無害な fixture、厳しい request/wall 上限、使った usage と失敗理由を Git 外に残す。probe 自体は探索 Trial に数えない。
2. **検証だけの子操作**: quota で終わった Root/子 run がすべて終了し、資源 claim が清算済みで、Snapshot digest と Finding の run lineage が一致する場合だけ、保存済み scope 内 Finding を fresh Lab で検証する。この操作は未開始対象を選ばず、`discovery-run-started` を書けない契約にする。検証結果と `review export` の有無を照合し、成功・`incomplete`・失敗をそれぞれ残す。
3. **再開の永続化**: 既存の provider-limited receipt は変更しない。回復証拠と処理済み Finding の cursor を追記し、親の crash 後も同じ Finding を重複検証せず、未開始対象の初回 Trial を別の次操作として判定する。証拠が無い、期限切れ、別枠、Lab/claim の不確実性がある場合は `WAIT_QUOTA` または `RECOVERING` に留める。

受入テストは、(a) 証拠なし・期限切れ・別 account/model なら provider 呼び出し0、(b) 同じ枠の肯定証拠で保存済み Finding だけが検証され、Trial start は増えず、同じ Snapshot の export に到達、(c) 同じ child の未開始対象はその後に別途初回 Trial として進む、(d) Verifier が再び上限を返しても typed `incomplete` と quota hold を保つ、(e) 検証後・journal 更新前の crash でも二重 Trial/二重検証を起こさない、を含める。Root＋3の無害 preflight を減らすなら、probe 0/1/複数呼び出し・account/model 不一致・broker 拒否・cleanup 失敗も検査する。

**判定**: quota 復帰後の無人検証・補充は未実装。肯定的な同一枠 readiness と検証専用の dispatch が揃う前に、親の quota hold を通常 campaign 再実行へつなぐ変更はしない。
