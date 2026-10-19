---
status: accepted
date: 2026-10-19
amends: 0029（「Harness の続行差し込みは行わない」は自動継続に限る）, 0033（最低 60 分の同一セッション継続は segment をまたぐ）
---

# provider の拒否で止まった Root thread を、操作者の指示で新しい使い捨て sandbox に再開する

## 背景

v8 の協調 Trial は Root 1 thread を同じ gVisor container の中で `codex exec resume` し続け、最低 60 分・wall 上限 120 分で探索する（ADR 0033）。provider が構造化エラー `cyber_policy` を返すと run は `incomplete(provider: provider-cyber-policy)`、対象は `target-skipped(provider-refused)` になり、container と Codex home は捨てられる。Root がそこまでに読んだ source、立てた仮説、子の結果、`/workspace/research` の notes は Private Evidence に残るが、同じ thread を続ける手段は無かった。所有者は 2026-10-19 に「探索の途中でサイバーポリシーなどを止められた時用に再開機能が欲しい」と求めた。自動ではなく、操作者が指示したときだけ動く。

## 決定

### 再開できる run の規則（Harness 所有、決定論的）

`campaign resume --campaign <id> --run <runId> --config <path>` は、台帳と Private Evidence だけを読んで次を全部満たすときに限り再開する。1 つでも欠ければ理由を 1 行出して終了コード 3 で終わり、event を書かない。

1. `<runId>` は `discovery-run-started`（`runKind: explore`）が有り、`discovery-run-finished` が `outcome: failed`、`reason: provider`、`reasonDetail: provider-cyber-policy`。provider limit、wall、schema、sandbox、`completed` は再開しない（`not-a-provider-refusal`）。※ 2026-10-19 追記で `completed` 以外の全理由に広げた（下記）。
2. その run を `resumesRun` で指す後続 segment が無い（`already-resumed`。再開するなら最新 segment の run id を名指しする）。
3. Lab を付けていない run（`labAttached: false`）で、campaign 設定も `discovery.lab = none`（`lab-attached`）。
4. 現在の campaign 設定が凍結する Snapshot digest、目的 prompt の digest、runtime profile の digest が元の run と同じ（`snapshot-digest-differs` / `prompt-version-differs` / `runtime-profile-differs`）。prompt 本文に v8 の再開段落（`Before giving up,` で始まる最後の段落）が含まれている（`resume-paragraph-missing`）。
5. 元 run の sealed receipt が読め、`session`（Root thread id、`sessions/` 相対 path 付きの session file 一覧、segment 番号）を持つ（`receipt-unavailable` / `session-unrecorded`）。一覧の file が全部 Private Evidence から読める（`session-evidence-missing`）。
6. 残り wall ＝ 120 分 − 同じ chain の全 segment の `wallTimeMs` 合計 ≥ 5 分（`wall-exhausted`）。

### 再開 segment の動き

- **新しい container。** 同じ Snapshot の read-only source mount（digest を再検査）、同じ隔離 flag、新しい grant と `auth.json`。container は再利用しない。不変条件 2 はそのまま。
- **復元するもの。** Root と子の session file を `$CODEX_HOME/sessions/<相対 path>` に、notes archive の完全な file を `/workspace/research/` に置いてから起動する。Root の sealed rollout に Harness が付けた `sandbox_process_diagnostic` 行は除く。復元先は空の新規 directory で、`wx` 書き込みと path 検査（`..`・絶対 path・`rollout-*.jsonl` 以外を拒否）を通す。
- **最初の turn。** runner は `codex exec resume <threadId> -` に、元の prompt と同じ digest の再開段落を渡す。目的 prompt 本文は送り直さず、新しい文も書かない。以後は従来どおり最低時間まで同じ段落で継続する。segment の最低時間は 60 分 − 消費済み wall（下限 1 秒、少なくとも 1 turn は行う）、wall は残り wall。
- **台帳。** 新しい run id で `discovery-run-started`（同じ `trialId` / `trialOrdinal`、`resumesRun: <元 run>`、`resumeSegment: n`）と通常の `discovery-run-finished`。Finding / Lead はいつも通り記録し、同一内容は identity で `existing` になる。元 run の `failed` と `target-skipped` は消さず書き換えない。`ledger funnel` の `discoveryAttempts`、`by Lab` の runs、objective 別の runs は再開 segment を数えず Trial を 1 回として扱い、wall と token は合算する。`ledger stops` は再度拒否された segment を別の stop として数える。
- **receipt。** 協調 run は毎回 `session`（`rootThreadId`、`rootTurns`、`segment`、`files[]{path, threadId, kind, diagnosticArtifactDigest}`）を receipt に記録する。任意項目なので旧 receipt も読めるが、`session` の無い旧 run は再開できない。再開 segment が捕捉する子は新しい thread だけで、前 segment の子は前 segment が seal した digest をそのまま一覧に引き継ぐ。

### 変えないこと

- 自動継続はしない。ADR 0029 の「Harness の続行差し込みは行わない」は自動の話として残し、本 ADR は操作者が名指しした 1 run の 1 segment だけを許す。
- 同じ thread は再び拒否されうる。provider は内容で判断するので、再開が通る保証は無い。再度拒否されれば同じ規則で（残り wall があれば）もう 1 segment 再開できる。
- prompt の言い換えはしない（OPERATIONS「拒否を避ける目的で prompt を言い換えない」）。prompt `.md`、判定器、policy JSON は触らない。
- 不変条件 1（渡すのは固定 source・trust 境界・Programme Boundary と、agent 自身が書いた session / notes だけ）、2（gVisor の使い捨て環境、broker 経由の外向きのみ）、8（台帳は digest 参照だけ、session file は Private Evidence）は変えない。
- soft refusal（本文で断る応答）は `schema` 失敗として出るので対象外。

## 理由

- 拒否で失うのは Root の文脈だけで、source・Snapshot・prompt は変わらない。Codex の session file は `codex exec resume` がそのまま読める形式で Private Evidence に既にあり、復元に新しい agent 向け文章は要らない。
- 規則を台帳と receipt の既存項目から決定論的に引くことで、Harness に「再開すべきか」の判断を持たせない（AGENTS.md「Harness は制御だけを持つ」）。
- Trial を 1 回と数えるのは、再開が新しい Trial（同一対象の追加 Trial、ADR 0029 で禁止）ではなく同じ thread の続きだから。

## 採らなかった選択肢

- 拒否を検知して自動で再開する: ADR 0029 の自動継続禁止に反し、拒否が繰り返されると wall を無駄に消費する。
- 新しい thread で同じ prompt をやり直す: Root の文脈を失うので「再開」ではない。それは通常の再 Trial であり所有者の事前承認が要る。
- 再開時に拒否を避ける文を足す: OPERATIONS の規則に反する。
- container を止めずに保持する: wall と資源を占有し、使い捨ての前提（不変条件 2）を崩す。

## 帰結

- 実機で拒否を意図的に起こす手段は無く、本 PR では fake codex と fake sandbox で配線だけを確かめた。本番で次に `provider-cyber-policy` が出たら、所有者は `ledger stops`、該当 run id、`campaign resume` の出力（refused なら理由、resumed なら segment と残り wall）、再開 segment の `discovery-run-finished` を記録する。
- 本番台帳の v5 期の `provider-cyber-policy` 3 run は prompt に再開段落が無く receipt に `session` も無いので `prompt-version-differs` / `session-unrecorded` で拒否される。

## 消し方

`src/discovery/resume-trial.ts`、`tests/discovery/resume-trial.test.ts`、`tests/discovery/codex-sandbox-resume-seed.test.ts`、`tests/discovery/codex-runtime-session.test.ts`、CLI の `campaign resume` と `CliProfile.resumeCampaignRun`、`CodexSandboxCommand.resume` と sandbox の seed、runner の `argv[6]`、`DiscoveryTransportRun.resume`、`PlannedTrial.resumes` を削除する。receipt の `session` と台帳の `resumesRun` / `resumeSegment` は読取互換として残す。

## 2026-10-19 追記: 止まった理由を問わず再開できる

所有者は 2026-10-19 に「原因に関係なく停止した場合は再開できるようにしたい」と決めた。同じ日、prod-20261019-4 で sureforms と the-events-calendar の Root がモデルの満杯（`server_overloaded`）で止まった。それぞれ 6 分と 24 分走り、子 4 体が source を読んでいたが、規則 1 に当たらないので再開できず、新しい Trial としてやり直すしかなかった。

- 規則 1 を「`discovery-run-finished` が `completed` 以外」に変える。provider の拒否、provider 上限、モデル満杯、CLI の異常終了、schema、sandbox、wall のどれでも再開できる。`completed` の run は `run-completed` で拒否する。`not-a-provider-refusal` は使わない。
- 規則 2〜6 は変えない。wall に届いた run は、規則 6（残り wall 5 分以上）で実際には拒否される。receipt に `session` が無い run（sandbox が session を捕まえる前に落ちた run など）は、これまでどおり `session-unrecorded` で拒否する。
- 操作者が名指ししたときだけ動き、自動では再開しない。これは変えない。provider 上限で終わった run は、runner が backoff 後に新しい Trial としてやり直す（ADR 0029 の 2026-10-19 追記）。その対象を再開すると、runner のやり直しと重なる。provider 上限の run を再開するのは、runner を止めているときに限る。
- 終了 event の無い run（host の電源断など）は、この追記の対象外で `run-unfinished` のまま。別の変更で扱う。

