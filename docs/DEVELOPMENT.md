# 開発の流れ

対象読者: このリポジトリの所有者と、依頼を受けて変更する AI。設計の正本は [SPEC.md](SPEC.md) と [ADR](adr/)。この文書は「何を作るか」ではなく「どう進めるか」を決める。

## 1. 目標

- 報奨で月 1,000 ドル以上（所有者、2026-10-10）。所有者の換算: アクティブインストール 30〜40 万規模の対象で、ATO を月 1 件、または Stored XSS を月 4 件、または SQLi を月 2 件程度。選定の下限と重みは[選定方針 JSON](../src/profiles/wordpress/policy/selection.json)が正本。
- 前の harness の問題は「対象選定に人間が入る」「結果確認に人間が入る」の 2 点だった。前者は自動選定で解けた。後者は人間を無くすのではなく、人間が読む件数を Harness が絞ることで解く。偽陰性（本物を落として報奨を逃す）は偽陽性より高くつく（所有者、2026-10-13）。
- 設計の教訓は [LESSONS.md](LESSONS.md)。新しい案はまずここに反していないかを見る。

## 2. ロードマップ（2026-10-13）

| Step | 内容 | 完了条件・引き金 |
| --- | --- | --- |
| 1 | 選定 → Snapshot → Lab → 探索 → 検証の自律ループ。scope 内 Finding を全件人間に届ける。人間レビュー・報告書・重複照合は skill（ADR 0031） | ループが quota 1 週分を人手介入 0 で回り切る（保守に数えないものは OPERATIONS 第 1 節）。Programme Boundary 内の Finding が全件 `review export` に届く。所有者が skill で 1 回のレビュー batch を完了し所要時間を記録する。期日は runner 起動＋8 日（最終設計 docs/reviews/2026-10-14-final-design.md 第 10 節） |
| 2 | レビュー側と検証側の作り込み | 週のレビュー batch が 6 時間超、または scope 内候補が週 15 件超。同じ手動作業を 3 回したら、その種類だけ道具化 |
| 3 | 候補: Claude 系 runtime、Patchstack、報告書の自動化 | Step 2 の後。[PARKING.md](PARKING.md) |

Step 1 の間に凍結するもの: 不変条件、モジュール境界（ADR 0031 の後）、判定器の集合、選定方針の構造（数値は変えてよい）、探索 prompt（所有者が明示した v4 への 1 回の改訂と、2026-10-16 に所有者が本文を確認して既定にした v5 を除く）。agent に渡る文章は所有者本人または第 5 節で委任を受けた AI が全文を読む。それ以外の案は [PARKING.md](PARKING.md) に 1 行で書き、ADR にも Issue の milestone にもしない。

設計は 2026-10-13 に所有者が確定し、2026-10-14 に最終設計（[docs/reviews/2026-10-14-final-design.md](reviews/2026-10-14-final-design.md)）を採用した。確定した流れ・境界・不変条件の図は [DESIGN-DIAGRAMS.md](DESIGN-DIAGRAMS.md)。Step 1 の完了条件が満たされるまで SPEC 第 2〜4 節と既存 ADR の内容は変えない。例外として、最終設計のために ADR 0016 / 0020 / 0022 / 0026 / 0029 / 0032 の該当行と SPEC §4 / §6 / §8 / §8a / §8b / §12 の該当文は所有者が解除した（2026-10-14）。ここから先の PR は実装と測定だけを行う。2026-10-14〜11-04 の 3 週は、問いは週 1 つのまま PR を複数本（各 500 行以内。削除行は数えない）出してよい。

Step 1 の週の問い（第 3 節の単位）:

- 第 1 週（〜10-17）: ループは quota 1 週分を人手 0 で回るか。止まった理由は何か。
- 第 2 週（〜10-24）: 所有者のレビュー batch は何時間で、何件を提出判断できたか。

Step 1 の作業順: #185（Finding / Lead の境界と review queue）→ `review export` と実行前後の差分観測器 → `lab up --finding` → skill 3 本 → Login Lockdown の候補を通す（最初の検査点）→ #184（campaign loop、quota 停止再開、並列 2）→ 選定候補源の拡張 → Verifier v7 → #107 再試行 → 探索 v4。

## 3. 単位は「問い 1 つ」

- 1 週間に答える問いを 1 つ決め、GitHub Issue に「問い」と「答えが分かる数字」を書く。例: 「`gpt-6-luna` は 90 分のうち何分使うか。prompt を変えると変わるか」「答えは台帳の run wall 中央値と `observed.filesRead`」。
- PR はその Issue を参照する。問いに関係ない変更は別の問いにする。
- 問いが決まっていない間は、PR を作らない。報告（第4節）だけを依頼する。
- 問いを決める前に [docs/knowledge/experiments.md](knowledge/experiments.md) を見る。過去の世代が同じ問いに答えていれば、その答えから始め、実験を繰り返さない。答えが出たら 1 行足す。

## 4. AI への依頼は 2 種類

| 種類 | 成果物 | 置き場 | 所有者がすること |
| --- | --- | --- | --- |
| 調べて報告 | 事実、選択肢、推奨、未確認の仮定を分けた文書 | [docs/reviews/](reviews/) に日付付き | 読んで決める。決めるまで変更は依頼しない |
| 変更して PR | 問い 1 つに答える PR | GitHub PR | テンプレートの 5 項目を読んで merge する |

報告を読まずに変更を依頼しない。変更の依頼には、報告のどの選択肢を採るかを書く。

## 5. PR の規則

- テンプレートの 5 項目（問い、変えたこと、変えなかったこと、測った数字、消し方）を日本語で埋める。AI が書いてよいが、所有者が分からない行があれば merge しない。書き直しを依頼する。
- 探索に触る PR は数字を貼る。二段にする: agent 入力を変える PR（prompt 本文、契約節、Lab setup）は再発見 case（ADR 0027）で最低 3 Trial の completed と source 根拠付き候補の有無を記録する。配線・runtime・選定の PR は runner が流した異なる slug の初回 3 Trial の completed・wall・停止理由で足りる。同じ slug の反復で件数を埋めない。未 merge branch で本番 runner を回すときは campaign ID に branch 名を含め、本番の分母に混ぜない。数字のない探索変更は merge されない。
- 実験軸（分担、継続、prompt 変種など）は opt-in の設定ブロック 1 つと profile の file 1 つに閉じ、台帳の run 記録に軸を残す。消し方を PR に書く。
- agent に渡る文章（`src/profiles/wordpress/prompts/` の本文、`.claude/skills/` の本文、Harness が生成して渡す節の雛形: 出力契約、Lab・入口・Programme Boundary の節、Verifier の victim 契約）を変える PR は、変更後の全文と日本語訳を PR 本文か `docs/reviews/` の文書に貼る。2026-10-13 に所有者は、出典対照表の採否と `owner-approved` の付与を AI に委任した（「採用するかどうかはあなたの方で決めてもらって構いません」「よしなにやってください」）。AI はラベルを付けるとき、委任を明記した PR comment を残す。出典に無い要素を足さない規則は変わらない。2026-10-18 に所有者は読了ゲートも外した（「owner-approved のラベルはいらないかも。結局、脆弱性を発見できるかどうかだからそっちで実験して結果がある程度わかるはず」、ADR 0032 の 2026-10-18 節）。所有者の全文読了は merge の条件ではなく、採否は探索の数字で決める。AI は出典付きで採った要素だけを書き、要素を足さない。
- 1 PR は追加差分 500 行以内を目安にする（削除行は数えない）。超えるなら問いを分ける。
- open の PR（Draft を含む）が 3 本を超えている間は、新しい実装 PR を出さない。先に既存 PR を merge するか閉じる。所有者の読む量が生産速度の上限で、agent の数ではない。
- `owner-approved` ラベルは、2026-10-18 以降は次の path も含めて委任済みの AI が差分を確認し、委任 comment を付けて付ける: `docs/adr/`、`docs/SPEC.md`、`src/profiles/wordpress/prompts/trust-boundary-v1.md`、`src/profiles/wordpress/policy/campaign.json`、`src/profiles/wordpress/policy/programme-scope.md`、`src/profiles/wordpress/discovery/programme-impacts.ts`、`src/profiles/wordpress/verification/judges.ts`、prompt の目的文、`policy/selection.json`、`.claude/skills/`、出力契約の雛形、Verifier の victim 契約。所有者本人だけが付けるものは残っていない（外部行動の承認は不変条件 7 のとおり所有者）。adr-guard の仕組みと、どの path が対象かの一覧は変えない。所有者が読了ゲートを戻すときは ADR 0032 に 1 行足してこの項を戻す。
- CI の `pnpm check` と `pnpm build` が通る。`private-guard`（Private Evidence・提出 package の構成物・記録や画像・512 KiB 超のファイルを止め、文書に貼られた canary token・HTTP 捕捉・秘密鍵・session cookie も見る）と `adr-guard` も通る。

## 6. 正本の改訂

- ADR を書くのは「不変条件かモジュール境界が変わる」か「実測が既存の ADR と矛盾した」ときだけ。週 1 本まで。それ以外の案は [PARKING.md](PARKING.md)。`docs/adr/` を変える PR は所有者の `owner-approved` ラベルが無いと CI で落ちる。agent に渡る文章を変える PR、`src/profiles/wordpress/policy/` と Programme Boundary の impact 分類を変える PR も同じ（第 5 節、ADR 0032）。
- SPEC や ADR と実態が食い違ったら、コードより先に ADR 1 本で改訂する。未コミットの変更を溜めない。
- 大きな設計変更（判定器の方式、探索の構造）は、報告 → 所有者の決定 → ADR → PR の順。ADR のない大きな変更は merge しない。

## 7. 週末に見る数字

```bash
node dist/cli/main.js ledger funnel --campaign <id>
```

```bash
node dist/cli/main.js ledger usage --campaign <id>
```

```bash
node dist/cli/main.js ledger stops --since <起動日>
node dist/cli/main.js continuous status --state <dir>
```

見るのは、Trial 数と completed 率、Finding と Lead の数、source 候補の数、run wall の中央値、失敗理由の内訳（拒否、上限、skip）、token の合計。当たりが 0 のまま wall 中央値が上限より十分短ければ、次の問いは「なぜ早く終わるか」になる。
