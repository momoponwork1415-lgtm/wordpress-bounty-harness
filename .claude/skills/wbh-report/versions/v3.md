---
name: wbh-report
description: 人間が再現を記録した Finding について、提出先（Patchstack か Wordfence）の要件とフォームの項目に揃えた英語の報告書の下書き、フォームの項目ごとの値、添付の一覧を Private Evidence に書き、review draft で digest を記録する。送信はしない。
---

# wbh-report v3

対象は、`harness review decide --reproduced match` が記録済みで、`review decide` が `accept` の Finding である。提出先は段 5（wbh-destination、#438）の非公開メモで決まっている。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js` を指す。場所は `--state <dir>` か `WBH_STATE_DIRECTORY` で渡す。旧版の v1 と v2 は `versions/` に残してある。

## 読む入力

- `harness review export --campaign <id> --finding <id>` の JSON。台帳の SQLite を直接読まない。
- `privateEvidence.directory` にある非公開メモ。
  - 段 5 の提出先メモ `destination-<campaign>-<Finding>.md`。2 行目の「結論:」を読む。
  - 重複照合のメモ。パスは `review.duplicate.note` にある。
  - wbh-review のメモと、人間が再現したときの手順メモ。
- 提出先の写し（`src/profiles/wordpress/policy/`）。読むのは提出先の写しだけで、もう一方の写しの行を要件として扱わない。
  - Patchstack: 提出要件 `patchstack-submission-requirements-2026-10-21.md`（「満たすこと」と「受け付けないもの」の分け方は同じファイルの「読み方」）、対象範囲 `patchstack-scope-2026-10-21.md`、フォーム `patchstack-submission-form-2026-10-21.md`。
  - Wordfence: 対象範囲 `wordfence-scope-2026-10-21.md`、フォーム `wordfence-submission-form-2026-10-21.md`。読み方は下の「Wordfence 向けの要件」にまとめた。
- 添付の材料（Private Evidence）。どの節に使うかは下の「Lab の記録の使い道」にある。
  - HTTP 記録は `http.path` にある。`http.source` が `harness-captured` のものだけを request の出典にする。`agent-authored` は Verifier の自己申告なので使わない。
  - 被害者側の画面は `observations.victim.screenshot` にある（Lab 観測器が撮った PNG）。
  - 人間が再現のときに撮った画面と録画も使う。場所は手順メモに書いてある。
  - PR #455 の Lab の画面と録画が main に入ったら、添付の一覧はそれも取る。
- 過去の提出（所有者の提出フォルダ。WSL では `/mnt/d/wordfence/submissions`）。参考にするのは、節の並び、PoC の書き方、添付の種類だけである。本文、プラグイン名、CVE、URL、ペイロード、request、画像は、下書きにも会話にも写さない。

## 書く前の確認

1. `verification.status` が `incomplete` でないこと、`review.decisions` の最後が `accept` であること、`review.humanReproduction.result` が `match` であることを確かめる。どれかが欠けていれば書かない。
2. 提出先を固定する。提出先メモの結論が `patchstack` か `wordfence` のときだけ書く。メモが無いとき、結論が `none` や `vendor:<名>` のときは、書かずに止める。1 つの Finding を 2 つの提出先に出さない。
3. 最新版で確かめたかを見る。`target.versions.latestObserved` か `target.versions.latestKnown` が `target.versions.explored` より新しければ、最新版での再確認（`review reverify --version`）の結果が `review.latestReverification` にあるかを見る。無ければ書かない。報告書には、確かめた版と、それが確認日の時点で最新版だったことを書く（Patchstack「tested against the latest available version」）。
4. 重複を確かめる。`review.decision.duplicate` が `no-match` のときだけ書く。`possible-match` と `unavailable` のときは書かない（Patchstack「Duplicates of earlier reports or already-published CVEs」、ADR 0038 の段 4）。公開範囲とインストール数も、書く前に確かめ直す。
5. 配布中の component かを確かめる。WordPress.org のプラグインの頁で、閉鎖や配布停止になっていないかを見る。`target.versions.latestObserved` が null なら、取得の失敗か閉鎖かを頁で見分ける（Patchstack「Closed, inaccessible, abandoned, or non-publicly-distributed components」、Wordfence の写しの 52 行）。premium 版の Finding なら、改変していない原本の archive を添付の一覧に入れる。
6. 同じ種別の Finding を束ねる（Patchstack 向けだけ）。同じ campaign の review 列（`harness review --campaign <id>`）の Finding を `review export` で読み、同じ `target.targetId` で `finding.impact` も同じ `accept` 済みのものを集める。集めたものは 1 本の報告書にまとめる（Patchstack「Multiple findings of the same vulnerability type must be consolidated into a single report」）。`group.size` が 2 以上なら、群の Finding も入っているかを確かめる。束ねた Finding のそれぞれに、この 1〜5 と 7、8 の確認を行う。Wordfence の写しには束ねる規則が無いので、Wordfence 向けは 1 Finding 1 下書きにする。
7. 手順が遠隔の攻撃者の位置で書けるかを確かめる。前提作りも含めて、手順は画面の操作か HTTP request で書く。WP-CLI、サーバー上のファイル操作、データベースの直接操作が要るなら書かない（Patchstack「WP-CLI or other server-side-only steps are not accepted」、Wordfence の写しの 152 行）。非現実的な前提を要するものも書かない（Patchstack「Unrealistic pre-requisites」）。
8. 主張は、検証の記録と人間が再現した手順の範囲に収める。観測していない成功、観測していない設定、観測していない範囲の版を書かない。Patchstack は、AI が生成した誤った前提を含む報告と、実物で試していない報告を、1 週間の利用停止にする（Patchstack の対象範囲の写しの「Automatic one-week bans」）。
9. Wordfence 向けは、下の「Wordfence 向けの要件」を満たすかを確かめる。満たさなければ書かない。

## Wordfence 向けの要件

写しは `wordfence-scope-2026-10-21.md`（対象範囲と除外）と `wordfence-submission-form-2026-10-21.md`（フォームの項目）である。行番号は対象範囲の写しのものである。

### 報告書に書くこと

1. 攻撃者位置は、未認証か低い権限の利用者（11 行「Subscriber, Customer」）にする。PR:H の役割（93 行。Administrator、Editor、Shop Manager、`unfiltered_html` を持つ役割）か、中間の権限（94 行。Contributor、Author、管理者が与える役割）が要るなら書かない。
2. 影響は、実演した機密性、完全性、可用性への影響で書く（58 行「considerable impact to the confidentiality, integrity, and availability」）。
3. フォームの版の欄は、写しの説明どおり `<=` と、確かめた最新の版にする。
4. Environment には、PHP、WordPress、MySQL の版と、有効にした設定を書く（フォームの Environment の説明）。
5. PoC は、人間が手順どおりに試し、Environment に書いた構成で動いたものだけにする。人間はフォームの Certification でそれを証明する。

### 書く前に確かめ直す対象範囲

- 有効インストール数（`target.activeInstallations` と、確認した時点の WordPress.org の値）。High Threat の 6 種は 25 以上、Stored Cross-Site Scripting と SQL Injection は 500 以上である。そのほかは研究者の tier による（50,000 以上、10,000 以上、500 以上）。25〜999 と 500〜999 の component は WordPress.org に載っていなければならない。premium は 1,000 未満なら対象外である（9〜37 行）。
- 除外資産（WordPress Core と 5 社の製品）に当たらないこと（45〜50 行）。提出の時点で配布か販売が止まっていないこと。vendor のサイトで動く web service ではないこと（52 行）。

### 前提をはっきり書く

前提の文は、次の行に当たらないことが読んで分かるように書く。当たるなら書かない。

- 一般的な構成で容易に再現できない競合状態（97 行、136 行「TOCTOU」）。
- 管理者が低い権限の利用者に明示的に権限を与えることが前提で、その可能性が低いもの（101 行）。
- 過大な brute force（102 行）。
- 管理者が設定や環境を誤って構成したことが前提（158 行）。
- サーバーへのローカルなアクセス、安全でない PHP 設定の変更、`wp_magic_quotes` の無効化、`WP_DEBUG` の有効化、EOL のソフトウェア、古いブラウザ（150〜160 行）。

既定と違う設定が要るときは、その設定を Environment に書き、PoC の最初の step で管理画面から作る。

### よく棄却される報告を文で外す

`finding.impact` ごとに、次の行に当たらないことを、観測した事実として PoC の step か Description の文で示す。否定の行を足して外すのではない。示せないなら書かない。

| `finding.impact` | 写しの行 | 報告書で示すこと |
| --- | --- | --- |
| `stored-xss` | 122〜126 行「CSS Injection」「HTML Injection」「Self Cross-Site Scripting」「Cross-Site Scripting via SVG file uploads」 | 攻撃者とは別の役割の利用者がページを開いたときに JavaScript が実行されることを、観測の step にする。SVG のアップロードによるものは書かない |
| `sqli` | 151 行「Any SQL injection requiring `wp_magic_quotes` to be disabled」 | Environment に書いた構成のまま PoC が動くこと |
| `php-file-write`、`rce` | 84 行「Limited File Uploads」、128〜130 行（安全な種類のファイル、二重拡張子） | 書き込んだファイルがサーバーで PHP として動いたことを、観測にする |
| `arbitrary-file-read`、`arbitrary-file-download`、`arbitrary-file-delete`、`lfi`、`rfi` | 90 行「Basic Information Exposure」、114 行「Full path disclosure」 | 攻撃者が選んだファイルを読めた、または消せたことを観測にし、パスや基本情報の露出で終えない |
| `privesc-to-admin`、`auth-bypass-to-admin`、`account-takeover` | 132〜133 行、145 行、147 行（IP の偽装、CAPTCHA、登録の回避、2FA） | 攻撃の後のアカウントが管理者として操作できることを観測にする。IP、CAPTCHA、2FA を回避するだけのものは書かない |
| すべて | 110 行「Theoretical vulnerabilities」、119 行（CVSS 3.1 が 4.0 未満）、139 行（nonce が守る操作） | request に nonce が要るなら、攻撃者の役割で nonce を得る step を PoC に入れる |

## 報告書の形（英語で書く）

節は次の順に置く。過去の提出で最も多い並び（Description、Environment and configuration、Proof of Concept、Impact Statement、Affected Code References、Product References、Other Details）に、添付の一覧とフォームの項目ごとの値を足した形である。見出しの 1 行目は `# Plugin - <component name> (<= <version>)` にする。

1. **Description**
   - 1 文目は `The <component name> plugin for WordPress is vulnerable to <type>` で始め、検証した版を書く。版の範囲は広げない。
   - 2 文目で欠けている guard を名指しする。call chain は語らない。
   - 3 文目は `This makes it possible for <attacker position> attackers to <result>` の形で、攻撃者位置と結果を書く。
   - 前提が要るときだけ、4 文目に 1 文で書く。`This only affects …` か `This requires …` で始め、サイト運用者の行動と費用で書く。「所有者が文書化された cleanup を省いた」と言い換えられる前提や、独立した前提を 2 つ以上積むものは、報告しない。
   - 前提の文を除いて 120 語以内にする。権限は語彙どおりに書き、`Subscriber and above` のように `and above` を付ける。severity の語、Harness の語り、「local でしか確認していない」という免責、妥当性の自己主張は書かない。
2. **Environment and configuration**: 箇条書きで書く。
   - WordPress、PHP、データベースの版。人間が再現した Lab のものを手順メモから写す。メモに無ければ、所有者に尋ねてから書く。
   - component の名前と確かめた版、それが確認日の時点で最新版であること。premium 版の問題を無料版として書かない（Patchstack「Attach the correct component slug, link, and version」）。
   - 有効にした設定（`labStateDiff.summary.settings` の名前）を、管理画面の menu path で書く。「この設定は不要」という行は書かない。
3. **Proof of Concept**: 番号付きの step で書く。
   - 人間が歩いて記録した手順から書く。Verifier の package だけから作らない。
   - 最初の step で、新しいサイトに component を入れ、前提の設定を管理画面から作る。次に、攻撃者の位置へ切り替える step を独立に置く（ログアウトするか、攻撃者の役割のアカウントでログインする）。最後の step を観測にする。
   - 遠隔の攻撃者の視点で、step ごとに「誰が（未認証か、どの役割のアカウントか）何をするか」を書く。被害者の操作が要る step には、被害者の役割を書く（Patchstack「step-by-step reproduction from a remote attacker's perspective」）。
   - HTTP request を送る step には、raw の request（request line、Host を含む header、body）を添える。値は人間が再現で使った実値にする。method とパスが Harness 捕捉の記録と一致することを確かめる（同「including HTTP requests」）。
   - 画面の言葉で書く（menu path、見出し、group、正確な control label の順）。menu path と control label は backtick で囲む。入力する値は 1 行の code block に置く。値はすべて実値にし、placeholder や `YOUR-SITE` を残さない。
   - 観測は 1 つにし、同じ事実の 2 つ目の証明を書かない。XSS の観測は、サイト自身の origin を示す dialog にする。Patchstack 向けの XSS は、ページを開いただけで追加の操作なしに実行されることを観測の step に書く（Patchstack の対象範囲の写しの XSS の条件）。negative control は、観測が推論のときだけ入れる。それ以外は Private Evidence に残す。
   - 観測の step には、それを写した画面を 1 枚対応付ける（Attachments のファイル名で書く）。録画があれば、手順全体に 1 本対応付ける（同「screenshots, or videos」）。
4. **Impact Statement**: 証拠に裏付けられた 1 文を、150 字以内で書く（Wordfence のフォームの上限は 200 字）。実演した影響だけを書く。動詞が設定の churn（modify、reset、purge、disable、reorder、trigger emails）なら報奨の floor に届かない。より狭い真の 1 文にするか、報告しない。
5. **Affected Code References**: `finding.sourceTrace` のファイルと行のうち、人間が再現で通った経路にあるものを書く。公開リポジトリにある固定した版のファイルの、その行を指す URL を 1 行に 1 つ書き、説明は付けない（Wordfence のフォーム「Provide URLs to affected code on public repositories」）。
6. **Product References**: WordPress.org のプラグインの頁へのリンクを書く。
7. **Other Details**: 公開記録との差別化（重複照合のメモにある `no-match` の文）、prior disclosures、release の比較、claim していないことは、ここにだけ書く。Description と PoC には入れない。
8. **Attachments**: 添付するファイルを 1 行に 1 つ、PoC の step の順に書く。行には、種類（HTTP 記録、画面、録画、PoC script、archive）、Private Evidence の中のパス、sha256 を書く。画面のファイル名は `<step 番号>-<写っているもの>.png` にする。期限のある共有 URL など、第三者のサイトへのリンクで代えない（Patchstack「Upload PoCs and other files as attachments」）。
   - Wordfence のフォームでファイルを付けられるのは、Video Demonstration の 1 つだけである（250 MiB まで）。録画 1 本をそこに当て、画面は所有者が確かめるために一覧に残す。
   - Patchstack は ZIP 5 つまで、合計 100 MB までである。画面、録画、PoC script、archive は ZIP に入れ、ZIP ごとに中身を並べる。How to reproduce の本文だけで再現できるように書き、添付だけに置いた情報に頼らない。
9. **Form fields (<programme>)**: 下の「提出フォームの項目」の表に従い、項目ごとに見出しを 1 つ置き、その下に貼る値だけを書く。見出しは写しの項目名そのままにする。
   - 長い項目の値は、対応する節の本文と同じ文にする。
   - 人間が答える項目は、見出しだけを置いて本文を空にする（Wordfence のフォームの写し「skill は下書きにその欄を空で用意する」）。
   - 写しに選択肢が無い選択の項目には、skill が案を書く。人間は貼る前に live form の選択肢で確かめる。

## 提出フォームの項目

「必須」の列は写しの印のままである。「人間」と書いた項目は、skill が値を書かない。

### Wordfence（`wordfence-submission-form-2026-10-21.md`）

| 項目 | 必須 | 選択肢と上限（写しのまま） | 値 |
| --- | --- | --- | --- |
| Type of Software | * | WordPress Core / WordPress Plugin / WordPress Theme | WordPress Plugin |
| Software Name | * | | 見出しの component name |
| Software Slug | * | | `target.targetId` |
| Affected Version(s) | * | 比較子と版。"If you're unsure of what to enter here, please use <= and provide the latest version of the software in which the vulnerability was confirmed to be present." | `<=` と確かめた最新の版 |
| Would you like Wordfence to handle the responsible disclosure of this vulnerability on your behalf? | * | 'No' を選ぶと報酬も CVE も出ない | 人間 |
| Description of Vulnerability | * | "concisely and accurately" | Description |
| Vulnerability Type | * | 一覧はフォーム側 | 案: 対象範囲の写しの種別名のうち `finding.impact` に当たるもの |
| Impact Statement | * | 1 文、200 字まで | Impact Statement |
| Common Weakness (CWE) Type | * | 名前か CWE 番号で検索 | 案: 最も近い CWE の番号と名前 |
| Authentication Level Required | * | 役割から選ぶ | 案: `finding.attackerPosition` の役割（未認証なら `None/Unauthenticated`） |
| References to Affected Code | | "Provide URLs to affected code on public repositories." | Affected Code References |
| References | | "Provide any supporting URLs where applicable." | Product References |
| Contributing Researchers | | 検索か新規入力 | 人間 |
| What is your Proof of Concept? | * | 選択（例: "Other, or text instructions"）。本文は Markdown | 選択は `Other, or text instructions`、本文は Proof of Concept |
| Video Demonstration | | ファイル 1 つ、250 MiB まで | Attachments の録画。付けるのは人間 |
| Environment | * | PHP、WordPress、MySQL の版と、特別な設定 | Environment and configuration |
| Certification | * | | 人間 |
| AI use と、使った AI tool(s) | * | | 人間 |
| Have you requested a CVE from another CNA for this vulnerability? | * | | 人間 |
| Have you reported this to another vendor, other than the software vendor? | * | | 人間 |
| 規約への同意 | * | | 人間 |

### Patchstack（`patchstack-submission-form-2026-10-21.md`）

| 項目 | 必須 | 選択肢と上限（写しのまま） | 値 |
| --- | --- | --- | --- |
| Submitter name or alias | | | 人間 |
| Contact e-mail | | | 人間 |
| Website | 任意 | | 人間 |
| Component type | | 選択（例: WordPress plugin） | WordPress plugin |
| Affected component | | | 見出しの component name |
| Component slug | | | `target.targetId` |
| Component link | | | Product References のリンク |
| Prefix | | 選択（例: ≤ Less than or equal） | 案: `≤ Less than or equal` |
| Affected version(s) | | | 確かめた最新の版 |
| Pre-requisite | | 選択。"The lowest possible user role needed to recreate the vulnerability. Reports for roles outside the Bug Bounty Program scope will not be accepted." | 案: `finding.attackerPosition` の役割。低く書かない |
| OWASP 2021: Vulnerability class | | 選択 | 案: `finding.impact` に当たる分類 |
| OWASP 2021: Vulnerability type | | 選択 | 案: `finding.impact` に当たる種類 |
| Vulnerability description | | Markdown、10,000 字まで | Description と Impact Statement |
| How to reproduce | | Markdown、50,000 字まで。"Place the complete proof of concept and all steps to reproduce in this 'How to reproduce' textarea. Information provided only in attachments is not accepted." | Environment and configuration と Proof of Concept |
| Additional information | 任意 | Markdown、50,000 字まで | Affected Code References と Other Details |
| Upload or drop files | 任意 | "You can attach up to 5 ZIP (.zip) files, with a combined size of up to 100 MB. Put supporting source code, component files, screenshots or videos inside the ZIP files." | Attachments の ZIP。付けるのは人間 |
| 規約への同意 | | | 人間 |

## Lab の記録の使い道

| export の値 | 使う節 | 添付 |
| --- | --- | --- |
| `http.path`（`http.source` が `harness-captured` のときだけ） | Proof of Concept の raw request の method とパスの照合 | HTTP 記録として付けてよい |
| `labStateDiff.summary.settings` | Environment and configuration の設定の名前 | 付けない |
| `observations.victim.role` | Proof of Concept の被害者の step の役割 | |
| `observations.victim.screenshot` | Proof of Concept の観測の step の画面 | 画面として付けてよい |
| `observations.steps` | 人間の手順メモと突き合わせるだけにする。Verifier の自己申告なので、報告書の主張の根拠にしない | 付けない |
| `finding.sourceTrace` | Affected Code References | |
| `review.duplicate.note` | Other Details の差別化の文 | 付けない |

## 出力と記録

1. 報告書 1 本を Markdown で、`privateEvidence.directory` の直下に `report-<campaign>-<Finding>.md` の名前で書く。このディレクトリは Finding ごとに分かれていない（提出先メモと同じ）。添付するファイルは、名前を付け直した写しを `report-<campaign>-<Finding>/` に置き、Patchstack 向けの ZIP もそこに作る。束ねた報告書には、書き始めた Finding の ID を使う。Git には書かない。一時的にも repo の中に作らない。
2. 書き終えたら、次を自分で数えて確かめる。
   - Description の語数（前提の文を除く）と、Impact Statement の字数。
   - placeholder が残っていないか、版の範囲が検証した版に収まっているか。
   - 英語だけで書かれているか。
   - Environment に WordPress、PHP、データベースの版と、確かめた版と最新版の確認日があるか。
   - PoC の各 step に行為者が書かれ、HTTP request を送る step に raw の request があるか。
   - WP-CLI やサーバー上だけの手順が無いか。
   - Attachments の各行のファイルが実在し、sha256 が一致し、外部リンクで代えていないか。Wordfence 向けは録画が 1 本で 250 MiB 以内か。Patchstack 向けは ZIP が 5 つ以内で、合計 100 MB 以内か。
   - Form fields に写しの項目がすべてあるか。長い項目の値が対応する節と同じ文か。字数が写しの上限に収まっているか。人間が答える項目が空か。
3. `harness review draft --campaign <id> --finding <id> --programme <patchstack|wordfence> --file <path> --prepared-by ai` で digest を記録する。束ねた報告書は、含めた Finding ごとに同じファイルで記録する。人間が手を入れたら、`--prepared-by human` で改めて記録する。
4. 録画は、人間が置いたものだけを添付の一覧に入れる。このスキルは録画を起動しない。

## しないこと

- 送信しない。フォームを開かない。Submit を自動化しない。提出は所有者が自分の拡張機能で行う（ADR 0038）。上の表で「人間」と書いた項目、Other Details の最終文、CAPTCHA、最終確認は人間が行う。AI の関与は正確に開示する。
- `submitted` に進めない。`harness review authorize` と `review submitted` は人間が実行する。
- ペイロード、資格情報、HTTP 本文、報告書の本文、過去の提出の中身を会話に貼らない。最終応答はパス、digest、状態だけにする。
- 束ねるのは、Patchstack 向けの同じ種別の Finding だけである。種別の違う Finding や、提出先の違う Finding を 1 本にしない。
