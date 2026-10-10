# AGENTS.md

設計段階のリポジトリ。正本は [docs/SPEC.md](docs/SPEC.md) と [docs/adr/](docs/adr/)。この文書はその要約で、食い違えば正本が勝つ。

## 読む順

1. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約、最初の縦断スライス。
2. [docs/adr/](docs/adr/) — 番号順。設計の理由と、採らなかった選択肢。
3. [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md) — 全体を1つの流れで理解したいときだけ。規則は増やさない。

## 不変条件（SPEC.md 第2節）

設計・実装・レビューのすべてで守る。

1. 探索エージェントへ渡すのは、固定した source、人間が書いた trust 境界宣言、Programme Boundary、Lab、時点で切った対象の公開履歴（カタログ情報のみ、ADR 0012）だけ。評価対象の答え、held-out 公開日以降の記録、PoC、payload、再現手順は渡さない。
2. 対象の実行は gVisor（`runsc`）の使い捨て環境の中だけ。ホストでは実行せず、弱い隔離へ暗黙に切り替えない。外向き通信は認証ブローカー経由の provider API だけ。
3. `runtime-confirmed` は Harness 所有の決定論的判定器だけが出す。証明は nonce 付き canary の回収に限る。エージェントや recipe の自己申告、リバースシェル、永続化、ホストアクセスは証明にしない。
4. 検証の失敗（環境、手順、観測、証拠の不足）は `incomplete`。`contradicted` にも棄却にもしない。
5. 判定は Finding と検証結果が同じ Target Snapshot digest を持つときだけ行う。digest 不一致は `incomplete`。
6. 人間の判断点は「提出前のレビュー」と「外部行動の承認」の2つ。対象選定の承認と未検証候補の採否は置かない。権限・対象範囲の拡張は人間の明示承認を要する。
7. 外部送信（報告、ベンダー連絡、公開）は、正確な Submission Candidate、文案の版、送信先へ結び付いた承認があるときだけ。Harness 自身は送信を実行しない。
8. 台帳は追記専用で、持つのは digest 参照だけ。payload、HTTP 記録、画面画像、実行ログ、認証情報、未公開の発見は Git 外の Private Evidence に置く。

## 探索promptの規則（SPEC.md 第6節）

- 既定はpilotで使ったv2からXSSのサイト全体制限を除いた `short-objective-managed-v3`。`wp2shell-bounty-v1` はADR 0017の比較armとして使う。どちらも脆弱性が必ずあるという前提や固定された攻撃経路は与えない。
- 主経路は Root＋最大3 subagent の協調Trial（ADR 0016）。人数と隔離はHarnessが管理し、分担と仮説はRootが決める。
- WP2Shell変種の30分下限はRootへの指示であり、Harnessが強制する保証ではない。run wallとcoverageを測り、守られない場合は継続境界を改善する。
- prompt本文を変えたら版を上げ、旧版を残してdigest pinを更新する。旧promptは過去Trialの再現用として維持する。

## `profiles/wordpress/` の規則（ADR 0011）

WordPress 固有のもの（WordPress.org からの取得、WordPress + MySQL の Lab 供給、PHP 向けの判定器、Wordfence / Patchstack の対象範囲方針、trust 境界宣言の雛形、保存先索引と成分分担、Lead 型、評価対象の分類）は `profiles/wordpress/` に置く。

汎用モジュール（selection / snapshot / lab / discovery / verification / ledger / review / evaluation）は profile が実装するインターフェースの型だけに依存し、WordPress の型や path を import しない。plugin、slug、hook、AJAX action、`wp_options` のような語が汎用モジュールに現れたら、それは profile へ移す合図。

profile のインターフェースは、2つ目の profile ができるまで汎用化しない。

## 品質ゲート

コミット前に `pnpm check` を通す。

## Agent skills

### Issue tracker

作業IssueはGitHub Issuesで管理する。手順は `docs/agents/issue-tracker.md`。

### Triage labels

Matt Pocock系スキルの5つの標準ラベルを使う。対応は `docs/agents/triage-labels.md`。

### Domain docs

単一コンテキストとして、用語集はルートの `GLOSSARY.md`、判断記録は `docs/adr/` に置く。読み方は `docs/agents/domain.md`。
