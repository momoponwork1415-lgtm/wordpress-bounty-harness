# 2026-10-11 Codex への依頼文（二段構え移行と判定器修正）

所有者が Codex セッションの最初に貼る文。設計の正本は ADR と SPEC、計画は [実装計画](2026-10-11-implementation-plan-two-stage.md)。この文は計画を変えない。

---

あなたはこのリポジトリ（wordpress-bounty-harness）の実装担当です。設計は決まっており、あなたの仕事は決まった順番で PR を出すことです。設計を変えたくなったら、コードではなく `docs/reviews/` に報告を書いて止まってください。

## ゴール

最終ゴールは Issue #127 の受入条件です。「本人発見 7 件のうち、TranslatePress 以外で Stored XSS 1 件と SQLi 1 件以上が、新しい Lab の Harness 判定器で `runtime-confirmed` になり、修正版の別 Snapshot で同じ経路が成立しない」。そこへ至る中間ゴールは 2 つです。

1. 判定器の修正（#118 → #119 → #120 → #121）が merge され、TranslatePress 3.3.1 の既知経路が実機 smoke で confirmed、3.3.2 で contradicted になる。
2. 二段構えの探索（#123 → #130 → #131 → #132）が merge され、開発セットで一段目・継続・二段目の数字が台帳から出る。

どの PR も「このゴールにどう近づくか」を本文の「問い」に書いてください。

## 最初に読むもの（この順）

1. `AGENTS.md`
2. `docs/SPEC.md` と `docs/adr/`（番号順。0025〜0027 は PR0 であなたが書く）
3. `docs/reviews/2026-10-11-harness-completeness-review.md`（何が壊れているか、根拠の file:line）
4. `docs/reviews/2026-10-11-implementation-plan-two-stage.md`（PR の順番、各 PR の範囲・テスト・貼る数字・消し方）
5. `docs/reviews/2026-10-11-two-stage-prompts-draft.md`（新 prompt の本文。Issue や PR 本文に貼らず、asset として追加する）
6. 担当する Issue 本文（#129、#118〜#121、#123、#130〜#132、#125、#126、#127）

## 進め方

- 作業単位は Issue 1 つ = branch 1 本 = PR 1 本。branch 名は `issue/<番号>-<短い英語>`。
- PR0（#129、ADR 0025〜0027 と SPEC / AGENTS.md の追従）を最初に出す。merge されるまで他の PR を merge 依存にしない。
- 系列 A（#118 → #119 → #120 → #121）と系列 B（#123 → #130 → #131 → #132）は別 branch で並行してよい。系列内は順番どおり。
- 計画の「事前の確認」3 点（Codex CLI の thread 再開、gVisor 内の screenshot、recorder の 2 network 参加）は、該当 PR に着手する前に 1 時間以内で確かめ、結果を Issue にコメントしてから方式を選ぶ。
- PR を出したら止まる。所有者が読んで merge する。merge 待ちの間は、依存しない次の Issue に進んでよい。
- 詰まったら、推測で進めず `docs/reviews/<日付>-<topic>.md` に「何を試し、何が分からないか、選択肢」を書いて止まる。

## PR の書き方

PR テンプレートの 5 項目を日本語で埋める。

1. 問い: この PR が答える 1 つの問い。
2. 変えたこと: file 単位で。
3. 変えなかったこと: 隣接していて触らなかったものと理由。
4. 測った数字: 探索に触る PR は開発セット（TranslatePress 3.2.6 / 3.3.1、修正版 3.3 / 3.3.2）で最低 3 Trial。Trial 数、完了数、Finding、Lead、wall 中央値、失敗理由。判定器の PR は既知経路を人間が書いた recipe で通した結果。
5. 消し方: この変更を外す手順。

加えて、prompt か scenario に触る PR は「対象固有の語（関数名、option 名、URL、画面名）を入れていない」ことを本文で明記する。

## 守ること

- `pnpm check` を通す。目安は PR あたり 500 行。
- SPEC / ADR と食い違う変更は、先に ADR を書く PR を出す。同じ PR に混ぜない。
- Issue の受入条件を書き換えない。満たせないと分かったら理由を Issue にコメントして止まる。
- 新 prompt は新 ID で追加し、旧 ID と digest pin を残す。既定の切り替えは計画で指定された PR（#130）でだけ行う。
- 不変条件（SPEC 第 2 節）を守る。探索エージェントに渡すものを増やすときは、それがカタログ情報か固定 source か Lab かを PR 本文に書く。advisory 本文、PoC、payload、修正差分、canary は渡さない。
- payload、HTTP 本文、recipe、画面画像、認証情報、未公開の発見を Git とテスト fixture に入れない。Private Evidence に置く。
- #127 で Wordfence mirror を読むときは、記録 ID、CVE、公開日、影響版、タイトルだけを使う。`description` を読んで prompt や scenario を調整しない。読んだ列を script の出力に明記する。
- 汎用モジュール（`src/selection` など）に WordPress 固有の語が出たら `profiles/wordpress/` へ移す。
- commit は所有者が頼んだときだけ。push と PR 作成はこの依頼で許可されている。外部への送信（ベンダー連絡、報告の提出）は一切しない。

## 各段階の完了の定義

- PR0: 3 本の ADR が置かれ、SPEC 第 6 / 7 / 10 節と AGENTS.md が一致。コードなし。
- 系列 A 完了: `scripts/smoke-real-lab.mjs`（#126）相当で、3.3.1 の既知経路が confirmed、3.3.2 が contradicted。Stored XSS の判定経路が `incomplete(evidence)` で止まらないことを 3.2.6 の既知経路で確認。
- 系列 B 完了: 開発セットで一段目 3 Trial、継続の発火、二段目 3 Trial の数字が台帳の `ledger funnel` と `ledger usage` から出る。
- #125、#126 完了後に #127 へ。7 件を順に回し、結果を `docs/evaluation/` に日付付きで記録する。0 件の case は「読まずに終わった」か「読んで出なかった」かを分け、無条件に Trial を増やさない。

## 報告の形

Issue へのコメントは「やったこと、数字、次に何をするか、確認が要る点」の 4 行。所有者に確認が要るのは #127 の 2 点（TranslatePress 3.2.6 の対象記録、Smash Balloon の外部依存の扱い）と、事前確認で方式が分かれたときだけ。
