# 開発計画の整理（2026-11-01 夜）

所有者の「開発計画について整理して」への答え。正本ではない。項目ごとに、いまの状態、決めてあること、まだ決めていないこと、大きさを分けて書く。番号は所有者が 2026-11-01 に並べた順に合わせ、既存の track は後ろにまとめた。

## 1. 今日（2026-11-01）終わったこと

| 項目 | Issue / PR | 状態 | 本番適用 |
| --- | --- | --- | --- |
| 選定: 下限 5,000、タグ無し、batch 10 | #739 / PR #740 | merge 済み | 未（設定は用意済み。ランナー再起動で `selection-batch-discarded` が 1 回出る） |
| 選定: 更新の鮮度 365 → 180 日。順序は install 降順のまま（ADR 0037 の leak 注記で updated 順を撤回） | #742 / PR #743 | merge 済み | 未（同上） |
| Lab 基準 v3: Wordfence が受け付ける入口は閉じない、`DISALLOW_FILE_EDIT`、wp-includes の直接実行禁止 | #744 / PR #745 | merge 済み | 新 build で自動 |
| 探索 Lab も同じ基準に立つ | #746 / PR #747 | merge 済み | 同上 |
| WordPress 本体を常に最新の安定版に（image が正、`select` が version-check と照合、ランナーは遅れていれば待つ、`refresh-image.sh`、ADR 0047） | #741 / PR #748 | merge 済み | 未（image 7.1.4 と設定 3 つを用意、`runtime check` ok） |
| 探索スキル `wbh-setup-v1`（Lab で plugin の通常利用を作る） | #749 / PR #750 | checks 待ち → merge | Lab 付き campaign で名指し。本番 v19-wide（Lab なし）は変えない |

本番ランナーは 2026-11-01 07:00Z の operator 停止のまま。再起動は所有者の go で、`/home/dev/worktree/prod28`（main、#750 を merge したら pull し直す）から `*-latest-core-20261101.json` の 3 設定で起動する。再起動後の v19 の数字は選定母集団が変わるので v18 と対になっていない。

## 2. 所有者の一覧の残り（説明 → ok → 実装の順で 1 つずつ）

### 2.1 外部サービス連携の plugin はソースだけの探索、有望なら人間が account と通信許可を用意して再探索

- **いまの状態**: 探索はすでにソースだけである。sandbox と探索 Lab に internet は無い（`--internal` network、broker 経由の provider API だけ）。検証 Lab の外部接続は ADR 0046 の 6 条件で通常運用になったが、Harness に中継器と公開入口の道具はまだ無く、AI 操作役が案件ごとに用意する（OPERATIONS 第 3 節）。`wbh-setup-v1` も外のサービスが要る object は作らず記録だけする。
- **決めてあること**: 所有者の 2026-11-01 の方針そのもの。段 1 の `wbh-screen` 規則 4（外部サービス由来の値は、普通の account を持つ誰もが書けるときだけ要検証）。
- **まだ決めていないこと**: (a) 「再探索」の形。ADR 0044 の第 2 Trial（Lead 入力 + 探索 Lab）に ADR 0046 の 6 条件で外部接続を付けるのが自然だが、探索 Lab の出口中継器は Harness の網の境界なので Harness のコードになる（制御だけなので責務の内側）。(b) 中継器を Harness に作るか、当面手作業のままか。(c) 対象の見分け方。段 1b の未決 22 件のうち外部サービス 13 件（#667）が最初の母集団。
- **大きさ**: 文書だけなら ADR 0046 への追記 1 つ。中継器を作るなら Harness の PR 1 本（Lab の network と記録）。
- **先に答えてほしいこと**: 中継器を Harness に作るか（提案は作る。手作業は 6 条件の 2 と 6 を毎回人が満たすことになる）。

### 2.2 プロンプトの組み立ての簡素化: 常に読み込まれる 1 枚の目的文 + スキルへの routing、断片の分割をやめる

- **いまの状態**: 目的文は `sections/<section>/<file>.md` の断片 9 つを `fragments` で組み、版ごとに digest を固定している（v11 deep、v14-wide current、v19-wide candidate）。断片は 5 directory に 33 file。スキルは `discovery.skills` で別に置く。
- **決めてあること**: 所有者 2026-11-01「分割方式はいらない。AGENTS.md のような常に読む 1 枚に目的を置き、長くなるなら WordPress 固有知識やスキルへの routing を書く。任せる」。
- **衝突**: ADR 0045（2026-10-31 夜）の凍結 5 項目と「設計変更は月 1 回」「v20 以降を作らない」。1 枚にまとめると本文の byte が変わり新しい目的文 id になる。これは ADR 0045 を改訂する決定で、v19 の計測（20 Trial）の後に「今月の 1 回」として入れるのが規則に合う。
- **提案する形**: 本文の意味は v19-wide のまま（文を足さない、消さない）で、断片の結合をやめて 1 file にし、末尾に「スキル `wbh-recon` / `wbh-tools` / `wbh-setup` を使う場面」の routing 段落だけ足す。`fragments` の仕組みは過去 Trial の digest 照合のために残し、新しい版だけ 1 file で持つ。
- **大きさ**: prompts の registry と 1 file、ADR 0045 の追記、全文と日本語訳の review 文書、owner-approved。Harness の組み立て関数は「1 file も通す」分岐 1 つ。
- **先に答えてほしいこと**: v19 の計測を待ってから入れるか、いま入れるか（提案は待つ。待たないなら ADR 0045 の「月 1 回」をこの変更に使うと明記する）。

### 2.3 子を新しい文脈で始める（Root の会話履歴を引き継がせず、file で渡す）

- **確かめた事実（2026-11-01、本番 v19 Trial の Codex 0.164 の rollout から）**: 子は Root の会話を丸ごと引き継いで始まる。子の rollout の先頭 59〜61 件は Root の履歴そのもので、その直後に developer 文「You are now a newly spawned child agent. The preceding conversation is inherited parent context.」が入る。子の最初の turn の入力は約 40,000 token（Root の最初の turn は 14,000）。v19 の Root 20 run は平均 7.8 体の子を立て、Trial の入力 token は平均 450 万（cache 込み）。
- **切り替えの口はある**: `spawn_agent` の引数 `fork_turns`（「Parent history to inherit. Defaults to `all`; use `none` to start without parent history.」）。Root は既定の `all` で呼んでいる。設定 file（`[agents]`）や custom agent の TOML にこの切り替えは無い（公式 docs を読んだ。context の渡し方自体が docs に無い）。つまり **Harness の設定では変えられず、Root が spawn のたびに選ぶ**。
- **提案**: `wbh-recon` の手順 8（引き継ぎ）に「子は親の履歴を引き継がずに始め、地図の節・tsv の行・setup 記録の行を message で名指す」の 1 文を足して v2 にする（agent に渡る文章、owner-approved）。Harness は変えない。測るのは子の最初の turn の入力 token（rollout から）、Trial の入力 token、Finding / Lead / Trial、段 1b 通過。子が親の読みを失って同じ file を読み直す分は「読んだ file / Trial」で見える。
- **大きさ**: SKILL.md 1 文 + registry の行 + review 文書。Claude runtime の子は別の仕組みなので、この文は「runtime が許すなら」と書く。

### 2.4 Finding / Lead の重複除去（設計書の S6 の前段）

- **いまの状態**: `scripts/lead-groups.mjs`（`overlap` / `pair` 規則）で Lead を束ねる道具はある（ADR 0044）。Finding 同士は `review dedupe`（公開情報との照合）はあるが、Trial 内・Trial 間の自己重複は人間が見ている（2026-10-28 の段 1b で 36 件の自己重複）。
- **決めてあること**: Harness は判定しない。束ねるのは AI 操作役か agent の仕事で、Harness は記録だけ（所有者 2026-10-27「中身は AI、形は Harness」）。
- **提案する形**: 同じ Snapshot の Finding に `lead-groups.mjs` と同じ規則を当て、レビュー列の表示で群にまとめる（`review` の出力に群 id を足す。判定ではなく表示）。
- **大きさ**: script の拡張 1 本と `review` 出力の列 1 つ。

### 2.5 plugin ごとの事実の DB（S6 → S3 の再利用）

- **いまの状態**: `lab-setup.md`（#750）が最初の file。`recon-map.md`、`tools/*.tsv` も Trial ごとに research artifact として封じられるが、次の Trial には渡らない。
- **決めてあること**: 探索に渡せるのは固定ソースとカタログ情報だけ（不変条件 1）。自分の過去 Trial の研究 file は固定ソースから作った派生物で、答えでも公開履歴でもないので渡せる。ただし Lead の文は ADR 0044 の第 2 Trial の入口に限る。
- **まだ決めていないこと**: 渡す単位（recon-map と lab-setup だけか、tsv も含むか）、版が上がったときの扱い（差分監視 #724 と同じ問い）。
- **大きさ**: Harness が `## Prior research` のような節で file を置く仕組み 1 つ（ADR 0044 の priorLeads と同じ型）。文書と test。
- **順番**: 2.1〜2.4 の後。#724（三つの戦力）の差分監視と一緒に設計するのがよい。

## 3. 並走している track（所有者の一覧の外）

| track | いまの状態 | 次の一手 | 待っているもの |
| --- | --- | --- | --- |
| 探索の計測（v19-wide） | 本番 35 Trial 相当の v18 と比べる予定。ランナー停止中 | 再起動 → 20 Trial → ADR 0039 追記 16 の 4 つの数字 | 所有者の go |
| 検証の無人化（#701） | PR #709 draft、cycle 1 済み | 段 0b〜③ を Codex の一発 run にする #648 は保留 | Lab の slot、人間の観測 |
| 検証の手順（wbh-verify） | #751（setup 記録の形）、#576（set-file）、#712（PHP session） | #751 を先に | owner-approved |
| 三つの戦力（#724、ADR 0045） | 設計済み。v19 計測の後に開始 | 差分監視を 2.5 と一緒に設計 | v19 の数字 |
| bench30 v3（#726） | 30 plugin、198 record、score-v3 | スキル S0〜S7 の単体テストの答えとして使う | — |
| 探索スキル列（#682、ADR 0043） | recon v1、tools v1、setup v1。trace は PR #697 draft | #697 を bench30 で採点してから | 数字 |
| 選定 | 本番適用待ち。WordPress.org / Performance Team の作者除外は HackerOne の範囲が未確認で保留 | #721 / PR #722（自前 bounty の plugin を除く、外部の bot）を確認 | — |
| Issue の整理 | ready-for-human 9 件（#667 #640 #576 #523 #435 #428 など） | 所有者の判断が要るものを 1 回の会話でまとめて聞く | 所有者 |
| 開いている PR | #738 #737（設計の文書）、#722（外部）、draft #709 #697 | 文書 2 本は merge か close を決める | — |

## 4. 規則との関係で注意すること

- **ADR 0045 の凍結 5 項目**: 2.2 は目的文の形を変えるので凍結に触れる。入れるなら ADR 0045 を改訂し、「今月の 1 回」をこれに使うと書く。2.1、2.3、2.4、2.5 と今日の 6 件は凍結の外（スキル、設定、Lab、選定、Harness の制御）。
- **back-pressure**（pr-review-merge.md、open PR > 3 で新しい実装 PR を止める）: 今日は所有者の直接の指示で越えた。#738 / #737 / #697 / #709 の整理をすれば戻る。
- **agent に渡る文章**: 2.2、2.3（手順に触れるなら）、#751 は全文と日本語訳と owner-approved。
- **ランナー再起動**: 所有者の go なしに行わない。

## 5. 提案する順番

1. PR #750 を merge（checks 待ち）→ prod28 を pull → 所有者の go でランナー再起動（今日の 6 件が本番に乗る）。
2. 2.1 の答え（中継器を Harness に作るか）→ ADR 0046 追記か PR。
3. 2.3 は事実が出た（子は履歴を全部引き継ぐ、`fork_turns: none` で切れる）。`wbh-recon` v2 の 1 文で入れるか決める。
4. 2.4 の script と表示。
5. v19 の 20 Trial が出たら、2.2（目的文を 1 枚に）を今月の設計変更として ADR 0045 を改訂して入れる。
6. 2.5 と #724 の差分監視を一緒に設計する。
7. 並走: #751、#697 の採点、Issue の ready-for-human をまとめて聞く。
