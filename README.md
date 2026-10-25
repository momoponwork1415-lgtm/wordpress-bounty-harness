# wordpress-bounty-harness

WordPress プラグインの未知の脆弱性を AI が探し、判定器が `runtime-confirmed` を出したものを人間が見て Wordfence / Patchstack へ出すための Harness。

## 読む順

1. [AGENTS.md](AGENTS.md) — 正本の要約と、守る不変条件。用語は [GLOSSARY.md](GLOSSARY.md)。
2. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約。
3. [docs/adr/](docs/adr/) — 番号順。設計の理由と、採らなかった案。
4. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 第 2 節と [docs/LESSONS.md](docs/LESSONS.md) — 今の Step と、過去の教訓。
5. 全体の流れや図は、要るときだけ読む。[docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md)、[docs/DESIGN-DIAGRAMS.md](docs/DESIGN-DIAGRAMS.md)、[docs/SYSTEM-DIAGRAMS.md](docs/SYSTEM-DIAGRAMS.md)。

食い違ったときは SPEC と ADR が勝つ。

## 今の動き方

- 探索: `select` で対象を選び、`campaign run` が gVisor（`runsc`）の使い捨て環境で目的 prompt `wp2shell-bounty-v10` の協調 Trial を 1 回走らせる。
- 検証: `verify next --handoff <dir>` が Finding ごとに Lab を立て、skill `wbh-verify` がその Lab で再現する。`runtime-confirmed` は Harness の判定器だけが出す。
- 人間のレビュー: skill `wbh-review`・`wbh-dedupe`・`wbh-report` が下調べと下書きを作り、所有者が `review decide` と `review authorize` で決める。Harness は外部へ送らない。

手順の詳細は [docs/OPERATIONS.md](docs/OPERATIONS.md)、対象範囲の方針は [src/profiles/wordpress/policy/programme-scope.md](src/profiles/wordpress/policy/programme-scope.md)。

## 状態の置き場所

- Git には設計、code、設定例、digest 参照だけを置く。
- payload、HTTP 記録、画面画像、実行ログ、認証情報、未公開の発見は Git 外の Private Evidence に置く。
- 台帳は追記専用で、digest 参照だけを持つ。

## 開発

変更は「問い 1 つに PR 1 本」で、流れは [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) に従う。今の完了条件は、開発セットで人手なしに通しで動くこと（v8 が見つけ、選定が対象を選び、`wbh-verify` で `runtime-confirmed` に届く）。Harness への変更は不具合の修正と削除に限る。

コミット前に `pnpm check` を通す。
