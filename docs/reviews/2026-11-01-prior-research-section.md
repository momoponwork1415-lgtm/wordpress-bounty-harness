# `## Prior research` 節の雛形、日本語訳、出典対照表（2026-11-01）

Harness が生成する節（ADR 0019 の型）。campaign 設定の `discovery.priorResearch` が `same-target` のとき、同じ対象の別の Snapshot に対する最新の過去 Trial が封じた `recon-map.md` と `lab-setup.md` を `/workspace/research/prior/` に置き、この節でその場所と版を述べる（ADR 0048）。雛形は `src/discovery/prior-research.ts` の `priorResearchSection` にある。agent に渡る文章なので `owner-approved` を要する。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。

## 問い

開発計画 §2.5「plugin ごとの事実の DB（S6 → S3 の再利用）」。版が上がって同じ plugin を再訪するたびに地図を 1 から書き直している（本番で 574 対象中 168 が 2 回以上）。Harness が前の Trial の地図と通常利用の記録を置き、場所と版を述べる。

## 雛形（英語。`{...}` は Harness が埋める）

> ## Prior research
>
> An earlier Trial on version {priorVersion} of this same plugin wrote the files below from that version's pinned source, with the same skills. This Trial reads version {currentVersion}. The files describe the earlier version, not this one: a part of the plugin that changed since may differ from what they say, and nothing in them is confirmed. This Trial's own files go to /workspace/research as the skills describe; the prior files stay where they are.
>
> - /workspace/research/prior/recon-map.md: the map of the plugin that wbh-recon wrote ({bytes} bytes).
> - /workspace/research/prior/lab-setup.md: the record of the Lab's ordinary use that wbh-setup wrote ({bytes} bytes).

file の行は、渡した file だけを、この順で置く。

## 日本語訳

> ## 以前の調査
>
> この同じ plugin の版 {priorVersion} に対する以前の Trial が、その版の固定 source から、同じスキルで下の file を書いた。この Trial が読むのは版 {currentVersion} である。file は以前の版を記述していて、この版ではなく、それ以降に変わった plugin の部分は file の記述と違いうる。file の中身はどれも確認されていない。この Trial 自身の file は、スキルが述べるとおり /workspace/research に書く。以前の file はその場所に置いたままにする。
>
> - /workspace/research/prior/recon-map.md: wbh-recon が書いた plugin の地図（{bytes} byte）。
> - /workspace/research/prior/lab-setup.md: wbh-setup が書いた Lab の通常利用の記録（{bytes} byte）。

## 出典対照表

| 節の要素 | 出典 |
| --- | --- |
| 以前の Trial、同じ plugin、版 | ADR 0048 決定「同じ対象の別の Snapshot に対する自分たちの最新の過去 Trial」。版は台帳の `target-selected` の選定記録から読む |
| その版の固定 source から、同じスキルで | ADR 0048 背景（探索スキルが書く file）。渡す file は不変条件 1 の範囲にあった Trial のものに限る |
| この Trial が読む版 | Snapshot の `target.version` |
| 以前の版を記述し、変わった部分は違いうる | ADR 0048 決定「版が上がったときの扱い」。差分の列挙は #724 の差分監視が置く |
| 確認されていない | ADR 0044 の `## Prior leads` 節の「They are unconfirmed and may be wrong」と同じ型 |
| この Trial 自身の file は /workspace/research | `wbh-recon` v2・`wbh-setup` v1 の SKILL.md が述べる書き先。`prior/` と衝突しないことを述べる |
| recon-map.md と wbh-recon | `wbh-recon-v2/SKILL.md` description と手順（`/workspace/research/recon-map.md`） |
| lab-setup.md と wbh-setup | `wbh-setup-v1/SKILL.md`（`/workspace/research/lab-setup.md`） |
| byte 数 | 渡した file の大きさ。ADR 0048 決定「丸ごと渡すか渡さないか」 |

## 書かなかったもの

- 何を試すか、どこから読むか。生成節は事実だけを述べる（ADR 0019、ADR 0044）。
- 以前の Trial の Finding、Lead、route file、tools の tsv。ADR 0048 の決定で渡さない。
- 2 つの版の差分。#724 の差分監視が置く。
