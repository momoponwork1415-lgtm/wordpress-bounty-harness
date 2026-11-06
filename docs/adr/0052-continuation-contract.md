---
status: accepted
date: 2026-11-06
amends: 0048（同じ Snapshot の Trial を「過去 Trial」に数えない規則の例外）、0049 追記 7（同一 Snapshot の再探索を別の契約として設計する）、0051 追記（同一 Snapshot の条件付き 2・3 回目と 4 回目以降の手動起動）
---

# 同じ Snapshot の未解決経路を次の Trial に渡す continuation 契約

## 背景

目的文 v26-wide は、Root に `/workspace/research/continuation.json` を書かせる。中身は「具体的な open route」の機械可読な索引で、形は `{ "schemaVersion": 1, "openRoutes": [{ id, sourceFile, sourceLine, observation, unresolved, nextCheck }] }` である。Harness は研究 directory を封じて Private Evidence に置くが、この file を読む者は誰もいなかった。再開（ADR 0036）で同じ Trial に戻るだけで、次の Trial には渡らず、`priorResearch: same-target`（ADR 0048）の渡す file の集合にも入っていなかった。

同一 Snapshot の再探索は 2 度試みて削除した。名指しの第 2 Trial（ADR 0044）と、Lead の件数でランナーが組む第 2 Trial（ADR 0049 決定 C）である。後者は Lead の生の件数を条件にしたため、雑音の Lead と未解決の経路を区別できなかった。所有者の望む規則（ADR 0051 追記）は「未解決経路があるときだけ 2・3 回目を自動で行い、4 回目以降は手動で起動する」で、受け渡し契約が無いことが残っていた。経緯と、公開されている他の harness の型は docs/reviews/2026-11-06-continuation-what-failed-and-how-to-implement.md にある。所有者は 2026-11-06 に「LESSONS 追記 PR と continuation 契約の実装を進めて」と決めた。

## 決定

- **件数の出所を替える。** 続きを組む条件は、Lead 全件ではなく、Root 自身が `continuation.json` に未解決と宣言した経路の件数にする。宣言は Root の自己申告だが、停止条件ではなく続行条件なので、「満たしたと書いて閉じる」誘因が働かない。空配列を書けば終わるだけである。
- **Harness が読むのは形と件数と id の digest だけ。** 研究 directory を封じた後、Harness は archive の entry `continuation.json` を strict な schema（`schemaVersion: 1`、`openRoutes[]` の各項目は `id` 1〜128 文字、`sourceFile` は `/` と `..` で始まらない相対 path、`sourceLine` は正の整数、`observation` / `unresolved` / `nextCheck` は文字列）に通す。結果を `discovery-run-finished.continuation` に `{ status: "valid" | "invalid" | "absent" }` で記録し、valid なら `openRouteCount` と各 id の sha256（`openRouteIdDigests`、先頭 64 件まで、超えたら `truncated: true`）を足す。`observation` / `unresolved` / `nextCheck` の文は読まず、記録せず、判定に使わない。id の生文字列も台帳に入れない。検査は `executeTrial` の 1 か所で行い、Codex と Claude の両 runtime の archive が同じ検査を通る。旧来の `continuation`（`mode: thread-resume` の受領記録）は同じ項目の別の形として読み続ける。
- **設定。** campaign 設定の `discovery.continuation: "open-routes" | "none"`。既定は `none`。リポジトリの wide 方針（`src/profiles/wordpress/policy/campaign.json`）は `open-routes`。本番ランナーの Git 外の設定は、このリポジトリの既定を変えるだけでは切り替わらない。
- **ランナーの規則。** 連続ランナーは新しい対象を選ぶ前に、その campaign prefix の最新の選定 campaign と、そこから `continuation-scheduled` で連なる continuation campaign を 1 つの連鎖として見る。Snapshot ごとに連鎖の最新の Root Trial を取り、次の条件を全部満たせば、その Snapshot の次の Trial を 1 つ組む。
  - Root の最新区間の `discovery-run-finished` が `continuation.status == "valid"` かつ `openRouteCount > 0`。outcome が `provider-limited` でなく、reason が `interrupted` でない（`completed` と、wall や schema で終わった封じ済みの報告を含む）。
  - その Snapshot で連鎖の中に数えた Trial（`countsAsTrialChain`）が 3 未満。
  - 進捗の規則: 2 回目以降の Trial は、受け取った id digest の集合（`configuration.continuation.passedIdDigests`）が今回の `openRouteIdDigests` の部分集合なら、続きを組まず `target-skipped`（stage `discovery`、reason `continuation-refused`、reasonDetail `no-progress`）をその Trial の campaign に 1 件記録する。集合演算だけで、文は読まない。
  - 同じ (snapshotDigest, ofRunId) に `continuation-scheduled` が無い。
- **組み方。** continuation campaign の id はランナーの番号（`<prefix>-<YYYYMMDD>-<n>`）を使う。解決の前に `continuation-scheduled { ofRunId, ofCampaignId, ordinal, openRouteCount, manual? }` を Snapshot ごとに 1 件書く。拒否されても失敗しても同じ Snapshot をもう一度組まないための印である。continuation campaign は選定 batch を束ねず、選定 pool を探らず、`holding-refusals` / `no-progress` の停止規則に数えない。同時数は通常の上限と live の上書きに従う。continuation campaign の後は通常の選定に戻る。ランナーが止まったときは memo に targets を残し、再起動で同じ campaign を続ける。
- **渡すもの。** `PRIOR_RESEARCH_FILE_NAMES` に `continuation.json` を足す（`same-target` の渡し方でも渡る）。continuation の Trial では、`resolveWordPressPriorResearch` の名指しの入口（`continuationOf`）で、続ける run の archive を同じ Snapshot から `/workspace/research/prior/` に置く。`stores.json` の導出、総量の上限、不変条件 1 の判定は既存のまま。`discovery.priorResearch` が `none` でも continuation の Trial には渡す。渡す file に `continuation.json` が入らなければ（無い、64 KiB 超、総量で外れた）`continuation-refused`（`continuation-file-unavailable`）で止める。既発見の群鍵（known-findings）は渡さない。台帳の `group.keys` は digest で、agent が読める名前ではない。
- **台帳。** 次の Trial の `discovery-run-started.configuration.continuation = { of, ordinal, openRouteCount, passedIdDigests }`。`of` は続けた Root run の最新区間の runId である。再開区間（ADR 0036）にも写し、`priorResearch` も写す。再開は記録した `priorResearch` から節を作り直し、continuation の記録があれば末尾の 1 文も足して digest を照合する。`continuation.json` が渡す集合に入る前に始まった `same-target` の Trial は、記録した file の名前に無い `continuation.json` を外して節を作り直す。
- **生成節の 1 文。** `## Prior research` 節の段落と file の行はそのまま使い、continuation の Trial のときだけ末尾に 1 文を足す。全文、訳、出典対照は docs/reviews/2026-11-06-continuation-section.md にあり、`owner-approved` を要する。目的文 v26 の本文は変えない。
- **名指し（4 回目以降）。** `campaign continue --campaign <新しい id> --run <runId> --config <path>`。名指しの run の Trial の最新区間について、valid かつ `openRouteCount > 0` だけを見る。3 回の上限と進捗の規則は適用せず、`continuation-scheduled { manual: true }` を書いて 1 Trial を組む。ランナーとの競合は `campaign resume` と同じ扱い（discovery sweep の保持）である。

## 理由

ADR 0049 決定 C の失敗は「件数だけを見たこと」ではなく「件数の出所が Lead 全件だったこと」にある。出所を Root の宣言に替えれば、Harness は形と件数だけを読む制御のままでよい（AGENTS.md「Harness は制御だけ」、所有者 2026-10-27「中身は AI、形は Harness」）。上限 3 回と名指しの 4 回目は所有者の規則そのものである。進捗の規則は RAPTOR の `must_progress` と同じ型で、渡した経路が 1 つも消えなければ 3 回目を待たずに止める。判定は id の集合演算だけで、経路の文の解釈は入らない。

## 採らなかった選択肢

- 背景文書 §3.2 の continuation v2（`needs`、`closedRoutes`、Harness が付ける `attempts`）: 目的文の改訂（v27）を要する。この契約は v26 が既に書く v1 の形だけで動かし、v2 は数字を見てから別の問いにする。
- 既発見の群鍵を `prior/known-findings.json` として渡す: 台帳の群鍵は digest で、agent が読める名前を Harness が作るには Finding の本文を読む必要がある。
- `observation` / `unresolved` の文から経路を選ぶ: Harness が判定器になる（不変条件 3、AGENTS.md の「移す合図」）。
- 選定 batch より前の campaign の Trial も候補にする: 有効にした時点の台帳にある数百の Trial を一斉に組み直し、新しい探索を止める（ADR 0049 追記 2 と同じ理由）。過去の Trial は `campaign continue` で名指しする。
- invalid の file で `target-skipped` を書く: 続かない理由は `discovery-run-finished.continuation.status` に既にあるので、別の記録を足さない。

## 計測

本番 2 週。分母は Codex 時間（ADR 0045）。数え方は [measurement.md](../agents/measurement.md) 5e にある。比べるのは 2 つである。

- 2・3 回目の Trial で、同じ Snapshot の 1 回目に無い群の Finding 数 / Codex 時間。対は偶然の pass@5（同じ 10 対象 × 5 回、盲目の反復）の b2〜b5。
- 渡した id の解消率: 前の Trial の `passedIdDigests` のうち今回の `openRouteIdDigests` に無いものの割合。対は leads2（Lead 133 群 → Finding 3）の転換率。

1 回目で `openRouteCount = 0` の Root は続きを組まないので分母から外れる。n は 2 週で 20 対象程度で、±2 を分けられない（ADR 0043 追記 8）。採否は「盲目の反復より明らかに悪くないか」で見る。

## 消し方

`discovery.continuation`、`src/discovery/continuation.ts` と `executeTrial` の検査、`continuation-scheduled`、`configuration.continuation`、`discovery-run-finished.continuation` の新しい形、ランナーの `pendingContinuations` と continuation campaign の分岐、`src/cli/wordpress-continuation.ts`、`resolveWordPressPriorResearch` の `continuationOf`、`PRIOR_RESEARCH_FILE_NAMES` の `continuation.json`、節の 1 文、`campaign continue` を revert する。台帳の記録（`continuation-scheduled`、`configuration.continuation`、`discovery-run-finished.continuation`、`target-skipped` の `continuation-refused`）は読み続ける（任意項目と schema の形を残す）。SPEC 第 6 節、AGENTS.md、DEVELOPMENT.md 第 2 節の該当行を「同一 Snapshot の第 2 Trial は行わない」に戻す。
