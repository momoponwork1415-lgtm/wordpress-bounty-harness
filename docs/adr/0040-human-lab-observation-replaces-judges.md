---
status: accepted
date: 2026-10-25
supersedes: 0004
amends: 0021（判定器と canary の回収）, 0026（観測器の判定）, 0031（決定論の観測から判定器を外す）, 0035（canary と判定器）, 0038（追記 10 の判定器の役割）
---

# 判定器と canary を削除し、確定は人間が Lab で観測して行う（#525）

## 背景

所有者は 2026-10-25 に、Codex 側で検証を回した結果として「判定器は残さない」と決めた（[#525](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/525)）。Lab で alert は発火しているのに判定器では判定できない結果が多く、所有者自身が Lab でアラートを確かめる方が確実だった。本番台帳では自動検証が 0/40、handoff が 3/22 で、検証の失敗理由の大半は `incomplete(precondition)` 80 件と `incomplete(no-judge)` 44 件だった（[設計課題の報告](../reviews/2026-10-20-design-issues-from-production-results.md)）。

## 決定

- 判定器の code を消す。`judges.ts`、canary の播種と照合、`verification/index.ts` の判定呼び出しと、判定器の結果による自動再試行（`observation`）を削除する。使わない設定にして残さない（AGENTS.md「削除」）。
- 確定は、人間が Lab の dialog、観測記録、捕捉を読んで行う。新しい検証は `runtime-confirmed`、`contradicted`、`incomplete(no-judge)` を出さない。
- 確定の根拠は、名指しした人間が新しい review Lab で記録した `review observe` の match と `review decide --reproduced match` だけである。エージェントや recipe の自己申告、捕捉を読んだだけの推定、AI が打った `review observe` / `--reproduced` は根拠にしない（2026-10-26 に明記）。
- handoff の attempt が終わり、Harness の捕捉が残ったものは `verification-finished` の `incomplete(awaiting-human-observation)` として記録する。捕捉が無いものは `incomplete(evidence)` にする。人間の確認は既存の `lab up --for-review` と `review observe`（`manual-observation-recorded`）、`review decide` で記録する。`verification-finished` を確定に書き換えない。
- 残すもの: Finding 単位の Lab の供給、`verify next --handoff` の受け渡し、recorder による HTTP 捕捉、Lab 状態の差分、Lab browser による被害者画面の記録（宣言した数値マーカーの dialog と画面）、`manual-observation-*`、台帳と Private Evidence。
- 既存の `runtime-confirmed` 26 件と、判定器があった時期のほかの記録は読み取り専用で読み続ける。

## 理由

判定器が結論を出せない Finding の確認は、結局人間が Lab で行っていた。検証時間は canary の回収に使われていた（ADR 0038 追記 10）。人間が Lab で確かめる方が確実だった。

## 採らなかった選択肢

- 自動検証を止めて判定器の code は残す: 使わない設定にして残す中間状態は置かない（AGENTS.md「削除」）。
- `verification-finished` に人間の確定を表す新しい結果値を足す: 検証の記録と人間の判断が混ざる。人間の記録は既存の `manual-observation-recorded` と `review decide` に寄せる。

## 帰結

- SPEC 第 2 節の不変条件 3 と第 7 節の判定器の表を改めた。ADR 0004 はこの ADR で置き換え、ADR 0021 / 0026 / 0031 / 0035 / 0038 に注記を足した。
- skill `wbh-verify` は v10 にし、canary の節と判定器が照合する条件を消した。旧 v9 は `versions/` に残す。
- 正式な文案と提出候補（`review scope`、`review draft`、`review authorize`、`review decide --reproduced`）は、今も `runtime-confirmed` / `reproduced` を要する。新しい検証の結果をそこへ通す basis は、ADR 0038 追記 10 のとおり別 PR で作る。
- 受入: handoff の結果が `incomplete(awaiting-human-observation)` に届き、`lab up --for-review` と `review observe` で人間の観測を記録できること。本番の handoff 3 件の数字は所有者の go の後に取る。

## 消し方

この ADR の PR を revert する。判定器、canary、再現パッケージの生成、`observation` の自動再試行が戻る。この PR の後に記録した `incomplete(awaiting-human-observation)` は、旧版でも理由コードを読めないため、revert の前にその event の扱いを決める。

## 2026-10-26 追記: 段 6 の根拠（#525、所有者の委任で AI）

帰結の「正式な文案と提出候補は今も `runtime-confirmed` / `reproduced` を要する」を、次のように改めた。

- 最新の検証が `incomplete(awaiting-human-observation)` で、Harness の捕捉があり、名指しした人間が同じ attempt の review Lab で `manual-observation-recorded` の `match` を記録したとき、`review decide --reproduced` はその review Lab package の digest に対して記録できる。
- その `--reproduced match` が揃うと、`review scope`、`review draft`、`review authorize` はこれを根拠に進む。判定器の再現パッケージは要らない。最終の人間の査読、人間の `accept`、重複 `no-match`、正確な文案と送信先への承認の条件は変えない。
- scope の事実は、判定器の条件の代わりに、Finding の攻撃者位置、Lab browser の被害者の記録、人間の `match` を読む。`match` は分類が主張する効果の観測として数え、判定器だけが記録した条件（path と拡張子の制御、サイト全体への広がり、option の分類）は含めない。それを要するプログラムは `ambiguous` のままになる。
- 修正版の対照（`review reverify --version`）は、同じ根拠の attempt の `route.json` を参照の route として使える。
- `verification-finished` は書き換えない。


## 2026-10-26 追記 2: 通常の公開サイトの構成は観測者が申告する（#578）

#353（PR #577）で Lab のシナリオが無くなり、scope の `defaultOrCommonSettings` を得る経路が無くなった。人間の観測の basis では、この事実を観測者の申告から取る。

- `review observe` に `--ordinary-site yes|no` と `--ordinary-site-reason <text>`（1〜500 字）を足した。2 つは組で指定する。`manual-observation-recorded` には `configuration: { ordinaryPublicSite, recordDigest }` を任意の項目として追記する。理由の文は Private Evidence の `manual-observation-configuration.json` に置き、台帳は真偽と digest だけを持つ（不変条件 8）。
- scope は、人間の観測の basis では、この申告の `ordinaryPublicSite` を `defaultOrCommonSettings` として読む。`yes` は `in-scope` の条件を満たし、`no` は `out-of-scope (version-or-configuration)`、申告が無ければ `ambiguous (version-or-configuration-unknown)` になる。Lab のシナリオの記録は、判定器があった時期の結果にだけ使う。
- scope の評価は、読んだ観測の identity と結び付けて記録する。review Lab を開き直して新しい観測を記録すると、`review scope` は評価し直す。前の観測の評価からは `review draft` も `review authorize` も進めない。
- `review export --version 2` の `review.manualObservation.configuration` に申告の真偽と記録の path を出す。

消し方: この追記の PR を revert する。追記した `configuration` を持つ event は、旧版の台帳 schema では読めないため、revert の前に扱いを決める。
