# TranslatePress 3.2.6 協調Trial

TranslatePress ベンチマーク（文書は 2026-11-01 に削除。tag `archive/pre-docs-rewrite-2026-11-01` の `docs/TRANSLATEPRESS-BENCHMARK.md`）の最初のケース。`campaign-production-v1.json` は `promptId` を書かないので、現行の目的 prompt（`wp2shell-bounty-v26-wide`）と既定の Lab 付きで、1 Trial、wall上限120分を設定する。`selection.json` は公開済み3.2.6だけを選ぶ。探索のコンテナへ修正版、advisory、PoC、答えの鍵は渡さない。

評価側の負の対照は **3.3** に固定する。Wordfence履歴の修正版情報と [Patchstackの公開記録](https://patchstack.com/database/wordpress/plugin/translatepress-multilingual/vulnerability/wordpress-translatepress-translate-multilingual-sites-with-ai-translation-plugin-3-2-6-unauthenticated-stored-cross-site-scripting-vulnerability)が一致する。公式WordPress.orgの3.3 archiveのSHA-256をGit外の `control-pin.json` に記録してから探索を開始する。Findingが出た場合にのみ、同じ経路を新Labの3.3で実行する。

```bash
pnpm build
node dist/cli/main.js runtime check --config examples/translatepress-3.2.6/campaign-production-v1.json
node dist/cli/main.js campaign run translatepress-multilingual --campaign <一意のID> --config examples/translatepress-3.2.6/campaign-production-v1.json
```

固定版対照は `review reverify --campaign <ID> --finding <ID> --config examples/translatepress-3.2.6/campaign-production-v1.json --version 3.3 --handoff <dir>`。これは `fixed-version` として台帳へ残り、最新版での提出前再確認とは区別される。

ADR 0017 の過去の比較設定（`campaign-short-managed-v4.json`、`campaign-wp2shell-bounty-v2.json`）と、承認済みコメントを 1 件足した `*-comment-fixture.json` の 2 設定は、現行の schema で parse できないので 2026-11-05 に削除し、Git 履歴にだけ残る。当時の二次言語 `fr_FR`（`lab.translatePress`）と承認済みコメント（`lab.initialApprovedComment`）の Lab 設定も同日に削除した。前提は検証スキルが Lab の通常機能で作る（ADR 0035）。

版付きの通常機能シナリオ `translatepress-translation-data-v1` は #353 で削除した。定義は tag `archive/pre-353-deletion` に、過去の記録を読むための digest pin は `src/profiles/wordpress/lab/retired-scenarios.ts` に残る。
