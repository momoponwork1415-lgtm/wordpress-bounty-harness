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
| 2 | レビュー側と検証側の作り込み | 週のレビュー batch が 6 時間超、または scope 内候補が週 15 件超。同じ手動作業を 3 回したら、その種類だけ道具化。探索は止めずに回し、本番で scope 内 Finding の group が週 15 件を超えたら Trial を減らす（所有者決定 2026-10-26、OPERATIONS 第 2 節） |
| 3 | 候補: Claude 系 runtime、Patchstack、報告書の自動化 | Step 2 の後。[PARKING.md](PARKING.md) |

Step 1 の間に凍結するもの: 不変条件、モジュール境界（ADR 0031 の後）、判定器の集合、選定方針の構造（数値は変えてよい。2026-10-19 の所有者決定で ADR 0037 が履歴の採点・cascade・再訪を足した）、探索 prompt（所有者が明示した v4 への 1 回の改訂と、2026-10-16 に所有者が本文を確認して既定にした v5 を除く）。agent に渡る文章は所有者本人または第 5 節で委任を受けた AI が全文を読む。それ以外の案は [PARKING.md](PARKING.md) に 1 行で書き、ADR にも Issue の milestone にもしない。

2026-10-18 に所有者は追加で、WP2Shell 記事にほぼそのまま寄せた v7 を唯一の新規探索promptにし、旧 prompt と実験結果は履歴として残すと決めた。その後、Root の早期終了を観測し、`wp2shell-bounty-v8` を唯一の新規探索promptにして最低60分の能動的な探索を要求し、PHPと必要な依存pluginの固定sourceを渡すと決めた（ADR 0033）。上のprompt凍結からこの変更を除外する。2026-10-25 に所有者は、探索に `wide` / `deep` の mode を置き、`deep` の目的文を `wp2shell-bounty-v10`（#522）、`wide` の目的文を `wp2shell-bounty-v10-wide`（下限なし、既定wall 20分）にすると決めた（ADR 0039、#518）。v10 と v10-wide も上のprompt凍結から除外する。v10-wide は v10 から粘りの段落を外し、最低 1 時間の段落を 2 wave の停止規則に替えたもので、違いはこの 2 段落だけである。同日、所有者は `wide` の目的文を「PRISM の方針に近づける」と決め、種別ごとの専門エージェントを固定で置く `wp2shell-bounty-v11-wide` を `wide` の現行にした。v10-wide は本番で 1 回分を回したので archived で残す（ADR 0039 の 2026-10-25 追記）。v11-wide も上のprompt凍結から除外する。同日、所有者は子のツール呼び出し 80 回の段落を外し、Harness が強制する数（子の数、最低時間、wall）を本文から外すと決め、`deep` を `wp2shell-bounty-v11`、`wide` を `wp2shell-bounty-v13-wide` にした（ADR 0039 の 2026-10-25 追記 4）。v12-wide、v11、v13-wide も上のprompt凍結から除外する。2026-10-26 に所有者は入口と短い経路を命令ではなく例と許容で書き、多少の偽陽性を後段の人間レビューで受け入れる `wp2shell-bounty-v14-wide` を `wide` の現行にした（ADR 0039 の 2026-10-26 追記）。v14-wide も上のprompt凍結から除外する。同日、所有者は子にも Lab の節を渡す 1 文を足した `wp2shell-bounty-v15-wide` を、本番で v14-wide と比べる候補にした（#599、ADR 0039 の 2026-10-26 追記 8）。v15-wide も上のprompt凍結から除外する。同日、所有者は第三者のサービスから取り込む内容について「置ける者がベンダーだけなら攻撃者ではない」と 1 文を直すよう指示し、`wp2shell-bounty-v16-wide` を `wide` の現行にした（ADR 0039 の 2026-10-26 追記 9）。v16-wide も上のprompt凍結から除外する。2026-10-27、所有者は「迷ったら報告はやめようか」と述べ、迷ったら Lead にすると決めた。これに合わせて 3 文を替えた `wp2shell-bounty-v17-wide` を `wide` の現行にした（ADR 0039 の 2026-10-27 追記 10）。v17-wide も上のprompt凍結から除外する。v8 の本文と digest は変えない。wall上限は120分のまま。agent入力の変更に必要な開発Trialの数字と他の品質ゲートは第5節のまま。

所有者決定 2026-10-25: 探索 prompt `wp2shell-bounty-v10`（#522）と `wide` mode（#518）は本番の対象で試し、所有者が結果の手応えで採否を決める試行とし、第 5 節の開発 Trial の数字は取らない。v8 は実績のある方法で、「これらの変更がうまくいかなかったら v8 に戻す」（戻し方は [v10 の文書](reviews/2026-10-25-wp2shell-bounty-v10.md) 第 5 節）。

所有者決定 2026-10-26（[監査](reviews/2026-10-26-system-audit.md) 第 F.2 節への答え、ADR 0032 の 2026-10-26 追記 4）:

- prompt の採否は、監査 第 B.3 節の 6 段で決める（第 5 節）。同日の「開発セット 6 case を各 1 run 回し、scope 内 Finding が 1 件以上の case を数える」基準は、これで置き換える。これから先の探索 prompt の変更には、上の 2026-10-25 の「開発 Trial の数字は取らない」に代えて、この決定を使う。
- 本番の既定は `wide` の `wp2shell-bounty-v14-wide` にした（`src/profiles/wordpress/policy/campaign.json`。2026-10-26 に v14-wide から v16-wide に替え、2026-10-27 に v17-wide に替えた後、同日に v16-wide へ戻し、さらに同日、v16-wide の Finding が v14-wide の 1 割に留まった数字で v14-wide に戻した。ADR 0039 の 2026-10-27 追記 11 と 12）。`deep` の `wp2shell-bounty-v11` は名指しの Trial でだけ使う。v16-wide の本文を契約 v4 で測った候補 `wp2shell-bounty-v18-wide` は、20 Trial で Finding / Trial が 0.20（v14-wide は 0.76）だったので一度 archived にした（#639、ADR 0039 の 2026-10-28 追記 13・14）。2026-10-31 に、v14-wide の最初の 14 Trial の Finding 15 件が段 1 で全件除外されたため、段 1 を通る Finding の数で測り直す候補に戻した。campaign 設定の `promptId` で名指ししたときだけ走る（追記 15）。
- 探索は止めずに回す。本番で scope 内 Finding の group が週 15 件を超えたら Trial を減らす（監査 第 B.3 節の段 (4)。数え方は OPERATIONS 第 2 節）。数は上の表の Step 2 の引き金と同じである。
- 記録だけ: 探索 Lab は、開発セットで `wide` の arm を 1 つ回してから残すかを決める。Claude の探索 runtime は残す。

2026-10-21 に所有者は、Step 2「レビュー側と検証側の作り込み」を Step 1 の判定（#238、2026-10-27）を待たずに始めると決めた。Step 1 の行にある「検証の自律ループ」は、runner の自動検証を止めた PR #434 で handoff 列（`verify next --handoff`）に置き換わった。検証から提出までの 6 段と、所有者が手動で再現してから提出する流れは [ADR 0038](adr/0038-verification-phases-and-submission-flow.md) と親 Issue #441 にある。探索方式の改善は 6 段が通るまで後回しにする。選定から探索までの運転は 2026-10-21 に確認し、残った不具合は親 Issue #443 に集めた（[確認の記録](reviews/2026-10-21-selection-to-discovery-check.md)）。

設計は 2026-10-13 に所有者が確定し、2026-10-14 に最終設計（[docs/reviews/2026-10-14-final-design.md](reviews/2026-10-14-final-design.md)）を採用した。確定した流れ・境界・不変条件の図は [DESIGN-DIAGRAMS.md](DESIGN-DIAGRAMS.md)。Step 1 の完了条件が満たされるまで SPEC 第 2〜4 節と既存 ADR の内容は変えない。例外として、最終設計のために ADR 0016 / 0020 / 0022 / 0026 / 0029 / 0032 の該当行と SPEC §4 / §6 / §8 / §8a / §8b / §12 の該当文は所有者が解除した（2026-10-14）。2026-10-18〜19 の所有者決定による ADR 0033〜0037 と、2026-10-25 の所有者決定による ADR 0039、それぞれに合わせた SPEC の改訂も同じ例外として扱う。ここから先の PR は実装と測定だけを行う。2026-10-14〜11-04 の 3 週は、問いは週 1 つのまま PR を複数本（各 500 行以内。削除行は数えない）出してよい。

2026-10-26 に所有者は、一回限りの外部サービス接続を使う手動検証について [ADR 0041](adr/0041-one-time-external-service-lab-connection.md) の境界変更を明示承認した。実験は翌日に終了し、本番ランナーと通常の Lab の既定動作は変えていない。

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
- 探索に触る PR は数字を貼る。分母は本番の対象である（所有者決定 2026-10-26 の 2 回目: 「今後は開発ベンチではなく普通に本番探索して止まったらバグ修正」）。同日の 1 回目の決定（開発セット 6 case × 3 run）は、次の切り分けのときだけに残す。
  - **本番で比べる。** agent 入力を変える PR（prompt 本文、契約節、Lab setup）は、同じ選定帯で旧版と新版を交互に回し、Trial 数をそろえて比べる。campaign ID に版を入れ、台帳の `discovery-run-started` の prompt 版で分ける。mirror を探索入力にしたときと同じやり方である（[2026-10-25 の報告](reviews/2026-10-25-wordfence-mirror-as-exploration-input.md)）。
  - **開発セットに戻す条件。** 本番で対象範囲内の Finding は出ているのに、人間の観測（`review observe`）の `match` が 1 週間 0 件のとき。このときだけ、答えの分かっている開発セット 6 case を回し、探索と検証のどちらが壊れたかを切り分ける。Finding が 0 件のときは探索の問題なので、本番の停止理由と `incomplete` の理由から直す。
  - **止まったら直す。** 本番の runner が止まった理由と、Finding の保留率・`incomplete` の理由の偏りは、[production-monitoring](agents/production-monitoring.md) で拾い、バグとして直す。
  - **探索 Lab の採否も本番で。** 開発セットの Lab arm（2026-10-26 の l14、6 Trial）は記録だけ残し、採否は本番で 1 arm 回して決める。

  採否の 6 段（[監査](reviews/2026-10-26-system-audit.md) 第 B.3 節）は次のとおり読み替える。段の順に読み、(1) が通らなければ先を読まない。
  1. 実行の健全性: 比べる 2 版それぞれで、completed が Trial 数の 5 分の 4 未満なら判定しない。provider-limited と failed は理由付きで別に数える。
  2. 主指標の公開経路一致: 開発セットに戻したときだけ測る。所有者の公開記録と同じ経路の Finding が出た run の数が、現行版以上であること。照合の結果は `docs/evaluation/` に書く。
  3. M1: 本番で、scope 内 Finding が 1 件以上出た Trial の割合が、現行版を下回らないこと。
  4. 人間が読む量: 上限を置かない（所有者決定 2026-10-26、「数は制限しない」）。列の長さは、検証の並列数と確認票の供給を増やす合図にだけ使う。
  5. 本番の当たり: 採用後の本番の最初の 30 Trial で、Finding が 1 件以上出た Trial が 0 なら戻す。
  6. 精度: 人間が観測した Finding のうち `match` の割合（M4）。閾値は最初の 20 件の観測で決める。

  配線・runtime・選定の PR は runner が流した異なる slug の初回 3 Trial の completed・wall・停止理由で足りる。同じ slug の反復で件数を埋めない。未 merge branch で本番 runner を回すときは campaign ID に branch 名を含め、本番の分母に混ぜない。数字のない探索変更は merge されない。数字は M1〜M6（docs/reviews/2026-10-26-system-history-and-metrics.md 第 4 節）の名前で出し、版をまたいで同じ問い合わせで比べられるようにする。
- 実験軸（分担、継続、prompt 変種など）は opt-in の設定ブロック 1 つと profile の file 1 つに閉じ、台帳の run 記録に軸を残す。消し方を PR に書く。
- agent に渡る文章（`src/profiles/wordpress/prompts/` の本文、`.claude/skills/` の本文、Harness が生成して渡す節の雛形: 出力契約、Lab・Programme Boundary の節、Verifier の victim 契約）を変える PR は、変更後の全文と日本語訳を PR 本文か `docs/reviews/` の文書に貼る。2026-10-13 に所有者は、出典対照表の採否と `owner-approved` の付与を AI に委任した（「採用するかどうかはあなたの方で決めてもらって構いません」「よしなにやってください」）。AI はラベルを付けるとき、委任を明記した PR comment を残す。出典に無い要素を足さない規則は変わらない。2026-10-18 に所有者は読了ゲートも外した（「owner-approved のラベルはいらないかも。結局、脆弱性を発見できるかどうかだからそっちで実験して結果がある程度わかるはず」、ADR 0032 の 2026-10-18 節）。所有者の全文読了は merge の条件ではなく、採否は探索の数字で決める。AI は出典付きで採った要素だけを書き、要素を足さない。
- 1 PR は追加差分 500 行以内を目安にする（削除行は数えない）。超えるなら問いを分ける。
- open の PR（Draft を含む）が 3 本を超えている間は、新しい実装 PR を出さない。先に既存 PR を merge するか閉じる。所有者の読む量が生産速度の上限で、agent の数ではない。
- `owner-approved` ラベルは、2026-10-18 以降は次の path も含めて委任済みの AI が差分を確認し、委任 comment を付けて付ける: `docs/adr/`、`docs/SPEC.md`、`src/profiles/wordpress/prompts/trust-boundary-v1.md`、`src/profiles/wordpress/policy/campaign.json`、`src/profiles/wordpress/policy/programme-scope.md`、`src/profiles/wordpress/discovery/programme-impacts.ts`、`src/profiles/wordpress/verification/judges.ts`、prompt の目的文、`policy/selection.json`、`.claude/skills/`、出力契約の雛形、Verifier の victim 契約。所有者本人だけが付けるものは残っていない（外部行動の承認は不変条件 7 のとおり所有者）。adr-guard の仕組みと、どの path が対象かの一覧は変えない。所有者が読了ゲートを戻すときは ADR 0032 に 1 行足してこの項を戻す。
- CI の `pnpm check` と `pnpm build` が通る。`private-guard`（Private Evidence・提出 package の構成物・記録や画像・512 KiB 超のファイルを止め、文書に貼られた canary token・HTTP 捕捉・秘密鍵・session cookie も見る）と `adr-guard` も通る。

## 6. 正本の改訂

- ADR を書くのは「不変条件かモジュール境界が変わる」か「実測が既存の ADR と矛盾した」ときだけ。週 1 本まで。それ以外の案は [PARKING.md](PARKING.md)。`docs/adr/` を変える PR は `owner-approved` ラベル（2026-10-18 以降は委任済みの AI が付ける、第 5 節）が無いと CI で落ちる。agent に渡る文章を変える PR、`src/profiles/wordpress/policy/` と Programme Boundary の impact 分類を変える PR も同じ（第 5 節、ADR 0032）。
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
