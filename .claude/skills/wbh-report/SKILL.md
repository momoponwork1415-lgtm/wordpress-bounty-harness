---
name: wbh-report
description: 人間が再現を記録した Finding 1 件について、Wordfence 向けの英語報告書の下書きを Private Evidence に書き、review draft で digest を記録する。送信はしない。
---

# wbh-report

対象: `harness review reproduced --result match` が記録済みで、`review decide` が `accept` の Finding 1 件。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js`。場所は `--state <dir>` か `WBH_STATE_DIRECTORY`。

## 読む入力

`harness review export --campaign <id> --finding <id>` の JSON、その `evidence.directory` にある wbh-review と wbh-dedupe の非公開 note、人間が再現したときの手順メモ（同じディレクトリに人間が置いたもの）。台帳の sqlite を直接読まない。

## 書く前の確認

1. `review.decisions` の最後が `accept`、再現の記録が `match` であること。どちらかが無ければ書かない。
2. 公開 scope、最新版、active installs、重複を再確認する。`versions.latestKnown` が `explored` より新しければ、最新版での再確認（`review reverify --version`）が済んでいるかを見る。済んでいなければ書かない。
3. 主張は検証 package と再現された手順の範囲内に収める。観測していない成功、観測していない設定、観測していない範囲の版を書かない。

## 報告書の形（英語で書く）

- **Description**: 3 文以内、120 語以内。1 文目に種別と攻撃者位置、2 文目に欠けている guard を名指しする（call chain を語らない）、3 文目に結果。権限は語彙どおりに書き、`Subscriber and above` のように `and above` を付ける。severity の語、harness の語り、「local でしか確認していない」という免責、妥当性の自己主張は書かない。
- **Affected versions**: 検証した版だけ。範囲を広げない。
- **Precondition**: 必要なら 1 文。`This only affects …` または `This requires …` で始め、site 運用者の行動と費用で書く。「所有者が文書化された cleanup を省いた」と言い換えられる前提、または独立した前提を 2 つ以上積むものは、報告しない。
- **Impact**: 実演した impact だけ。動詞が設定の churn（modify、reset、purge、disable、reorder、trigger emails）なら報奨の floor 未満なので、より狭い真の 1 文にするか、報告しない。
- **Environment**: 有効になっているものだけ（`stateDiff.settings` の名前）。「この設定は不要」という行を書かない。
- **Proof of Concept**: 人間が歩いて記録した手順から書く。Verifier の package だけから作らない。画面の言葉で書く（menu path → 見出し → group → 正確な control label）。値はすべて実値にし、placeholder や `YOUR-SITE` を残さない。観測は 1 つ。同じ事実の 2 つ目の証明を書かない。XSS の観測は site 自身の origin を示す dialog。control（negative control）は観測が推論のときだけ入れ、それ以外は private package に残す。
- **Impact Statement**: 証拠に裏付けられた 1 文、150 字以内。
- **Other Details にだけ入れるもの**: 公開記録との差別化（wbh-dedupe の `no-match` の文）、prior disclosures、release の比較、claim していないこと。Description と PoC には入れない。
- **フォームの選択値**: Authentication は `None/Unauthenticated` か該当する役割、PoC type は `Other, or text instructions`。提出時に live form の実際の選択肢で人間が確かめる。

## 出力と記録

1. 報告書 1 本を Private Evidence の Finding ディレクトリ（export の `evidence.directory`）に Markdown で書く。Git には書かない。一時的にも repo 内に作らない。
2. 書き終えたら Description の語数、Impact Statement の字数、placeholder の有無、版の範囲を自分で数えて確認する。
3. `harness review draft --campaign <id> --finding <id> --programme wordfence --file <path> --prepared-by ai` で digest を記録する。人間が手を入れたら `--prepared-by human` で改めて記録する。
4. 動画は、有効な package が既にあるときだけ参照する。録画は人間の別作業で、この skill は起動しない。

## しないこと

- 送信しない。form を開かない。Submit を自動化しない。送信先の決定、Other Details の最終文、研究者の identity、AI 利用の開示、CAPTCHA、最終確認は人間が行う。AI の関与は正確に開示する。
- `submitted` に進めない。`harness review authorize` と `review submitted` は人間が実行する。
- payload、credential、HTTP 本文、報告書の本文を会話に貼らない。最終応答は path、digest、状態だけ。
- 1 Finding 1 下書き。複数の Finding を 1 本に束ねない。
