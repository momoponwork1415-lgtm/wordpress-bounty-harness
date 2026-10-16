# Codex 監視セッションの依頼文（dev-set 配線計測、2026-10-16）

所有者が Codex に貼る。監視だけを行い、Harness・Lab・設定・Git に書き込まない。読む対象は Git 外の計測用 state（Private Evidence の本文は開かない）。

```text
役割: 進行中の dev-set 計測 Trial（5 case × 1 Trial、順次: ssa → brizy → relevanssi → tp331 → tp326）を 15 分ごとに観測し、1 画面の状況報告を書く。操作は一切しない。

読む場所:
- 進行ログ: ~/.local/state/wordpress-bounty-harness-wiring-gate-20261016/driver.log（"=== start / end" 行）
- 各 case の CLI 出力: 同ディレクトリの {ssa,brizy,relevanssi,tp331,tp326}/campaign*.log
- 台帳（読み取り専用）: cd /tmp/claude-1000/-home-dev-wordpress-bounty-harness/17390e67-9dd7-4985-9e76-4f5e80b8ecb2/scratchpad/wt-int && node dist/cli/main.js --state ~/.local/state/wordpress-bounty-harness-wiring-gate-20261016/<case>/state ledger funnel --campaign <id>、同 ledger runtime --campaign <id>、同 ledger usage --campaign <id>
  campaign ID: wiring-gate-integration-ssa-1016-r2、wiring-gate-integration-brizy-1016-r2、wg-int-relevanssi-1016、wg-int-tp331-1016、wg-int-tp326-1016
- コンテナ: docker ps --format '{{.Names}}\t{{.Status}}'（codex-agent-*、provider-egress-broker-*、wbh-*-{wp,db,proxy,canary}）
- ホスト資源: free -g、df -h /home

15 分ごとの報告（1 画面、日本語）:
1. 今どの case が、どの段階か（selected / frozen / lab ready / discovery started / discovery finished / verification / done）と、開始からの経過分。
2. 直近の台帳 event と、その reason / reasonDetail / providerLimit（あれば）。
3. コンテナの数と Up 時間。wbh-* が残骸として増えていないか（1 case につき wp/db/proxy/canary の 4 つが基準）。
4. 異常の兆候: campaign.log に ZodError / provider limit / cyber_policy / broker 失敗 / timeout の語、discovery-run-started から 65 分を超えて finished が無い、free メモリ 8 GiB 未満、disk 残 20 GB 未満。
5. 終了した case は completed / incomplete の別、Finding / Lead 数、wall 分、停止理由を 1 行で。

しないこと:
- continuous stop / lab cleanup / docker stop / kill / rm を打たない。設定 file、host.json、campaign.json を変えない。新しい Trial を起動しない。
- Private Evidence（<state>/private-evidence/）の中の候補本文、payload、HTTP 記録、認証情報を開かない・貼らない。台帳の集計と reason code だけを使う。
- git の操作（commit、push、branch、checkout）をしない。GitHub に書かない。
- 異常を見つけても自分で直さない。報告に「要確認」と書いて止める。

終了条件: driver.log に "tp done" が出たら、5 case の最終表（case / Trial / completed / Finding / Lead / Root wall 中央値 / 停止理由 / 非 cache token）を 1 つ出して終わる。
```
