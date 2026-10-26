# 本番 runner の監視（別 session の AI が回す手順）

本番の探索 runner を、開発 session とは別の AI session が観測する手順。観測と報告が仕事で、舵取りはしない。許す操作は第 4 節の 1 つだけ。

## 1. 前提を読む

1. `AGENTS.md` の不変条件と「Harness と AI の責務」。
2. `docs/OPERATIONS.md` 第 1 節「継続運転」（止まる理由 6 つ、`status` の読み方、停止マーカー）と「対象の自動選定」。
3. `docs/agents/ledger-reading.md`（台帳の読み方）。
4. `docs/adr/0036-operator-resume-after-provider-refusal.md`（`campaign resume` の条件）。

## 2. 今回の起動条件（2026-10-19 01:04 JST）

| 項目 | 値 |
| --- | --- |
| checkout | `/home/dev/wordpress-bounty-harness-prod7`（origin/main 8e77ea5、build 済み） |
| state | `~/.local/state/wordpress-bounty-harness` |
| host 設定 | `~/.config/wordpress-bounty-harness/host-production-v5.json` |
| campaign 設定 | `~/.config/wordpress-bounty-harness/campaign-production-4x.json`（repo の `campaign.json` と同じ内容で `resources` だけ 4 / 4 / 43008 MiB） |
| 選定方針 | `~/.config/wordpress-bounty-harness/selection-production-2026-10-19.json`（repo の `selection.json` と同じ内容で `maximumHistoryAgeDays` だけ 14。PR #383） |
| prompt | `wp2shell-bounty-v10`、Lab なし（`discovery.lab: none`）、wall 120 分、Root ＋ 子最大 4 |
| 並列 | 対象 4 件まで同時 |
| mirror | 2026-10-14T01:39Z 時点。更新は cron 19:10 UTC、鍵は `~/.config/wordfence/env`（中身を読まない、表示しない） |
| 標準出力 | `~/.local/state/wordpress-bounty-harness/continuous-20261019.out` |

起動時に、前の方針で凍結した未消費の batch（または memo の campaign の batch）が今の方針 digest と合わなければ、runner は `selection-batch-discarded`（reason `policy-changed`）を台帳に書き、ログに `selection-batch-discarded batch=<id>` を 1 行出して、待たずに新しい選定へ進む（#302）。破棄した batch の対象は Trial を始めていないので、次の選定でまた選ばれうる。

## 3. 観測する

状態は必ず `--host` 付きで見る。

```bash
cd /home/dev/wordpress-bounty-harness-prod7 && node dist/cli/main.js --state ~/.local/state/wordpress-bounty-harness --host ~/.config/wordpress-bounty-harness/host-production-v5.json continuous status
```

台帳は `~/.local/state/wordpress-bounty-harness/ledger.sqlite` の `ledger_events`（`event_type`、`campaign_id`、`finding_id`、`event_json`）。この host に `sqlite3` CLI は無いので `node -e` と `node:sqlite` の `DatabaseSync` を読み取り専用で使う。

5〜10 分おきに次を見る。

1. **選定**: 選ばれた slug と版、score の内訳（paying class 件数、最終記録の新しさ、install）、`cascadeStep` の有無（主帯なら無印）、除外理由の件数。選定レポートは `target-selected` の artifact digest から Private Evidence を辿る。読むのは slug・版・数字だけ。
2. **Trial**: `discovery-run-started` の prompt 版が mode の現行版（`deep` は v11、`wide` は v14-wide）か、同時に走る Root の数、Root ごとの子の数、wall、観測値（読んだ file 数、token）。
3. **失敗**: provider 429（`provider-limited`）、`provider-cyber-policy` の拒否、`run-failed`、schema error、停滞（終了 event が無く出力も 30 分以上止まる run。2026-10-17 は websocket 426 の後に無言で止まり wall も発火しなかった）。host の memory（`free -g`）と container 数（`docker ps --format '{{.Names}}'` の `wbh-`）。
4. **Finding**: 件数だけ。category 別、`finding-parked` か対象範囲内か。本文、payload、path、証拠は読まない・引用しない。
5. **runner の停止**: `stopped(<理由>)` になったら理由と直前の例外を記録する。再起動はしない。
6. **検証の列**: 対象範囲内で、検証の無い Finding の group 数と、`incomplete(awaiting-human-observation)` のまま人間の観測が無い件数。滞留しても探索は絞らない（所有者決定 2026-10-26、「数は制限しない」）。数は検証の並列数と確認票の供給を増やす合図として使う。

## 4. 許す操作は 1 つ

Root が `provider-cyber-policy` で止まったとき、ADR 0036 と OPERATIONS を読み、`continuous run` が同じ host で動いている間に `campaign resume` を打てるか（runner の batch 間の掃除は探索の残骸だけを消し、`campaign resume` が生きている間は `<state>/sweep-holds/<pid>` で止まる。runtime ごとの同時数に収まるか）を確かめる。文書が安全だと言うときだけ 1 回打つ。

```bash
cd /home/dev/wordpress-bounty-harness-prod7 && node dist/cli/main.js --state ~/.local/state/wordpress-bounty-harness --host ~/.config/wordpress-bounty-harness/host-production-v5.json campaign resume --campaign <id> --run <runId> --config ~/.config/wordpress-bounty-harness/campaign-production-4x.json
```

判断が付かなければ打たず、command を報告に書く。

## 5. しないこと

- runner、container、sandbox を止めない・殺さない・再起動しない。`docker rm` を打たない。
- code、prompt、skill、policy、host 設定を変えない。
- Finding の本文や証拠を読まない。mirror の鍵を表示しない。
- 探索の中身（どこを読むか、何を探すか）に口を出さない。

## 6. 報告

1 時間ごと、または異常のたびに日本語で短く。所有者は「何件選ばれ、何件走り、何件終わり、Finding が何件、異常は何か」だけ知りたい。

- 時系列（JST）。
- 選定表: slug、版、score 内訳、`cascadeStep`。
- Trial 表: campaign、slug、結果、wall、子の数、対象範囲内 Finding、parked、Lead。
- 異常と根拠（file と行、または event の identity）。
- 次に開発側がすべきこと。

数字と category 名だけで、Finding の中身は書かない。
