# TranslatePress 3.2.6 協調Trial

[TranslatePress ベンチマーク](../../docs/TRANSLATEPRESS-BENCHMARK.md)の最初のケース。`campaign-production-v1.json` は唯一の新規探索prompt v7、Rootと最大4子、1 Trial、wall上限120分を設定し、入口索引は渡さない。短い目的prompt（`short-objective-v2`）と旧 managed v1 / v3、`wp2shell-bounty-v1` の設定例は 2026-10-18 に削除し、Git 履歴にだけ残る。`selection.json` は公開済み3.2.6だけを選ぶ。探索のコンテナへ修正版、advisory、PoC、答えの鍵は渡さない。

評価側の負の対照は **3.3** に固定する。Wordfence履歴の修正版情報と [Patchstackの公開記録](https://patchstack.com/database/wordpress/plugin/translatepress-multilingual/vulnerability/wordpress-translatepress-translate-multilingual-sites-with-ai-translation-plugin-3-2-6-unauthenticated-stored-cross-site-scripting-vulnerability)が一致する。公式WordPress.orgの3.3 archiveのSHA-256をGit外の `control-pin.json` に記録してから探索を開始する。Findingが出た場合にのみ、同じ経路を新Labの3.3で実行する。

```bash
pnpm build
node dist/cli/main.js runtime check --config examples/translatepress-3.2.6/campaign-production-v1.json
node dist/cli/main.js select --config examples/translatepress-3.2.6/campaign-production-v1.json
node dist/cli/main.js campaign run translatepress-multilingual --campaign <一意のID> --config examples/translatepress-3.2.6/campaign-production-v1.json
```

固定版対照は `review reverify --campaign <ID> --finding <ID> --config examples/translatepress-3.2.6/campaign-production-v1.json --version 3.3`。これは `fixed-version` として台帳へ残り、最新版での提出前再確認とは区別される。

`campaign-short-managed-v4.json` と `campaign-wp2shell-bounty-v2.json` はADR 0017の過去の比較設定として保持する。新規探索では起動できない。当時は二次言語 `fr_FR` を両方のLabで有効にして比較した。

`*-comment-fixture.json` の2設定は過去の比較用。最初の公開投稿に無害な承認済みコメントを1件追加した結果を、commentなしTrialと混ぜない。

`campaign-short-managed-v4-translation-data.json` も過去の比較用で、新規探索では起動できない。版付きの通常機能シナリオ `translatepress-translation-data-v1` の定義と digest pin は `src/profiles/wordpress/lab/scenarios.ts` に残る。
