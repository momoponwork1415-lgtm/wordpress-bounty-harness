# 本番 runner の監視（別 session の AI が回す手順）

本番の探索 runner を、開発 session とは別の AI session が観測する手順。観測と報告が仕事で、舵取りはしない。許す操作は第 4 節の 1 つだけ。

## 1. 前提を読む

1. `AGENTS.md` の不変条件と「Harness と AI の責務」。
2. [OPERATIONS.md](../OPERATIONS.md) 第 2 節「ランナー」と第 4 節「1 件の手動 Trial」。
3. `docs/agents/ledger-reading.md`（台帳の読み方）。
4. `docs/adr/0036-operator-resume-after-provider-refusal.md`（`campaign resume` の条件）。

## 2. 実際の起動条件を確認する

checkout、`--state`、`--host`、campaign 設定、選定方針、接頭辞、出力ログを、稼働中のプロセスの引数と起動記録から確認する。Git 内の [campaign.json](../../src/profiles/wordpress/policy/campaign.json) は新規設定の基準であり、稼働中の runner が読んでいる Git 外の設定を置き換えない。認証情報ファイルの中身を表示しない。

2026-11-05 時点の引継ぎ情報: 直近の起動記録では checkout が `/home/dev/worktree/prod38`、本番 state が `/home/dev/.local/state/wordpress-bounty-harness`、Git 外 host 設定が `/home/dev/.config/wordpress-bounty-harness/host-production-v12-latest-core-xdebug-20261102.json`、接頭辞が `prod-c22` だった。campaign は `prod-c22-20261104-9`。Git 外 campaign 設定は `campaign-production-claude-opus-wide-3-skills-v22-lab-20261104.json` で、v22-wide、Lab 付き、Claude のみ、探索スキル 4 本、`priorResearch: same-target` である。PID ファイルのプロセスは存在せず、memo の `running` は古い。終了 event のない Trial が 3 件ある。この段落は状態の写しであり、次回の監視では必ず再確認する。リポジトリの新しい wide 方針は v26-wide だが、本番設定は自動的に切り替わらない。

## 3. 観測する

状態は必ず `--host` 付きで見る。

```bash
node dist/cli/main.js --state <確認した state> --host <確認した host 設定> continuous status
```

`continuous status` は PID の生存も照合し、memo が `running` でも PID が死んでいれば `stale` と表示して終了コード 1 を返す。`<state>/continuous-<接頭辞>.json` と `.pid` だけで稼働中と判断しない。台帳の正本は `<state>/ledger.sqlite` の `ledger_events`。`sqlite3` CLI がない host では `node:sqlite` の `DatabaseSync` を `readOnly: true` で開く。

稼働中は 5〜10 分おきに、止まっているときは状態変化の有無を次の項目で見る。

1. **選定**: 選ばれた slug と版、インストール数、更新日、初回 / 版上昇の理由、除外理由の件数。選定レポートは `selection-batch-bound` の artifact digest から Private Evidence を辿る。読むのは slug・版・数字だけ。
2. **Trial**: `discovery-run-started` に実際に記録された prompt 版と、稼働中のランナーが使う Git 外の campaign 設定を照合する。リポジトリの既定は `deep` が v11、`wide` が v26-wide（ADR 0051）だが、既存ランナーが自動的に切り替わるわけではない。同時に走る Root の数、Root ごとの子の数、wall、観測値（読んだ file 数、token）も見る。終了 event がない run は completed や候補 0 件に数えない。
3. **失敗**: provider 429（`provider-limited`）、`provider-cyber-policy` の拒否、`run-failed`、schema error、停滞（終了 event が無く出力も 30 分以上止まる run。2026-10-17 は websocket 426 の後に無言で止まり wall も発火しなかった）。host の memory（`free -g`）と container 数（`docker ps --format '{{.Names}}'` の `wbh-`）。
4. **Finding**: 件数だけ。category 別、`finding-parked` か対象範囲内か。本文、payload、path、証拠は読まない・引用しない。
5. **runner の停止**: `stale`、`stopped`、`stopping`、backoff の理由と直前の例外を記録する。再起動はしない。
6. **開発セットに戻す合図**（週 1 回）: 直近 7 日の対象範囲内 Finding が 1 件以上で、`manual-observation-recorded` の `match` が 0 件なら、[DEVELOPMENT.md](../DEVELOPMENT.md) 第 5 節の切り分け条件を報告する。Finding が 0 件なら探索側の停止理由と `incomplete` の理由を先に直す。
7. **検証の列**: 対象範囲内で、検証の無い Finding の group 数と、`incomplete(awaiting-human-observation)` のまま人間の観測が無い件数。滞留しても探索は絞らない（所有者決定 2026-10-26、「数は制限しない」）。数は検証の並列数と確認票の供給を増やす合図として使う。

## 4. 許す操作は 1 つ

Root が `provider-cyber-policy` で止まったとき、ADR 0036 と OPERATIONS を読み、`continuous run` が同じ host で動いている間に `campaign resume` を打てるか（runner の batch 間の掃除は探索の残骸だけを消し、`campaign resume` が生きている間は `<state>/sweep-holds/<pid>` で止まる。runtime ごとの同時数に収まるか）を確かめる。記録済みの campaign と run を名指しし、互換のある設定を確認できたときだけ 1 回打つ。

```bash
node dist/cli/main.js --state <確認した state> --host <確認した host 設定> campaign resume --campaign <id> --run <runId> --config <互換を確認した campaign 設定>
```

判断が付かなければ打たず、command を報告に書く。

停止した runner の復旧と探索方式の切り替えは監視 session の操作範囲外とし、操作者へ次の順を引き継ぐ。

1. 新しい main を**別の** checkout で build し、旧 Git 外設定を残して v26 の Git 外設定を別ファイルに作る。目的文、Lab、最低時間、子の上限、`followUp`、研究引継ぎが [campaign.json](../../src/profiles/wordpress/policy/campaign.json) と一致するか確認する。
2. 終了 event のない旧 Trial を台帳から列挙し、runtime と回収可否を確認する。2026-11-05 の `prod-c22-20261104-9` の 3 件は Claude の未終了 run で、[ADR 0036](../adr/0036-operator-resume-after-provider-refusal.md) の規則上 `campaign resume` は `run-unfinished` で拒否する。旧台帳を残して未終了として報告する。同じ接頭辞で runner を再起動すると、その対象は新しい Trial になり得る。
3. 同時に動く本番 runner がないことと停止マーカーを確認し、同じ選定方針・**同じ接頭辞**で v26 設定の `continuous run --resume` を起動する。旧 Claude run は個別再開されず、同じ対象を v26 の新 Trial としてやり直す。そのとき旧 run は集計上 `superseded` と扱う。別の接頭辞で起動すると旧 campaign の未終了 run が残るため、切り替えの経緯を台帳で追いにくい。runner のログで再開拒否理由と新 Trial を確認し、`continuous status` と次の `discovery-run-started` の prompt ID で実際の切り替えを確かめる。

## 5. しないこと

- runner、container、sandbox を止めない・殺さない・再起動しない。`docker rm` を打たない。
- code、prompt、skill、policy、host 設定を変えない。稼働中 checkout で build しない。
- Finding の本文や証拠を読まない。mirror の鍵を表示しない。
- 探索の中身（どこを読むか、何を探すか）に口を出さない。

## 6. 報告

1 時間ごと、または異常のたびに日本語で短く。所有者は「何件選ばれ、何件走り、何件終わり、Finding が何件、異常は何か」だけ知りたい。

- 時系列（JST）。
- 選定表: slug、版、インストール数、更新日、初回 / 版上昇の理由。
- Trial 表: campaign、slug、結果、wall、子の数、対象範囲内 Finding、parked、Lead。
- 異常と根拠（file と行、または event の identity）。
- 次に開発側がすべきこと。

数字と category 名だけで、Finding の中身は書かない。
