# Codex への依頼: 区画分配型の探索（partitioned）を Claude runtime で本番に入れる

前提: PR #634（形）、#635（本体の固定一覧）、#636（runtime）、#638（並列の上限 8）が main にマージ済みであること。所有者が Windows 側で `.wslconfig` の `memory=56GB` を書いて `wsl --shutdown` を済ませていること（再起動でランナーは全部止まるので、その後に起こし直す）。`free -g` で total が 54 以上であることを確認してから始める（2026-10-28 02:20 に反映済み: total 54 GiB、docker から見える memory 56,236 MiB）。設計は `docs/reviews/2026-10-28-adopted-design-for-approval.md`（§6 に決定 15 点）、ADR 0042。Issue は #633（測定）。

## やること

1. `/home/dev/worktree/prod26`（いまの本番 checkout）を main の先頭に更新して build する（手順はいつもの restart script と同じ）。
2. 新しい campaign 設定を作る: `~/.config/wordpress-bounty-harness/campaign-production-claude-partitioned-20261028.json`。元は `campaign-production-claude-wide-3-20261026.json` を複製し、次だけ変える。
   - `discovery.mode`: `"partitioned"`
   - `discovery.maxChildren`: 削除（partitioned では使わない。残すと schema で拒まれる場合は削除）
   - `discovery.enumerator`: `{ "runtime": "claude", "wallMinutes": 20, "tools": ["enumerate-hooks-v1", "enumerate-sinks-v1", "core-fixed-list-v1"], "rowSource": "agent" }`
   - 形の見本は repo の `examples/campaign-partitioned.json`。`enumerator` と `tracer` の `model` / `effort` は書かない（書くなら両方同じ値）
   - `discovery.partition`: `{ "maxEntriesPerPartition": 60, "maxPartitions": 8, "maxResubmits": 2 }`
   - `discovery.tracer`: `{ "runtime": "claude", "wallMinutes": 45, "maxParallel": 8 }`
   - `promptId`: `"objective-partition-v1"`（`promptVariant` は書かない）
   - `resources`: `{ "maxConcurrentRuns": 1, "maxConcurrentTargets": 1, "memoryBudgetMiB": 36864, "maxConcurrentTargetsByRuntime": { "codex": 0, "claude": 1 } }`
     理由: 1 対象ずつ、追跡役 8 体（(4,096 + 512) MiB × 8 = 36,864 MiB）。Ubuntu 56 GB のうち、Codex の v14-wide 1 本（10,752 MiB）と Lab と OS の余裕を引いた分。
   - `enumerator.model` / `tracer.model` は書かない（host の profile `claude-opus-5-5` / high がそのまま使われる。段階 1 は 2 役とも同じ model）。
3. 選定は `selection-production-claude-wide-3-20261026.json` を複製して `selection-production-claude-partitioned-20261028.json` にする。中身は変えない（同じ帯・履歴・除外。比較の分母は台帳にある v14-wide の Trial なので、同じ対象が選ばれる方がよい）。
4. 設定の検査: `harness --host <host-production-v8-codex0164.json> --state <state-dir> runtime check --config <新しい campaign.json>` が通ること。
5. 起動: Codex の v14-wide のランナーは 1 本にする（`campaign-production-codex-wide-5-v17-20261027.json` の `maxConcurrentTargetsByRuntime.codex` を 1、`maxConcurrentTargets` を 1 にした複製 `campaign-production-codex-wide-1-20261028.json` で起こし直す。promptId は v14-wide のまま）。Claude の v16-wide のランナーは起動しない（所有者決定 2026-10-27: v14 に戻す。partitioned の比較中は Claude は partitioned だけ）。次を追加で起こす。
   ```
   continuous run --config "$C/campaign-production-claude-partitioned-20261028.json" --selection "$C/selection-production-claude-partitioned-20261028.json" --campaign-prefix prod-part --resume > "$S/continuous-20261028-claude-partitioned.out" 2>&1 < /dev/null &
   ```
6. 最初の 1 Trial が終わったら、次を Issue #633 のコメントに貼る。
   - `ledger funnel --campaign <prod-part-...>` の出力
   - `node scripts/trial-timeline.mjs --state <state-dir> --campaign <id>` の出力
   - `enumeration-recorded` の `scriptRan`、`scriptRowCount`、`agentRowCount`、`resubmits`、`partitionCount`
   - 区画ごとの追跡役の `discovery-run-finished` の outcome と reason
   funnel の `attempts:` の行に Trial 単位の未完（`schema/enumeration-rejected` など）が出る。`target-skip-diagnostic` に理由が残る。
   その後は 20 対象 × k=2 まで回す。止める条件: 列挙役の `enumeration-rejected` が 3 対象連続、または provider-limited が 1 時間に 3 回。止めたら Issue に書く。

## やらないこと

- Codex runtime に partitioned を入れない（Codex は一発の実行と子の上限を設定で縛れない）。
- 設定の数字を上の値から変えない。変えたいときは Issue #633 に理由を書いてから。
- dev set の Trial は回さない（本番が bench）。
