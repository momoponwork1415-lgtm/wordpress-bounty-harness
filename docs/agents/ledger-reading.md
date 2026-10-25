# 台帳の読み方（AI 向け）

台帳は `<state>/ledger.sqlite` の表 1 つ `ledger_events`。正本は [SPEC](../SPEC.md) §9、event の型は `src/ledger/index.ts`。図は [SYSTEM-DIAGRAMS](../SYSTEM-DIAGRAMS.md) 3.2〜3.4。

## まず CLI

```bash
node dist/cli/main.js --state <state> --host <host.json> ledger funnel --campaign <id>    # 段ごとの件数と分類別
node dist/cli/main.js --state <state> --host <host.json> ledger runtime --campaign <id>   # model / CLI / catalog / run 数
node dist/cli/main.js --state <state> --host <host.json> ledger usage --campaign <id>     # UTC 日別の token
node dist/cli/main.js --state <state> --host <host.json> review parked --campaign <id>    # Programme 外で止めた Finding
```

`--host` が無いと「A host configuration is required」で止まる。

## reason まで見たいとき

ホストに `sqlite3` が無いことが多い。Node 22 の `node:sqlite` で読む。

```js
// dump-events.cjs  使い方: D=<state の親> node --no-warnings dump-events.cjs <case>=<campaignId> ...
const { DatabaseSync } = require("node:sqlite");
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o ?? {})) { const key = p ? `${p}.${k}` : k; v && typeof v === "object" && !Array.isArray(v) ? flat(v, key, out) : (out[key] = v); } return out; };
const KEEP = /reason|status|stage|wall|providerLimit|impact|kind|role|tokens|occurredAt|nextStep|scenario/i;
const SKIP = /digest|Digest|identity|campaignId|snapshot|Id$/;
for (const [c, id] of process.argv.slice(2).map((s) => s.split("="))) {
  const db = new DatabaseSync(`${process.env.D}/${c}/state/ledger.sqlite`, { readOnly: true });
  const rows = db.prepare("select sequence, event_type, finding_id, event_json from ledger_events where campaign_id = ? order by sequence").all(id);
  console.log(`##### ${c} ${id} events=${rows.length}`);
  for (const r of rows) {
    const f = flat(JSON.parse(r.event_json)); const pick = {};
    for (const [k, v] of Object.entries(f)) if (KEEP.test(k) && !SKIP.test(k) && v != null) pick[k] = v;
    console.log(r.sequence, r.event_type, r.finding_id ? r.finding_id.slice(7, 15) : "-", JSON.stringify(pick));
  }
}
```

`readOnly: true` で開く。書かない。

## 読み方の要点

- 1 campaign の流れ: `target-selected` → `snapshot-frozen` → `lab-provisioned` → `discovery-run-started`（explore 1 + child 3）→ `candidate-normalized` → `finding-recorded` / `finding-parked` / `lead-recorded` → `discovery-run-finished` → `discovery-concluded` → `verifier-run-finished` → `verification-finished`。
- 失敗の場所: `lab-provisioned.status failed`（failureStage, reason）、`discovery-run-finished.reason`（provider / schema / sandbox / policy / evidence、`reasonDetail` に `provider-cyber-policy` や `timed-out`）、`target-skipped.reason`（stage freeze / discovery / verification）、`verification-finished.result.reason`（incomplete の 10 種）。
- 時刻: `occurredAt` はホストの時計。ずれていることがあるので、長さは `wallTimeMs` で読む。#212 が直るまで、同じ run の started と finished は同じ `occurredAt` を持つ。
- 「Trial に数えない run」は `discovery-run-finished.observed`（filesRead、childThreadsObserved、brokerMetrics.forwardedRequests）で判る。
- `incomplete` は陰性ではない。件数を「候補 0 件」に混ぜない。

## Trial の時系列を出す

Root の委任 → 子の調査 → 報告 → Root の次の判断を、1 Trial ずつ時系列にする読取器。台帳と Private Evidence と transcript を読むだけで、何も書かない（`scripts/trial-timeline.mjs`、Node 22 の `node:sqlite` を `readOnly` で開く）。

```bash
node scripts/trial-timeline.mjs --state <state> --campaign <id>                      # campaign の Trial 一覧
node scripts/trial-timeline.mjs --state <state> --campaign <id> --trial <trialId>    # 1 Trial の時系列（--run <runId> でも指せる）
node scripts/trial-timeline.mjs --state <state> --campaign <id> --trial <trialId> --json
```

`--work <dir>` は transcript の置き場（既定 `~/.local/share/wordpress-bounty-harness/work`、中の `provider-attachments/`）。無くても台帳と receipt の列は出る。

- 出すもの: Root の開始と終了、子の委任（時刻、委任文の sha256 と文字数）、子の終了（wall、`observed` の toolCalls / filesRead / uniqueFilesRead）、子ごとの Finding / parked / Lead の件数、子の報告が Root に渡った時刻とその後の Root の最初の行動、Root の最初の最終報告の時刻、同一スレッドへの追依頼の回数、再開区間（segment）、終了理由。
- 出さないもの: 委任文・報告・候補の本文、payload、file の中身。digest、件数、時刻だけ（不変条件 8）。ラベルは、短い識別子だけをそのまま、それ以外は digest にして出す。
- 出どころ: 時刻は receipt の `startedAt` / `completedAt` と transcript の `timestamp` から取る。台帳の `occurredAt` は使わない（#212）。Claude は Root の session transcript（`Agent` の `tool_use`、`queue-operation` の task-notification、`StructuredOutput` が最終報告）。Codex は Root の rollout（`spawn_agent`、`followup_task`、`SubAgentActivity`、`phase: final_answer`）と子の rollout。session transcript が無い receipt は run の stream で代える（時刻が近似になる）。
- Codex の委任文は暗号化されていて、委任文の digest は `unavailable`。`task_name` と暗号文の長さだけ出す。
- 読み方の注意: 出力末尾の「Not derivable today」に、その Trial で取れなかったものを列挙する。取れなかったものを 0 と読まない。

## 開かないもの

`<state>/private-evidence/` の `content/` 以下（候補本文、HTTP 記録、payload、画面、認証情報）。台帳の分類・reason・digest と、`manifest.json` の一覧だけで足りる。Issue や PR に貼るのも分類と件数だけ。

## 既知のずれ

- SPEC §7 の funnel 文には `reproduced` と `parked` の段が無い（コード側にはある）。
- review queue の「再試行を使い切った」判定は `provider` を即時に使い切り扱いにし、pipeline は 1 回再試行する（`src/review/index.ts` と `src/cli/pipeline.ts`）。
