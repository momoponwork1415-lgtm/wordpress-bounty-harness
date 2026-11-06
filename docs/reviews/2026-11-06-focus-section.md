# `## Prior research` 節の focus の 1 文、日本語訳、出典対照表（2026-11-06）

Harness が生成する `## Prior research` 節（ADR 0019 の型、ADR 0048）に、名指しの続きの Trial で操作役の焦点メモを渡したときだけ、continuation の 1 文（docs/reviews/2026-11-06-continuation-section.md）の後にもう 1 文を足す（ADR 0052 の 2026-11-06 追記）。雛形は `src/discovery/prior-research.ts` の `FOCUS_SECTION_SENTENCE` と `priorResearchSection` にある。agent に渡る文章なので `owner-approved` を要する。AI は出典にある要素だけを書き、要素を足さない（DEVELOPMENT.md 第 5 節）。

## 問い

「操作役の AI が前回 Trial の Lead と未解決経路を読んで続きを名指しするとき、その Trial に『どこから始めるか』の短いメモを渡せるか。open route を残さなかった Root にも名指しで続きを組めるか」。

## 足す 1 文（英語）

> The operator's note in `/workspace/research/prior/operator-focus.md` names where this Trial starts; like the other prior files it is a hint and may be wrong.

置き場所は、節の file の行（と、あれば「Withheld for size」の行）と continuation の 1 文の後の、独立の段落である。2026-11-01 の段落、file の行、continuation の 1 文は変えない。`operator-focus.md` の行は、2026-11-02 追記の形（`- /workspace/research/prior/operator-focus.md ({bytes} bytes).`）で `continuation.json` の直後に並ぶ。focus の無い Trial の節は従来と byte 単位で同じで、過去の Trial の節の digest と照合できる。open route が 0 で focus だけのときも continuation の 1 文はそのまま出す（`continuation.json` の open route が空であることは Root が見れば分かる）。

## 日本語訳

> `/workspace/research/prior/operator-focus.md` にある操作役のメモは、この Trial がどこから始めるかを名指しする。他の prior file と同じく、それはヒントであり、間違っているかもしれない。

## 出典対照表

| 文の要素 | 出典 |
| --- | --- |
| `/workspace/research/prior/operator-focus.md` | ADR 0052 の 2026-11-06 追記（`PRIOR_RESEARCH_FILE_NAMES` に `operator-focus.md` を足し、`prior/` に置く）。continuation の 1 文の `/workspace/research/prior/continuation.json` と同形 |
| the operator's note | ADR 0052 の 2026-11-06 追記「操作役が書いた Markdown 1 本」。所有者決定 2026-11-06「操作役 AI が Lead を読んで続きを名指しする手順」 |
| names where this Trial starts | ADR 0052 決定「この Trial の最初の作業（first work）」と同じ位置付け。依頼文「『どこから始めるか』の短いメモ」 |
| like the other prior files | 節の 2026-11-01 段落「nothing in them is confirmed」。メモを他の prior file と同じ扱いにする（ADR 0048） |
| a hint and may be wrong | 目的文 v26 の Prior research 段落（ADR 0048 で入れた既存表現）「use only those supplied records as starting hints. They may come from another Trial or another version and may be wrong.」 |

## 書かなかったもの

- メモの中身、どの経路を選んだか、なぜ選んだか。Harness はメモを読まない（ADR 0052、所有者 2026-10-27「中身は AI、形は Harness」）。
- メモをどう使うか（従え、確かめよ、など）。目的文 v26 の Prior research 段落が既に「Check every cited entry … against this Trial's pinned source」と言っているので、重ねない。
- メモが Lead の写しでないこと、公開記録や PoC を含めないこと。これは書く側（skill）の規則で、agent に伝える要素ではない（ADR 0052 の 2026-11-06 追記）。

## 気付き（所有者の確認用）

- continuation の 1 文は open route を「この Trial の最初の作業」と言い、focus の 1 文はメモを「どこから始めるか」と言う。open route > 0 と focus の両方があるときは 2 つの「最初」が並ぶ。どちらを先にするかは Harness が決めず、Root が決める。言い換えるかは別の owner-approved の問いとして残す。
- 2026-11-01 の段落は版をまたぐ引き継ぎの文で、名指しの続きでは元の版と読む版が同じになる（continuation の出典対照の気付きと同じ）。
