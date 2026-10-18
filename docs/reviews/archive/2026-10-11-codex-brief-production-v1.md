# Codex への依頼文: milestone「本番運用 v1」の実装（2026-10-11）

正本ではない。所有者が Codex に貼る依頼文の控え。食い違えば SPEC と ADR が勝つ。

## 依頼文

```text
あなたはこのリポジトリ（wordpress-bounty-harness）の実装者として、GitHub milestone「本番運用 v1（WP2Shell 方式、人間は読む・再現する・提出する）」の Issue を順番に実装する。

## 最初に読む（この順で、全部）
1. AGENTS.md
2. docs/SPEC.md（第2節の不変条件8項目は暗唱できる程度に）
3. docs/adr/0025〜0028（0028 は status: proposed。本文の決定を前提にしてよいが、ADR 自体は変えない）
4. docs/reviews/2026-10-11-overall-design-v1.md（全体像と Issue の順番）
5. docs/reviews/2026-10-11-thorough-design-review.md（H1〜H9 の指摘と該当行）
6. docs/DEVELOPMENT.md と .github/pull_request_template.md
7. 着手する Issue の本文とコメント（gh issue view <番号> --comments）

## 作業の順番
① #139 → ② #138（#142 を同梱）→ ③ #121 → ④ #140 → ⑤ #127 → ⑥ #141 → ⑦ #95、#96、#144 → ⑧ #143 → ⑨ #100。#126 は並行。
一つの Issue が終わって PR が merge されるまで次に進まない。Issue 本文に「所有者の確認が要る点」があり未回答なら、その Issue は着手せず、次に進める Issue を探して所有者に報告する。

## 守ること
- 1 Issue = 1 PR = 1 ブランチ（issue/<番号>-<短い名前>）。main から切る。
- PR 本文はテンプレートの5項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で各3行以内。空欄にしない。
- コミット前に pnpm check を通す。test を消して通すことは禁止。
- 探索（src/discovery、src/cli/wordpress*.ts、prompts）に触る PR は、開発セットで 3 Trial の結果（Trial 数 / completed / Finding / Lead / wall 中央値 / 失敗理由）を貼る。実機 Lab が無い環境なら、その旨を「測った数字」に書いて所有者に起動を依頼し、推測の数字を書かない。
- 不変条件8項目に抵触する変更を見つけたら実装せず、PR か Issue コメントで「どの条件に、なぜ」を書いて止まる。
- 汎用モジュール（selection / snapshot / lab / discovery / verification / ledger / review / evaluation）に plugin、slug、hook、AJAX action、wp_options の語を入れない。入れたくなったら profiles/wordpress/ へ置く。
- 台帳は追記専用。既存 event の読み取り互換を壊さない。消すのは「書く側」だけ。
- prompt の .md は旧版も全部残す。本文を変えるなら版を上げて digest pin を更新する。prompt 本文に対象固有の名前、PoC、「必ずある」「最低 N 時間」を入れない。
- Private Evidence、payload、HTTP 記録、認証情報を Git に入れない。
- 新しい設定項目を増やすとき、相互排他を手書きの refine で表現しない。union で表す（#142）。
- 削除は Issue 本文の「削除範囲」に書かれたものだけ。それ以外の「ついで削除」はしない。

## #138 で消すもの（Issue 本文の「削除範囲」と同じ）
- 既定 prompt を screening-v1 から wp2shell-bounty-v2 へ。
- stage、continuation axis、continuation block、30/90 分と 7:3 の分岐、screening 用 entry index 検証、Harness の continuation 差し込み。
- 残す: prompt .md 全版と digest、台帳の stage / continuationOf を読む側、short-objective-managed-v4 の比較 arm。

## 各 PR の最後に報告すること
- 変えたファイルと行数。消した関数と設定名の一覧。
- pnpm check の結果（test 数）。
- Issue の受入条件のうち、満たしたもの・満たしていないもの・この環境では測れないもの。
- 所有者に要る判断があれば一文で。
```

## 所有者側でこの依頼文の前に済ませること

- PR「docs: 2026-10-11 の設計レビュー、全体設計 v1、ADR 0028 を追加する」を merge する。Issue 本文が参照する文書がこれに入っている。
- 所有者の3入力を Issue に書く: 旧ハーネスでの提出1件あたりの分数（#141）、公開履歴を選定でどう扱うか（#144）、ADR 0028 の accept（#141）。無くても ①〜③ は進む。
- #127 と #100 の実機 Lab 起動は所有者が行う。Codex は script と文書を用意するところまで。
