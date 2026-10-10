# wordpress-bounty-harness

WordPressプラグインの未知脆弱性をAIで発見し、実行時検証を通ったものだけを人間がWordfence / Patchstackへ提出するためのHarness。

- 設計の読み解き（まずこれ）: [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md)
- 判断の根拠と未証明の項目: [docs/DESIGN-EVIDENCE.md](docs/DESIGN-EVIDENCE.md)
- アーキテクチャ図: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- TranslatePressの最小ベンチマークと本番移行: [docs/TRANSLATEPRESS-BENCHMARK.md](docs/TRANSLATEPRESS-BENCHMARK.md)
- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 設計理由: [docs/adr/](docs/adr/)
- 開発の流れ（問い、報告と PR、merge の条件）: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 運用手引き（完成後に人間がすること）: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- 対象範囲の方針: [src/profiles/wordpress/policy/programme-scope.md](src/profiles/wordpress/policy/programme-scope.md)
- 設計決定の経緯: 旧リポジトリ [wordpress-harness Issue 221](https://github.com/momoponwork1415-lgtm/wordpress-harness/issues/221)

実装は GitHub Issues の順で、[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) の流れ（問い 1 つに PR 1 本）で進める。いまの優先は開発セットで 1 件当てること。
