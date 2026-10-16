# 配線 PR の初回 3 Trial 計測（2026-10-16）

## 測定の位置づけ

DEVELOPMENT §5 の「配線・runtime・選定を変える PR は異なる slug の初回 3 Trial の数字を貼る」を、Codex の runner 系 PR #263 #264 #266 #267 #269 について満たすための計測。main に PR #264（#263 を含む）、#267（#265 #266 を含む）、#269（#268 を含む）の head を merge した統合 branch `claude/wiring-gate-integration` で、既定 `wp2shell-bounty-v4`、履歴なし、対象版ごとに最大 1 Trial、wall 60 分、`entryIndex: true` で回した。対象は再発見ベンチマーク（#127）の開発セットから 5 case。未探索の本番対象は消費していない。本番の分母には混ぜない（campaign ID に `wiring-gate` / `wg-int` を含む）。

既知事例の再発見は配線と判定器の確認であり、未知の発見率を示さない。公開記録との経路一致（`publicRecordMatch`）はすべて `unassessed` で、人間が照合する。候補本文、payload、HTTP 記録は Git 外の Private Evidence にあり、ここには載せない。

## 結果

| case | campaign | 結果 | Root wall | Finding / Lead / parked | 検証 | 非 cache 入力 token | 停止理由 |
| --- | --- | --- | ---: | --- | --- | ---: | --- |
| Simply Schedule Appointments 1.6.10.0 | `wiring-gate-integration-ssa-1016-r2` | completed | 23.3 分 | 4 / 3 / 2 | verifier 11 回。`runtime-confirmed` 2（sqli、stored-xss）、`incomplete(observation)` 2 | 738,638 | max-runs |
| Brizy 2.8.11（1 回目） | `wiring-gate-integration-brizy-1016-r2` | Lab provision 失敗（72 秒、理由不明） | — | — | — | 0 | setup-failed（#284） |
| Brizy 2.8.11（再試行） | `wg-int-brizy-1016-r3` | completed | 12.1 分 | 1 / 3 / 0 | `incomplete(precondition)` 1（catalogue に無い前提） | 981,287 | max-runs |
| Relevanssi 4.28.3（1 回目） | `wg-int-relevanssi-1016` | incomplete(provider)。Root が 5.3 分で provider の cyber policy 拒否 | 5.3 分 | 0 / 1 / 0 | — | 373,531 | provider-refused（#220） |
| Relevanssi 4.28.3（再試行） | `wg-int-relevanssi-1016-r3` | completed | 11.3 分 | 0 / 3 / 0 | — | 460,221 | max-runs |
| TranslatePress 3.3.1 | `wg-int-tp331-1016` | incomplete(wall)。Root が 60 分の wall で timed-out | 60 分 | 1 / 0 / 0（子の Finding） | `runtime-confirmed` 1（未認証 → 管理者） | 839,160 | run-failed |
| TranslatePress 3.2.6 | `wg-int-tp326-1016` | completed | 11.2 分 | 2 / 2 / 0 | `runtime-confirmed` 2（未認証 → 管理者） | 565,499 | max-runs |

Root wall は台帳の `wallTimeMs`。子 3 run はどの case も Root より先に終わった（10〜22 分）。

集計: 7 run のうち Trial に数える run 7、completed 5（slug 4 種）、理由付き incomplete 2（provider 1、wall 1）、Lab 失敗 1（Trial に数えない）。`runtime-confirmed` 合計 5。候補 0 件の case は無い。

## 配線の確認（PR の受入に関わるもの）

- 子の有効な Finding は Root と独立に保存され、判定器まで届いた。TP 3.3.1 で Root が wall で止まった後も、子の Finding 1 件が `runtime-confirmed` になった（ADR 0029）。
- provider の拒否は `target-skipped(provider-refused, stage: discovery)` で記録され、子 3 run の完了と Lead 1 件は残った。campaign は終了コード 0 で次へ進める（#240 の意図どおり）。
- wall の timeout は単調時計（`setTimeout`）で 60 分に効いた。
- Lab の provision 失敗は 1 回だけで、同じ scenario の再試行は成功した。失敗の理由が台帳にも CLI 出力にも残らないのは #284。
- 検証の自動再試行は理由ごとに回り、SSA では 1 Finding あたり最大 4 attempt で止まった（recipe → observation ×3）。

## 注記

- ホストの時計が約 8 時間 40 分遅れており、TP 3.3.1 の最中（実時刻 2026-10-16 02:09Z 頃）に同期された。それ以前の event の `occurredAt` はずれている。TP 3.3.1 の Root の `wallTimeMs`（34,778 秒）は時計の跳びで膨らんでおり、実際は 60 分の wall で止まっている。他 case の wall は時計の跳びより前か後に閉じているので影響しない。
- campaign ID が 42 文字の最初の Relevanssi 試行は、台帳 identity の 128 文字上限で対象が黙って skip された（#281）。表には載せていない。
- WordPress image は `pdo_mysql` 入りの 6.8.3。入っていない image では Lab が `incomplete(precondition)` になる。
- #212（run の開始・終了 event が同じ `occurredAt`）はこの計測でも全 case で再現した。

## 使い方

- PR #263 #264 #266 #267 #269 の「測った数字」にこの表を貼る。#266 #267 #269 は #265 と #268 の修正（Codex、2026-10-16 の依頼文）を取り込んだ後に merge する。
- 再発見の評価は #127 に comment。公開記録との照合は所有者が `review inspect` で行い、`publicRecordMatch` を更新する。
- 手順は [docs/agents/measurement.md](../agents/measurement.md)。
