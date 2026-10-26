---
name: wbh-destination
description: accept 済みで重複照合が no-match の Finding 1 件について、提出先を Wordfence → Patchstack → 個別の vendor の順に調べる。報酬が出る先 1 つ（wordfence / patchstack / vendor:<名>）か none を、方針の写しの行と公開ページを根拠にして非公開メモに書く。台帳には書かず、送信もしない。
---

# wbh-destination v2

検証から提出までの段 5（ADR 0038、#438）を行う。対象は、`harness review decide` で `accept` が記録され、重複照合の結果が `no-match` の Finding 1 件である。結論は `wordfence`、`patchstack`、`vendor:<名>`、`none` のどれか 1 つにする。wbh-report v2 はこのメモの結論を読んで、報告書を書くかどうかと提出先を決める。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js` を指す。場所は `--state <dir>` か `WBH_STATE_DIRECTORY` で渡す。旧版の v1 は `versions/v1.md` に残す。

## 前提にする所有者の決定

- 提出先は Wordfence、Patchstack、個別の vendor の順に探す（ADR 0038 の 32 行）。
- 報酬が出ない先には提出しない。報酬が出ると確かめられない先も選ばない。どの先も選べなければ、結論は `none` にする（#438 の受入条件 3）。
- Wordfence が vendor の既存の VDP を理由に受け付けなかった対象は、Patchstack か vendor に出す（ADR 0038 の 19 行）。これは Wordfence が断った後の扱いである。Patchstack の「Active VDP」の表示から、Wordfence が断ると予測する根拠にはしない。
- 1 つの Finding に決める提出先は 1 つだけである。2 つの先に出さない（#438 の受入条件 5）。
- 提出は所有者が行う。この skill は提出先を提案し、メモを書くだけである（不変条件 6・7）。

## 読む入力

- `harness review export --campaign <id> --finding <id>` の JSON。台帳の SQLite を直接読まない。使う欄は次のとおりである。
  - `target.targetId`、`target.versions.explored`、`target.activeInstallations`
  - `finding.impact`、`finding.attackerPosition`、`finding.configurationPrecondition`
  - `review.decision.decision`、`review.decision.duplicate`
  - `review.scopeAssessments`（programme ごとの判定。`programmeId` と `status` を読む）
  - `review.latestDraft` と `review.latestDraft.programme`
  - `privateEvidence.directory`
- 方針の写し（`src/profiles/wordpress/policy/`）。2026-10-08 の写しは履歴なので読まない。
  - Wordfence の対象範囲: `wordfence-scope-2026-10-21.md`
  - Wordfence のフォームの項目: `wordfence-submission-form-2026-10-21.md`
  - Patchstack の対象範囲: `patchstack-scope-2026-10-21.md`
  - 研究者の tier: `programme-scope.md` の 66 行（1337 tier）
  - 選定の除外作者: `src/profiles/wordpress/policy/selection.json` の `excludedAuthors`
- 公開ページ。読むだけにする。ログインせず、フォームを開かず、vendor にも programme にも連絡しない。
  - WordPress.org のプラグインの頁（`https://wordpress.org/plugins/<slug>/`）と、作者の profile の頁
  - vendor のサイトと、親会社のサイト
  - バグバウンティの公開一覧（HackerOne、Bugcrowd、Intigriti、YesWeHack）
  - Patchstack の脆弱性 database にあるプラグインの頁（`https://patchstack.com/database/wordpress/plugin/<slug>/vulnerabilities`）と、Active VDP の一覧（`https://patchstack.com/database/vdp`）
  - Patchstack の規則（`https://patchstack.com/articles/bug-bounty-guidelines-rules/`）

export には作者の欄が無い。作者は、確認する時点の WordPress.org の頁から読む。

## 手順

### 1. 固定する

campaign、Finding、`target.targetId`、`target.versions.explored`、`finding.impact`、`finding.attackerPosition`、確認を始めた時刻（UTC）を最初に書く。

### 2. 止める条件

- `review.decision.decision` が `accept` でないときと、`review.decision.duplicate` が `no-match` でないときは、メモを書かずに止める。段 4（wbh-dedupe、#442）を先に通す。
- `review.latestDraft` があるときは、文案が既に `review.latestDraft.programme` に結び付いている。別の結論を書かずに止め、その事実を所有者に伝える。
- 同じ Finding のメモが既にあるときは、書き換えずに止める。書き直すかどうかは所有者が決める。

### 3. 対象の事実を読む

- WordPress.org の頁で、作者名、作者の profile、配布中かどうか、有効インストール数、readme の中の脆弱性の報告先に関する文を読む。
- ブランドの持ち主を確かめる。頁の作者の行、vendor のサイトの footer、作者の profile が公開している他のプラグインから、親会社を読む。
- readme の中で Patchstack、WPScan、Wordfence を名指しする文は、vendor 自身の方針として読まない（#188 出典対照表の表 2 の 12）。
- Patchstack の database のプラグインの頁で、「Active VDP」の表示と Security Policy の頁があるかを読む。これは事実としてメモの「見た証拠」に書き、段 A の 3 の根拠にはしない。

### 4. 段 A: Wordfence

写しは `wordfence-scope-2026-10-21.md` である。次の 4 つを全部調べ、それぞれの結果をメモに書く。どれかに当たれば「受けない」とし、段 B へ進む。

1. 作者か親会社が除外資産に当たる。写しの 45〜50 行と `excludedAuthors` を見る。写しの 54 行は、除外資産を CVE も報酬も無いとしている。
2. 提出の時点で配布が止まっている。または、Finding が vendor のサイトで動く web service に依る（写しの 52 行）。
3. vendor か親会社が、自前の脆弱性の programme を運用している。写しは、自前のバグバウンティを持つ 6 社を除外資産に挙げ（45〜50 行）、一覧は網羅ではないと書いている（43 行）。この項目には、その意味での programme の証拠があるときだけ当てる。
   - 証拠になるのは、vendor か親会社の自前の頁か、公開一覧（HackerOne、Bugcrowd、Intigriti、YesWeHack）にある programme の頁である。
   - 報告のアドレスだけを書いた方針の頁と、報告先を Patchstack か Wordfence とする方針の頁は、証拠にしない。「responsible disclosure」の 1 文だけの記述も証拠にしない（#188 出典対照表の表 2 の 12 と 13）。
   - Patchstack の「Active VDP」の表示も証拠にしない。dev set の 2 件はどちらもこの表示があり、どちらも Wordfence が受理して報酬を払った記録がある。
4. `review.scopeAssessments` に、`programmeId` が `wordfence` で `status` が `out-of-scope` の判定がある。メモには、その判定に当たる写しの行を引く。閾値は 9〜39 行、対象外の種別は 77〜103 行、よく棄却される報告は 105〜160 行にある。

どれにも当たらなければ、結論を `wordfence` にし、段 C 以降は調べない。段 B も、下の Active VDP の場合を除いて調べない。写しが報酬の対象外と書いているのは、除外資産（54 行）と対象外の一覧（162 行）だけである。

- 判定が `ambiguous` のときと、判定が無いときも、規則の行が明示して外していなければ `wordfence` のままにする。確かめる点は「所有者が確かめること」に書く。迷う程度では次の先へ移らない。
- Patchstack の「Active VDP」の表示があり、結論が `wordfence` のときも、段 B を調べて表に書く。結論は `wordfence` のまま変えない。Wordfence が既存の VDP を理由に断ったときに、所有者が段 B の結果を使う。

### 5. 段 B: Patchstack

段 A で「受けない」となったときと、段 A の Active VDP の場合に行う。写しは `patchstack-scope-2026-10-21.md` である。

1. mVDP の対象かどうかを読む。Patchstack の規則 §3.9 は「Patchstack mVDP program」を Active VDP の一覧へリンクしている（2026-10-21 に確認）。プラグインの頁の「Active VDP」の表示と Security Policy の頁を見て、報酬の文と報告先の指定の文を写す。頁が読めないときは「不明」と書き、「無い」とは書かない。
2. 受けるかどうかを見る。`review.scopeAssessments` の `patchstack` の判定と、写しの行を照らす。受理の条件は 11〜15 行、受理種別は 17〜31 行、権限は 37〜41 行、受理しない種別は 43〜47 行、条件を欠くものは 49〜57 行、mVDP の外で扱わないものは 59〜64 行（インストール数は 64 行）、提出要件は 66〜79 行、設定の前提は 81〜87 行、閾値は 91〜97 行、その他の除外は 99〜138 行にある。明示の行に当たれば「受けない」とする。
3. 報酬を見る。一般の受理種別に条件どおり当たる報告（14 行、17〜31 行）には XP が付き、月の報酬 pool から XP の割合で払われる（規則 §18.3）。13 行の zero-day の条件をすべて満たす報告には、XP の代わりに固定の報酬が出る（規則 §22）。mVDP の対象であることだけで受ける報告（15 行）は、XP が付かないことがある（15 行「may no longer receive XP」、規則 §3.9）。この場合は報酬を確かめられないので、`patchstack` にしない。

段 A で「受けない」となったときは、受けると読めて報酬もあるなら結論を `patchstack` にして終え、それ以外は段 C へ進む。段 A の Active VDP の場合は、結果を表に書くだけで、結論は変えない。

### 6. 段 C: 個別の vendor

段 B でも決まらないときだけ行う。

- 段 A の 3 で見た vendor か親会社の方針の頁に、金銭の報酬を払うという文と、このプラグインが対象に入るという文の両方があるときだけ、結論を `vendor:<名>` にする。`<名>` には、頁に書かれた programme の持ち主の名前を入れる。
- 報酬の文として読むのは、「bug bounty」の語か、公開一覧での報酬（bounty）の表示である。公開一覧に載っていても、報酬の表示が無い programme は報酬なしと読む。謝辞、hall of fame、記念品だけの方針も報酬なしと読む。
- 報酬の文と対象の文のどちらかが無ければ、`vendor:<名>` にしない。推測で vendor を選ばない（#438 の受入条件 3）。

### 7. 段 D: none

どの段でも決まらなければ、結論を `none` にする。理由として、各段で当たった行を書く。

## メモ

置き場所は `privateEvidence.directory` の直下である。このディレクトリは Finding ごとに分かれていない Private Evidence の置き場なので、ファイル名を `destination-<campaign>-<Finding>.md` にする。Git には置かない。一時的にも repo の中に作らない。

先頭の 7 行は次の形に固定する。wbh-report v2 は「結論」の行を読む。

```text
# 提出先メモ（wbh-destination v2）
結論: <wordfence | patchstack | vendor:<名> | none>
campaign: <id>
Finding: <id>
対象: <slug> <確かめた版>
確認日時（UTC）: <時刻>
読んだ写し: wordfence-scope-2026-10-21.md、patchstack-scope-2026-10-21.md
```

その後に、次の 4 節をこの順で置く。

1. 段ごとの結果。段 A〜D を 1 行ずつの表にする。列は、提出先、受けるか（受ける / 受けない / 確かめられない / 調べていない）、報酬（あり / なし / 確かめられない / 調べていない）、当たった規則の行、見た証拠である。
2. 当たった規則の行。「ファイル:行」と 12 語以内の引用を、1 行に 1 つ書く。所有者の決定を根拠にした行は「ADR 0038:<行>」と書く。
3. 見た証拠。開いた公開ページの URL、読んだ文（12 語以内）、開いた時刻を 1 行に 1 つ書く。見つからなかったものも書く（例: vendor の方針の頁が無かった）。Patchstack の「Active VDP」の表示と Security Policy の頁の有無は、毎回ここに書く。
4. 所有者が手で確かめること。下の雛形から当てはまる行を選び、この Finding で確かめる点を足す。

Finding の本文、ペイロード、HTTP 記録、認証情報はメモに写さない。書くのは、公開ページの事実、規則の行、export の分類名（`finding.impact` と `finding.attackerPosition` の値）だけである。

## 所有者が確かめることの雛形

- 毎回書く。写しは所有者が 2026-10-21 に貼ったものである。提出の前に、所有者が公式ページを開き、除外資産と対象範囲が写しと同じかを見る（`programme-scope.md` の 3 行）。Wordfence の除外資産の一覧は網羅ではない（写しの 43 行）。
- Patchstack の「Active VDP」の表示があるとき。「Patchstack の Active VDP あり。Wordfence が既存 VDP を理由に受けなかったときは、段 B の結果に従って Patchstack に出す」と書く。
- 結論が `wordfence` のとき。フォームで脆弱性の開示を Wordfence に任せない（No）と、報酬も CVE も出ない（`wordfence-submission-form-2026-10-21.md` の 13 行）。
- 結論が `patchstack` のとき。規則に明らかに合わない報告は、1 週間の利用停止になる（`patchstack-scope-2026-10-21.md` の 140〜146 行）。確かめられない条件が残るなら、所有者が提出の前に解く。
- 結論の programme について、`review.scopeAssessments` に `in-scope` の判定が無いとき。`review draft --programme` にはこの判定が要る。AI 操作役が `harness review scope --campaign <id> --finding <id>` を打つ（runtime-confirmed か reproduced の Finding だけに打てる）。
- vendor か Patchstack の方針に報告先の指定があるとき（ほかの先に出さない、公開まで秘密を守る、など）。その文と URL を書き、所有者が提出の前に読む。
- 結論が `vendor:<名>` のとき。wbh-report v2 は vendor 向けの報告書を書かない。`review draft` も programme の判定が要るので、提出の記録は所有者が手で扱う。
- 有効インストール数が閾値をまたぐとき。export の値（`target.activeInstallations`）と、確認した時点の WordPress.org の値を両方書く。
- 提出するとき。結論の値を `harness review authorize --candidate <id> --draft <digest> --to <結論>` の送信先に写すのは、所有者である。

## しないこと

- 送信しない。フォームを開かない。vendor にも programme にも連絡しない。公開ページを読むだけで、ログインしない。
- 台帳に書かない。`review decide`、`review scope`、`review draft`、`review authorize` を打たない。
- 結論を 2 つ書かない。結論を書いた後で、別の先に向けた文案を作らない。
- 報酬の額、順位、採算の見込みを書かない。
- Finding の中身、ペイロード、HTTP 本文、認証情報を、会話にも Git にも書かない。最終応答は、メモのパス、結論、確かめることの件数だけにする。
- 次の skill（wbh-report）を自動で起動しない。
