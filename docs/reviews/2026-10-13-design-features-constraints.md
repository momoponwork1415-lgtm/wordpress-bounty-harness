# 全体設計・機能一覧・制約の出典（2026-10-13）

調べて報告。正本ではない。対象は branch `docs/2026-10-13-governance` HEAD `cae7561` と、PR #191（#185）の作業ツリー。読み取りだけで調べ、`.private`、Private Evidence、`~/.local/state` は読んでいない。

所有者の依頼: 「全体設計と詳細な機能一覧をまとめる。特に制約は、所有者が想定していないものが入っていそうなので出典を付ける」。

## 0. 先に結論

- **全体設計は SPEC 第 3 節の 1 本の流れで、人間の判断点は 2 つだけ**（提出前レビュー、外部行動承認）。2026-10-13 の ADR 0031 で、レビュー・報告書・重複照合は Harness の責務から外れて skill になった。
- **機能は CLI 23 コマンド、台帳 event 26 種、判定器 9 種、Lab scenario 10 本、探索 prompt 14 版 + Verifier 6 版**。詳細は第 2 節。
- **制約のうち、所有者の決定として文書で確認できるのは 5 群だけ**: 攻撃者位置、Reflected XSS / CSRF を目的外、`danger-full-access` + 外側 gVisor、WP2Shell 単一協調 Trial への回帰、Wordfence / Patchstack 閾値（公式転記）。**それ以外の数値の大半は Codex 名義 commit か AI 共著 PR で入り、根拠文書がない**。第 3 節に全件。
- **矛盾または無効になっている制約が 6 つ**ある（第 4 節）。runBudget は本番で効いていない、core 版が 6.8.3 と 7.1.3 で食い違う、ADR 0022 の自動再試行は未実装、重大 option 7 個固定が本物候補を落とした、plugin 固有 scenario が ADR 0026 と逆向き、同時実行既定 2 が SPEC「最初は 1 つずつ」と不一致。
- **所有者が決めるべき項目を第 5 節に 14 個**並べた。推奨を付けたが、決めるのは所有者。

## 1. 全体設計

### 1.1 目的と流れ

WordPress plugin の未知脆弱性を AI で発見し、実行時検証を通ったものだけを人間が Wordfence / Patchstack へ提出する（SPEC §1）。流れは 1 本（SPEC §3）:

選定（機械）→ Snapshot 凍結 → Lab 供給（gVisor）→ 協調 Trial（Root + 最大 3 子、対象ごとに 1 回）→ Programme Boundary で Finding を振り分け（#185）→ 独立 Verifier → 決定論的判定器 → 台帳 → `review export` → 人間が skill でレビュー・重複照合・報告書 → 人間が提出し転帰を記録。

### 1.2 不変条件（SPEC §2、8 条）

探索に答えを渡さない / 対象実行は gVisor 内だけ / `runtime-confirmed` は判定器だけ、証明は nonce 付き canary / 検証失敗は `incomplete` / 同じ Snapshot digest でだけ判定 / 人間の判断点は 2 つ / 外部送信は承認付きで人間が行う / 台帳は追記専用で digest 参照のみ。

### 1.3 モジュール境界（SPEC §4、ADR 0008、0011）

strict TypeScript のモジュラーモノリス。汎用 8 モジュール（selection / snapshot / lab / discovery / verification / ledger / review / evaluation）と薄い cli。WordPress 固有のものは `src/profiles/wordpress/` に閉じ、汎用側は profile の型だけに依存する。2 つ目の profile ができるまで汎用化しない。

### 1.4 責務の分割（ADR 0031、2026-10-13）

| 誰が | 何を |
| --- | --- |
| Harness（コード） | 自律ループ、決定論の観測（canary、HTTP 捕捉、差分観測器）、提出状況の台帳、`review export` |
| skill（`.claude/skills/`、所有者が対話で使う） | 候補の読み方（`wbh-review`）、重複照合（`wbh-dedupe`）、報告書（`wbh-report`） |
| 所有者 | 対照表で prompt / skill の要素を決める、レビュー batch、提出 |

### 1.5 設計の原則（LESSONS.md から、Step 1 に効くもの）

選定は出力境界で制御し prompt に頼らない / prompt は膨らむので byte 上限を test で固定する / 長い run は当たりを増やさない / 判断は skill、機械的な処理はコード / 見えない結果は無いのと同じ。

## 2. 機能一覧

### 2.1 CLI（`src/cli/index.ts:459-910`）

`--host <path>` 必須。状態は `~/.local/state/wordpress-bounty-harness`（`ledger.sqlite`、`private-evidence/`）。

| 群 | コマンド | 目的 |
| --- | --- | --- |
| 選定 | `select --config` | WordPress.org 候補を点検・採点し Snapshot を凍結、`target-selected` を記録 |
| 本番 | `campaign run <slug>` / `--all` `[--retry-incomplete]` | 選定 batch を campaign に bind し、凍結 → Lab → 探索 → 検証を回す。再開可能停止は exit 3 |
| レビュー | `review` / `review parked`（#191） | confirmed と incomplete の列 / Programme Boundary 外の 1 行一覧 |
| | `review decide` / `dedupe` / `scope` / `reverify` / `draft` / `authorize` / `submitted` / `outcome` | 人間の判断、重複照会、scope 評価、最新版再検証、文案保存、承認、提出、転帰の記録。Harness は送信しない |
| 台帳 | `ledger funnel` / `usage` / `runtime` | funnel・コスト・token、対象×日の token、runtime 別 run 数 |
| 運用 | `history status` / `runtime check` / `lab cleanup` | Wordfence ミラー鮮度、Codex 版と image の照合、残骸の削除 |
| 評価 | `eval score` / `keys` / `rubric` / `compare` / `prospective` | 答え鍵との位置重なり、鍵 manifest、blind rubric、arm 比較、前向き照合 |

`snapshot` 単独コマンドは無い（select / campaign run 内で凍結）。`lab up` / `lab down` は #186 で追加予定。ADR 0031 により `review decide` 以降の多機能は Step 2 で skill へ寄せる候補。

### 2.2 モジュール（主な入口）

| ディレクトリ | 役割 |
| --- | --- |
| `cli/` | 配線と preflight（Docker、runsc、pinned image、資格情報権限、Codex 版） |
| `selection/` + `profiles/wordpress/selection` | 候補列挙（popular / tag）、適格性、採点、台帳による除外 |
| `snapshot/` + `profiles/wordpress/acquisition` | WordPress.org 取得、manifest で封印、内容アドレスで凍結、pinned image から core 取り出し |
| `lab/` + `profiles/wordpress/lab` | gVisor の WordPress + MariaDB、録画 proxy、beacon 受信、canary 配置・観測、scenario |
| `discovery/` + `profiles/wordpress/discovery` | Trial 実行、停止規則、Codex in gVisor、egress broker、候補の正規化・受理・保留、出力契約、入口索引、storage 索引 |
| `verification/` + `profiles/wordpress/verification` | Codex Verifier、判定器 9 種、再現パッケージ |
| `ledger/` | SQLite 追記専用。append / read / usage / funnel |
| `review/` | 列、判断、scope、文案、承認、提出、転帰、重複照会 |
| `evaluation/` | 位置重なり採点、arm 比較（Clopper-Pearson）、前向き照合 |
| `infrastructure/` | canonical JSON / digest、source tree 照合、Private Artifact Store |
| `profiles/wordpress/wordfence-history` ほか | Wordfence ミラー、programme 規則の転記、scope 評価、受入基準 v1 |

### 2.3 台帳 event（26 種、`src/ledger/index.ts:33-349`）

target-selected / selection-batch-bound / snapshot-frozen / lab-provisioned / discovery-run-started / discovery-run-finished / discovery-concluded / campaign-stopped / target-skipped / candidate-rejected（旧、記録箇所なし）/ candidate-normalized / candidate-held / finding-recorded / finding-parked（#191）/ lead-recorded / child-report-recovered / discovery-report-recovered / verifier-run-finished / verification-finished / review-decided / scope-assessed / draft-saved / external-action-authorized / submission-recorded / submission-outcome。

funnel: reached → accepted / held / parked → raw → verified → confirmed / contradicted / incomplete → reviewed → inScope → submitted → outcome。`verification-finished` は追記時に digest 不一致・凍結記録なし・証拠未解決なら `incomplete` に格下げする。

### 2.4 判定器（9 種、`judges.ts`）

| 判定器 | impact | 証拠 |
| --- | --- | --- |
| administrator-principal | privesc-to-admin, auth-bypass-to-admin, account-takeover | session cookie の Lab 内検証、または攻撃者 role の変化 |
| non-administrator-principal | privesc-to-contributor+, auth-bypass-non-admin | contributor 以上の獲得、他人の session |
| sql-canary | sqli | canary テーブル変化、または request に無い canary 値が response に出る |
| execution-canary | rce, php-file-write | Lab 内実行でだけ生じる salt 付きの印 |
| file-canary-read / delete | arbitrary-file-read / download / lfi / delete | file canary 値の出現、または消失 |
| option-canary | options-update | canary option または重大 option 7 個の変化 |
| stored-script | stored-xss | script canary の beacon が Lab ブラウザ訪問で届く。画面写真必須。self は precondition |
| sensitive-object-canary | sensitive-object-access | 低権限 request への harness-captured response に保護オブジェクト値 |

判定器なし → `incomplete(no-judge)`: rfi, reflected-xss, csrf-to-write, idor, missing-authz, content-deletion, other。#185 で後 6 つは Finding として記録されず parked になる。

### 2.5 Lab

container 6 種（network `--internal`、volume、MariaDB、WordPress、録画 proxy、beacon 受信）+ 一時（WP-CLI、probe、Playwright）。image は全て `@sha256` 固定。core は pinned image からコピーし依存 Snapshot に凍結、`version.php` を campaign の版と照合。canary: option、投稿、post meta、ファイル、ユーザ、管理者 canary ユーザ、SQL canary テーブル、webroot 外と PHP source のファイル canary、role と option の基準値。scenario 10 本（汎用 4、plugin 固有 6）。被害者操作は Playwright が型付き手順で行い、Verifier にブラウザを渡さない。

### 2.6 探索

Trial = Root explore run 1 本。Codex `multi_agent` で子 3 まで、深さ 1。wall 60 分。同時実行 1〜4（既定 2）。prompt の組み立て順: objective → 出力契約 → trust boundary → Programme Boundary → Lab → 担当ファイル → 入口索引。候補は生のまま保存 → 正規化 → 受理 or 保留（ADR 0018）。入口索引は literal 登録の ajax / admin-post / REST / shortcode と 17 の request hook。mode: wp2shell（既定）/ entry-index-control / comparison / ablation / assignment。

### 2.7 検証

Finding ごとに Codex Verifier run 1 本（wall 30 分）、低権限アカウントだけ、impact 別に canary を発行、検証用 Lab を新しく作る。成果物 `http.json` / `steps.md` / `route.json` / `session.json` / `refutation.md`。judge.observe → observed なら再現パッケージ + `runtime-confirmed`。incomplete 理由 10 種（provision / precondition / recipe / provider / sandbox / observation / evidence / cleanup / digest-mismatch / no-judge）。

### 2.8 選定方針（`selection.json`、id `wordpress-selection-2026-10-12`）

prompt `wp2shell-bounty-v3`、再訪 version-or-prompt-changed、core 6.8.3、候補源 popular 1 ページ + tag upload / login 各 1 ページ × 20、maxCandidates 40、install 下限 10,000、観測 2 日、更新 365 日、対象 5、除外作者 Automattic / Facebook / Google / SiteGround / Yoast、攻撃面タグ重み、High Threat タグ 21 個、採点重み installations 10 / recency 5 / surface 1 / highThreat 15、runBudget 20 / 40。

## 3. 制約一覧と出典

出典の分類:

- **所有者**: SPEC / ADR / Issue に「判断者の指示」「所有者が決めた」と書かれている、または 2026-10-13 の対話で確認した。
- **公式転記**: Wordfence / Patchstack の公開ページの写し。
- **ADR**: AI が提案し所有者が merge した ADR に根拠がある。
- **Issue/PR**: Issue 本文または PR に値がある。多くは AI が「推奨: B」の書式で提案し、所有者が merge。
- **不明**: コード以外に根拠がない。Codex 名義 commit か AI 共著 PR で入った。

### 3.1 選定

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| selection.json:5 | 既定 prompt | wp2shell-bounty-v3 | ADR 0029、#143 |
| :6 | 再訪条件 | version-or-prompt-changed | #144 |
| :7 | core 版 | 6.8.3 | **不明**。開発セット（#40/#53）の値が #144 で本番へ写された。所有者は 2026-10-13 に「最新版（7.1.3）」と指示 |
| :10-15 | 候補源 | popular 1 ページ、tags upload / login、各 1 ページ × 20、上限 40、鮮度 1 日 | **不明**（Codex 8755bea）。所有者は 2026-10-13 に「指定した記憶はない。upload / login は有力。カテゴリは増やしてよい」 |
| :17 | install 下限 | 10,000 | Issue/PR（#99、Codex 共著）。#11 は 1,000、#32 は 500 だった。引き上げ理由なし |
| :18-19 | 観測鮮度 / 更新上限 | 2 日 / 365 日 | **不明**（#11 commit、値の記述なし） |
| :20 | 1 回の対象数 | 5（schema 3〜5） | #144 |
| :21-27 | 除外作者 | Automattic, Facebook, Google, SiteGround, Yoast | **公式転記**（Wordfence 対象外資産）。所有者が 2026-10-13 に確認 |
| :28 | 除外 slug | 空 | #32（ベンダー service 必須のものは手で入れる運用） |
| :29-37 | 攻撃面タグ重み | form / forms / upload 4、api 3、user / login / ecommerce 2 | **不明**（#11 の案 a） |
| :38-60 | High Threat タグ 21 個 | | #32 案 B。一覧の出典なし、「取りこぼしが見えたら見直す」のまま |
| :61-66 | 採点重み | installations 10、recency 5、surface 1、highThreat 15 | #32（highThreat のみ）、他は **不明** |
| :67-70 | runBudget | default 20、highThreat 40 | #32。**本番 wp2shell mode では maxRuns=1 に負けて無効** |
| wordpress-selection.ts:101-116 | 採点式 | log10(1+installs)×重み + 線形 recency、history = 0 | ADR 0030（history のみ）。式の形は **不明** |
| contracts.ts:93-98 | 候補源 schema 上限 | popularPages≤5、tags≤8、pagesPerTag≤5、perPage≤50、maxCandidates 5〜500、maxAgeDays≤7 | **不明** |
| enumerator.ts | 応答 1,000,000 B、1 ページ最大 50、timeout 15 秒 | | **不明** |

### 3.2 Snapshot と scope

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| wordpress-host.ts:105-111 | plugin 取り込み上限 | 20,000 entries、1 file 20 MiB、合計 200 MiB、path 512 B、深さ 32 | **不明** |
| wordpress-core-source.ts:14 | core 取り込み上限 | 20,000 entries / 512 MiB | **不明**（#67） |
| programme-scope.md | Wordfence 閾値 | High Threat ≥25、Common / 他 ≥500、1,000 未満は .org 掲載、premium ≥1,000 | **公式転記**（2026-10-08） |
| programme-scope.md | Patchstack 閾値 | ≥100、1,000 未満は CVSS ≥8.5 | **公式転記** |
| SPEC §8a | 攻撃者位置 | unauthenticated / subscriber / customer。contributor 以上は信頼側 | **所有者**（判断者の指示 2026-10-08、ADR 0027） |
| SPEC §8a | Reflected XSS / CSRF | 探索の目的にも提出候補にもしない | **所有者**（2026-10-08） |
| scope-policy.ts:145-152 | Stored XSS の self | out、別主体未確認は ambiguous | PR #153（#119） |

### 3.3 Lab

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| Dockerfile:1 | base image | wordpress:7.1.3-php8.3 | #178 / PR #180。**選定方針の 6.8.3 と食い違う** |
| container-startup.ts | 隔離 | runsc、`--internal`、no-new-privileges、recorder / receiver は read-only + cap-drop ALL | SPEC §2、ADR 0003 / 0009 |
| container-startup.ts | WordPress / DB container の資源上限 | なし | — |
| 各所 | tmpfs 65m / 16m / 512m、health check 60 回 × 10 秒、wp-cli timeout 60 / 120 秒、出力 64 KiB | | **不明** |
| SPEC §8b | 渡す認証情報 | subscriber（customerRole 時は customer）。管理者は渡さない | **所有者**（ADR 0027） |
| wordpress.ts:154 | DB 公開 | 既定 read-only | SPEC §6 |
| wordpress.ts:150-151 | 初期データ | title ≤120、posts ≤20 | **不明**（#26） |
| scenarios.ts | scenario | 汎用 4 + plugin 固有 6 | ADR 0020 / 0026。固有 6 は #157〜#169。**所有者が 2026-10-13 に plugin 別 scenario を止めた** |
| canary-placement.ts:16-24 | 重大 option | users_can_register, default_role, siteurl, home, admin_email, active_plugins, wp_user_roles | SPEC §7（4 個）+ #30（「等」の解釈で 3 個追加）。**監視外の本物候補を not-observed にした**（2026-10-13 review §2） |
| lab-observation.ts | 被害者 browser | screenshot ≤4 MiB、click 待ち 10 秒、発火待ち 3 秒、1 path 3 操作、path ≤5 | ADR 0021（path 5）。3 操作 / 3 秒 / 10 秒は **不明**（#31、#153） |

### 3.4 探索 runtime

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| codex-gvisor-sandbox.ts:37-39 | sandbox memory | 単独 2048 MiB、協調 8192 MiB | **不明**（旧 repo 移植、PR #101） |
| :442 | CPU | `--cpus=1`（Root + 子 3 で共有） | **不明**（Codex 22fd97c）。**所有者 2026-10-13: 外す**（#184 で 6 へ） |
| :440, 443 | pids / tmp | 256 / 256m | PR #101 / **不明** |
| :436-439 | 隔離 | runsc、read-only rootfs、cap-drop ALL、no-new-privileges、非 root | **所有者**（SPEC §14 2026-10-08）、SPEC §2 |
| :559-566 | mount | source / core は ro、Lab / DB は add-host だけ | SPEC §6、ADR 0003 |
| :335 | wall の絶対上限 | 240 分 | **不明**（60 → 240、#69） |
| :47-50 | rollout 取り込み | 256 file、header 64 KiB、1 session 60 MiB、合計 240 MiB | #121（値の根拠なし） |
| codex-native-agent-runtime.ts:992 | CLI 内側 sandbox | `danger-full-access` | **所有者**（SPEC §14 2026-10-08） |
| :996-1034 | 自律実行 | approval never、user config / rules 無視、apps / remote_plugin / unified_exec 無効、履歴なし | 旧 repo 移植 |
| :1009 | Web 検索 | disabled | SPEC §2、ADR 0009 |
| :1015-1017 | 子の数 / 深さ | 3 / 1 | ADR 0016 / 0029 |
| agent-runtime-profile.ts | model / effort | 協調は gpt-6-sol + daybreak_blue 必須、子は同 model / effort、CLI ≥0.161.0 | ADR 0016 / SPEC §6。effort の値は Git 外 host 設定 |
| :1197-1199 | broker | 要求 協調 1,600 / 単独 100、本文 8 MiB / 1 MiB、応答 8 MiB | ADR 0017 / OPERATIONS.md:51-52。応答は **不明** |
| broker.ts:30 | broker container | 512 MiB、cpus 1、pids 64 | 旧 repo 移植 |
| wordpress.ts:180-185 | 本番 wall | 既定 60、上限 60、入口索引を強制 | ADR 0029（実測 35〜38 分への暫定値） |
| wordpress.ts:164-165 | 本番 Trial 数 | maxRuns 1、noFindingRuns 1 | ADR 0029 |
| wordpress.ts:141-146 | 同時実行 | 1〜4、既定 2、memory 10,240 MiB | #33、ADR 0014。**SPEC §6「最初は 1 つずつ」と不一致**。所有者 2026-10-13: 2 → 3 |
| wordpress.ts:116 | screening-v1 の新規起動 | 禁止 | ADR 0029 |
| wordpress.ts:983-995 | 公開履歴 | ablation の history arm だけ。本番は none | ADR 0012 / 0030 |
| entry-points.ts:52-83 | 入口索引の範囲 | literal 登録の ajax(-nopriv) / admin-post(-nopriv) / REST / shortcode、request hook 17 個。menu 画面、block、cron、変数名登録の hook は入らない | **不明**（2026-10-09 の設計案の一部） |
| storage-index.ts:53-55 | 索引上限 | PHP 20,000 file、1 file 2 MiB、component key 200、超過は partial | **不明**（#70 は「上限」のみ） |

### 3.5 探索 prompt（`wp2shell-bounty-v3.md`、`trust-boundary-v1.md`）

| 行 | 制約 | 出典 |
| --- | --- | --- |
| v3:3 | 攻撃者 3 位置、contributor 以上は信頼側、脆弱性があると前提しない | **所有者**（SPEC §8a）、ADR 0027 |
| v3:5 | 影響の優先順位（rce 先頭、stored-xss 7 番目、sensitive-object-access 最後）、部分 primitive を Finding にしない、「それ以外の具体的効果も記録」 | SPEC §8b「報奨順を書き」。**順位の根拠なし**。所有者の有償実績（ATO / Stored XSS / SQLi）と不一致。「それ以外も記録」が `other` 候補の直接の出典 |
| v3:7 | 子 3、脆弱性の種類を事前に与えない、approach family registry | ADR 0016 / 0029 |
| v3:9 | 1 波目が空でも止めない、結合は全辺に裏付けがあるときだけ | ADR 0017（WP2Shell 由来） |
| v3:11 | 2 波以上、最初の優先 Finding 後に別 family の波、2 波連続で増分なしなら停止、最低時間なし | ADR 0017 / 0029 |
| 出力契約 v2 | 子にも契約全文、4 key、Root は JSON 文字列 | ADR 0019、#143 |
| trust-boundary-v1:5-9 | role を超えない、既定設定、安全でない設定を仮定しない、確認は判定器 | SPEC §8a / §2 |
| discovery-prompts.test.ts | 禁止語（CVE / PoC / advisory / payload / 対象名 / 「at least N hours」）、digest pin。**byte 上限なし** | ADR 0012 / 0013 / 0029 |

### 3.6 出力契約（Finding / Lead schema）

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| finding.ts:36-81 | 文字数 | claim ≤4000、precondition / brokenProperty ≤1000、controls / labObservations ≤4000、function ≤256、sourceTrace ≥1 | **不明**（#25） |
| finding.ts:37 | attackerPosition | 3 値 | **所有者**（SPEC §8a） |
| finding.ts:41-64 | impact | 22 値 | SPEC §8b 共通分類 |
| lead.ts | Lead | summary ≤2000、primitive 5、storage kind 6・key ≤200、missingEdge 5 | **不明**（#72） |

### 3.7 検証

| 場所 | 制約 | 出典 |
| --- | --- | --- |
| verifier-v6.md:3 | 反証を試みる。他の脆弱性を探さない。確認判定を出さない | SPEC §7。**所有者 2026-10-13: 「発火の確認」へ向きを変える（#187）。未反映** |
| v6:5 | 低権限の位置だけ、DB と core は読むだけ | SPEC §7 |
| v6:7 | 被害者 path 1〜5、被害者の資格情報を使わない | ADR 0021 |
| v6:9-13 | canary 以外のコードを書かない、principal は fresh account、過去の確認経路は同じ手順 | PR #65 / #101 |
| v6:15 | 6 field、中身は文字列 | SPEC §7 |
| codex-verifier.ts:454 | Verifier wall | 30 分 | **不明**（#24） |
| judges.ts:33-52 | 証拠 schema | steps 1〜30、exchanges 1〜500、cookie / url ≤4096 | **不明** |
| pipeline.ts:327-333 | 再検証 | Lab Setup digest が同じなら再検証しない（`--retry-incomplete` が例外）、scenario retry は直前 precondition + 別 scenario | #171、ADR 0020。**ADR 0022 の自動再試行（recipe / observation 2 回、provision 1 回）は未実装** |

### 3.8 台帳

| 場所 | 制約 | 値 | 出典 |
| --- | --- | --- | --- |
| ledger/index.ts:466, 814 | read 件数 | 最大 1000、既定 100 | **不明**（#8）。pipeline.ts の 19 箇所が `limit: 1000` で頁送りせず、超過は黙って切れる |
| :45 | selectionIds | 1〜5 | #144 |
| :157 | 取り込む子 thread | ≤3 | #121 / ADR 0029 |
| :347 | 報奨額 | ≤1,000,000 USD | **不明** |

## 4. 矛盾と無効化

| # | 事実 | 影響 | 直す Issue |
| --- | --- | --- | --- |
| 1 | `runBudget` 20 / 40 は本番 wp2shell mode の `maxRuns = 1` に常に負ける | High Threat 対象に多く回す設計が効いていない。選定の採点だけに影響 | 新規（#184 で条件付き追加 Trial と一緒に決める） |
| 2 | 選定方針 core 6.8.3、Dockerfile 既定 7.1.3 | 実際の image は Git 外 host 設定が決め、方針ファイルは参考値になっている | #184（所有者指示: 最新版） |
| 3 | ADR 0022 の自動再試行が未実装 | incomplete(recipe / observation) が手動 `--retry-incomplete` 待ち | #107 |
| 4 | 重大 option 7 個固定 | 監視外 option への書き込みが `not-observed` になり候補を落とす | #186（実行前後の差分観測器で option 全体を見る） |
| 5 | plugin 固有 scenario 6 本 | ADR 0026「plugin 非依存を優先」と逆。保守負担 | PARKING.md に止め済み。消すかは Step 2 |
| 6 | 同時実行既定 2 vs SPEC §6「最初は 1 つずつ」 | 文書と既定の不一致 | #184 で SPEC §6 を 1 行直す（owner-approved 要） |

## 5. 所有者が決めること

AI が決めた値のうち、結果に効くものだけ。番号は依頼のための札。推奨は参考で、決めるのは所有者。

| # | 項目 | 今の値 | 推奨 | 理由 |
| --- | --- | --- | --- | --- |
| D1 | 選定の候補源タグ | upload, login | 所有者が 3〜6 個を列挙する。AI は増やさない | 2026-10-13「カテゴリは増やしてよい」。login / security への偏り（15 対象中 9）は AI の値から来た |
| D2 | install 下限 | 10,000 | 所有者の報奨下限（Wordfence High Threat 25 / Common 500 ではなく実益のある規模）に合わせて決める | 1,000 → 500 → 10,000 と動いた経緯に理由がない |
| D3 | High Threat タグ 21 個と重み 15 | #32 の案 B | 当面維持。D1 と同時に見直す | 選定の偏りの原因の半分 |
| D4 | 更新上限 365 日 / 観測鮮度 2 日 | | 維持 | 結果への影響が小さい |
| D5 | runBudget の扱い | 20 / 40（無効） | #184 の条件付き追加 Trial（初回で scope 内 Finding があれば +2）に置き換え、runBudget は消す | 無効な設定を残さない |
| D6 | core 版 | 6.8.3（方針）/ 7.1.3（image） | 7.1.3 に揃え、方針ファイルの値を正本にする | 所有者指示 |
| D7 | sandbox CPU | 1 | 6（#184） | 所有者指示 |
| D8 | 同時実行 | 2 | 3（Opus 併用時は 2） | 所有者指示 |
| D9 | v3 の影響優先順位 | rce 先頭、stored-xss 7 番目 | v4 の対照表で所有者が決める | 有償実績は ATO / Stored XSS / SQLi |
| D10 | 「それ以外の具体的効果も記録」 | v3 にあり | v4 で外すかを対照表で決める | `other` 候補の出典。#185 で parked になるので害は減った |
| D11 | 重大 option 7 個 | 固定 | #186 の差分観測器で option 全体の差分を取り、固定 7 個は参考に落とす | 本物候補を落とした |
| D12 | Verifier wall 30 分 | | 維持。#187 の計測で再考 | 根拠がないが、変える根拠もまだない |
| D13 | Finding の文字数上限 | claim 4000 など | 維持 | 保留の原因になった記録はない |
| D14 | 台帳 read 1000 件 | 頁送りなし | pipeline.ts の 19 箇所を頁送りに直す（小 PR） | 本番周回が増えると黙って切れる |
| D15 | Reflected XSS の扱い | Wordfence 対象外、Patchstack 向けにも出さない（所有者 2026-10-08） | Wordfence 向けは除外のまま。Patchstack 向けに出すかだけ決める。出すなら #185 の除外から外し、判定器なしのまま人間レビューへ | 所有者の有償 18 件のうち 7 件が reflected XSS（2026-08-30 まで有償）。live page（所有者貼付 2026-10-13）で「Explicitly Out of Scope」を確認。変更日は未確認 |
| D16 | `content-deletion` を #185 で parked にするか | 除外（SPEC §8b「探索の目的に含めない」、出典は AI） | 除外から外す。判定器が無いので `incomplete(no-judge)` として人間レビューへ届く | Wordfence の live page は「Arbitrary Content Deletion」を Explicitly In-Scope に挙げ、1337 tier は ≥500 install で報奨対象。programme-scope.md も Wordfence 側で受理に分類している。偽陰性を避ける所有者方針と合わない |

## 6. 未確認の仮定

- 本番 campaign config は Git 外にあり、ここでは `examples/translatepress-3.3.1/campaign-production-v1.json` と schema 既定値で代用した。実際の host 設定の effort / image digest は見ていない。
- 出典「不明」は「文書と commit message に根拠が無い」の意味で、所有者が口頭で決めた可能性は排除できない。所有者が覚えているものがあれば、この表に書き足す。
- 行番号は HEAD `cae7561` と PR #191 の作業ツリーのもの。
