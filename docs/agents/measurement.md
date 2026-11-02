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
- 数えるものは上の表と同じ（Finding / Trial、Lead / Trial、段 1b の成立、Lab で人間が `match` を記録した数、読んだ file 数、token、時間）。加えて research artifact を開いて `recon-map.md` の有無と大きさ、Corrections 節の行数を書く。`wbh-tools-v1` の腕では `tools/hooks.tsv`、`tools/sinks.tsv`、`tools/README.md` の有無と行数も書く。中身は読まない。
- スキルは 1 本ずつ足す。`wbh-tools-v1` は `wbh-recon-v1` の上に乗せて測る（腕: recon のみ / recon + tools）。地図が無い Trial で tools だけを測らない。
- `wbh-recon-v2`（#752）は v1 の手順 8 に「子は親の履歴を引き継がずに始める」の 1 文を足したもの。腕を分けるときは rollout の子の最初の `token_count` の入力（v1 の既定では約 40,000）と、Trial の入力 token、読んだ file / Trial（子が読み直す分）を並べる。
- `wbh-recon-v3`（#714 / #686）は v2 に手順 9「closing」と description の 1 文を足したもの。v3 を名指した Trial は、Root の wall、固有 PHP file 読了率（read-paths の plugin 相対 path の固有数 / plugin の PHP file 数）、Finding / Trial、Lead / Trial、登録簿の Closing 節の「決着した経路 / 隙間のあった経路」を、v21 + v2 の 10 Trial と並べる（ADR 0043 追記 4）。対になっていない。
- `wbh-setup-v1`（#749）は Lab 付きの Trial（`discovery.lab: attached`）でだけ意味を持つ。腕は recon + tools / recon + tools + setup で、台帳の `labObserved` から Trial あたりの site への要求数（`requests`）、`observations`、`resets` を出し、Finding / Lead の `labObservations` が空でない数を数える。research artifact では `lab-setup.md` の有無、Objects 表の行数、Verified の 200 の数、Not built の行数を書く。中身は読まない。Lab の無い Trial にこのスキルを数えない。
- `wbh-falsify-v1`（#786）は recon + tools（Lab 付きなら + setup）の上に乗せる。research artifact では `assumptions/*.md` の有無と行数、Counts 節の enforced / not enforced / open、`traces/*.md` の数を書く。中身は読まない。bench（#726 の残り 20 件）では、最適化系の記録、論理系のプラグイン、Lead 止まりだった記録のうち Finding に進んだ数と、全体の当たり（基準 9 / 20）を並べる。本番の分母は ADR 0045 のまま。
- `wbh-falsify-v2`（#791）は v1 に「歩き」の手順（`walks/<subsystem>.md`、entry ごとに check か use まで）を足し、表を別の agent が歩きの file から始めるもの。research artifact では `walks/*.md` の有無と Counts（check まで / use まで / 未歩き / 経路）、`assumptions/*.md` の Counts、`traces/*.md` の数を書く。中身は読まない。bench は 6 対象 × 1 Trial に絞る（所有者決定 2026-11-02）。見る数字は、v1 で失った直接 sink 型の記録が戻った数、v1 で増えた到達（Lead 止まり → Finding、未到達 → Lead）を失っていないか、Root の時間、自力で 120 分に当たった件数。 結果（h32、2026-11-02）: F 12 / L 5 / - 20 で h30 の 12 / 8 / 17 を上回らず、採らなかった。v1 と v2 はどちらも `archived` で、過去 Trial の照合にだけ使う。
- `wbh-lab-v1`（#793 決定 E）は Lab 付きの Trial で recon + tools + setup の上に乗せる。台帳の `labObserved` から Trial あたりの `lookups`（find / sql / trace の内訳は `lookupLog` の kind）、`observations`、`resets` を出し、Root の wall と並べる。research artifact では `lab-facts.md` の有無と行数、見つかった / 見つからない marker の数、`lab-traces/*.md` の数、Closing 節の「Lab の事実で決着した行 / Lab を使わずに残した行」を書く。中身は読まない。比べる相手は同じ Lab 付きで `wbh-lab-v1` を名指さない v21-wide の Trial（2026-11-02 再開後）と bench h34。分母は ADR 0045 の Lab 発火 / Codex 時間。
  - `## Lab` 節が `wbh-lab` を名指す 1 文（ADR 0049 追記 6）: Trial ごとに diagnostic artifact（`<workDirectory>/provider-attachments/diagnostic-<digest>/content/diagnostic.json`）で `skills/wbh-lab/SKILL.md` の読み回数を数え、recon / tools / setup の SKILL.md の回数と並べる。前は `prod-v21-20261102-4` の 5 Root で 0 回（他の 3 つは各 4 回以上）、`lab-facts.md` 0 件、lookups 0〜2 / Trial。後は同じ v22-wide の設定の次の Trial で同じ 3 つを数える。
- 本番 wide の最低時間（ADR 0039 追記 22、2026-11-02）: 置かなかった。代わりに recon-v2 と recon-v3 を同じ選定帯で交互に回し、Root の `wallTimeMs`、Finding / Trial、Lead / Trial、Lead の `missingEdge` の内訳、`labObserved.lookups` を並べる。基準線は 2026-11-01 の Lab 無し・recon-v2 の 20 Trial（Root 中央値 15 分、F 8 / L 68）と 11-01〜02 の recon-v3 の 27 Trial（Root 28〜31 分、F 2 / L 250）。対象の大きさ（hooks.tsv の行数）を並記する。
- bench h33（ADR 0049、#793 の PR 1）は h32 と同じ 6 対象（37 record）を、第 1 Trial から Lab を付けて（`discovery.lab` の既定 `attached`、観測器 `find` / `sql`）1 Trial ずつ回す。合格線は Finding の数が h32 を上回り、Lead 止まりの record が減ること。分母は Lab 発火 / Codex 時間（ADR 0045）。台帳の `labObserved.lookups` / `refusedLookups` と `exploration-lab.json` の `lookupLog` の件数（`find` / `sql` 別、`answered` / `refused` 別）を Trial ごとに書く。答えの中身は読まない。
- bench h34（ADR 0049 追記 1、#793 の PR 2）は h33 と同じ 6 対象（37 record）を、`trace`（1 リクエストの plugin 内の関数呼び出し列）を足した Lab image で 1 Trial ずつ回す。先に image を再 build して `images.wordpress` を再 pin する（README の手順）。合格線は HTML 書き換え・変換系の record（h31 で未到達だった 6 件の形）への到達が増え、Finding の数が h33 を下回らないこと。分母は Lab 発火 / Codex 時間（ADR 0045）。`lookupLog` の件数は `find` / `sql` / `trace` 別に書き、`trace` は `answered` / `unavailable` / `refused` 別に数える。答えの中身は読まない。
- `wp2shell-bounty-v22-wide`（ADR 0049 決定 E、ADR 0039 追記 21）は v21-wide から hooks.tsv の行数で閉じる規則を消しただけで、語を足していない。本番の v22-wide の Trial を v21-wide の Trial（2026-11-01〜02）と並べ、Root の wall（Root とその再開区間の `discovery-run-finished.wallTimeMs` の合計）、Trial あたりの lookup 数（`labObserved.lookups` と `refusedLookups`）、Finding / Trial と Lead / Trial（`finding-recorded`、`lead-recorded`。`finding-parked` は別に数える）、Lab 発火 / Codex 時間（ADR 0045）を比べる。対になっていないので、同じ選定帯の分布として並べ、中央値と範囲を書く。bench は組まない。
- 既定を有りに切り替えるかは DEVELOPMENT 第 5 節の 6 段で決める。形だけの PR（#682 の PR 1）は数字を持たず、所有者が探索の再開を指示した後に測る。

## 5c. Lead を入力にした第 2 Trial（ADR 0044）

`discovery.priorLeads.targets` を書いた campaign は、名指しした Snapshot だけを対象にし（選定は回さない）、各 Trial に `## Prior leads` 節と探索 Lab（`discovery.lab: attached` が必須）を付ける。台帳の `discovery-run-started.configuration.priorLeads` の有無で第 2 Trial を見分ける。中身は代表の数 `representatives`、代表の `leadIds`、`representativesDigest`、隙間の文を伏せた数 `gapWithheld`、節の `sectionDigest`。

- 代表は対象ごとに `leadIds`（最大 8）か、`scripts/lead-groups.mjs --rule pair --json` の出力ファイル（`groupsPath`、その Snapshot の Lead が代表の群を全部使う）で名指しする。どれを渡すかは AI 操作役が決め、選び方を Issue のコメントに残す。
- 起動前に拒むもの: 別の Snapshot の Lead、台帳か Private Evidence に無い Lead、公開履歴カタログを受けた Trial の Lead、v8 より前の目的文の Trial の Lead、`pair` 以外の規則の群ファイル、別の campaign が同じ Snapshot と同じ代表の組ですでに走らせたもの。
- 主な数字: **Finding になった Lead の群の数 / 入力した群の数**。「なった」は、第 2 Trial の Finding を入れて `lead-groups.mjs --snapshot <digest>` を回し、入力した代表と同じ群に入ったこと。既定の `overlap` と `pair` の両方の数を並べる。加えて段 1b（wbh-source-check）を通った Finding の数を、入力した群に入ったものと入らなかったものに分けて書く。
- 第 2 Trial は v14-wide・v18-wide・v19-wide の Trial と同じ分母に混ぜない。第 1 Trial は Lab なし、第 2 Trial は Lab ありなので、上がっても入力の効果と Lab の効果は分けられないと書く。

### 自動の後続 Trial（ADR 0049 追記 2、#793 の PR 3）

連続ランナーが組んだ第 2 Trial は、`discovery-run-started.configuration.followUp`（`of` = 第 1 Trial の Root の runId、`leadCount`）のある run で見分ける。名指しの第 2 Trial（leads2: `configuration.priorLeads` あり、`followUp` なし）とは分けて数える。

- 分母は Codex 時間。後続 Trial の Root とその再開区間、子の `discovery-run-finished.wallTimeMs` を合計して時間に直す。
- 分子は後続 Trial の `finding-recorded`（`finding-parked` は別に数える）。加えて段 1b（wbh-source-check）を通った数と、人間の観測で `match` になった数を並べる。
- 比べる相手は leads2（2026-11-01、名指しの第 2 Trial 14 本で Finding 4）。同じ分母に直し、「Finding / Codex 時間」で上回るかを見る。合格線は Issue #793 の表の 3 行目。
- 組めなかったものは `follow-up-scheduled` があって `discovery-run-started` の無い Snapshot で、理由は同じ campaign の `target-skipped`（reason `follow-up-refused`、`reasonDetail` に ADR 0044 の拒否 code）にある。`follow-up-scheduled.leadCount` が 8 を超えた Trial は、代表が台帳順の先頭 8 件に切れているので、その件数も書く。
- 第 1 Trial と後続 Trial はどちらも Lab 付き（`discovery.lab` の既定 `attached`）なので、違いは Lead 入力と前回の研究 file だけである。

数え方の例（台帳を読むだけ。Private Evidence は開かない。[ledger-reading.md](ledger-reading.md) の `node:sqlite` の読み方と同じ）:

```bash
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT event_json FROM ledger_events WHERE event_type = ? ORDER BY sequence").all("discovery-run-started");
for (const { event_json } of rows) {
  const e = JSON.parse(event_json);
  const f = e.configuration.followUp;
  if (f) console.log(e.campaignId, e.runId, e.snapshotDigest, f.of, f.leadCount);
}' <state>/ledger.sqlite
```

## 5d. 前回の研究 file を渡した Trial（ADR 0048、ADR 0049 決定 D、#793 の PR 4）

`discovery.priorResearch: same-target` の campaign で、同じ plugin の別の版の Trial が封じた研究 file（地図、Lab の通常利用の記録、REGISTRY、仮定の表、歩き、保存先の表 `stores.json`）を受けた Trial は、`discovery-run-started.configuration.priorResearch` に `sourceRunId` があるもので見分ける。`{ none: ... }` のものは有効だったが渡せなかった Trial、項目が無いものは無効の campaign である。`sourceState` があれば、元の Trial は `research import` で別の台帳（bench）から取り込んだものである。

- 分母は 2 つ並べる。Trial 数と Codex 時間（ADR 0045）。Root の wall は、その Trial の Root（`runKind: explore`）とその再開区間の `discovery-run-finished.wallTimeMs` の合計。
- 主な数字: **Root の wall の中央値**と **F/Trial**（`finding-recorded` の数 / Trial 数。`finding-parked` は別に数える）を、研究ありの Trial と研究なしの Trial で並べる。研究なしは、同じ選定帯で `priorResearch` が `{ none: "no-earlier-trial" }` か項目なしの Trial。加えて段 1b（wbh-source-check）を通った数と、人間の観測で `match` になった数を並べる。
- 同じ Snapshot に研究あり / なしの対は作らない（所有者 2026-10-31「同じ版は 1 回」）。比べるのは別の plugin・別の版の Trial の分布であり、対でないことを書く。
- 渡した file の種類で分けるときは、`configuration.priorResearch.files[].name` を見る（`stores.json` があるのは元 Trial に Lab の記録があったもの）。`withheld` があれば、総量の上限で外した file の名前が入っている。
- 合格線は Issue #793 の表の 4 行目: Root 時間が短くなり、F/Trial が落ちないこと。

数え方の例:

```bash
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const rows = db.prepare("SELECT event_json FROM ledger_events WHERE event_type = ? ORDER BY sequence").all("discovery-run-started");
for (const { event_json } of rows) {
  const e = JSON.parse(event_json);
  const p = e.configuration.priorResearch;
  if (!p) continue;
  console.log(e.campaignId, e.runId, p.sourceRunId ? `${p.sourceState ?? "local"} ${p.sourceVersion} ${p.files.length} files${p.withheld ? ` (${p.withheld.length} withheld)` : ""}` : `none ${p.none}`);
}' <state>/ledger.sqlite
```

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
