# 監視セッションの依頼文（子モデル実験 ＋ 本番 runner、2026-10-21）

所有者が別 session（Codex か Claude）に貼る。監視だけを行い、Harness・Lab・設定・Git・GitHub に書き込まない。手順の正本は `docs/agents/production-monitoring.md`。Private Evidence の本文は開かない。

```text
役割: 2 つの進行を観測し、30 分ごとに 1 画面の状況報告を日本語で書く。操作は一切しない。
 A. 子モデル実験（Issue #418、PR #427）: 7 対象 × 2 arm、各 arm 内は 3 本並列、arm は os → oh の順。
 B. 本番 runner（continuous run、Codex 3 本並列。実験の後に所有者が Opus 3 ＋ Codex 3 に戻す）。

先に読む: AGENTS.md の不変条件、docs/agents/production-monitoring.md 第 3〜6 節、docs/agents/ledger-reading.md。

A. 実験の読む場所（Git 外、すべて読み取り専用）
- 進行ログ: ~/.local/state/wordpress-bounty-harness-child-model-20261021/wave.log（"=== start" / "=== end ... exit=N" / "all done ... arm=os|oh"）
- 各 case の CLI 出力: 同ディレクトリの <case>-<arm>/campaign.log
- 台帳: cd /home/dev/wbh-418 && node dist/cli/main.js --state ~/.local/state/wordpress-bounty-harness-child-model-20261021/<case>-<arm>/state --host ~/.local/state/wordpress-bounty-harness-child-model-20261021/<case>-<arm>/work/host.json ledger funnel --campaign <id>、同 ledger runtime --campaign <id>（Root と子のモデルが出る）、同 ledger usage --campaign <id>
- campaign ID: cm-<case>-<arm>-1021-r1
- case と対象: mwwpform = mw-wp-form 5.1.8、kirki = kirki 6.4.0、c2c = click-to-chat-for-whatsapp 4.45、wpvivid = wpvivid-backuprestore 0.9.136、checkemail = check-email 2.0.16、forminator = forminator 1.58.2、seopress = wp-seopress 10.3
- arm: os = Root Opus ＋ 子 Sonnet、oh = Root Opus ＋ 子 Haiku（host.json の profile id が claude-opus-root-sonnet-child-high / claude-opus-root-haiku-child-high）
- 設定: prompt wp2shell-bounty-v8、Lab なし、wall 120 分、Root ＋ 子最大 4。1 Trial の resources は 4 CPU / 12288 MiB

B. 本番の読む場所
- 状態（必ず --host 付き）: cd /home/dev/wordpress-bounty-harness-prod17 && node dist/cli/main.js --state ~/.local/state/wordpress-bounty-harness --host ~/.config/wordpress-bounty-harness/host-production-v6.json continuous status
- runner の log: ~/.local/state/wordpress-bounty-harness/continuous.log（"concurrency effective=" の行で runtime ごとの上限が分かる）、標準出力 ~/.local/state/wordpress-bounty-harness/continuous-20261019.out
- 並列の実効値: ~/.local/state/wordpress-bounty-harness/continuous.concurrency（全体）、同 .claude、同 .codex。いまは 6 / 0 / 3。実験が終わると所有者が .claude を 3 にし、campaign 設定の runtimeShare を両 runtime に振る。その後は "concurrency runtime=claude effective=3" が出るのが正常
- 台帳: ~/.local/state/wordpress-bounty-harness/ledger.sqlite を node:sqlite の DatabaseSync で readOnly に開く（sqlite3 CLI は無い）。見るのは event_type、campaign_id、reason。本文は見ない
- campaign ID: prod-<日付>-<n>

共通
- コンテナ: docker ps --format '{{.Names}}\t{{.Status}}'（codex-agent-*、claude-agent-*、provider-egress-broker-*。実験は Lab なしなので wbh-*-{wp,db,proxy,canary} は増えない。wbh-development-image-registry は常駐）
- ホスト資源: free -g、df -h /home、uptime の load average

30 分ごとの報告（1 画面）
1. 実験: どの case がどの段階か（start 済み / discovery-run-started / finished / end）、開始からの経過分、同時に走っている本数（3 を超えていないか）。
2. 実験: 終わった case は 1 行で。campaign / 結果（completed か incomplete(理由)）/ Root wall 分 / 子の数 / Finding（対象範囲内・parked）/ Lead / 非 cache token / 停止理由。exit≠0 は campaign.log の最後の例外を 1 行で。
3. 本番: continuous status の 1 画面の要約（選ばれた slug と版、走っている Trial、終わった Trial、Finding の件数、runner の state）。
4. 異常の兆候: campaign.log か continuous.log に ZodError / provider-limited / provider-cyber-policy / provider-refusal / model-not-admitted / broker / timeout の語。discovery-run-started から 125 分を超えて finished が無い run。free メモリ 8 GiB 未満。disk 残 20 GB 未満。claude-agent-* と codex-agent-* の合計が 6 を超える。
5. 次に開発側がすべきこと（あれば）。

しないこと
- continuous stop / lab cleanup / docker stop / kill / rm を打たない。設定 file、host.json、campaign.json、selection.json、continuous.concurrency* を変えない。新しい Trial を起動しない。campaign resume も打たない（判断が要るときは command を報告に書く）。
- Private Evidence（<state>/private-evidence/）の候補本文、payload、HTTP 記録、認証情報、報告書の下書きを開かない・貼らない。台帳の件数と reason code だけを使う。
- git の操作（commit、push、branch、checkout、worktree）をしない。GitHub（Issue、PR、コメント、ラベル）に書かない。
- 異常を見つけても自分で直さない。報告に「要確認」と書いて止める。
- 探索の中身（どこを読むか、何を探すか）に口を出さない。

終了条件: wave.log に "all done ... arm=oh" が出たら、14 Trial の最終表（case / arm / 結果 / Root wall / 子の数 / Finding / Lead / 非 cache token / 停止理由）を 1 つ出す。その後は本番だけを 1 時間ごとに続ける。
```

## 起動時の既知の状態（2026-10-21 02:50 JST、監視セッションが再確認しなくてよいこと）

- 実験の driver は 2026-10-20T17:46Z（02:46 JST、ホスト時計は GitHub と一致）に起動済み。標準出力は `~/.local/state/wordpress-bounty-harness-child-model-20261021/driver.out`。
- os wave の最初の 3 本 mwwpform / kirki / c2c は 02:46〜02:47 JST に start し、台帳に `target-selected → snapshot-frozen → discovery-run-started` が記録済み。`claude-agent-*` 3 つと `provider-egress-broker-*` 3 つが Up。
- `ledger runtime` の行（Root と子のモデル）は `discovery-run-finished` の後に出る。走っている途中は空で正常。
- 本番 runner は pid 591540、`/home/dev/wordpress-bounty-harness-prod17` から動いていて Codex 3 本。

## Claude セッションで回すときの待ち方

- 観測の報告は `docs/reviews/2026-10-21-monitor-report.md` に JST の見出しを付けて追記する（Git に追加しない）。
- 待ち時間は Bash を `run_in_background` で `sleep 1800` として走らせ、完了通知で次の観測に入る。前面の sleep は使えない。Monitor ツールで `wave.log` の `=== end` / `all done` 行を待ってもよい。
- 許可されていないツール呼び出しが拒否されたら、別の読み取り手段に切り替えるか「読めなかった」と書く。中断しない。
