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

## 2026-11-06 追記: 名指しの続きに操作役の焦点メモを渡す（focus 経路）

**問い。** 操作役の AI が前回 Trial の Lead と未解決経路を読んで続きを名指しするとき、その Trial に「どこから始めるか」の短いメモを渡せるか。open route を残さなかった Root にも名指しで続きを組めるか。

**背景。** 台帳を数えると、prod-v26 の終了 Root 80 本のうち open route > 0 は 15 本だけで、Lead を出したのに open route 0 の Root が 48 本あった。自動の続きは Root の宣言だけで組むので、この 48 本には続きが無い。所有者は 2026-11-06 に「操作役 AI が Lead を読んで続きを名指しする手順（skill）が欲しい」と決めた。skill の本文（何を読み、何を書くか）は Harness の外にある。ここで決めるのは Harness 側の「形」だけである。

**決定。**

- **名指しの条件を緩める。** `campaign continue --run <runId>` は、名指しした Trial の最新区間の `discovery-run-finished` が `provider-limited` でなく、reason が `interrupted` でないこと（自動の条件と同じ除外）に加えて、`continuation.openRouteCount > 0` **または** `--focus <path>` があることを要る。両方無ければ `not-continuable`（open route も焦点メモも無い）で拒否する。`continuation` が `invalid` / `absent` のときは `openRouteCount` 0、`passedIdDigests` [] として扱う。3 回の上限と進捗の規則は、従来どおり名指しには当てない。
- **焦点メモ（operator focus）。** `--focus <path>` は操作役が書いた Markdown 1 本で、UTF-8、8 KiB 以下、空でない。超えたら UsageError で止め、切らない。Harness は内容を読まず、形（サイズ、UTF-8）だけを見る。本文は provider attachment store に content-addressed で置き（kind `focus`、`<work>/provider-attachments/focus-<hex>/content/focus.md`）、台帳には digest と byte 数だけを書く。`continuation-scheduled` に `focusDigest` と `focusBytes`（`manual: true` のときだけ現れる任意項目）、`discovery-run-started.configuration.continuation` に `focus: { digest, bytes }` を足し、再開区間（ADR 0036）にも写す。
- **渡し方。** 続きの Trial で `/workspace/research/prior/operator-focus.md` として置く。`PRIOR_RESEARCH_FILE_NAMES` に `operator-focus.md` を足し、順序は `continuation.json` の直後にする。archive 由来ではなく store 由来なので、`resolveWordPressPriorResearch` は名指しの focus digest があるときだけ store から読んで files に足す。Root が同じ名前の file を研究 directory に書いても、archive からは渡さない。`stores.json` の導出、総量の上限、再開時の再建と digest 照合は既存のまま通す。メモが store に無ければ `continuation-refused`（`continuation-focus-unavailable`）で止める。open route が 0 の名指しは `continuation.json` を要らず、焦点メモだけで組む。自動の続き（ランナーが組むもの）に focus は無い。
- **生成節の 1 文。** `## Prior research` 節の末尾、`CONTINUATION_SECTION_SENTENCE` の後に、focus があるときだけ `FOCUS_SECTION_SENTENCE` を足す。全文、訳、出典対照は docs/reviews/2026-11-06-focus-section.md にあり、`owner-approved` を要する。目的文 v26 の本文は変えない。open route が 0 で focus だけのときも continuation の 1 文はそのまま出す（`continuation.json` の open route が空であることは Root が見れば分かる）。
- **操作役が読む一覧。** `review leads --campaign <id>` の各行の末尾に Root Trial の `runId`（`trialId`）を足す。新規 `campaign trials --campaign <id> | --prefix <campaignPrefix>`（readOnly）は Root Trial ごとに 1 行で、`runId`、選定 id（`targetId@version`）、campaign、`ordinal`、続きなら元 `runId`、最新区間の outcome / reason（終わっていなければ `running`）、`continuation.status` と `openRouteCount`、その Trial の Finding が属する群の数、Lead 数、封じた研究 archive の digest（`discovery-run-finished.researchArtifact.digest`。無ければ `-`）を出す。台帳の形と件数だけで、文は出さない。

**不変条件 1 との関係。** 不変条件 1 の例外（SPEC 第 2 節）は「Finding と Lead は渡さない」と言う。焦点メモは、操作役が自分たちの Trial の Lead と研究 file を読んで書くメモであり、Lead の写しではない。公開記録の本文、PoC、ペイロード、他人の再現手順を含めてはならない。この規則は skill の側にあり、Harness は形だけを見る。

**削除済みの ADR 0044（`priorLeads`）との違い。** ADR 0044 は過去 Trial の Lead を全件、機械で `## Prior leads` 節に写した。Harness が Lead を選ばず、agent は雑音の Lead と未解決の経路を区別できなかった。focus 経路では、操作役が Lead と研究 file を読んで続ける経路を選び、短いメモに書く。渡るのはそのメモ 1 本（8 KiB 以下）だけで、Lead の本文は渡らない。読む側の規則（何を書くか、何を書かないか）は skill にあり、Harness は形（サイズ、UTF-8、digest）だけを見る。

**計測。** 名指し（focus あり）の続きと自動の続きは別の列で数える（measurement.md 5e）。focus の有無は `continuation-scheduled.focusDigest` と `configuration.continuation.focus` で見分ける。

**消し方。** `--focus`、`operator-focus.md`（`PRIOR_RESEARCH_FILE_NAMES` と台帳の名前の pattern）、`FOCUS_SECTION_SENTENCE`、attachment の kind `focus`、`continuation-scheduled` の `focusDigest` / `focusBytes`、`configuration.continuation.focus`、名指し条件の緩和（`sealedFinish` だけで通す分岐と `openRouteCount` 0 の許容）、`campaign trials`、`review leads` の `trial` 列を revert する。台帳の記録は読み続ける（任意項目と schema の形を残す）。
