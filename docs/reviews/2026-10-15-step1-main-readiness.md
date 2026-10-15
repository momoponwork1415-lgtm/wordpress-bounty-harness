# Step 1 main 実装の到達点と無人運転の阻害要因

調査日: 2026-10-15 JST。基準: `origin/main` `dfc9c9f`（PR #258 まで）。これは正本を改訂しないレビュー記録。根拠の優先順位は `SPEC.md`、ADR、`DEVELOPMENT.md`、`LESSONS.md`、Issue #238 とその子 Issue とした。Issue が参照する `docs/reviews/2026-10-14-final-design.md` はこの基準 commit に存在しないため、その「第 5 節 P6 (1)〜(15)」は照合不能。

## 現在の経路

```text
WordPress.org 候補列挙・採点（P5 の一部）
  ↓
選定・Snapshot 固定（P2）
  ↓
使い捨て gVisor Lab（P1 の修正を含む）
  ↓
1 対象の Root＋最大 3 子 Trial（P3/P4 の停止・skip）
  ↓
独立 Verifier と判定器 → review queue
  ↓
人間のレビュー・再現・提出判断

continuous run / stop / status（P6）は上の複数 batch を結ぶ CLI として追加済み。
実機 1 週間の無人運転を証明した状態ではない。
```

## 照合結果

| 領域 | 実装されたこと | 未充足・故障条件 |
| --- | --- | --- |
| 対象供給 | 既定方針は `revisitPolicy: never`、WordPress.org 人気順 10 頁と 8 タグ各 1 頁、最大 1,000 件。`select --minimum 1` と下限別方針 file を追加（#253/#254）。選定だけで探索開始しなかった対象を戻す。 | `discovery-run-finished.observed` は下界値（`src/ledger/index.ts`）なのに、`src/profiles/wordpress/selection/ledger-exclusions.ts` の `countsAsTrial` は `filesRead=0` を「読んでいない」証明として扱う。記録欠落時に既往 slug を未探索として戻し得る。 |
| 旧履歴 | Git 外の `started` / `ambiguous` / `reconsider` JSON を `select` が読む。欠落はレポートで `unavailable`（#253）。 | `reconsider` が旧 `started` と現行 Trial 既往まで解除する。reader は重複・集合の矛盾や Git 外所在を検査しない。`continuous run` の起動前確認は file の存在だけで、`campaign run` は JSON 内容・選定時 digest と `revisitPolicy: never` を照合しない。旧 queue の開始記録を exporter が網羅するか未確認。 |
| 並列 | 1 campaign 内では `maxConcurrentTargets` と memory budget に従って対象を実行し、探索 Root＋最大 3 子を使う。拒否・通常 run 失敗は対象 skip、provider 上限と operator stop は campaign 停止（#251/#252）。 | 複数 campaign と Codex/Opus 間の共通資源枠・対象 claim は実装されていない。旧 #228 は閉じた参照案。Step 1 は単一 runner 運用であり、別セッションとの同時起動をコードで防げない。 |
| Lab 停止・再開 | Verifier quota の停止・再開と対象境界の signal stop がある（#252）。 | `src/cli/pipeline.ts` は Lab teardown 失敗でも次の対象へ進み得る。再試行枯渇後の `incomplete` も同一 campaign 再開のたび discovery Lab を再供給し得る。残存 Lab と review Lab の区別が自動清掃にない。 |
| 継続 runner | `continuous run / stop / status`、選定後の再実行、backoff、候補不足・拒否・disk・Programme 鮮度 hold を追加（#255〜#257）。 | `src/cli/continuous.ts` は起動時に stop marker を無条件削除し、`incomplete` を間隔・回数上限なしで即再実行する。`continuous-cli.ts` は review Lab marker が無ければ `cleanupLeftovers(remove:true)` を全体にかけ、他の Lab を削除し得る。preflight は `waiting-login` より先で、失効時は待機に入れない。 |
| 進捗・期限 | `continuous.json` に campaign ID と連続回数、`continuous status` に今日・週の件数を表示。 | 空選定・連続 error などの判断は台帳から復元できず、memo が実質的な第 2 状態源。直接上書きの破損時動作が未定。status の `unsettled` は日境界をまたぐ開始・終了を同じ `since` で切るため誤算し得る。ログイン margin は既定で 825 分だが既存 preflight は 1 時間を見ており、通常の認証寿命では待機し続ける可能性がある。 |

## 判定と次の手

1. **現時点の 1 週間無人運転は開始しない。** 起動遮断の優先は、旧履歴の開始済み slug を解除できないこと、実行時の JSON/digest/方針固定、operator stop marker の保持、全 Lab 自動削除の廃止または対象 Lab ID 限定。`incomplete` の無制限即再実行も止める。
2. P4 の残存 Lab と再試行枯渇後の無駄な Lab 再供給を修正し、故障注入で台帳・Private Evidence と `review queue` を保持する。
3. 未実施の実機ゲートを別に測る。`DEVELOPMENT.md` 第 5 節は配線・runtime・選定 PR に異なる slug の初回 3 Trial、agent 入力変更 PR に開発セット 3 Trial を要求する。#248〜#258 の公開 PR 本文には、必要な実 Trial 3 件の completed・wall・停止理由がまだ示されていない。ローカル `pnpm check` と `pnpm build` の成功はその代わりにならない。
4. 所有者の決定を要する文書差分を解く。`OPERATIONS.md` は no-progress 3 batch、Issue #242 は 2 batch であり、連続回数の永続化方式も未確定。旧 queue の開始履歴と `reconsider` の解除条件を確認し、候補の実残数を Git 外で測る。P9 の v4 prompt と既定 campaign/policy の整合は週次起動前に確認する。

この記録はコード・Issue・PR 本文の静的照合であり、実対象の脆弱性や Private Evidence は含まない。実 Trial、週次 runner、外部報告は実行していない。
