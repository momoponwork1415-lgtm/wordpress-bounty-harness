# Wordfence PRISM / Argus の記事と事例から読む探索手法と、本リポジトリの設計をそこへ寄せる差分（2026-10-25）

「調べて報告」の記録。正本ではなく、SPEC・ADR・prompt・skill・コードを変えない。所有者の指示（2026-10-25）は 3 つ。「PRISM と Argus の記事はすべて読む」「PRISM の発見事例は代表的なものを確認し、未認証〜subscriber から届く SQLi・Stored XSS・ATO に限らず、報酬が高そうな危険なものを見る」「Argus の事例も見る」「記事から探索手法が読み取れるなら、設計をそちらへ寄せる」。

本文では、Wordfence 本人の記述を【本人】、公開記録の読み取りを【記録】、この文書の推測を【推測】で分ける。ペイロード、PoC、再現手順は書かない。事例は仕組みの水準（入口 → 欠けている検査 → 到達先 → 効果）にとどめる。先行する調査は [Argus と PRISM の公開情報](2026-10-25-wordfence-argus-and-prism.md)（PR #524 の branch）で、本文書はそれに記事の全文読みと事例 62 件の読み取りを足し、設計への差分を書く。

## 先に答え

- **記事から読める PRISM の手法は 6 点に収まる。** (1) 脆弱性種別ごとの専門 agent、(2) 危険な操作から逆向き、または信頼できない入力から順向きにたどる、(3) 1〜2 hop で止める、(4) WordPress の ground truth に導かれる、(5) 経験的な PoC 実行で検証する、(6) 人間が 10 分〜同日で PoC を確認して公開する。設計、prompt、model、sandbox、走査周期、費用、外れ率は公開されていない。
- **事例から読める形は記事と一致する。** 詳細ページ 75 件のうち PRISM の 53 件は 1 hop 32、2 hop 17、3 hop 3、不明 1。Argus の 9 件は 1 hop 1、2 hop 4、連鎖 4。PRISM の 2 hop の大半は「公開ページや管理画面に印字された nonce を拾ってから handler を叩く」である。
- **PRISM の量の大半は本リポジトリの攻撃者位置の外にある。** mirror の 355 件のうち、未認証・subscriber・customer から届くのは 93 件（26%）、そのうち CVSS 7.2 以上は 31 件、8.8 以上は 8 件。残りは contributor+（119 件）と administrator+（44 件）が中心で、Medium が 80% を占める。幅優先の形を採っても、報酬に届く候補の数は PRISM の公開件数ではなく、この 93 件の形で見積もる。
- **寄せる差分は 7 つ**（§5）。Strategy の fragment に「繰り返し出る仕組みの形」6 行を足す。入口の順に「毎 request で走る早期 hook の handler」を足す。探索 Lab（PoC 実行）の優先度を上げる。報告の形を人間が 10 分で確認できる水準に揃える。非既定の設定や別 plugin など現実的な前提を要する Finding は検証列に残す（所有者決定 2026-10-25。入口の park は ADR 0038 追記 8 で 10-24 に外れており、残るのは旧規則で park された本番 3 件の復帰）。選定の再走査を「新版と修正直後」に寄せる。修正直後の同一対象の掘り直し（Argus の 8 件中 2 件が修正の迂回）を sweep に含める。
- **Argus は寄せない。** 9 件すべてに人間の共同クレジットがあり、後期の記事は「チームが指揮し Argus が補助」と書く。連鎖は comment → block render、second-order の移行処理、native library まで下る追跡で、所有者決定（#528）どおり PARKING に置く。

## 1. 読んだもの

| 種類 | 件数 | 方法 |
| --- | --- | --- |
| Wordfence のブログ記事（PRISM / Argus を主題か言及） | 14 本、全文 | r.jina.ai 経由。2026-04〜10 の index 7 か月分とサイト内検索で網羅を確認。月次 / 四半期のバグバウンティ報告（2026-03〜06、Q1 / Q2 2026、Q3 2025）には PRISM / Argus / Eclipse の記述なし |
| 研究者プロフィール（PRISM、Argus、Hall of Fame） | 3 ページ | 同上。2026-10-25 取得 |
| 第三者の記事（The Repository ほか） | 1 本 | 先行調査の 9 本に追加 |
| Wordfence Intelligence の詳細ページ | 75 件（PRISM 53、Argus 9） | 未認証・subscriber から届く SQLi・Stored XSS・権限昇格・認証回避・file / RCE / object injection の全件 49 件（§3.2）と、High 以上の残り 13 件（§3.5） |
| ローカル mirror（`/home/dev/wp-bounty-workspace/intelligence/history.sqlite`） | PRISM 355 件、Argus 9 件 | 読み取り専用で集計 |

詳細ページは 75 件すべてが「説明の段落 + 参照（trac の file と changeset）」だけで、コードも PoC も無い。約 3 分の 1 は関数名・hook 名・option 名を本文で名指しする。1 件（User Profile Builder）は説明の段落自体が無い。

## 2. 記事から読める手法（本人の言葉）

### 2.1 PRISM

| 観点 | 【本人】 | 出典 |
| --- | --- | --- |
| 何か | 「autonomous vulnerability research platform」「autonomous AI threat intelligence agent」「最も多産な研究者」。2026-04 下旬に立ち上げ（07-23 の記事で「3 か月前」）。プロフィールの最初の公開は 2026-04-16 | 07-23、05-13、07-28、プロフィール |
| 構成 | 「専門の agent が 1 体ずつ、脆弱性のスペクトルの別々の波長を分析する。XSS から deserialization まで」 | プロフィール |
| 設計の由来 | 「脆弱性の種類ごとを含め、さまざまな分野の『専門家』に頼るセキュリティ専用の cognitive architecture は、社内で目覚ましい結果を出した」。semantic routing、agentic trajectory での LoRA fine-tune、小さい model への蒸留を実験中（PRISM の名指しではない） | 04-10 |
| たどり方 | 「危険な操作から逆向きにたどって信頼できないものが届くかを見る。または信頼できない入力から順向きにたどって何に触れられるかを見る。違うのは、その追跡をどこまで深く押すか」 | 08-25 |
| 深さ | 「1 件の発見は 1 つから数個の欠陥、あるいは 1〜2 段の短い跳躍。それが正しいトレードオフだ。重大な WordPress の脆弱性の大半はそういう形で、そのすべてを捕まえたい」 | 08-25 |
| 幅 | 「あらゆるバグ種別と脅威モデルにわたる広大な面を、ひとりで一日中掃く。それがエコシステム全体を覆う方法で、バックドアが入って 2 時間後に気づく方法」 | 08-25 |
| ground truth | 「WordPress の ground truth に導かれる」。定義は無い | プロフィール |
| 検証 | 「経験的な PoC の実行で検証される」。実行環境の記述は無い | プロフィール |
| 人間の確認 | ARVE: 10:33 に PRISM が報告を提出、10:43 に人間が検証して PoC を確認。Burst: 05-08 に発見、同日に検証・PoC 確認・開示開始・firewall 規則 | 07-28、05-13 |
| triage | Eclipse が人間の投稿と PRISM の出力を triage する。研究者は Eclipse に pull request を出して改善する | 07-23 |
| model | 名指し無し。「OpenAI、Anthropic、Google の組み合わせ」「Mythos とサイバー能力のある OpenAI と Anthropic の model」「控えめな parameter 数の model でも harness の工夫で目覚ましい結果」 | 04-10、10-08、07-23 |
| 走査周期・対象の選び方 | 明文無し。「一日中」「入って 2 時間後」「コードが入って 15 日後」から、新版やコミットに対して走っていると読める | 08-25、07-28、05-13 |
| 数字 | 07-23: 30 日で 88 件、累計 202、30 日順位 1 位。08-25: 300 件超。10-25 のプロフィール: 累計 355、90 日 246、最終公開 10-23、全期間順位 21。直近 30 日の Hall of Fame は 74 件で 2 位（1 位は人間の研究者 157 件） | 各記事、プロフィール |
| 費用、外れ率、棄却数 | 公表無し | — |

### 2.2 Argus（記事で足りる、所有者指示）

| 観点 | 【本人】 | 出典 |
| --- | --- | --- |
| 何か | 「aggressive vulnerability hunting のための社内 application」「AI か harness か agent かを議論したが、どれも当たらない」。DEF CON 2026 で公開 | 08-27 |
| 原則 | 「confine, constrain, focus, motivate, parallelize, hypothesize, verify, record, prioritize, and then iterate hard and fast」「革新は prompt engineering、harness 設計、task ごとの model 選択、従来の決定論的なプログラムから」 | 08-27 |
| 深さ | 「幅を捨てて 1 つの対象にとどまり、長い多段の経路を視野に保つ。悪用が数段先にしか存在せず、各段が前の段に依存する種類」 | 08-25 |
| 追跡の範囲 | 「保存した request の先、後で管理者が行う移行処理まで」「endpoint ごとのテストでは見落とす関係を、application の workflow 全体でたどる」「アップロードされたファイルを PHP の先、Imagick、ImageMagick、Ghostscript、JPEG 2000 decoder まで下る」 | 10-20、09-18、10-12 |
| 検証 | Avada: 「無人で約 2 時間」で連鎖と PoC。「隔離した対象に対して検証」。Duplicator: 「使い捨ての対象で site takeover と PHP 実行まで」。ライブラリ 2 件: sanitizer build、対照 file、9 構成、10,240 回の移植性試験 | 08-25、10-20、09-18、10-12 |
| 自律の度合い | Avada だけ「誰も介在せず」。後期（Duplicator、libheif、Ghostscript）は「チームが研究を指揮し、Argus が補助」「Alex Thomas が主導し検証した WordPress 7.1 security assessment」 | 10-20、09-18、10-12 |
| model | 「model agnostic。新しい model が出たらすぐ切り替えて capability と価格を比べる」。設計・model・prompt・harness は公開しない（2 回明言）。プロフィールの指令は [REDACTED] | 08-27、08-25 |
| 数字 | プロフィール 9 件、90 日 4 件、全期間順位 525。Avada の約 2 時間以外に時間・費用の数字は無い | プロフィール |

### 2.3 記事から読めないもの

PRISM の prompt、専門 agent の一覧（「XSS から deserialization まで」のみ）、1 対象あたりの時間、同時に走る数、PoC の実行環境、走査の周期と対象の閾値、費用、外れ率、人間が棄却した数、Eclipse の判断基準。Argus も同じ。先行調査の第 6 節と同じ結論で、今回の全文読みでも埋まらなかった。

## 3. 事例から読める形

### 3.1 mirror の 355 件（PRISM）

| 観点 | 数【記録】 |
| --- | --- |
| 攻撃者位置（タイトル） | contributor+ 119、subscriber+ 51、administrator+ 44、未認証 42、プラグイン独自ロール 16、author+ 16、editor+ 11、ほか |
| 本リポジトリの攻撃者位置（未認証・subscriber・customer） | **93 件（26%）**。うち CVSS 7.2 以上 31 件、8.8 以上 8 件。対象は 71 slug |
| 深刻度 | Medium 284（80%）、High 62、Critical 7 |
| 月別（攻撃者位置の内側） | 6 月 7、7 月 25、8 月 15、9 月 19、10 月 27（23 日まで） |
| 対象 | 218 slug。76 slug に 2 件以上（最多 7 件）。同じ slug の同じ日の公開は 44 組 96 件（1 対象の 1 回の走査で複数の経路が出る形） |
| 公開日 | 50 日に集中、1 日最大 26 件、中央値 4 件（まとめて公開している） |
| 入口の語（タイトル） | parameter 160、shortcode 59、AJAX 34、block 25、order / checkout 14、settings 12、import / export 9、REST 8、form 8、search 7、cookie 6、upload 5、login 4 |
| 説明の語 | 「insufficient escaping / unprepared」216、capability 68、nonce 63、設定やプラグインの前提 32、unfiltered_html 3 |

### 3.2 詳細ページ 49 件の形（追加 13 件は §3.5）

| | PRISM（40） | Argus（9） |
| --- | --- | --- |
| hop | 1 hop 25、2 hop 13、3 hop 1、不明 1 | 1 hop 1（Ocean Pro Demos）、2 hop 4、連鎖（3 以上）4 |
| 入口 | AJAX action 11（うち nopriv 7）、form 送信 8、毎 request で走る早期 hook（`init`、login、検証、2FA、SSO）6、REST 4、shortcode 経由 4、profile / user meta 2、upload 1、cookie 1、webhook 1、core の filter 1、公開ページの query param 1 | comment 2、form 2、upload 1、SSO 1、subscriber の AJAX 1、未認証の AJAX 1、公開コンテンツを後で管理者の道具が読む 1 |
| 検査 | 無し 22、あるが迂回 15（公開ページに印字された nonce 6、対象をまたいで有効な nonce 1、自前の nonce 形式を core が検証できない 1、capability filter の短絡 1、sanitizer の後で decode 2、realpath の false で基底が空 1、admin-ajax 上で常に真の管理者検査 1、sanitizer が serialized 構文を残す 1、弱い識別子照合 1）、該当なし 3、不明 1 | 迂回 6（hash の役割混同、整合性 hash の偽造、型検査が配列を通す、HMAC の区切り、修正直後の gate の引数違い、ほか）、無し 3 |
| 到達先 | HTML 出力 13（訪問者が見る 7、管理者が見る 5、不明 1）、SQL 7、login / session 4、role / capability 4、unserialize 2、include 2、file delete 2、file write 1、file read 1、callable 1、email → password reset 1、DB の紐付け 1、option 1 | unserialize 3、file write 2、callable 2、session 1、HTML 1 |
| 前提 | 前提あり 24 / 40。設定が非既定 9、別プラグイン 5（WooCommerce 3、BuddyBoss 1、Pro 版 1）、特定の公開ページ・shortcode・form 6、管理者が画面を見る 5、open registration か事前の委任 4、環境 3（重複あり） | 9 / 9。コンテンツ 5、設定 3、環境 2、second-order 1、別 plugin の gadget 2（重複あり） |
| 共同クレジット | 人間との共同 2 / 40 | 9 / 9（人間が先に書かれる） |
| 修正の迂回 | 0 | 2（Fusion Builder 3.16.1 の gate、WPMU DEV の前 CVE） |

### 3.3 繰り返し出る仕組みの形（カタログ水準、ADR 0012 (a) の範囲）

PRISM の 53 件から、対象固有名を外して 6 つに束ねた。これが §5 で Strategy の fragment に足す行の元である。

- (a) nopriv の AJAX か REST の handler で、唯一の gate が nonce だが、その nonce をプラグイン自身が未ログインの訪問者に印字している（Tourfic、WPBot、Kali Forms、AI Copilot、GeoDirectory、Advanced IP Blocker の error 経路）。
- (b) `init` などの早期 hook で毎 request 走り、request parameter を読んで option を書くか、ユーザーをログインさせる handler（ARVE、SMS Alert、Advanced IP Blocker、WPO365、Customer Email Verification、Autopay、WP Compress）。
- (c) プラグイン独自の「login as」「検証」「2FA」「SSO」「support access」が、ユーザー提供の識別子を前段に結び付けずに信頼する（Groundhogg、WPO365、Advanced IP Blocker、WPMU DEV）。
- (d) sanitizer の後に decode する順序で、encode された値が sanitizer を抜けて render 時に戻る（Mang Board、Premium Packages）。
- (e) permission callback が true を返す REST route（FundEngine、Booking Package）。
- (f) allow-list が最上位の key だけを見て、入れ子の key が query に届く（rtMedia）。

ほかに、unserialize は 5 件中 4 件が「保存して後で発火」（二段）、file 系は 1 hop が多く、RCE に届くかは `.htaccess` を無視する web server か POP chain の有無に依る。

### 3.4 報酬が高そうな事例（High 以上、本リポジトリの攻撃者位置）

未認証・subscriber から届き CVSS 7.2 以上の PRISM 31 件のうち、§3.2 の 54 件に含まれないのは 6 件（Solace Extra の content deletion / demo import 9.1、Mapster の user meta write 8.8、Simple File List の file modification 7.5、FluentCart と WP Booking System の情報開示 7.5、Video Gallery の任意関数呼び出し 7.5）。プラグイン独自ロールから届く 8.1 以上が 7 件ある（Appointment Booking、Groundhogg 4.9、Elementor の REST nonce 迂回 CSRF、LifterLMS の object injection、RegistrationMagic の CSRF、FluentCart の file deletion、WP Photo Album Plus の command injection）。これら 13 件の読み取りは §3.5 にある。

Argus の 9 件は Ocean Pro Demos（7.2）を除く 8 件が 8.8 以上で、未認証 8 件。連鎖の長さは、コンテンツや設定の前提、second-order（管理者が後で行う操作）、gadget や別 plugin への依存の 3 つで決まる。入口は comment、form、upload、SSO、公開コンテンツなど標準的な面が 7 / 8（Ocean を除く）で、「プラグインの管理機能の弱い gate」型は Tutor LMS と Ocean の 2 件だけ。

### 3.5 追加 13 件の読み取り【記録】

未認証・subscriber から届く High の 6 件と、プラグイン独自ロールや CSRF で 8.1 以上の 7 件。表は仕組みの水準だけ。

| 対象 | 種別 / CVSS | 攻撃者位置（実際） | 入口 → 検査 → 到達先 | hop | 前提 |
| --- | --- | --- | --- | --- | --- |
| Solace Extra ≤1.6.0 | content deletion / demo import 9.1 | 実際は subscriber+（nopriv 登録だが nonce が要り、nonce は全管理画面に印字） | AJAX → capability 無し、nonce は漏れる → メニュー・widget・theme mod・テンプレートの消去と demo import | 2 | ログインだけ |
| Mapster WP Maps ≤1.23.0 | user meta write 8.8 | subscriber+ | profile 更新 → nonce も capability も key の allow-list も無し → 任意 key の `update_user_meta`（自分の account） | 1 | 無し。ページ自身が「権限昇格はできない」と書く |
| Simple File List ≤6.3.7 | file modification 7.5 | 未認証 | AJAX → `is_admin()` の分岐が設定の検査より先に短絡 → サーバー上の file の改変・削除 | 1 | 無し（front-manage 設定 off でも成立） |
| FluentCart ≤1.7.0 | IDOR 情報開示 7.5 | 未認証 | nopriv AJAX → 所有者検査無し、再利用防止が攻撃者提供の 2 値を比較 → 他の顧客の請求・配送情報 | 1 | 無し（5 req / 60 s の緩い rate limit） |
| WP Booking System ≤2.1.0.3 | 情報開示 7.5 | タイトルは未認証、説明は subscriber+（`admin_init`） | `admin_init` の action param → capability 無し → 通知メール本文（氏名・email・電話・日付）を id で列挙 | 1 | ログインだけ |
| Video Gallery ≤4.0.3 | 任意関数呼び出し 7.5 | subscriber+ | AJAX（file 削除）→ nonce は file 欄付き form の shortcode ページに印字、capability 無し → sanitize 後の `path` を引数なし関数として呼ぶ | 2 | file 欄付き form の shortcode が表示されている |
| LatePoint ≤5.7.3 | 権限昇格 8.8 | 独自ロール（`settings__edit` を持つ Agent 等。管理者が付与） | 設定更新 form → capability はあるが広すぎ、role 値を検証しない → 新規顧客の既定 WP role を administrator に | 2 | 管理者が cap を付与、その後に顧客が登録 |
| Groundhogg ≤4.9 | 権限昇格 8.8 | 独自ロール Sales Rep（管理者が付与） | contact 編集 → `user` param に所有者・`promote_users` の検査無し → contact を管理者 WP user に紐付け → note の auto-login link → 管理者 session | 3 | Sales Rep 相当の account |
| Elementor 4.3.0〜4.3.1 | CSRF → 権限昇格 8.8 | 未認証 + 管理者のクリック | REST → `is_own_route_request` の nonce 検査を迂回 → 管理者 session で任意の REST 操作 | 2 | 管理者を誘導。2 版の窓 |
| LifterLMS ≤10.2.1 | object injection 8.8 | 独自ロール（`edit_course`。Instructor 等、管理者が付与） | lesson 作成 form → 信頼できない meta の deserialize | 1 | plugin 内に POP chain 無し。別 plugin が要る |
| RegistrationMagic ≤6.0.9.1 | CSRF → 権限昇格 8.8 | 未認証 + 管理者のクリック | 自動化 task の form → nonce 無し → WP-Cron が任意の提出者を管理者に昇格 | 3 | 管理者を誘導、提出が 1 件ある |
| FluentCart ≤1.6.2 | 任意 file 削除 8.1 | 独自ロール（ページは role 名を書かない） | REST / API の `deleteFile` → path 検証無し → 任意 file の削除（config → RCE） | 1 | role のみ |
| WP Photo Album Plus ≤9.3.02.002 | command injection 8.8 | 独自 cap `wppa_upload`（管理者が subscriber にも付与できるが既定では無い） | AJAX（crop）→ cap はあり sanitizer もあるが、decode が percent-encoded の shell メタ文字を戻す → ImageMagick のコマンド列 | 1 | ImageMagick、cap の付与 |

**本リポジトリの攻撃者位置から届くもの: 8 / 13。** 未認証で account 不要が 2（Simple File List、FluentCart ≤1.7.0）、自己登録の subscriber が 4（Solace Extra、Mapster、WP Booking System、Video Gallery）、CSRF で管理者の誘導が要るものが 2（Elementor、RegistrationMagic。Programme Boundary では `csrf-to-write` で parked）。残り 5 件（LatePoint、Groundhogg 4.9、LifterLMS、FluentCart ≤1.6.2、WP Photo Album Plus）は管理者が付与する独自 role や cap が要り、AGENTS.md の trust 境界の内側に当たる。Wordfence はそれらにも 8.1〜8.8 を付けて公開しており、市場と本リポジトリの境界の差は既知のとおり。

**13 件から足す形。** 「nonce が攻撃者の読める場所に印字されている」が 2 hop の主形として再び出る（Solace Extra は管理画面、Video Gallery は shortcode ページ）。Mapster と LifterLMS は「権限昇格はできない」「POP chain は無い」とページ自身が書きながら 8.8 なので、CVSS だけでは悪用可能性を測れない。独自 role の 7 件中 3 件は plugin 独自の capability 体系（`settings__edit`、`edit_contacts`、`wppa_upload`）に依っており、mirror を triage するときの「管理者付与 → trust 境界の内側」の安い目印になる。

## 4. 本リポジトリとの対照

| 観点 | PRISM【本人・記録】 | 本リポジトリの今（v11-wide、設計文書） | 判定 |
| --- | --- | --- | --- |
| 種別ごとの専門 agent | 「XSS から deserialization まで」。種別の一覧は非公開 | v11-wide は到達先 4 種（HTML、SQL、file / include / unserialize、identity / auth）で子を固定 | 一致。種別の切り方は記録の到達先分布（§3.2）と合う。authz / option（role、capability、option の書き換え）は PRISM の記録に多いが本リポジトリでは parked 種別 |
| たどる向き | 逆向きと順向きの両方 | v11-wide は「入口から到達先へ順向き」だけ | ずれ。逆向き（到達先から入口へ）を Strategy に足す（§5 差分 1） |
| 深さ | 1〜2 hop | 「1〜2 hop、多段の連鎖は組まない」 | 一致 |
| 入口の順 | 記録から AJAX、form、早期 hook、REST、shortcode | v11-wide は mirror 全体の頻度順。「毎 request で走る早期 hook」が無い | ずれ。入口に 1 項足す（§5 差分 2） |
| ground truth | 「WordPress の ground truth に導かれる」 | v11-wide の PRISM-c「guard が実際に何をするかを固定した core の source で確かめる」 | 一致（解釈）。記録の「迂回」19 件のうち nonce 絡みが 8 件で、core の nonce と capability の意味論を source で確かめる指示は当たっている |
| PoC 実行 | 「経験的な PoC の実行で検証される」。環境は非公開 | 探索 Lab は入口を閉じてある。設計文書 Phase D | ずれ。PRISM の 6 点のうち唯一欠けている要素（§5 差分 4） |
| 人間の確認 | 報告から 10 分〜同日で PoC を確認 | handoff → wbh-verify → 人間が Lab のアラートを見る（判定器は削除） | 同型。ただし報告の形（route、前提、誰が見る画面か）が人間の 10 分に足りるかは未計測（§5 差分 5） |
| 前提の扱い | 非既定の設定・Pro 版・別 plugin・特定ページの前提付きで 7.2〜9.8 を公開 | 入口の park は ADR 0038 追記 8（2026-10-24、PR #489）で廃止済み。旧規則で park された本番 Finding 3 件は未復帰で、復帰の呼び出し口が無い | 方向は一致。所有者が 2026-10-25 に「現実的な範囲の前提なら戻す」と決めた（§5 差分 6） |
| 走査の周期 | 「一日中」。コミットから 2 時間、15 日 | 選定の `version-increased` 再訪は 90 日周期（ADR 0037） | ずれ。#528 項目 3 のとおり再訪周期を縮める（§5 差分 7） |
| 同一対象の掘り直し | 1 対象で複数経路（同日 44 組 96 件）。Argus は修正の迂回 2 件 | wide は「各専門 agent が入口を一通り終えたら止める」。修正直後の掘り直しは無い | 半分一致。修正直後の同一 slug を sweep の対象に足す（§5 差分 7） |
| 量と報酬 | 355 件中 93 件が本リポジトリの攻撃者位置。High 以上 31 件 | Programme Boundary で出口を絞る | 一致。幅を採っても、報酬に届くのは 4 分の 1 と見積もる |

## 5. 寄せる差分（提案。採否は所有者、本文は owner-approved）

設計文書（[探索アーキテクチャの再設計](2026-10-25-exploration-architecture-redesign.md)）の Phase に乗せる。agent に渡る文章の変更は版を上げ、出典対照表に行を足す。対象固有の関数名・option 名・URL は入れない（§3.3 の 6 行は対象名を外してある）。

| # | 差分 | 置き場 | Phase | 根拠 |
| --- | --- | --- | --- | --- |
| 1 | Strategy に「到達先から逆向きにたどり、信頼できない入力が届くかを見る」を 1 文足す（順向きと両方） | `strategy/sinks-v12.md`（fragment） | C2（v12-wide） | 【本人】08-25 |
| 2 | 入口の順に「毎 request で走る早期 hook（init、login、検証、2FA、SSO、webhook の callback）の handler」を足す | 同上 | C2 | 【記録】§3.2 で 7 / 54、§3.3 (b)(c) |
| 3 | Strategy に §3.3 の 6 つの形を「よく見る形」として足す（対象名なし、6 行） | 同上。出典対照表に PRISM-e〜j として追加 | C2 | 【記録】§3.3。ADR 0012 (a) の一般パターン |
| 4 | 探索 Lab（Phase D）を C2 と同じ優先度に上げる。PRISM の「経験的な PoC 実行」に当たる唯一欠けている要素 | 設計文書 §6、§11 | D1 | 【本人】プロフィール。所有者決定 Q1「PRISM に寄せるなら必須」 |
| 5 | Finding の報告の形を「人間が 10 分で確認できる」水準に揃える。route（入口の URL / action と到達先）、前提（設定・ページ・ロール）、誰がどの画面で見るか、を `review export` の 1 画面に出す | `review export` と wbh-review skill | 検証側（#441） | 【本人】ARVE 10 分、Burst 同日 |
| 6 | 現実的な前提（非既定の設定、別 plugin、特定ページ、コンテンツ、second-order）付きの Finding を検証列に残す。PRISM の 40 件中 24 件、Argus の 9 件全部が前提付きで公開され 7.2〜9.8 が付いている。入口の park は ADR 0038 追記 8 で廃止済み。残る作業は、旧規則で park された本番 3 件（opus-prod-20261019-3、opus-prod-20261021-1、prod-20261021-3 に各 1 件、2026-10-25 時点で復帰 0 件）を `finding-park-restored` で戻すことと、v12 の Strategy で前提付きの経路を落とさない文にすること | `restoreParkedWordPressFinding`（PR #489。呼び出し口が無い）、v12 fragments | 所有者決定済み（2026-10-25「戻していい。前提は現実的な範囲なら問題ない」）。復帰は Issue #529 | 【記録】§3.2、§3.5 |
| 7 | 選定の再走査を「新版が出た対象」と「修正直後の同一 slug（修正の迂回）」に寄せ、再訪周期 90 日を縮める。sweep（#520）の種に「修正直後の対象」を足す | `policy/selection.json`、ADR 0037 追記、#520 | 選定（#528 項目 3） | 【本人】2 時間、15 日。【記録】Argus 2 / 8 が修正の迂回 |

寄せない点: Argus 型の連鎖（#528）、専門 model の fine-tune と semantic routing（記事は実験段階で、本リポジトリは model を増やさない）、Eclipse 型の AI triage（所有者決定「judge は要らない」と LESSONS「judge を増やさない」）。

## 6. 判定器の削除との整合

PRISM の確定は「PoC を実行して報告 → 人間が 10 分で確認」で、Harness が決定論的に判定する段は無い。本リポジトリの新しい形（探索 Lab の観測 + handoff + 人間が Lab のアラートと捕捉を見る、判定器は削除）はこれと同型である。差は、Wordfence は人間が PoC を再実行するのに対し、本リポジトリは Harness が捕捉した HTTP と dialog を人間が読む点で、観測の取り方の違いにとどまる。

## 7. 次の手

1. 設計文書の Phase C2 に差分 1〜3 を入れる（v12-wide の fragments、出典対照表 PRISM-e〜j）。
2. 差分 6 は所有者が 2026-10-25 に決めた（戻す）。ADR の行は ADR 0038 追記 8 が既に改訂している。残る本番 3 件の復帰は Issue #529 に起こした。
3. 差分 7 を #528 項目 3 と #520 の comment に足す。
4. §3.3 の 6 つの形は §3.5 の 13 件でも増えなかった（nonce の印字が再出、独自 cap の形は trust 境界の内側）。差分 3 の 6 行のまま進める。

## 参照

- 先行調査: [Argus と PRISM の公開情報](2026-10-25-wordfence-argus-and-prism.md)、[mirror を探索入力に](2026-10-25-wordfence-mirror-as-exploration-input.md)、[探索アーキテクチャの再設計](2026-10-25-exploration-architecture-redesign.md)、[出典対照表 §2.1](2026-10-13-prompt-source-comparison.md)
- Wordfence の記事（全文読み、r.jina.ai 経由、2026-10-25）: Argus 8 本（08-25 Avada、08-27 Moving Beyond、08-27 WPMU DEV、09-01 Gravity Forms、09-14 Events Calendar、09-17 Tutor LMS、09-18 libheif、10-12 Ghostscript、10-20 Duplicator）、Maunder 3 本（04-10、07-23、10-08）、PRISM 2 本（05-13 Burst Statistics、07-28 ARVE）、プロフィール 3 ページ
- 事例の詳細ページ: Wordfence Intelligence `vulnerabilities/id/<uuid>` 75 件（uuid は mirror の `vulnerabilities.id`。独自 role の 7 件は slug ページ）。本文書には仕組みの水準だけを書いた
- Issue: #518、#520、#521、#522、#525、#528
