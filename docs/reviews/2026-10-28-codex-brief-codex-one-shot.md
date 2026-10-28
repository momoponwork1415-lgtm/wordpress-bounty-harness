# Codex への依頼文: 区画分配型を本番で回せるようにする（2026-10-28）

所有者が Codex に貼る文。詳細は Issue #647 と #646 にある。背景: 所有者決定（2026-10-28 夜）で、設計の問答の決定 9「段階 1〜3 は Claude だけ」を撤回し、Codex でも動かす。Claude の token が無く、`prod-part` は Trial 0 件のまま止まっている。また、列挙の道具の行数が区画の上限を超えることが実測で分かった（#647）。

## 共通の前置き（セッションの先頭に 1 回）

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。先に読む: AGENTS.md、docs/DEVELOPMENT.md 第 5 節、docs/FACTORY.md 第 4 節、docs/adr/0042。
origin/main から 1 Issue 1 branch（codex/issue-647-tool-rows、codex/issue-646-codex-one-shot）。1 Issue 1 PR。pnpm check と pnpm build を通す。
触らない: SPEC §2、prompt と skill の本文（prompts/agents/*.md、objective-partition-v1.md を含む）、policy/、programme-impacts.ts、台帳の既存 event 型、~/.local/state、docker、Trial の起動、merge、close、ラベル。docs/adr/0042 への追記（#647 は追記 4、#646 は追記 3）だけは各 Issue の受入条件のとおり書く。
open PR が 3 本を超えたら新しい PR を出さず、branch を push して Issue に comment。
```

## タスク 1（先に）

```text
Issue #647 を解く。対象 file: src/profiles/wordpress/discovery/tools/enumerate-sinks-v1.sh（v2 を足す）、src/profiles/wordpress/discovery/tools.ts（tool id）、src/cli/wordpress-session.ts（enumerator.tools と partition の既定値）、examples/campaign-partitioned.json、docs/adr/0042（追記 4）。
受入条件は #647 の 2026-10-28 夜の comment の 1〜5。先に失敗する受入試験 1 つ（output 行の畳み込み）、次に最小実装。
数字（12 plugin の畳んだ後の行数、収まる対象の数）は Codex が PR 本文に貼る。対象のコードは実行しない（grep だけ）。
触らない: 役の Markdown（受入 5）。
PR 本文は 5 項目。
```

## タスク 2

```text
Issue #646 を解く。対象 file: src/discovery/claude-one-shot-runtime.ts（写す元）、src/discovery/codex-gvisor-sandbox.ts（/workspace/input・tools・output の mount）、src/discovery/codex-native-agent-runtime.ts（codexArgs、features.multi_agent=false）、src/cli/wordpress-session.ts（役の schema、runtime の literal）、src/cli/wordpress.ts（821 行付近の guard）、src/cli/wordpress-host.ts（851 行付近の配線）。
受入条件は Issue 本文の 1〜10。先に失敗する受入試験 1 つ（受入 8: Codex sandbox の fake で 列挙役 → 差し戻し 1 回 → 追跡役 2 区画 が Claude と同じ台帳 event の列を出す）、次に最小実装。
触らない: 役の Markdown と目的文（受入 7）。変えたくなったら止まって Issue に理由を書く。
PR 本文は 5 項目。この PR では起動しない。
```

タスク 1 と 2 は同じ file（`wordpress-session.ts`）を触るので並行しない。

## 受け渡し

- PR の merge は委任済みの AI が行う（DEVELOPMENT 第 5 節）。
- 両方の merge 後、Codex が本番の `prod` ランナーの設定を区画分配型に切り替える（所有者決定 2026-10-28 夜: 実験ではなく本番の主経路。#629 の comment）。`discovery.mode: partitioned`、列挙役・追跡役とも runtime `codex`、`tracer.maxParallel` は 4 から始め、最初の 10 Trial で `provider-limited` の追跡役が 0 なら 8 に上げる。v14-wide は別ランナーで `maxConcurrentTargets` 1 の比較の腕として残し、Codex の合計同時数を 5 前後に保つ。
- 最初の 20 対象分の funnel（群、段 1b 通過、時間、token、script の行と agent の行の使用率）を #633 に貼る。v14-wide を消すかは、その数字で委任済みの AI が決める。
