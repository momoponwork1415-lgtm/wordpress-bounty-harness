# 検証ループ（AI 向け、#701）

探索が台帳に足した Finding を、人間が何もしなくても観測パッケージ（`observation-ready` の Lab と観測手引き）まで進める。人間がするのは、一覧を見ること、観測を記録すること、提出することの 3 つだけになる（所有者決定 2026-10-31）。

この手順は AI の運用であり、Harness のコードではない（AGENTS.md「Harness は制御だけ」）。Harness が受け持つのは、Lab の供給と記録だけである。段の判断は各 skill が行い、どの Finding をどの段に回すかは道具 `scripts/verification-loop.ts` が台帳から機械的に並べる。消すときは、この文書と道具を消せばよい。各 skill は単独で残る。

## 守ること

- 確定の根拠は、名指しした人間が記録した `review observe` の `match` と `review decide --reproduced match` だけである（不変条件 3、ADR 0040）。ループは `review observe` と `--reproduced` を打たない。
- ループが台帳に書くのは、`review decide --by ai`（`--minutes` は付けない）と、`verify next --handoff` / `review reverify --handoff` / `lab down` が残す Lab の記録だけである。
- 外部へは送信しない。Wordfence のフォームへの入力も行わない。
- Finding の本文、ペイロード、HTTP 本文、資格情報は、Git にも Issue にも PR にも書かない。観測手引きは Private Evidence と所有者の Windows フォルダにだけ置く。
- 失敗した段は、`incomplete` か理由付きの記録を残して止め、次の Finding や報告単位へ進む（不変条件 4）。止まった段で Finding を落とさない。

## 起動

専用の Claude Code セッションを 1 つ開き、`/loop` に「docs/agents/verification-loop.md の 1 周を回す」と渡す。間隔はそのセッションが自分で決める（所有者決定 2026-10-31、権限の設定は変えない）。探索ランナーが動いている間は、1 日 1 回以上回す。Lab の枠が空いた時と、所有者が観測を記録した時にも回す。周と周は重ねない。前の周が終わってから次を始める。

使う CLI は `/home/dev/worktree/tools` の build（`node dist/cli/main.js`）である。`--host` と `--config` には、探索ランナーと同じファイルを使う。ランナーの引数は `ps -o args -p $(cat <state>/continuous-<接頭辞>.pid)` で確かめる。state は本番（`~/.local/state/wordpress-bounty-harness`）を使う。

## 段の印

台帳だけで、次の周に同じ Finding を同じ段へ二度回さないで済むよう、各段の結果を `review decide --by ai` の理由コードで残す。`defer` は検証列から外さない。

| 段 | 結果 | 記録 |
| --- | --- | --- |
| 1 `wbh-screen` | 要検証 | `--decision defer --reason screen-v5-verify` |
| 1 `wbh-screen` | 除外 | `--decision reject --reason screen-v5-<理由コード>` |
| 1b `wbh-source-check` | 成立 | `--decision defer --reason source-check-pass` |
| 1b `wbh-source-check` | 不成立 | `--decision reject --reason source-check-input` か `source-check-reach` |
| 1b `wbh-source-check` | 未決 | `--decision defer --reason source-check-unknown`（所有者の判断待ち） |
| 検証のやり直し | 2 回目も観測待ちに届かない | `--decision defer --reason loop-retry-exhausted`（所有者の判断待ち） |

理由コードの形は `^[a-z0-9][a-z0-9-]{0,63}$` で、コロンは使えない。

## 1 周の手順

### 0. 次にやることを並べる

```bash
node --experimental-strip-types scripts/verification-loop.ts --json > <state>/review-notes/verification-loop-<YYYYMMDDTHHMM>.json
```

道具は台帳、`review-decision` の記録、最新の `review-notes/report-units-*.json`、`docker ps` だけを読み、何も書かない。開発セットの campaign（既定は `^(tp326-|issue-?[0-9])`）は数えない。出力の `next` の各列が、下の各節に当たる。`labs.free` は Lab の枠（`--lab-slots`、既定 4）から、観測待ちで生きている Lab の数を引いた残りである。この 4 は道具の既定値で、Harness は Lab の数を制限しない（#432）。

### 1. 片付け（`labs.teardown`）

人間が観測を記録した Lab を、`lab down --lab <labId> --config <path>` で落とす。その Lab を保持している `verify next` のプロセスも終わったことを確かめる。ほかの Lab と探索の container には触らない。`lab cleanup --remove` は使わない。

`labs.viewOnly` は、後の attempt に置き換えられたのに観測用に保持したまま生きている Lab である。`review observe` は最新の attempt と照合するので、この Lab には記録できない。所有者が目視を終えたと「検証と提出」が知らせてから落とす。それまでは枠に数える。その Finding は止まった検証として、単位の新しい Lab でやり直す。

### 2. 段 1（`next.screen`）

対象（slug と版）ごとにサブエージェントを 1 体立てる。`.claude/skills/wbh-screen/SKILL.md` の現行版を、`要検証` / `除外` の 2 値と報告単位まで行わせる。結果は Private Evidence の `screen-report-<日付>.md` と Finding ごとのメモに残る。台帳への記録は、親（ループのセッション）が上の表のとおりに打つ。

最初の周だけは、2026-10-31 の `review-notes/exclusion-screen-2026-10-31.json` を取り込む。`verdict: keep` で台帳に印の無い Finding に `screen-v5-verify` を打つ。そのうえで、残った Finding だけを選別する。

### 3. 段 1b（`next.sourceCheck`）

対象ごとにサブエージェントを 1 体立てる（Opus 級、1 単位 10 件まで）。`.claude/skills/wbh-source-check/SKILL.md` を行わせ、親が上の表のとおりに記録する。未決の Finding は所有者の判断待ちになり、一覧の「判断待ち」に出る。

### 4. 報告単位（`next.unit`）

段 1b で成立した Finding を、`wbh-screen` の「報告単位」の節に従って同根ごとにまとめる。前回の `report-units-*.json` の単位をすべて引き継いだうえで、新しい単位を足した `report-units-<日付>.json` を書く（同じ日付のファイルがあれば `-2`）。既存の単位に入る Finding は、その単位の構成員にする。

### 5. Lab（`next.lab`）

`next.lab` は、空いている枠の数だけ並ぶ。1 単位に Lab 1 台で、同じ Snapshot の Finding を 5 件まで順に回す（#704）。止まった検証のうち単位のあるものは、その単位の Lab に入る（7 節のやり直し）。構成員の誰か（最新版の派生を含む）がすでに観測待ちか報告に進んだ単位は、報告 1 件にまとめるので Lab を立てず、`next.labCovered` に並ぶ。単位ごとに次を行う。

1. Git 外に新しい handoff ディレクトリを作り、`verify next --config <path> --campaign <id> --finding <id,...> --handoff <dir> --hold-minutes 1440` をバックグラウンドで起動する。
2. Finding ごとのディレクトリ（`<dir>/<n>-<id の先頭 12 文字>`、一覧は `<dir>/batch.json`）に `lab.json` が現れたら、`wbh-verify` の操作役サブエージェント（Opus）を 1 体立てる。1 つのディレクトリには操作役を 1 体だけ置く。依頼文には次を書く。
   - 所有者が許可した、使い捨ての gVisor Lab での検証であること。
   - `.claude/skills/wbh-verify/SKILL.md` に従うこと。
   - 読むのは `lab.json` と `review-export.json` だけであること。
   - 6 ファイルか `abort` を書いたら終えること。
   - `review observe` と `--reproduced` は打たないこと。
3. 順に回す Finding では、前の Finding の 6 ファイルが確定した後に、次のディレクトリの `lab.json` が現れる。そのたびに操作役を 1 体ずつ立てる。
4. `verify next` が `verified finding ... : incomplete` を出して Lab を保持したら、6 節へ進む。Lab を保持しなかったときは、出力の理由を 7 節の扱いにする。

Lab の待ち時間の上限は 30 分である。それを超えたときと `abort` のときは、Harness が理由付きの `incomplete` を記録する。ループの側で記録し直さない。

### 6. 観測手引き

`observation-ready` まで届いた単位ごとに、日本語の観測手引きを書く。置き場は Git 外の `<state>/review-notes/observation-guides/observation-guide-<単位>.md` で、所有者の Windows フォルダ（`/mnt/d/wordfence/harness-labs-<日付>/`）にも同じ名前で写す。2026-10-31 の手引きと同じ 7 節にする。

1. Lab の状態（Lab ID、保持の期限、対象と版、基準環境）
2. ブラウザから Lab に入る方法（hosts の 1 行、URL、管理者の account の在りか。資格そのものは書かず、`verify next` が Private Evidence に置いた入口ファイルの path を示す）
3. 見るもの（Harness が残した状態、`victim.paths` の画面、期待される観測）
4. 自分の手で再現する場合（`steps.md` の path。手順の本文は写さない）
5. 記録する方法（OPERATIONS 第 3 節の段 6 の写し。AI は代行しない）
6. 終わったら（観測の記録が台帳に入れば、次の周で Lab が片付く）
7. Lab が消えていたとき（`lab up --for-review` で新しい review Lab を立てる）

### 7. 止まった検証（`next.stalled`）

観測待ちに届かなかった Finding は、`incomplete` の理由ごとに 1 回だけやり直す。

- `precondition`（依存プラグインが足りない）: `review reverify --resnapshot-dependencies --handoff` で依存を固定し直す（#692）。
- `precondition`（パーマリンクや設定が足りない）: 現行の基準環境の Lab で立て直す（#706）。
- `recipe` / `observation`: 操作役の記録（`precondition`、`steps.md`）を読み、手順の誤りなら同じ Lab の形で立て直す。
- 判定器の時期の `no-judge` / `runtime-confirmed`: 新しい流れで検証し直す（所有者決定 2026-10-26）。

2 回目も観測待ちに届かなければ、`loop-retry-exhausted` を打って止める。所有者の判断待ちに回る。

### 8. 照合と報告書（`next.report`）

人間の観測が `match` の Finding に、`wbh-dedupe` を行う。続けて、人間の `--reproduced match` が揃っていれば `wbh-report` の暫定文案まで進める。どちらも記録は各 skill の書式に従う。最終の査読、`--prepared-by human`、`authorize`、送信は所有者が行う。

### 9. 一覧と周の記録

1. `node --experimental-strip-types scripts/submission-board.ts` で一覧を作り直し、`/mnt/d/wordfence/harness-labs-<日付>/submission-board-<日付>.html` に上書きで写す。
2. Issue #701 に、周の件数だけをコメントする。書くのは、各段の件数、Lab を立てた数、`observation-ready` に届いた数、止まった数とその理由コード、`metric.medianHoursToObservationReady` である。Finding ID は先頭 12 文字までにし、本文は書かない。

## 測る数字

- Finding が台帳に入ってから `observation-ready` になるまでの中央値（時間）。道具の `metric.medianHoursToObservationReady` で、`--since` で期間を指定する。
- 所有者が触った回数。観測と提出のほかは 0 を目標にする。周の記録に、所有者に判断を求めた件数（`next.owner`）を添える。
