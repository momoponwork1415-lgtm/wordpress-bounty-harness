# 計測の手順（AI 向け）

DEVELOPMENT §5 の「探索に触る PR は開発セットで最低 3 Trial の数字を貼る」を、AI が自分で回すための手順。正本は [DEVELOPMENT](../DEVELOPMENT.md) §5 と [SPEC](../SPEC.md) §6〜§7。規則は足さない。

## いつ使うか

- agent 入力（prompt、skill、Harness 生成の節）を変える PR → 再発見 case で 3 Trial。
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
- `campaign.json`: `promptId`、`runWallTimeMinutes` 60、`stopRules.maxRuns` 1、`lab.scenarioId` を case に合わせる。
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

実例は `docs/evaluation/2026-10-16-wiring-gate-measurement.md`。
