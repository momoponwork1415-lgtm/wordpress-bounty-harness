# wordpress-bounty-harness

WordPressプラグインの未知脆弱性をAIで発見し、実行時検証を通ったものだけを人間がWordfence / Patchstackへ提出するためのHarness。

- 設計の読み解き（まずこれ）: [docs/DESIGN-WALKTHROUGH.md](docs/DESIGN-WALKTHROUGH.md)
- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 設計理由: [docs/adr/](docs/adr/)
- 運用手引き（完成後に人間がすること）: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- 対象範囲の方針: [src/profiles/wordpress/policy/programme-scope.md](src/profiles/wordpress/policy/programme-scope.md)
- 設計決定の経緯: 旧リポジトリ [wordpress-harness Issue 221](https://github.com/momoponwork1415-lgtm/wordpress-harness/issues/221)

実装はGitHub Issuesの順で進める。最初の縦断スライスはSPEC.md第12節。
