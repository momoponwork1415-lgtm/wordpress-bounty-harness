# Wordfence履歴ミラー照合

`findDuplicates({ plugin, version, property }, { databasePath, statePath })` は、reviewで使うローカル照合口。返すのは公開済み履歴の**候補**だけで、重複の確定は人間が行う。`status: "stale"` や `"unavailable"` は「重複なし」を意味しない。`needs-review` は版の範囲または影響分類を機械的に判定できなかった候補。

## 取り込み元と更新

- 元データ: Wordfence Intelligence V3 Production Feed (`https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production`)。WordfenceのAPI認証が必要。
- 現行の正規化器: 旧環境 `/home/dev/whitebox-harness/tools/refresh_wordfence.py`。このscriptがfeedを取得し、`wordfence-history/v1`形式の`history.sqlite`と`wordfence-cache/v1`形式の`state.json`を作る。既定の保存先は`/home/dev/wp-bounty-workspace/intelligence/`。実データはGit外に置く。
- 更新: 旧環境で`python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace`を実行する。API keyは`WORDFENCE_INTELLIGENCE_API_KEY`環境変数、または`~/.config/wordfence/env`に置く。出力が`refreshed`または`throttled`なら状態を確認し、`stale-fallback`なら更新失敗として扱う。旧scriptは成功後30分以内の再取得を抑止する。
- 提出前: 更新を試し、`state.json`の`last_successful_at`と`stale_fallback`を確認する。adapterの既定鮮度は24時間で、超過または更新失敗なら候補を返しつつ`stale`を表示する。既定値は呼び出し時に`maxAgeMs`で変更できる。

adapterはSQLiteをread-onlyで開き、stateとDBのschema、feed digest、件数のmetadataが一致するときだけ検索する。APIへの通信や自動更新はしない。`signals`は旧正規化器のtitle/descriptionからの分類なので、分類が欠けた履歴は手動確認候補として残す。重複照合結果、履歴の本文、認証情報をDiscovery入力やGitに置かない。

## Discovery向けの時点で切った公開カタログ

`extractCampaignHistory(plugin, historyCutoff, { databasePath, statePath })` は同じローカルmirrorを読み、公開日がcutoffより**厳密に前**のplugin記録だけを `CampaignInput v1` のcatalogに投影する。投影する項目はid、分類signal、影響版、修正版、公開日、公開記録のタイトル、変更ファイル一覧に限る。advisory本文、PoC、payload、再現手順は投影しない。現行mirrorに差分ファイル情報はないため `changedFiles: []` とし、ファイルを推測しない。取得できない公開日を持つ記録は除外する。stateとDBの整合が取れないときは `unavailable` を返し、空の履歴として扱わない。

cutoffは本番ではsnapshot版の公開日時、評価ではheld-outの公開日時に一致させる。`validateProductionCampaignInput` / `validateEvaluationCampaignInput` が境界で検査する。runへの履歴の有無は `historyForRun` の割合設定で決め、台帳の `discovery-run-started.history` にmode・digest・渡したrecord idを残す。Findingの任意の `historyRecordId` は、そのrunへ渡したidだけを記録できる。
