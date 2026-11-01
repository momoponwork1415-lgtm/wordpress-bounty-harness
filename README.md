# wordpress-bounty-harness

WordPress プラグインの未知の脆弱性を、AI が gVisor の中で固定したソースから探し、人間が Lab で観測して Wordfence へ出すための Harness。Harness は制御だけを受け持ち、判定器は持たない。確定の根拠は人間の観測の記録だけである。

## 読む順

1. [AGENTS.md](AGENTS.md) — 正本の要約と、守る規則。用語は [GLOSSARY.md](GLOSSARY.md)。
2. [docs/SPEC.md](docs/SPEC.md) — 目的、不変条件、モジュール境界、受け渡し契約。
3. [docs/SYSTEM.md](docs/SYSTEM.md) — 選定から提出までの 6 段を、Harness・AI・人間の受け持ちで追う。
4. [docs/adr/](docs/adr/) — 番号順。設計の理由と、採らなかった案。
5. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) と [docs/LESSONS.md](docs/LESSONS.md) — 運用規則と、過去 4 世代の教訓。
6. [docs/OPERATIONS.md](docs/OPERATIONS.md) — 実際に打つコマンド。
