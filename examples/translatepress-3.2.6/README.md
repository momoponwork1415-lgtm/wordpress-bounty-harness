# TranslatePress 3.2.6 協調Trial

[TranslatePress ベンチマーク](../../docs/TRANSLATEPRESS-BENCHMARK.md)の最初のケース。`campaign.json` は履歴なし、`short-objective-v2`、Root と最大3子、1 Trial、90分上限を設定する。`selection.json` は公開済み3.2.6だけを選ぶ。探索のコンテナへ修正版、advisory、PoC、答えの鍵は渡さない。

評価側の負の対照は **3.3** に固定する。Wordfence履歴の修正版情報と [Patchstackの公開記録](https://patchstack.com/database/wordpress/plugin/translatepress-multilingual/vulnerability/wordpress-translatepress-translate-multilingual-sites-with-ai-translation-plugin-3-2-6-unauthenticated-stored-cross-site-scripting-vulnerability)が一致する。公式WordPress.orgの3.3 archiveのSHA-256をGit外の `control-pin.json` に記録してから探索を開始する。Findingが出た場合にのみ、同じ経路を新Labの3.3で実行する。

```bash
pnpm build
node dist/cli/main.js runtime check --config examples/translatepress-3.2.6/campaign.json
node dist/cli/main.js select --config examples/translatepress-3.2.6/campaign.json
node dist/cli/main.js campaign run translatepress-multilingual --campaign <一意のID> --config examples/translatepress-3.2.6/campaign.json
```

固定版対照は `review reverify --campaign <ID> --finding <ID> --config examples/translatepress-3.2.6/campaign.json --version 3.3`。これは `fixed-version` として台帳へ残り、最新版での提出前再確認とは区別される。

`campaign-managed.json` は診断用のopt-in変種。短い目的は維持し、Rootが選ぶ問いを3子へ分担する管理指示と子のJSON出力契約だけを追加した。旧 `short-objective-v2` の本文とdigestは変えず、既定promptにもしていない。短い目的promptで子が動かなかった実測を受けて試す場合、別のキャンペーンIDで条件差を記録する。

`campaign-short-managed-v3.json` と `campaign-wp2shell-bounty.json` はADR 0017の新しい比較用設定。二次言語 `fr_FR` を両方のLabで有効にし、prompt以外を揃える。実行前に二次言語の翻訳とXSSの発火先がLabにあることを確認する。両armは別のcampaign IDで実行し、旧Trialの結果を比較分母に含めない。
