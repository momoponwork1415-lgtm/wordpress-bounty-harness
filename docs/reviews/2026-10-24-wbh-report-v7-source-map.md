# `wbh-report` v7 全文・日本語訳・出典対照表（2026-10-24）

## 対象と結論

この文書は `.claude/skills/wbh-report/SKILL.md` v7 の全文を下に保存し、`docs/DEVELOPMENT.md` 第 5 節の出典対照表を記す。旧 v6 の本文は別 PR で `.claude/skills/wbh-report/versions/v6.md` に保存する。v7 は、nonce 回収による `runtime-confirmed` の登録済み暫定文案を維持し、現行 `incomplete(observation)` に Harness 所有ブラウザの dialog 観測がある場合だけ、Wordfence 向けの登録しない内部プレビューを Private Evidence に書く。攻撃要求との marker 一致と順序は因果関係を証明しない。ブラウザ signal は nonce 回収や人間の手動再現の代わりではない。

この文書には未公開 Finding の名前、攻撃 URL、payload、捕捉 HTTP、報告本文を載せない。新経路の実 Finding での成功件数は、この改訂時点では計測していない。

## 出典対照表

| v7 の要素 | 出典・根拠 | 採用範囲 |
| --- | --- | --- |
| dialog 観測を先に記録し、人間が最後に再現・査読する | 所有者の 2026-10-24 の指示「検証は軽くやって人間の検証でもいい」「発火したという事実だけ記録」；`docs/adr/0038-verification-phases-and-submission-flow.md` 追記 9 | 登録しない内部プレビューのみ |
| 独立 signal の値、攻撃要求との marker 一致と順序、別の被害者、既存コンテンツの人間確認 | `src/review/export.ts` の `browserSignal` 契約、`src/profiles/wordpress/verification/verifier-record.ts` の `dialogSchema` と `signal`、`src/profiles/wordpress/verification/judges.ts` の stored-script judge と独立レビュー | export は `dialog-observed`、`capturedAttackerRequestMarkerMatch: true`、`verificationSequence: post-setup-request-before-victim-visit`、`victimPrincipal: separate` を要求する。Private Evidence record の `requiresHumanPreexistingContentCheck: true` も要求する。因果関係は未証明 |
| 現行検証・Snapshot・Lab Setup・証拠 digest への結合 | `src/review/export.ts` の最新 `verification-finished` 選択と evidence digest 読み込み、`src/profiles/wordpress/verification/verifier-record.ts` の file digest、`docs/SPEC.md` 第 2 節 5 | 別 attempt・別 Snapshot の記録は使わない |
| Harness 捕捉 HTTP を必須にし、自己申告や setup だけで成功と書かない | `src/profiles/wordpress/verification/http-evidence.ts`、`src/review/export.ts` の `http.source`、`docs/SPEC.md` 第 2 節 3 | `http.source: harness-captured` の場合のみプレビューを進める |
| `runtime-confirmed` は nonce canary に限り、観測不足は `incomplete` | `docs/SPEC.md` 第 2 節 3–4、`docs/adr/0038-verification-phases-and-submission-flow.md` 追記 9 | 判定結果の昇格を禁じる |
| Private Evidence に文案を置き、提出用の登録をしない | `docs/SPEC.md` 第 2 節 7–8、`src/review/index.ts` の draft・scope・authorization gate、ADR 0038 追記 9 | `review draft`、Submission Candidate、package manifest を作らない |
| JSON は根拠のある 16 項目が揃った場合だけ `pending` | `src/profiles/wordpress/policy/wordfence-fill-only-v3.md` の schema と拡張機能の `pending` 制御、所有者の Wordfence 優先・AI tools 初期値の指示 | 不明値の創作、空欄埋め、フォーム入力をしない |
| 動画は任意 | 所有者の「video は必須ではない」の指示、`wbh-report` v6 | 実在する録画だけ添付候補にする |
| confirmed 経路と Patchstack の既存手順 | `wbh-report` v6 の全文、ADR 0038 の既存の段階的決定 | 新しい内部プレビュー以外は維持 |

## 日本語訳

以下のスキル全文は日本語で書かれているため、その本文が日本語訳を兼ねる。フォーム上の英語ラベル、schema key、CLI command は照合に必要な固有文字列として原文を保持する。新たな英語表示文だけは次のとおり訳す。

| スキルの固定表示文 | 日本語訳 |
| --- | --- |
| `Internal observation preview: a matching request preceded a browser dialog in one verification. Causality, preexisting content, nonce confirmation, and human reproduction remain unverified. Do not submit.` | 内部観測プレビュー：同じ検証で、一致する要求の後にブラウザ dialog を観測した。因果関係、既存コンテンツの影響、nonce 確認、人間による再現は未確認。提出しないこと。 |
| `Internal draft: human reproduction and report review pending. Do not submit.` | 内部暫定文案：人間による再現と報告書の査読は未了。提出しないこと。 |

## 改訂後のスキル全文

````markdown
---
name: wbh-report
description: Wordfence 向けの英語報告書とフォーム入力用 JSON を Private Evidence に作る。nonce 確認済みなら review draft に記録し、ブラウザ dialog の観測なら因果関係と人間確認待ちの内部プレビューにとどめる。送信はしない。
---

# wbh-report v7

Wordfence 向けは、Harness の判定器が `runtime-confirmed` とした Finding から、人間が手動再現する前に**登録する暫定版**を作る。旧経路の `reproduced` は、この Wordfence 主経路には入れない。`incomplete(observation)` に Harness 所有ブラウザの dialog 観測がある場合は、後述の**登録しない内部プレビュー**だけを作れる。攻撃要求との marker 一致と順序は、dialog の原因まで証明しない。どちらも手動再現済み・提出可能と主張しない。人間が最後に Lab で再現し、報告書と JSON を査読・修正してから、別の版として記録する。Patchstack 向けの報告作成条件と Markdown の形は v3 のままにする。Patchstack も承認前には、人間が査読した最終文案を別 revision として保存し、その後に人間の `accept` を記録する。提出先は段 5（wbh-destination、#438）の非公開メモで決まる。`harness` は repo root で `pnpm build` した後の `node dist/cli/main.js` を指す。場所は `--state <dir>` か `WBH_STATE_DIRECTORY` で渡す。旧版の v1〜v6 は `versions/` に残す。

## 読む入力

- `harness review export --campaign <id> --finding <id>` の JSON。台帳の SQLite を直接読まない。
- `privateEvidence.directory` にある非公開メモ。
  - 段 5 の提出先メモ `destination-<campaign>-<Finding>.md`。2 行目の「結論:」を読む。
  - 重複照合のメモ。パスは `review.duplicate.note` にある。
  - wbh-review のメモ。人間の手順メモは Wordfence の暫定版には不要で、最終化のときに読む。Patchstack では従来どおり読む。
- 提出先の写し（`src/profiles/wordpress/policy/`）。読むのは提出先の写しだけで、もう一方の写しの行を要件として扱わない。
  - Patchstack: 提出要件 `patchstack-submission-requirements-2026-10-21.md`（「満たすこと」と「受け付けないもの」の分け方は同じファイルの「読み方」）、対象範囲 `patchstack-scope-2026-10-21.md`、フォーム `patchstack-submission-form-2026-10-21.md`。
  - Wordfence: 対象範囲 `wordfence-scope-2026-10-21.md`、フォーム `wordfence-submission-form-2026-10-21.md`。読み方は下の「Wordfence 向けの要件」にまとめた。
- 添付の材料（Private Evidence）。どの節に使うかは下の「Lab の記録の使い道」にある。
  - HTTP 記録は `http.path` にある。`http.source` が `harness-captured` のものだけを request の出典にする。`agent-authored` は Verifier の自己申告なので使わない。
  - 被害者側の画面は `observations.victim.screenshot` にある（Lab 観測器が撮った PNG）。
  - `incomplete(observation)` の内部プレビューでは `observations.victim.browserSignal.record` の Lab browser 記録を読む。`pageAfterDialogScreenshot` は dialog を閉じた後の画面で、dialog 自体の画像ではない。
  - 人間が再現のときに撮った画面と録画は、最終化のときに使う。暫定版に存在しない添付として書かない。
  - PR #455 の Lab の画面と録画が main に入ったら、添付の一覧はそれも取る。
- 過去の提出（所有者の提出フォルダ。WSL では `/mnt/d/wordfence/submissions`）。参考にするのは、節の並び、PoC の書き方、添付の種類だけである。本文、プラグイン名、CVE、URL、ペイロード、request、画像は、下書きにも会話にも写さない。
- Wordfence 履歴 mirror（`src/profiles/wordpress/wordfence-history/README.md` の Git 外の SQLite）。段 4 の重複照合と検証が済んだ後だけ、公開済みで同じ impact・攻撃者位置に近い別 slug の `description` を最大 3 件読む。mirror が使えなければ文体の参照だけを省く。公開記録の本文・PoC・ペイロードを探索へ渡さない。

## 書く前の確認

1. Wordfence 向けの**登録する暫定版**は、Finding と検証結果の Target Snapshot digest が一致し、Harness の判定器による `verification.status` が `runtime-confirmed` で、実行時の再現パッケージと nonce 付き canary の証拠が参照できることを確かめる。`incomplete`、旧経路の `reproduced`、自己申告だけの観測、digest 不一致からはこの主経路の暫定版を書かない。`review.decision.decision` が `accept`、`review.decision.reasonCode` が `preliminary-pass` で、`review.decision.decidedAt` が現行 `verification.occurredAt` より後であることを確かめる。これは AI の中間記録で、提出前の人間査読ではない。この段階では `review.humanReproduction.result` の `match` と人間の最終 `accept` は要求しない。`incomplete(observation)` の内部プレビューは後述の条件だけで分けて扱う。Patchstack 向けは v3 と同じく、最後の判断が `accept` で、人間の再現が `match` のときだけ書く。
2. 提出先を固定する。提出先メモの結論が `patchstack` か `wordfence` のときだけ書く。メモが無いとき、結論が `none` や `vendor:<名>` のときは、書かずに止める。1 つの Finding を 2 つの提出先に出さない。
3. 最新版で確かめたかを見る。`target.versions.latestObserved` か `target.versions.latestKnown` が `target.versions.explored` より新しければ、最新版での再確認（`review reverify --config <path> --handoff <dir>`。`--version` を付けない）の結果が `review.latestReverification` にあり、Wordfence 主経路では `runtime-confirmed` であることを確かめる。結果が無いか `incomplete` なら書かない。`review.latestReverification.findingId` が元の Finding ID と違う場合、**元 Finding の文案・draft を止める**。その ID を `review export --campaign <id> --finding <derived Finding ID>` で開き、derived Finding 自身の Target Snapshot、判定器の証拠、最新版、重複、scope、提出先を改めて照合してから、その ID で報告書と `review draft` を作る。元 Finding の HTTP や source trace を最新版の証拠として流用しない。報告書には、確かめた版と、それが確認日の時点で最新版だったことを書く（Patchstack「tested against the latest available version」）。
4. 重複を確かめる。`review.duplicate.status` が `no-match` で、`review.duplicate.checkedAt` が現行 `verification.occurredAt` より後のときだけ書く。`possible-match` と `unavailable` のときは書かない（Patchstack「Duplicates of earlier reports or already-published CVEs」、ADR 0038 の段 4）。Wordfence の scope は、段 4 で同じ Finding ID に実行した最新の `review scope` 出力の assessment ID に `scope:` を付けた値と `review.scopeAssessments[].assessmentId` を突き合わせ、同じ要素の `status` が `in-scope` であることを確かめる。export の履歴内の古い `in-scope` だけでは進めない。`ambiguous`、期限切れ、未評価は止める。公開範囲とインストール数も、書く前に確かめ直す。
5. 配布中の component かを確かめる。WordPress.org のプラグインの頁で、閉鎖や配布停止になっていないかを見る。`target.versions.latestObserved` が null なら、取得の失敗か閉鎖かを頁で見分ける（Patchstack「Closed, inaccessible, abandoned, or non-publicly-distributed components」、Wordfence の写しの 52 行）。premium 版の Finding なら、改変していない原本の archive を添付の一覧に入れる。
6. 同じ種別の Finding を束ねる（Patchstack 向けだけ）。同じ campaign の review 列（`harness review --campaign <id>`）の Finding を `review export` で読み、同じ `target.targetId` で `finding.impact` も同じ `accept` 済みのものを集める。集めたものは 1 本の報告書にまとめる（Patchstack「Multiple findings of the same vulnerability type must be consolidated into a single report」）。`group.size` が 2 以上なら、群の Finding も入っているかを確かめる。束ねた Finding のそれぞれに、この 1〜5 と 7、8 の確認を行う。Wordfence の写しには束ねる規則が無いので、Wordfence 向けは 1 Finding 1 下書きにする。
7. 手順が遠隔の攻撃者の位置で書けるかを確かめる。前提作りも含めて、手順は画面の操作か HTTP request で書く。WP-CLI、サーバー上のファイル操作、データベースの直接操作が要るなら書かない（Patchstack「WP-CLI or other server-side-only steps are not accepted」、Wordfence の写しの 152 行）。非現実的な前提を要するものも書かない（Patchstack「Unrealistic pre-requisites」）。
8. Wordfence の暫定版の主張は、Harness が捕捉した HTTP、Lab 観測器、判定器、固定 source で裏付けられる範囲に収める。Verifier の `observations.steps` は手順の候補として読んでも、成功の証拠にはしない。人間が行ったと書かず、まだ歩いていない手順・未観測の設定・版・影響を事実として補わない。足りない箇所は非公開の査読チェックに列挙する。Patchstack は従来どおり、人間が再現した手順と検証記録の範囲で書く。Patchstack は、AI が生成した誤った前提を含む報告と、実物で試していない報告を、1 週間の利用停止にする（Patchstack の対象範囲の写しの「Automatic one-week bans」）。
9. Wordfence 向けは、下の「Wordfence 向けの要件」を満たすかを確かめる。満たさなければ書かない。

## Wordfence 向けの要件

写しは `wordfence-scope-2026-10-21.md`（対象範囲と除外）と `wordfence-submission-form-2026-10-21.md`（フォームの項目）である。行番号は対象範囲の写しのものである。

### 報告書に書くこと

1. 攻撃者位置は、未認証か低い権限の利用者（11 行「Subscriber, Customer」）にする。PR:H の役割（93 行。Administrator、Editor、Shop Manager、`unfiltered_html` を持つ役割）か、中間の権限（94 行。Contributor、Author、管理者が与える役割）が要るなら書かない。
2. 影響は、実演した機密性、完全性、可用性への影響で書く（58 行「considerable impact to the confidentiality, integrity, and availability」）。
3. フォームの版の欄は、写しの説明どおり `<=` と、確かめた最新の版にする。
4. Environment には、PHP、WordPress、MySQL の版と、有効にした設定を書く（フォームの Environment の説明）。
5. 暫定版の PoC は Harness が観測した操作と結果から書き、人間が歩いたと主張しない。人間の手動再現後、実際に行った手順と Environment に合わせて最終版を直す。フォームの Certification は人間がその後に答える。

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

節は次の順に置く。過去の提出で最も多い並び（Description、Environment and configuration、Proof of Concept、Impact Statement、Affected Code References、Product References、Other Details）に、添付の一覧とフォームの項目ごとの値を足した形である。見出しの 1 行目は `# Plugin - <component name> (<= <version>)` にする。Wordfence の暫定版には、その直後に `Internal draft: human reproduction and report review pending. Do not submit.` と明記する。最終版では人間がこの表示を外す。

1. **Description**
   - 公開 mirror の類似例は、種別・原因・攻撃者ができることを述べる順序、長さ、役割の呼び方だけの手本にする。類似例の文や固有の事実を写さず、今回の版・guard・結果は Finding、固定 source、Lab の証拠から書く。類似例の ID は非公開の査読チェックに残す。
   - 1 文目は `The <component name> plugin for WordPress is vulnerable to <type>` で始め、検証した版を書く。版の範囲は広げない。
   - 2 文目で欠けている guard を名指しする。call chain は語らない。
   - 3 文目は `This makes it possible for <attacker position> attackers to <result>` の形で、攻撃者位置と結果を書く。
   - 前提が要るときだけ、4 文目に 1 文で書く。`This only affects …` か `This requires …` で始め、サイト運用者の行動と費用で書く。「所有者が文書化された cleanup を省いた」と言い換えられる前提や、独立した前提を 2 つ以上積むものは、報告しない。
   - 前提の文を除いて 120 語以内にする。権限は語彙どおりに書き、`Subscriber and above` のように `and above` を付ける。severity の語、Harness の語り、「local でしか確認していない」という免責、妥当性の自己主張は書かない。
2. **Environment and configuration**: 箇条書きで書く。
   - WordPress、PHP、データベースの版。Wordfence の暫定版では固定 Snapshot と Lab の記録から写し、最終版では人間が再現した Lab の記録と照合する。Patchstack では人間の手順メモから写す。根拠のない版は埋めない。
   - component の名前と確かめた版、それが確認日の時点で最新版であること。premium 版の問題を無料版として書かない（Patchstack「Attach the correct component slug, link, and version」）。
   - 有効にした設定（`labStateDiff.summary.settings` の名前）を、管理画面の menu path で書く。「この設定は不要」という行は書かない。
3. **Proof of Concept**: 番号付きの step で書く。
   - Wordfence の暫定版は、Harness 捕捉の request、Lab 観測器の記録、判定器の結果、固定 source から再現の候補手順を書く。各 step の行為者と観測の根拠を非公開の査読チェックに対応付ける。Verifier の自己申告だけを根拠にしない。Patchstack と Wordfence の最終版は、人間が歩いて記録した手順に直す。
   - 最初の step で、新しいサイトに component を入れ、前提の設定を管理画面から作る。次に、攻撃者の位置へ切り替える step を独立に置く（ログアウトするか、攻撃者の役割のアカウントでログインする）。最後の step を観測にする。
   - 遠隔の攻撃者の視点で、step ごとに「誰が（未認証か、どの役割のアカウントか）何をするか」を書く。被害者の操作が要る step には、被害者の役割を書く（Patchstack「step-by-step reproduction from a remote attacker's perspective」）。
   - HTTP request を送る step には、raw の request（request line、Host を含む header、body）を添える。暫定版には `http.source: harness-captured` の実値だけを使い、method とパスを捕捉記録と照合する。最終版では人間が再現で使った request に更新する（同「including HTTP requests」）。資格情報や一時的な Lab の秘密を公開文へ含めない。
   - 画面の言葉で書く（menu path、見出し、group、正確な control label の順）。menu path と control label は backtick で囲む。入力する値は 1 行の code block に置く。値はすべて捕捉した実値にし、placeholder や `YOUR-SITE` を残さない。画面の control label を捕捉していない場合は推測して埋めず、非公開の査読チェックに不足として書く。
   - 観測は 1 つにし、同じ事実の 2 つ目の証明を書かない。XSS の観測は、サイト自身の origin を示す dialog にする。Patchstack 向けの XSS は、ページを開いただけで追加の操作なしに実行されることを観測の step に書く（Patchstack の対象範囲の写しの XSS の条件）。negative control は、観測が推論のときだけ入れる。それ以外は Private Evidence に残す。
   - 観測の step には、それを写した実在する画面を 1 枚対応付ける（Attachments のファイル名で書く）。暫定版では Lab 観測器の画面を使える。画面が無いなら作ったことにせず、査読チェックに不足を記す。録画が実在すれば手順全体に 1 本対応付ける（同「screenshots, or videos」）。
4. **Impact Statement**: 証拠に裏付けられた 1 文を、150 字以内で書く（Wordfence のフォームの上限は 200 字）。実演した影響だけを書く。動詞が設定の churn（modify、reset、purge、disable、reorder、trigger emails）なら報奨の floor に届かない。より狭い真の 1 文にするか、報告しない。
5. **Affected Code References**: `finding.sourceTrace` のファイルと行のうち、暫定版では Harness が捕捉した経路と固定 source で裏付けられ、最終版では人間が再現で通った経路にあるものを書く。公開リポジトリにある固定した版のファイルの、その行を指す URL を 1 行に 1 つ書き、説明は付けない（Wordfence のフォーム「Provide URLs to affected code on public repositories」）。
6. **Product References**: WordPress.org のプラグインの頁へのリンクを書く。
7. **Other Details**: 公開記録との差別化（重複照合のメモにある `no-match` の文）、prior disclosures、release の比較、claim していないことは、ここにだけ書く。Description と PoC には入れない。
8. **Attachments**: 添付するファイルを 1 行に 1 つ、PoC の step の順に書く。行には、種類（HTTP 記録、画面、録画、PoC script、archive）、Private Evidence の中のパス、sha256 を書く。画面のファイル名は `<step 番号>-<写っているもの>.png` にする。期限のある共有 URL など、第三者のサイトへのリンクで代えない（Patchstack「Upload PoCs and other files as attachments」）。
   - Wordfence のフォームでファイルを付けられるのは、任意の Video Demonstration の 1 つだけである（250 MiB まで）。録画が実在するときだけ、人間がそこに 1 本添付する。録画が無ければ欄は空のままでよい。画面は所有者が確かめるために一覧に残す。
   - Patchstack は ZIP 5 つまで、合計 100 MB までである。画面、録画、PoC script、archive は ZIP に入れ、ZIP ごとに中身を並べる。How to reproduce の本文だけで再現できるように書き、添付だけに置いた情報に頼らない。
9. **Form fields (<programme>)**: 下の「提出フォームの項目」の表に従い、項目ごとに見出しを 1 つ置き、その下に貼る値だけを書く。見出しは写しの項目名そのままにする。
   - 長い項目の値は、対応する節の本文と同じ文にする。
   - 人間が答える項目は、見出しだけを置いて本文を空にする（Wordfence のフォームの写し「skill は下書きにその欄を空で用意する」）。
   - 写しに選択肢が無い選択の項目には、skill が案を書く。人間は貼る前に live form の選択肢で確かめる。
10. **Internal package binding**（Wordfence のみ）: 提出欄へは貼らない内部節として、同じ版の `wordfence-fill-only/3` JSON の Private Evidence 内相対 path と sha256、`submission-package/v1` manifest の相対 path を書く。暫定版では人間の手動再現・査読が未完了と明記し、最終版では実際の結果に更新する。JSON を作り直したら、この sha256 と Markdown の版も更新する。manifest は Markdown と JSON の sha256 を持つため、Markdown に manifest 自身の sha256 は埋めない。

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
| Video Demonstration | | 任意。ファイル 1 つ、250 MiB まで | 録画が実在するときだけ人間が添付。無ければ空欄 |
| Environment | * | PHP、WordPress、MySQL の版と、特別な設定 | Environment and configuration |
| Certification | * | | 人間 |
| AI use | * | Yes / No | 人間 |
| What AI tool(s) did you use to generate this report or discover this vulnerability? | * | テキスト欄 | 初期テンプレート `OpenAI Codex and Claude Code`。人間が最終査読で実際に使ったツールに合わせて修正する |
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

## Wordfence のフォーム入力用 JSON

Wordfence の暫定版には、Markdown と同じ Private Evidence に `wordfence-fill-only/3` JSON を別に書く。これは所有者の Fill-Only Extension の入力である。契約の正本は `src/profiles/wordpress/policy/wordfence-fill-only-v3.md`。拡張機能は 16 項目の構造を入力前に検査し、各 `fields[].key` をフォーム上の入力欄に対応付けて入力後に読み戻す。`human_verification.status` が `pending` の暫定 JSON は確認表示までとし、フォームへ入力しない。人間の再現・査読後の `confirmed` 版だけを使う。拡張機能は Submit を実行しない。

最上位は `schema_version: "wordfence-fill-only/3"`、`generated_at`、`target`、`fields`、`poc`、`human_verification`、`human_only` とする。`target` には `software_name`、`software_slug`、確認した `version` を入れる。`poc` の `markdown` は Markdown の Proof of Concept 節と同じ本文にする。`human_verification` は暫定版で `{ "status": "pending" }` とし、人間が行っていない確認日時・結果を入れない。`human_only` の `never_automate` は、開示の委任、Certification、AI 利用の Yes/No、CVE・他 vendor への報告、研究者 identity、規約同意、CAPTCHA、Submit を文字列の配列で列挙する。AI tool(s) の名前は `fields` に入れる。根拠の digest があれば `source` に置く。`report_style` は内部の版名として使え、拡張機能は読まない。

`fields` の各要素には `field_number`（自動入力項目の順を示す整数）、`key`、`kind`、`required`（boolean）、`value` を入れる。`field_number` は拡張機能のエラー表示用であり、フォームとの対応は `key` で決まる。`choice` / `text` / `long-text` の `value` は文字列、`multi-text` は文字列の配列にする。次の 16 項目をこの順で置く。選択肢の実値は提出時の live form で人間が確かめ、暫定版の段階で存在しない選択肢を作らない。`cwe` は `CWE-<番号>` とし、拡張機能はフォーム選択肢の番号と完全一致させる。`ai_tools` は初期テンプレート `OpenAI Codex and Claude Code` を入れる。人間が最終査読で実際に使ったツールを確認し、必要なら修正する。

| `field_number` | `key` | `kind` | `required` | Markdown の値 |
| --- | --- | --- | --- | --- |
| 1 | `software_type` | `choice` | true | `WordPress Plugin` |
| 2 | `software_name` | `text` | true | Software Name |
| 3 | `software_slug` | `text` | true | Software Slug |
| 4 | `version_operator` | `choice` | true | `<=` |
| 5 | `affected_version_to` | `text` | true | Affected Version(s) の確認版 |
| 6 | `description` | `long-text` | true | Description of Vulnerability |
| 7 | `vulnerability_type` | `choice` | true | Vulnerability Type の案 |
| 8 | `impact_statement` | `text` | true | Impact Statement |
| 9 | `cwe` | `choice` | true | Common Weakness (CWE) Type の案 |
| 10 | `authentication` | `choice` | true | Authentication Level Required の案 |
| 11 | `affected_code_references` | `multi-text` | false | References to Affected Code の URL 配列 |
| 12 | `product_references` | `multi-text` | false | References の URL 配列 |
| 13 | `proof_of_concept_type` | `choice` | true | What is your Proof of Concept? の選択案 |
| 14 | `proof_of_concept` | `long-text` | true | Proof of Concept の本文 |
| 15 | `environment` | `long-text` | true | Environment and configuration の本文 |
| 16 | `ai_tools` | `long-text` | true | What AI tool(s) did you use to generate this report or discover this vulnerability? の値 |

人間が答える欄は `fields` に入れない。v3 は `<=` と確認した上限の版だけを入力し、`affected_version_from` は `fields` に入れない。必須の値を実証できない場合は仮の値で JSON を完成させず、報告書の暫定版と非公開の不足一覧を残して JSON / manifest / `review draft` の記録を止める。

JSON を出す場合は、フォーム用の文字列と Markdown の対応する節が同じであること、16 個の `key` が重複なくそろうこと、`ai_tools` に初期テンプレートが入っていること、`multi-text` だけが配列であること、`human_verification.status` が `pending` であることを機械的に確認する。選択肢の live form との一致と AI tool(s) の実際の利用状況は、提出前の人間の査読で確認する。

## Lab の記録の使い道

| export の値 | 使う節 | 添付 |
| --- | --- | --- |
| `http.path`（`http.source` が `harness-captured` のときだけ） | Proof of Concept の raw request の method とパスの照合 | HTTP 記録として付けてよい |
| `labStateDiff.summary.settings` | Environment and configuration の設定の名前 | 付けない |
| `observations.victim.role` | Proof of Concept の被害者の step の役割 | |
| `observations.victim.screenshot` | Proof of Concept の観測の step の画面 | 画面として付けてよい |
| `observations.steps` | 暫定版の手順候補と、後の人間の手順メモとの突き合わせにだけ使う。Verifier の自己申告なので、報告書の主張の根拠にしない | 付けない |
| `finding.sourceTrace` | Affected Code References | |
| `review.duplicate.note` | Other Details の差別化の文 | 付けない |

## 出力と記録（`runtime-confirmed` の登録する暫定版）

1. 報告書 1 本を Markdown で、`privateEvidence.directory` の直下に書く。このディレクトリは Finding ごとに分かれていない（提出先メモと同じ）。Wordfence 向けは `report-<campaign>-<Finding>-r<revision>.md` とし、版ごとに別ファイルにして以前の版を上書きしない。添付の写しは `report-<campaign>-<Finding>-r<revision>/` に置く。Patchstack 向けは v3 の `report-<campaign>-<Finding>.md`、添付は `report-<campaign>-<Finding>/` のままとし、ZIP もそこに作る。束ねた報告書には、書き始めた Finding の ID を使う。Git には書かない。一時的にも repo の中に作らない。
2. Wordfence 向けは、同じ版の `report-<campaign>-<Finding>-r<revision>.wordfence-fill.json` を書く。必須の `fields[].value` を根拠で満たせないときは JSON を出さず、不足を Private Evidence の査読チェックに記録して止める。JSON ができたら、その相対 path と sha256 を Markdown の `Internal package binding` に入れる。続いて `report-<campaign>-<Finding>-r<revision>.submission-package.json` を書き、`schema_version: "submission-package/v1"`、一意の `id`、`created_at`、`report_group_id`（Wordfence は Finding ID）、`program: "wordfence"`、`report`、`fill_json`、`attachments`、`human_only_remaining` を入れる。`report` と `fill_json` はそれぞれ Private Evidence 内の相対 `path`、`media_type`、`bytes`、`sha256` の object、`attachments` は同じ形の object の配列にする。`human_only_remaining` には手動再現、査読、開示・Certification・AI 利用の Yes/No などの人間専用欄、外部承認、送信を残す。manifest は Markdown の sha256 を持ち、Markdown は JSON の sha256 と manifest の path を持つ。両方の digest が実ファイルと一致することを確かめる。
3. 書き終えたら、次を自分で数えて確かめる。
   - Description の語数（前提の文を除く）と、Impact Statement の字数。
   - 提出欄に placeholder が残っていないか、版の範囲が検証した版に収まっているか。人間専用欄は空にする。
   - 英語だけで書かれているか。
   - Environment に WordPress、PHP、データベースの版と、確かめた版と最新版の確認日があるか。
   - PoC の各 step に行為者が書かれ、HTTP request を送る step に raw の request があるか。
   - Affected Code References の各 URL が固定した版のファイルを指し、該当する行番号アンカーを持つか。
   - WP-CLI やサーバー上だけの手順が無いか。
   - Attachments の各行のファイルが実在し、sha256 が一致し、外部リンクで代えていないか。Wordfence 向けは録画があれば 1 本で 250 MiB 以内か。Patchstack 向けは ZIP が 5 つ以内で、合計 100 MB 以内か。
   - Form fields に写しの項目がすべてあるか。長い項目の値が対応する節と同じ文か。字数が写しの上限に収まっているか。人間が答える項目が空か。
   - Wordfence 向けは、Markdown の `Internal package binding` と JSON と manifest の path / sha256 が一致し、16 個の入力項目の値が Form fields と一致するか。`human_verification.status` が暫定版では `pending` か。`ai_tools` が初期テンプレートか。JSON に人間専用の欄や人間の確認済みという主張が無いか。
4. `harness review draft --campaign <id> --finding <id> --programme <patchstack|wordfence> --file <path> --prepared-by ai` で Markdown の digest を記録する。Wordfence の暫定 Markdown は JSON の sha256 を含むので、承認対象の draft revision はフォーム入力値にも結び付く。束ねた Patchstack 報告書は、含めた Finding ごとに同じファイルで記録する。
5. Wordfence の人間の手動再現後は、実際の手順・Environment・画面と report / JSON の値を人間が照合し、別 revision の Markdown、JSON、manifest を作る。人間は JSON と manifest の sha256 を**実ファイルから再計算**し、Markdown の `Internal package binding`、manifest の `report` / `fill_json` / `attachments` と一致することも確認する。`human_verification.status` は人間が確認した結果にだけ更新する。人間は `review decide --reproduced match`、最終 Markdown の `review draft --prepared-by human`、`review decide --decision accept`、正確な文案版と送信先に対する `review authorize` をこの順で行う。Patchstack は v3 の条件に従って手動再現の `match` と報告作成前の `accept` を確かめてから Markdown を作る。その後、承認前に人間が同じ文案を査読して `review draft --prepared-by human` で最終 revision を保存し、さらに人間の `review decide --decision accept` を記録する。Patchstack 用の JSON や追加の自動化は作らない。この skill は AI の文案記録までを行い、後の人間の判断や承認を代行しない。
6. 録画は、実在するものだけを添付の一覧に入れる。このスキルは録画を起動しない。

## `incomplete(observation)` の内部プレビュー

この経路は、Lab browser の dialog 観測を人間へ渡す作業資料に限る。上の「書く前の確認」にある `runtime-confirmed`、最新の `in-scope` scope assessment、暫定 `accept`、重複 `no-match`、最新版確認を満たしたと**読み替えない**。欠ける結果は査読チェックに書き、提出可能性を結論しない。

1. `review export` の現在の `verification` が `status: incomplete`、`reason: observation` で、`observations.victim.browserSignal` の `kind` が `numeric-dialog`、`status` が `dialog-observed`、`capturedAttackerRequestMarkerMatch` が `true`、`verificationSequence` が `post-setup-request-before-victim-visit`、`victimPrincipal` が `separate` のときだけ進む。画面にある文字列、クリック、Verifier の手順メモ、marker の不一致、順序が確立していない観測は代用しない。`http.source` が `harness-captured` であることも確認する。
2. `observations.victim.browserSignal.record.path` の JSON を Private Evidence から読み、実ファイルの sha256 が `observations.victim.browserSignal.record.digest` と一致することを確かめる。record でも `status`、`capturedAttackerRequestMarkerMatch`、`verificationSequence`、`victimPrincipal` が 1 と一致し、`requiresHumanPreexistingContentCheck` が `true` であることを確かめる。`dialogEvent` の `type` は `alert`、`message` は record の `marker` と一致すること、`topLevelPageOriginAtEvent` は `http://wordpress`、`topLevelPageUrlAtEvent` と空でない `frameUrlsAtEvent` の全 URL も同じ origin であることを確かめる。record の `victimRole` は宣言した被害者 role と一致させる。`review export` は現行 `verification-finished` の evidence digest からこの record を読む。record の `snapshotDigest` と `labSetupDigest` がそれぞれ export の `snapshotDigest`、現行 `verification.labSetupDigest` と一致しない場合は止める。この対応によって現行 `verification.verificationId` の観測として扱い、過去 attempt の観測を流用しない。`verification.reason` が `digest-mismatch` のときは、signal の表示に関係なく止める。
3. Wordfence の明示除外が同じ Snapshot の `wbh-screen` v4 で確認済みなら作らない。`review.duplicate`、最新版、scope、提出先の資料はあれば読み、無いものや未解決のものを査読チェックに列挙する。元 Finding に最新版の派生 Finding が記録されていれば、元の ID では作らず、派生 ID の export と観測を読み直す。Lab の観測した版より広い affected version は書かない。
4. Private Evidence に `report-<campaign>-<Finding>-preview-r<revision>.md` を新しい版として書く。先頭に `Internal observation preview: a matching request preceded a browser dialog in one verification. Causality, preexisting content, nonce confirmation, and human reproduction remain unverified. Do not submit.` と入れる。同じ検証内で setup 後の攻撃要求と、その後の被害者訪問中に dialog を観測した事実だけを書き、要求が dialog を引き起こしたと断定しない。人間が既存コンテンツ由来の発火でないことを確認するまで、脆弱性の再現成功と書かない。`pageAfterDialogScreenshot` は dialog を閉じた後の画面であり、dialog の画像とは説明しない。本文は Harness 捕捉 HTTP、固定 source、ブラウザ記録で裏付けられる事実だけにし、人間が歩いていない PoC、影響、通常構成を断定しない。未確認点と証拠の path・digest を非公開の査読チェックに残す。
5. Wordfence Fill-Only v3 の 16 項目をすべて根拠付きの値で満たせる場合だけ、同じ版の `report-<campaign>-<Finding>-preview-r<revision>.wordfence-fill.json` を作る。Harness 捕捉の raw HTTP、固定 source と参照箇所、確認版と affected version、攻撃者の認証条件、PoC、impact、フォーム選択肢の値を個別に照合する。setup だけの記録、Verifier の自己申告、一般論、未確認の最新版・影響範囲から値を補わない。`human_verification` は `{ "status": "pending" }` とし、Markdown に JSON の path と sha256 を結び付ける。必須値が欠ける場合は JSON を作らず、不足を査読チェックに残す。AI tool(s) は規定の初期テンプレートを使い、人間専用欄は入力しない。
6. この版は **`review draft` に登録せず、`submission-package/v1` manifest と Submission Candidate を作らない**。`review authorize`、`review submitted` に進めず、`pending` JSON をフォームへ入力しない。人間の手動再現を記録して正式な提出経路へ進めるには、別の Review API 経路が必要である。このスキルで判定器の結果を `runtime-confirmed` や `reproduced` に変えない。

## しないこと

- 送信しない。フォームを開かない。Submit を自動化しない。提出は所有者が自分の拡張機能で行う（ADR 0038）。`pending` の暫定 JSON は拡張機能の確認表示までにとどめ、フォームへ入力しない。上の表で「人間」と書いた項目、Other Details の最終文、CAPTCHA、最終確認は人間が行う。AI の関与は正確に開示する。
- `submitted` に進めない。`review decide --reproduced`、最終版の `review draft --prepared-by human`、`review decide --decision accept`、`review authorize`、`review submitted` は人間が実行する。
- ペイロード、資格情報、HTTP 本文、報告書の本文、過去の提出の中身を会話に貼らない。最終応答はパス、digest、状態だけにする。
- 束ねるのは、Patchstack 向けの同じ種別の Finding だけである。種別の違う Finding や、提出先の違う Finding を 1 本にしない。
````
