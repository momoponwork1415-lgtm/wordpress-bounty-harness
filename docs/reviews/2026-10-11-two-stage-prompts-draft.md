# 2026-10-11 二段構え探索の prompt 下書き

設計レビュー（同日）で合意した「広さ優先の二段構え」「継続境界は Harness が持つ」「contributor 以上は対象外」に合わせた目的 prompt の下書き。正本ではない。採用するときは `src/profiles/wordpress/prompts/` に新 ID で置き、digest pin を付け、旧版を残す（ADR 0013）。出力契約は Harness が schema から生成して付ける（ADR 0019）ので本文に書かない。

Harness が本文の後に付ける節: 出力契約、Trust boundary、Programme Boundary、Lab（endpoint、低権限 account、RO DB）、Entry points（入口索引、#123）、二段目のみ Unresolved questions（一段目の Finding / Lead / unexamined）。

## 1. `screening-v1`（一段目、単独 agent、壁時計 30 分）

```markdown
# WordPress discovery: screening v1

Inspect the pinned source of the assigned plugin and its disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment with default settings. Contributor and higher roles, and any permission an administrator grants deliberately, are trusted. A vulnerability is not assumed. Zero Findings is a valid result.

Priorities, in order: `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `arbitrary-file-delete` / `arbitrary-file-download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `stored-xss`; `sensitive-object-access`. Record other concrete effects without promoting them.

This run is about coverage, not depth. Start from the entry-point index supplied below: every externally reachable handler the plugin registers. For each entry, read the handler and what it reaches, and classify it as trusted (state why), reachable but safe (state why), or candidate (state what fails). Go through the whole index before going deep on any single candidate. When the index is exhausted, continue with public-facing code the index does not list: template output, front-end forms, scheduled tasks, activation and uninstall paths.

A Finding needs a complete chain with a source location for each edge: the input the attacker controls, the check that is missing or does not bind, the operation it reaches, and the effect. Use the Lab to confirm that the entry is reachable and what the response looks like; write down only what you observed, and write `none` if you observed nothing. If one edge is unsupported, record a Lead with the exact gap instead of a Finding. Do not turn a partial route into a Finding to fill the report.

Only the Harness judge issues `runtime-confirmed`. You do not have to demonstrate impact; state precisely what the judge should expect to observe and under which role and configuration.

Report `examined` and `unexamined` so that a later run can continue where you stopped. Stop when the index and the public-facing code are covered or the run limit is reached. Do not stop because one strong candidate exists.
```

## 2. `deep-dive-v1`（二段目、Root＋3、壁時計 90 分）

```markdown
# WordPress discovery: deep dive v1

Investigate the pinned source and disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment with default settings. Contributor and higher roles, and any permission an administrator grants deliberately, are trusted. A vulnerability is not assumed. Zero Findings is a valid result.

Priorities are the same as the screening run: `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `arbitrary-file-delete` / `arbitrary-file-download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `stored-xss`; `sensitive-object-access`.

You receive the entry-point index and the unresolved questions of an earlier screening run: its Findings, Leads, and `unexamined` entries. They are starting points, not answers. Treat each as a hypothesis to confirm or refute from the source, and look for what the screening run did not reach.

As Root, decide the division of work from the source and the unresolved questions, and start three subagents with genuinely different source-grounded questions. Give them regions of code, data flows, or state transitions and the question to settle; do not give them vulnerability types or the route you currently favor. Keep a registry of approach families with their source evidence, contrary evidence, blocked routes, and open questions. When children converge on one family, redirect the next wave to a family nobody is on.

For each candidate chain, test every edge: who controls the input, which check applies and whether it binds for the attacker position, what transformations happen in between, where the value is stored or consumed later, whether the default configuration reaches that point, and what the Lab actually returns. A chain with one unsupported edge is a Lead, not a Finding. The strongest surviving Lead with its exact gap is a valid result.

Write only observed Lab behaviour in `labObservations`, and `none` if you observed nothing. Only the Harness judge issues `runtime-confirmed`.

The Harness decides when the Trial ends. If coverage is incomplete when you report, it will hand back the remaining entries and ask you to continue. Do not pad time, and do not stop early because one Finding exists.
```

## 3. 継続メッセージ（Harness が同じコンテナへ1回だけ差し込む）

```markdown
Your report is recorded. Coverage is incomplete: the entries below appear in neither `examined` nor `unexamined` with a reason, and {remainingMinutes} minutes remain. Continue with these entries and return the same report keys again. Do not repeat Findings or Leads already reported; refer to them by their `claim` or `summary`.

{entriesNotCovered}
```

条件: `unexamined` に入口索引上の入口が残り、壁時計が下限（30 分）未満のとき。再投入は1回まで。再投入の有無、理由、残り時間を台帳に残す。

## 4. 書かなかったもの、変えたもの

- 30 分下限と wave 数の指示を本文から外した。守らせる規則は Harness が持つ（継続メッセージと壁時計）。
- 出力契約を外した。既定 v4 と比較用 v2 に残っていた約 60% の手書き契約は Harness 生成に統一する。
- `labObservations` に「観測が無ければ `none`」を明記した。必須非空の項目を推測で埋める圧力を無くす（schema 側も `none` を許す変更が要る）。
- 脆弱性の種類ごとの探し方、特定の関数名・URL・画面名は書かない。一段目の順序は「索引を全部見てから深く」だけで、どこに何があるかは言わない。
- contributor 以上は trust boundary 雛形と同じ文で「対象外」を本文にも書いた。
- 「他の効果は記録するが昇格させない」で、`other` / `missing-authz` などを Finding にする圧力を下げた。到達先のない authz は Lead として出る。

## 5. 測り方（採用時の PR に貼る数字）

開発セット（TranslatePress 3.2.6 / 3.3.1 / 3.3.2）で各 3 Trial。一段目は「候補が出た対象の割合」「索引の何割を `examined` にしたか」「wall 中央値」。二段目は「一段目の Lead のうち確認か反証に至った数」「`runtime-confirmed`」「継続メッセージの発火回数」。旧 v4 / v2 の数字と同じ表で並べ、区間が重なれば判定不能と書く。

## 6. Verifier prompt

`verifier-v6` は据え置き。#118〜#120 の判定器修正で変わるのは Harness 側の証拠要求であり、Verifier への指示は「recorder 経由で送る」「観測した条件を自己申告でなく route に書く」の2点を足すだけでよい。別 PR。
