---
name: wbh-report
description: 人間が再現を記録した Finding について、提出先（Patchstack か Wordfence）の提出要件に揃えた英語の報告書の下書きと添付の一覧を Private Evidence に書き、review draft で digest を記録する。送信はしない。
---

# wbh-report v2

対象は、`harness review decide --reproduced match` が記録済みで、`review decide` が `accept` の Finding である。提出先は段 5（#438）の非公開メモで決まっている。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js` を指す。場所は `--state <dir>` か `WBH_STATE_DIRECTORY` で渡す。旧版は `versions/v1.md` に残してある。

## 読む入力

- `harness review export --campaign <id> --finding <id>` の JSON。台帳の SQLite を直接読まない。
- `privateEvidence.directory` にある非公開メモ。wbh-review、wbh-dedupe、提出先（段 5）のメモと、人間が再現したときの手順メモを読む。
- 提出要件の写し（`src/profiles/wordpress/policy/`）。
  - Patchstack: `patchstack-submission-requirements-2026-10-21.md`。「満たすこと」と「受け付けないもの」の分け方も、同じファイルの「読み方」にある。
  - Wordfence: **未着。** 所有者が規則の文を持ってくるまで、この行は空けておく（#436）。届いたら同じディレクトリに日付付きで置かれる。それまでは Patchstack の写しを Wordfence の要件として読み替えない。Wordfence 向けの下書きでは、Patchstack を出典に付けた行を要件として扱わず、書いてもよい形として扱う。ただし確認 6（束ねる）は Wordfence 向けには行わない。
- 添付の材料（Private Evidence）。
  - HTTP 記録は `http.path` にある。`http.source` が `harness-captured` のものだけを request の出典にする。`agent-authored` は Verifier の自己申告なので使わない。
  - 被害者側の画面と録画は、`privateEvidence.artifacts` の kind `victim-view` にある（Lab 観測器が撮った PNG と WebM、各ファイルの sha256 の一覧）。この kind が無い Finding では、kind `judge-evidence` のディレクトリにある被害者画面の PNG を使う。
  - 人間が再現のときに撮った画面と録画（人間が Finding のディレクトリに置いたもの）も使う。
- 過去の提出（所有者の提出フォルダ。WSL では `/mnt/d/wordfence/submissions`）。参考にするのは、節の並び、PoC の書き方、添付の種類だけである。本文、プラグイン名、CVE、URL、ペイロード、request、画像は、下書きにも会話にも写さない。

## 書く前の確認

1. `verification.status` が `incomplete` でないこと、`review.decisions` の最後が `accept` であること、`review.humanReproduction.result` が `match` であることを確かめる。どれかが欠けていれば書かない。
2. 提出先を固定する。段 5 のメモの結論が `patchstack` か `wordfence` のときだけ書く。メモが無いとき、結論が `none` や `vendor:<名>` のときは、書かずに止める。1 つの Finding を 2 つの提出先に出さない。
3. 最新版で確かめたかを見る。`target.versions.latestObserved` か `target.versions.latestKnown` が `target.versions.explored` より新しければ、最新版での再確認（`review reverify --version`）の結果が `review.latestReverification` にあるかを見る。無ければ書かない。報告書には、確かめた版と、それが確認日の時点で最新版だったことを書く（Patchstack「tested against the latest available version」）。
4. 重複を確かめる。`review.decision.duplicate` が `no-match` のときだけ書く。`possible-match` と `unavailable` のときは書かない（Patchstack「Duplicates of earlier reports or already-published CVEs」、ADR 0038 の段 4）。公開範囲とインストール数も、書く前に確かめ直す。
5. 配布中の component かを確かめる。WordPress.org のプラグインの頁で、閉鎖や配布停止になっていないかを見る。`target.versions.latestObserved` が null なら、取得の失敗か閉鎖かを頁で見分ける（Patchstack「Closed, inaccessible, abandoned, or non-publicly-distributed components」）。premium 版の Finding なら、改変していない原本の archive を添付の一覧に入れる。
6. 同じ種別の Finding を束ねる（Patchstack 向けだけ）。同じ campaign の review 列（`harness review --campaign <id>`）の Finding を `review export` で読み、同じ `target.targetId` で `finding.impact` も同じ `accept` 済みのものを集める。集めたものは 1 本の報告書にまとめる（Patchstack「Multiple findings of the same vulnerability type must be consolidated into a single report」）。`group.size` が 2 以上なら、群の Finding も入っているかを確かめる。束ねた Finding のそれぞれに、この 1〜5 と 7、8 の確認を行う。Wordfence 向けは、写しが届くまで 1 Finding 1 下書きにする。
7. 手順が遠隔の攻撃者の位置で書けるかを確かめる。前提作りも含めて、手順は画面の操作か HTTP request で書く。WP-CLI、サーバー上のファイル操作、データベースの直接操作が要るなら書かない（Patchstack「WP-CLI or other server-side-only steps are not accepted」）。非現実的な前提を要するものも書かない（同「Unrealistic pre-requisites」）。
8. 主張は、検証の記録と人間が再現した手順の範囲に収める。観測していない成功、観測していない設定、観測していない範囲の版を書かない。

## 報告書の形（英語で書く）

節は次の順に置く。過去の提出で最も多い並び（Description、Environment、Proof of Concept、Impact Statement、参照）に、Patchstack が求める component の行と添付の一覧を足した形である。提出フォームの項目への割り当ては、下の「提出フォームの構成」が届いてから行う。

1. **Component**: slug、WordPress.org のプラグインの頁へのリンク、確かめた版、それが最新版であることと確認日を書く。premium 版の問題を無料版として書かない（Patchstack「Attach the correct component slug, link, and version」）。
2. **Description**: 3 文以内、120 語以内で書く。1 文目に種別と攻撃者位置を書き、2 文目で欠けている guard を名指しする（call chain を語らない）。3 文目は結果である。権限は語彙どおりに書き、`Subscriber and above` のように `and above` を付ける。severity の語、Harness の語り、「local でしか確認していない」という免責、妥当性の自己主張は書かない。
3. **Affected versions**: 検証した版だけを書き、範囲を広げない。
4. **Precondition**: 要るときだけ 1 文で書く。`This only affects …` か `This requires …` で始め、サイト運用者の行動と費用で書く。「所有者が文書化された cleanup を省いた」と言い換えられる前提や、独立した前提を 2 つ以上積むものは、報告しない。
5. **Environment**: 有効になっているもの（`labStateDiff.summary.settings` の名前）だけを書く。「この設定は不要」という行は書かない。
6. **Proof of Concept**:
   - 人間が歩いて記録した手順から書く。Verifier の package だけから作らない。
   - 遠隔の攻撃者の視点で、step ごとに「誰が（未認証か、どの役割のアカウントか）何をするか」を書く。被害者の操作が要る step には、被害者の役割を書く（Patchstack「step-by-step reproduction from a remote attacker's perspective」）。
   - HTTP request を送る step には、raw の request（request line、Host を含む header、body）を添える。値は人間が再現で使った実値にする。method とパスが Harness 捕捉の記録と一致することを確かめる（同「including HTTP requests」）。
   - 画面の言葉で書く（menu path、見出し、group、正確な control label の順）。値はすべて実値にし、placeholder や `YOUR-SITE` を残さない。
   - 観測は 1 つにし、同じ事実の 2 つ目の証明を書かない。XSS の観測は、サイト自身の origin を示す dialog にする。negative control は、観測が推論のときだけ入れる。それ以外は Private Evidence に残す。
   - 観測の step には、それを写した画面を 1 枚対応付ける（Attachments のファイル名で書く）。録画があれば、手順全体に 1 本対応付ける（同「screenshots, or videos」）。
7. **Impact**: 実演した影響だけを書く。動詞が設定の churn（modify、reset、purge、disable、reorder、trigger emails）なら報奨の floor に届かない。より狭い真の 1 文にするか、報告しない。
8. **Impact Statement**: 証拠に裏付けられた 1 文を、150 字以内で書く。
9. **Affected code references**: `finding.sourceTrace` のファイルと行のうち、人間が再現で通った経路にあるものを書く。固定した版のソースの行で書き、説明は付けない。
10. **Other Details**: 公開記録との差別化（wbh-dedupe の `no-match` の文）、prior disclosures、release の比較、claim していないことは、ここにだけ書く。Description と PoC には入れない。
11. **Attachments**: 添付するファイルを 1 行に 1 つ書く。行には、種類（HTTP 記録、画面、録画、PoC script、archive）、Private Evidence の中のパス、sha256 を書く。添付は人間がフォームで行う。期限のある共有 URL など、第三者のサイトへのリンクで代えない（Patchstack「Upload PoCs and other files as attachments」）。

**Wordfence のフォームの選択値**: Authentication は `None/Unauthenticated` か該当する役割、PoC type は `Other, or text instructions` にする。これは写しが届く前からの記述なので、提出のときに人間が live form の実際の選択肢で確かめる。

## 提出フォームの構成（未着）

**未着。** 所有者が提出フォームの項目名と選択肢を console の JavaScript で取り、`src/profiles/wordpress/policy/` に日付付きで写すまで、この節は空けておく（#439 の受入条件 5）。届くまでは、項目名、選択肢、字数の上限を推測で書かない。届いたら、上の節をフォームの項目に割り当てる表をここに置く。

## 出力と記録

1. 報告書 1 本を Markdown で、Private Evidence の Finding のディレクトリ（export の `privateEvidence.directory`）に書く。Git には書かない。一時的にも repo の中に作らない。
2. 書き終えたら、次を自分で数えて確かめる。
   - Description の語数と Impact Statement の字数。
   - placeholder が残っていないか、版の範囲が検証した版に収まっているか。
   - 英語だけで書かれているか。
   - Component に slug、リンク、版、最新版の確認日があるか。
   - PoC の各 step に行為者が書かれ、HTTP request を送る step に raw の request があるか。
   - WP-CLI やサーバー上だけの手順が無いか。
   - Attachments の各行のファイルが実在し、sha256 が一致し、外部リンクで代えていないか。
3. `harness review draft --campaign <id> --finding <id> --programme <patchstack|wordfence> --file <path> --prepared-by ai` で digest を記録する。束ねた報告書は、含めた Finding ごとに同じファイルで記録する。人間が手を入れたら、`--prepared-by human` で改めて記録する。
4. 録画は、Lab 観測器のもの（kind `victim-view`）か、人間が置いたものだけを添付の一覧に入れる。このスキルは録画を起動しない。

## しないこと

- 送信しない。フォームを開かない。Submit を自動化しない。提出は所有者が自分の拡張機能で行う（ADR 0038）。Other Details の最終文、研究者の identity、AI 利用の開示、CAPTCHA、最終確認は人間が行う。AI の関与は正確に開示する。
- `submitted` に進めない。`harness review authorize` と `review submitted` は人間が実行する。
- ペイロード、資格情報、HTTP 本文、報告書の本文、過去の提出の中身を会話に貼らない。最終応答はパス、digest、状態だけにする。
- 束ねるのは、Patchstack 向けの同じ種別の Finding だけである。種別の違う Finding や、提出先の違う Finding を 1 本にしない。
