# 運用方針（2026-10-18 所有者決定）と現状の対照

調べて報告。正本ではない。所有者が 2026-10-18 に口頭で決めた「選定・探索・検証」の運用方針を書き起こし、origin/main `a3e8ab9` と open PR / Issue に照らして「ある・一部ある・無い」を分け、正本と衝突する点と所有者に確認が要る点を挙げる。変更はしていない。

## 0. 所有者の方針（書き起こし）

| 段 | 方針 |
|---|---|
| 選定 | アクティブインストール 10 万以上 100 万未満を機械的に固定する。基準に合う plugin が無ければ下限を 10 万 → 5 万 → 3 万と下げる。3 万でも無ければ 100 万超を許可する |
| 選定の履歴条件 | 未認証または Subscriber から実行できる Stored XSS、SQL Injection など、所有者が探したい class の公開記録が過去にあるかを見る。脆弱性が出たばかりの plugin を優先する |
| 選定の道具 | しばらく skill は使わず、インストール数と Wordfence Intelligence API の履歴で機械的に選ぶ。そのため Wordfence Intelligence の mirror を毎日更新する |
| 探索 | WP2Shell 記事からほぼ変更していない prompt（v7）を使う。検出能力はこれで問題ないとして進める |
| 検証 | skill にする。Finding があれば検証 skill が queue から取り出して実行する。判定器は「SQLi なら読み出せる物（パスワードハッシュ等）を定義し、同一の物を読めたか」のような形。そこまでの過程は AI に任せ、所有者が実行できる形（Python script、または人間に明確な手順）にする |
| 敵対的検証 | 探索 prompt に埋め込まれて探索内で行われる。検証側は「本当に再現できるか」だけを見る |
| ループ | 選定と探索は所有者が止めるか token が尽きるまで回してよい。検証は定期実行で Finding を検証する形でもよい。検証の方法自体は要確認 |
| 後回し | 人間レビューと報告書作成は、上のループが回るようになってから作る |

## 1. 現状との対照

### 選定

| 方針の要素 | 現状 | 判定 |
|---|---|---|
| 10 万〜100 万帯 | `policy/selection.json` に `minimumActiveInstallations: 100000` と `maximumActiveInstallations: 1000000`（PR #293 で入った） | ある |
| 下限を 5 万、3 万へ下げる | `selection.50000.json` / `selection.30000.json` がある。runner は候補枯渇で `exhausted` 停止し、所有者が別 file で起動し直す。OPERATIONS 第 1 節「install 下限は runner が無人で変えない」 | 一部ある。自動の切り下げは無い |
| 3 万でも無ければ 100 万超 | 無い。#295 は「100 万超は直近 1 年の公開記録 M 件以上を根拠にして選ぶ」案（open、ready-for-agent） | 無い。#295 と向きは同じ |
| 履歴条件（class と権限） | mirror の `signals` 表は class（stored-xss、sql-injection など）のみ。権限（未認証 / Subscriber）の列は無い。feed の record JSON は丸ごと保存しているので CVSS vector（PR:N / PR:L）から取れる可能性がある（未確認）。選定 code は `scoreBreakdown.history = 0` 固定、`historySignals` は読めるが効かない | 無い |
| 出たばかりを優先 | 選定の `recency` は WordPress.org の最終更新日。公開記録の新しさは見ない | 無い |
| Wordfence mirror の日次更新 | 正規化器は旧環境 `/home/dev/whitebox-harness/tools/refresh_wordfence.py`。手動実行。mirror の最終成功は 2026-10-14 01:39Z（4 日前）。#231 は低優先で close、PARKING に「鮮度不足が制約になったとき」 | 無い（手順はある） |

### 探索

| 方針の要素 | 現状 | 判定 |
|---|---|---|
| 記事 prompt v7 | PR #350 `codex/wp2shell-bounty-v7`。本文は所有者が用意。子 4、wall 120、索引なし。CI は `adr-guard` だけ失敗（`owner-approved` ラベル待ち）。「測った数字」は計測中（campaign `v7m-A-<case>-1018-r1`、3 case） | 一部ある。merge 待ち |
| 旧 mode の削除 | PR #351 `opus/delete-campaign-modes`。CI 全部通過。agent 入力は変えない | 一部ある。merge 待ち |
| 敵対的検証は prompt 内 | v7 本文に「adversarial agents」「doubly checked」の節がある | ある |
| 止めるまで回す | `continuous run` が select → campaign run → 次 batch を回る。本番 runner は 2026-10-17 に停止中。再開条件は #332 の数字（所有者決定 2026-10-18）だったが、本方針では「検出能力は問題ないとして進める」 | ある。再開条件の読み替えが要る |
| 探索だけで回す | #297（探索だけで止まる mode、検証は後から Finding 単位）は open。`campaign.json` に verification mode は無く、pipeline は探索の直後に検証 Lab を立てる | 無い |

### 検証

| 方針の要素 | 現状 | 判定 |
|---|---|---|
| 検証を skill にする | #352（`wbh-verify`、受入条件 3 つ）が open。skill は無い。現行は Harness が Verifier agent（`verifier-v7`）を起動する | 無い。設計は Issue にある |
| queue から取り出す | `verify next --campaign <id>` がある（#321）。review export に検証待ちが出る | ある |
| 「読み出せる物を定義して同一か判定」 | `wordpress-sql-canary`（播種した行の値が応答に返るか、または表が変わるか）と `wordpress-sensitive-object-canary`（播種したユーザーの資格情報などが返るか）が `judges.ts` にある。canary は nonce 付きで Lab 供給時に撒く | ある。方針と同じ形 |
| 所有者が実行できる形 | `standard-reproducer.ts` に HTTP step だけの Python route（`standard-reproduce.py`）があり、判定器もこれを読む。人間向けの reproduction package も `reproduction-package.ts` にある | ある。skill の出力をこの形に合わせれば足りる |
| 定期実行 | `verify next` は 1 件ずつ。timer や loop は無い。runner の `verifyNext` worker は探索と同じ process | 一部ある |
| 再現できるかだけを見る | Verifier 指示 v1〜v7 の連鎖、precondition 文からの scenario 選択は「再現方法を Harness が持つ」側なので #352 / #353 で削除予定 | 方針と同じ向き |

### 後回しのもの

`wbh-review` / `wbh-report` / `wbh-dedupe` は skill として存在する。触らなくてよい。

## 2. 正本と衝突する点（所有者決定の記録が要る）

1. **ADR 0030「対象選定では公開履歴を採点しない」**。履歴条件と「出たばかりを優先」はこの決定の反対。ADR 0032 への追記か、#353 の ADR 0033 に含める。#295 も同じ指摘をしている。
2. **DEVELOPMENT 第 2 節「選定方針の構造は凍結（数値は変えてよい）」**。履歴条件の field と下限の自動切り下げは構造の変更。
3. **OPERATIONS 第 1 節「install 下限は runner が無人で変えない」**。自動切り下げは明文の反対。切り下げたことは台帳の `target-selected` の reason に残す必要がある。
4. **ADR 0026「Verifier にブラウザや管理者セッションを渡さない」**。skill が Lab の前提（通常機能の設定）を作るなら管理者権限が要る。#352 は ADR 0033 で決めるとしている。
5. **AGENTS.md「索引を既定でカタログとして渡す」「既定 v5」**。v7 は索引なし。#350 が文書を揃えている（#339 も同じ）。

## 3. 所有者に確認が要る点（検証）

1. **誰が skill を回すか**。(a) AI session が `/loop` や timer で `verify next` を取り、skill で再現して判定器まで進める、(b) 所有者が時間のあるときに起動する。方針は (a) を許している。(a) なら判定器の出す `runtime-confirmed` だけが結果で、skill の自己申告は記録にしない（不変条件 3）。
2. **skill の権限**。Lab の前提を作るために管理者を使ってよいか。使うなら「前提作りは管理者、再現は trust 境界の役だけ」を手順で分け、HTTP 捕捉で区別できるようにする。
3. **出力の形**。判定器が読む HTTP step の Python route を正とし、人間向け手順（Markdown）を同じ package に並べる。これで「所有者が実行できる形」と「判定器が読む形」が 1 つになる。
4. **履歴条件の「権限」の取り方**。Wordfence feed の CVSS vector（PR:N / PR:L）か、title の文言か。前者を推奨するが、mirror に保存した record に vector が入っているかを確認してから決める。
5. **100 万超の条件**。「3 万まで枯渇したら許可」だけか、#295 の「直近 1 年に公開記録 M 件以上」も重ねるか。重ねる方を推奨する（大型 plugin に偏る問題は 2026-10-16 の本番で実測済み）。

## 4. 提案する順番（推論。採否は所有者）

| 順 | 作業 | 既存の Issue / PR | 大きさ |
|---|---|---|---|
| 1 | ADR 0032 に 2026-10-18 の選定決定（履歴条件、下限自動切り下げ、100 万超の条件）を追記し、ADR 0030 を改訂 | #295、#353 | 文書 1 本 |
| 2 | Wordfence mirror の日次更新。旧 script を `scripts/` へ移すか、旧環境のまま systemd timer で回し、`history status` を runner 起動前の gate にする | #231 を再 open | 小 |
| 3 | 選定: 履歴条件（class × 権限）、最新公開日の score、runner 内の下限 3 段切り下げと 100 万超段、reason を `target-selected` に残す | #295 を拡張 | 中。選定方針の test を 3 段で固定 |
| 4 | #351 を merge し、#350 は 3 Trial の数字を貼って `owner-approved` を付け merge。既定 prompt を v7 にする | #350、#351 | 待ちのみ |
| 5 | 探索だけで回す mode と `verify pending` | #297 | 中（Issue に 300 行以内） |
| 6 | `wbh-verify` skill と ADR 0033 の権限判断。出力は HTTP step の Python route ＋ 人間手順。Verifier 連鎖と scenario 正規表現を同時に削除 | #352、#353 | 大。開発セット 1 件で `runtime-confirmed` まで |
| 7 | 本番 runner を v7・探索のみで再開。検証は timer か AI session の loop で `verify next` → skill | #238 の完了条件を置き直す | 運用 |

4 は 1〜3 と独立で、今日から進められる。5 と 6 は 4 の後。2 は単独で先にできる。

## 未確認事項

- mirror の record JSON に CVSS vector が入っているか（`history.sqlite` を開いていない）。
- PR #350 の 3 Trial 計測の現在の進み（campaign `v7m-A-*`）。state dir は `~/.local/state/wordpress-bounty-harness-v6-measure-20261018/` の隣と推定。
- local checkout の main は origin より 91 commit 遅れ。この報告は origin/main を worktree に出して読んだ。
