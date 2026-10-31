# 計測の手順（AI 向け）

DEVELOPMENT §5 の「探索に触る PR は数字を貼る」（分母は本番の対象。開発セットは本番で Finding は出るのに `match` が 1 週間 0 件のときの切り分けだけ。所有者決定 2026-10-26）を、AI が自分で回すための手順。正本は [DEVELOPMENT](../DEVELOPMENT.md) §5 と [SPEC](../SPEC.md) §6〜§7。規則は足さない。

## いつ使うか

- agent 入力（prompt、skill、Harness 生成の節）を変える PR → 本番の同じ選定帯で旧版と新版を交互に回し、Trial 数をそろえる。採否は DEVELOPMENT §5 の 6 段（本番の読み替え）。
- 本番で Finding は出るのに人間の `match` が 1 週間 0 件 → 開発セット 6 case を各 3 run（18 Trial）回し、探索と検証を切り分ける。
- 配線・runtime・選定を変える PR → 異なる slug 3 件の初回 Trial（runner が回すのと同じ経路）。
- どちらも本番の分母に混ぜない。campaign ID に branch 名か用途を入れる。

## 1. 統合 branch と build

複数の未 merge PR をまとめて測るときは、main に各 PR の head を merge した統合 branch を作る。

```bash
git worktree add -b claude/<用途>-integration <scratchpad>/wt-int origin/main
cd <scratchpad>/wt-int && git merge --no-edit origin/<pr-branch-1> origin/<pr-branch-2>
pnpm install --frozen-lockfile --prefer-offline && pnpm check && pnpm build
```

Trial が走っている間、この worktree を消さない（`dist/` を使い続ける）。

## 2. Git 外の state

case ごとに分ける。1 case = `state/`（台帳と Private Evidence）と `work/`（host.json、campaign.json、selection.json）。

```text
~/.local/state/wordpress-bounty-harness-<用途>-<日付>/<case>/{state,work}
```

- `host.json`: `examples/translatepress-3.3.1/host.example.json` を元に、`workDirectory` を case ごとに分け、`images.*` を全部 digest で指定する。WordPress image は `pdo_mysql` 入りのもの（無いと `incomplete(precondition)`）。
- `selection.json`: manual 形。`candidateSlugs` と `pinnedVersions` で版を固定し、`promptVariant` を既定 prompt にする。
- `campaign.json`: `promptId` は `wp2shell-bounty-v11`、`runWallTimeMinutes` は 120。`lab.scenarioId` は #353 で削除したので書かない。最低60分の能動的探索を同じTrial内で行う。入口索引は渡さない。
- 時刻: ホスト（WSL2）の時計は遅れることがある。開始前に `date -u` と外部の時刻を比べる。ずれていれば記録に注記し、wall は台帳の `wallTimeMs` で読む。

## 3. 実行

```bash
node dist/cli/main.js --state <case>/state campaign run <slug> --campaign <id> --host <case>/work/host.json --config <case>/work/campaign.json
```

- campaign ID は 40 文字以内。超えると台帳の identity が 128 文字を超え、対象が黙って skip される（#281 が直るまで）。
- 1 ホストで同時に走らせる Trial は 1 本。他の campaign が同じホストで動いていないか `docker ps` で見る（Lab は 1 本につき container 4 つ）。
- 順に回すときは driver script で `=== start / end` を 1 つの log に書き、終わりに目印の行（例 `all done`）を書く。後続の待ち受けはその行を見る。
- 失敗した case は新しい campaign ID で 1 回だけ再試行する。理由（Lab の provision 失敗、provider 拒否）は別物として記録する。

## 4. 読む

```bash
node dist/cli/main.js --state <case>/state --host <case>/work/host.json ledger funnel --campaign <id>
node dist/cli/main.js --state <case>/state --host <case>/work/host.json ledger runtime --campaign <id>
node scripts/report-rediscovery-cases.mjs --state <case>/state --campaign <id>   # 再発見 case のとき
```

event の reason まで見たいときは [ledger-reading.md](ledger-reading.md) のスクリプトを使う。Private Evidence の本文（候補、HTTP 記録、payload）は開かない。

## 5. 表にして貼る

PR の「測った数字」に貼る列は固定する。

| case | 結果 | Root wall | 候補（Finding / Lead / parked） | 検証（confirmed / incomplete 理由） | 非 cache token | 停止理由 |
| --- | --- | --- | --- | --- | --- | --- |

- 「結果」は completed / incomplete(理由)。wall・provider・schema の失敗は理由付き `incomplete` で、候補 0 件には数えない（SPEC §6）。
- 子の Finding が Root と独立に保存されたかを 1 行書く（ADR 0029 の配線確認）。
- `runtime-confirmed` が出ても、公開記録との経路一致は人間の照合。表には `unassessed` と書く。

## 5b. 探索スキルの腕（ADR 0043）

`discovery.skills` を書いた campaign は、目的文も契約も変えずに、名指しした `SKILL.md` を sandbox の CLI home に置く。台帳の `discovery-run-started.configuration.skills [{id, digest}]` で腕を分ける。

- 比べる相手は同じ mode・同じ選定帯で `discovery.skills` を書かない Trial。campaign を 2 つ用意し、対象を交互に回して Trial 数をそろえる。
- 数えるものは上の表と同じ（Finding / Trial、Lead / Trial、段 1b の成立、Lab で人間が `match` を記録した数、読んだ file 数、token、時間）。加えて research artifact を開いて `recon-map.md` の有無と大きさ、Corrections 節の行数を書く。`wbh-tools-v1` の腕では `tools/hooks.tsv`、`tools/sinks.tsv`、`tools/README.md` の有無と行数も書く。`wbh-trace-v1` の腕では `traces/` の file 数と、Open 節に行が残る file の数も書く。中身は読まない。
- スキルは 1 本ずつ足す。`wbh-tools-v1` は `wbh-recon-v1` の上に乗せて測る（腕: recon のみ / recon + tools）。地図が無い Trial で tools だけを測らない。`wbh-trace-v1` も地図の上に乗せ、直前の腕との差だけを測る（腕: 直前の腕 / 直前の腕 + trace）。
- 既定を有りに切り替えるかは DEVELOPMENT 第 5 節の 6 段で決める。形だけの PR（#682 の PR 1）は数字を持たず、所有者が探索の再開を指示した後に測る。

## 6. 記録先

- 再発見 case: `docs/evaluation/<日付>-<用途>.md` に表と注記、Issue #127 に comment。
- 配線の初回 3 Trial: 対象 PR の本文に表を貼り、merge の comment に campaign ID を残す。
- 進行中の状態は Git に置かず、Issue の comment に書く。

## 開発セット（2026-10-16 時点）

| case | slug / 版 | scenario | 備考 |
| --- | --- | --- | --- |
| ssa | simply-schedule-appointments 1.6.10.0 | public-booking-page-v1 | 公開記録 2 件 |
| brizy | brizy 2.8.11 | public-builder-page-v1 | Lab の provision が一過性で失敗することがある（#284） |
| relevanssi | relevanssi 4.28.3 | approved-comment-searchable-v1 | provider の拒否が出ることがある（#220） |
| tp331 | translatepress-multilingual 3.3.1 | translatepress-translation-data-v1 | |
| tp326 | translatepress-multilingual 3.2.6 | translatepress-translation-data-v1 | 公開記録 2 件 |
| （動かない） | custom-facebook-feed 4.13.0 | — | 外部 API 依存。catalog 外（#283） |
| （動かない） | unlimited-elements-for-elementor 2.0.16 | — | SVN export と Elementor 依存の接続待ち（#282） |

### 2026-10-16 の決定: 再発見ベンチマークは所有者が発見した記録だけにする

所有者の決定（2026-10-16）: ベンチマークは Wordfence の公開記録で発見者が所有者（Yuto Hyakumoto / momopon1415）になっているものだけ。他者の記録を広く足す案（同日の 12 plugin 拡張、PR #298）は取り消した。mirror に所有者名義の記録は 28 件あり、reflected XSS 7 件（Programme Boundary 外）、WPML（WordPress.org に ZIP なし）、Widget Countdown（修正版なし、script が受け付けない）を除く 19 記録・16 対象版を catalog にした。scenario は catalog 既存 case のものを使い、新規 case は無し（plugin 非依存の既定 Lab）。所有者の追加決定（同日）: catalog のうち reflected XSS か対象外分類の記録しか無い plugin は Trial を回さない。回すのは Programme Boundary 内の記録（SQLi、Stored XSS、ATO）を持つ対象だけ。検証は探索の後に所有者が Finding から起動する（#297）。state は `~/.local/state/wordpress-bounty-harness-bench-20261016/<case>/`、campaign ID は `bench-v5-<case>-1016-rN`。

| case | slug / 版 | 公開記録 | 分類 / 位置 | Trial |
| --- | --- | --- | --- | --- |
| ssa | simply-schedule-appointments 1.6.10.0 | CVE-2026-3658 | SQLi / 未認証 | 回す（scenario public-booking-page-v1） |
| （回さない） | tutor 3.9.8 | CVE-2026-5502 | コンテンツ改変（missing-authz）/ Subscriber+ | 対象外の分類（所有者決定 2026-10-16: reflected XSS と対象外の記録しか無い plugin は回さない） |
| （回さない） | booking-package 1.7.06 | CVE-2026-4911 | 価格改変 / 未認証 | 対象外の分類（business-logic-only） |
| brizy | brizy 2.8.11 | CVE-2026-5324 | Stored XSS / 未認証 | 計測済み（2026-10-16-prompt-v5-comparison.md） |
| （回さない） | classified-listing 5.3.10 | CVE-2026-7563 | missing-authz / Subscriber+ | 対象外の分類 |
| （回さない） | wp-user-frontend 4.3.1 | CVE-2026-5459 | IDOR / 未認証 | 対象外の分類 |
| （回さない） | cost-calculator-builder 3.6.17 | CVE-2026-7753 | missing-authz → 情報漏えい / Subscriber+ | 対象外の分類 |
| tp326 | translatepress-multilingual 3.2.6 | CVE-2026-18512 | Stored XSS / Subscriber+ | 計測済み |
| tp331 | translatepress-multilingual 3.3.1 | CVE-2026-19632 | ATO / 未認証 | 回す（scenario translatepress-translation-data-v1） |
| geodir | geodirectory 2.8.183 | CVE-2026-96766 | Stored XSS / Subscriber+ | 回す |
| relevanssi | relevanssi 4.28.3 | CVE-2026-97641 | Stored XSS / 未認証 | 計測済み |
| （依存待ち） | rometheme-for-elementor 2.1.5 | CVE-2026-84763 | Stored XSS / 未認証 | Elementor 依存（#282 と同じ接続） |
| （回さない） | rometheme-for-elementor 2.0.2 | CVE-2026-3425、CVE-2026-3426 | LFI / missing-authz、Author+ | 信頼境界の内側 |
| （依存待ち） | unlimited-elements-for-elementor 2.0.16 | CVE-2026-18561 | SQLi / 未認証 | Elementor 依存（#282） |
| （回さない） | reepay-checkout-gateway 1.8.9 | CVE-2026-3462 | missing-authz / Subscriber+ | 対象外の分類。WooCommerce 依存 |
| （動かない） | custom-facebook-feed 4.13.0 | CVE-2026-93756 | Stored XSS / 未認証 | 外部 API 依存（#283） |
| （回さない） | lifterlms 9.2.1 | CVE-2026-5207 | SQLi / Custom+ | 信頼境界の内側 |
| （回さない） | location-weather 3.0.2 | CVE-2026-7249 | missing-authz / Contributor+ | 信頼境界の内側 |

実例は `docs/evaluation/2026-10-16-wiring-gate-measurement.md`。
