# `## Prior research` 節の continuation の 1 文、日本語訳、出典対照表（2026-11-06）

Harness が生成する `## Prior research` 節（ADR 0019 の型、ADR 0048）に、continuation の Trial のときだけ末尾に 1 文を足す（ADR 0052）。雛形は `src/discovery/prior-research.ts` の `CONTINUATION_SECTION_SENTENCE` と `priorResearchSection` にある。agent に渡る文章なので `owner-approved` を要する。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。

## 問い

「Root が `continuation.json` に残した未解決経路があるとき、同じ Snapshot の次の Trial を自動で組み（最大 3 回）、その経路を次の Trial の最初の作業として渡せるか」。背景は docs/reviews/2026-11-06-continuation-what-failed-and-how-to-implement.md の §3（R5: 前の Trial の経路を読む義務が無い）。

## 足す 1 文（英語）

> The open routes in `/workspace/research/prior/continuation.json` are this Trial's first work: check each against the pinned source, record in your research notes whether it is resolved, disproved or stopped by privilege, and only then move to new approach families.

置き場所は、節の file の行（と、あれば「Withheld for size」の行）の後の、独立の段落である。2026-11-01 の段落と file の行の形は変えない。`continuation.json` の行は、2026-11-02 追記の形（`- /workspace/research/prior/continuation.json ({bytes} bytes).`）で並ぶ。continuation でない Trial の節は従来と byte 単位で同じで、過去の Trial の節の digest と照合できる。

## 日本語訳

> `/workspace/research/prior/continuation.json` の open routes は、この Trial の最初の作業である。各 route を固定 source で確かめ、それが解消したか、否定されたか、権限で止まったかを研究メモに記録し、その後で初めて新しい approach family に進む。

## 出典対照表

| 文の要素 | 出典 |
| --- | --- |
| `/workspace/research/prior/continuation.json` | ADR 0052 決定（`PRIOR_RESEARCH_FILE_NAMES` に `continuation.json` を足し、`prior/` に置く）。file の形は目的文 v26 の `continuation.json` 段落 |
| open routes | 目的文 v26 の `continuation.json` 段落「a machine-readable index of concrete open routes」 |
| この Trial の最初の作業 | 背景文書 §3.4「`prior/continuation.json` の open routes は、この Trial の最初の作業である」。ADR 0048 が「数字を見てから」と先送りした 1 文 |
| 固定 source で確かめる | 背景文書 §3.4「各 route を現行のソースで確かめ直し」。節の 2026-11-01 段落の「pinned source」と同じ語 |
| 解消・否定・権限停止 | 背景文書 §3.4「解消・否定・権限停止のどれかを」。目的文 v26 の「Remove resolved or disproved routes from the array」 |
| 研究メモに記録 | 目的文 v26 の「keep their reasoning in the research notes」。背景文書 §3.4 の `closedRoutes` は contract v1 に無いので、書き先は研究メモにした（ADR 0052 採らなかった選択肢） |
| 新しい approach family に進む | 背景文書 §3.4「新しい family に進む」。「approach families」は目的文 v26 の語 |

## 書かなかったもの

- 経路の中身、どの経路から読むか。Harness は経路の文を読まない（ADR 0052、所有者 2026-10-27「中身は AI、形は Harness」）。
- 既発見の群鍵（known-findings）。台帳の `group.keys` は digest で、agent が読める名前ではない。
- `closedRoutes` と `needs`。contract v1 に無い項目で、目的文の改訂（v27）を要する。この PR では目的文を変えない。

## 気付き（所有者の確認用）

2026-11-01 の段落は版をまたぐ引き継ぎの文で、continuation の Trial では元の版と読む版が同じになる（「An earlier Trial on version 3.4.0 … This Trial reads version 3.4.0. The files describe the earlier version, not this one」）。依頼は「既存の段落と file の行をそのまま使い」なので段落は変えていない。同じ版のときに段落を言い換えるかは、別の owner-approved の問いとして残す。
