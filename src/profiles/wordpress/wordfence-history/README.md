# Wordfence履歴ミラー照合

`findDuplicates({ plugin, version, property }, { databasePath, statePath })` は、reviewで使うローカル照合口。返すのは公開済み履歴の**候補**だけで、重複の確定は人間が行う。`status: "stale"` や `"unavailable"` は「重複なし」を意味しない。`needs-review` は版の範囲または影響分類を機械的に判定できなかった候補。

## 取り込み元と更新

- 元データ: Wordfence Intelligence V3 Production Feed (`https://www.wordfence.com/api/intelligence/v3/vulnerabilities/production`)。WordfenceのAPI認証が必要。
- 現行の正規化器: 旧環境 `/home/dev/whitebox-harness/tools/refresh_wordfence.py`。このscriptがfeedを取得し、`wordfence-history/v1`形式の`history.sqlite`と`wordfence-cache/v1`形式の`state.json`を作る。既定の保存先は`/home/dev/wp-bounty-workspace/intelligence/`。実データはGit外に置く。
- 更新: 旧環境で`python3 tools/refresh_wordfence.py --workspace /home/dev/wp-bounty-workspace`を実行する。API keyは`WORDFENCE_INTELLIGENCE_API_KEY`環境変数、または`~/.config/wordfence/env`に置く。出力が`refreshed`または`throttled`なら状態を確認し、`stale-fallback`なら更新失敗として扱う。旧scriptは成功後30分以内の再取得を抑止する。
- 鮮度の確認: `harness history status`（`inspectHistoryMirror`）が、照合口と同じ規則で `fresh` / `stale` / `unavailable`、最終成功時刻、経過時間、件数を出す。`fresh` 以外は終了コード1。
- 提出前: 更新を試し、`state.json`の`last_successful_at`と`stale_fallback`を確認する。adapterの既定鮮度は24時間で、超過または更新失敗なら候補を返しつつ`stale`を表示する。既定値は呼び出し時に`maxAgeMs`で変更できる。

adapterはSQLiteをread-onlyで開き、stateとDBのschema、feed digest、件数のmetadataが一致するときだけ検索する。APIへの通信や自動更新はしない。`signals`は旧正規化器のtitle/descriptionからの分類なので、分類が欠けた履歴は手動確認候補として残す。重複照合結果、履歴の本文、認証情報をDiscovery入力やGitに置かない。

## 選定向けの件数（ADR 0037）

`openWordfenceAdvisoryHistory({ databasePath, statePath })` は選定の `WordPressAdvisoryHistorySource`。`inspectHistoryMirror` と同じ整合・鮮度の規則（方針の `maximumHistoryAgeDays`）で開き、slug ごとに window 内の非 informational plugin 記録の件数、`signals` の class 名が報奨対象 class に入る件数、最新の公開日だけを返す。title、description、CWE、record JSON は読まない。mirror が stale / unavailable のときは開かず、選定が止まる。

## Discovery向けの時点で切った公開カタログ（削除済み）

`extractCampaignHistory` と `CampaignInput v1` の `catalog` mode は 2026-10-18 の [ADR 0034](../../../../docs/adr/0034-harness-control-only-deletions.md) で削除した。ablation の history 軸でしか使われず、`wp2shell` mode は常に `history: { mode: "none" }` を渡していた。旧Trialの台帳 `discovery-run-started.history`（mode・digest・渡したrecord id）は読み続け、Findingの任意の `historyRecordId` はそのrunへ渡したidだけを記録できるという台帳側の規則も残る。このmirrorを探索へ投影する code はもう無い。
