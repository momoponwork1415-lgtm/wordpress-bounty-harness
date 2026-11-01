# 所有者の過去の発見の型と、探索アーキテクチャの適合（2026-10-31）

正本ではない。所有者の問い「過去に私が見つけたものはどういうタイプか、掃き出し型で拾えるか」への報告。出典は Wordfence 履歴 mirror（`/home/dev/wp-bounty-workspace/intelligence/history.sqlite`、researchers に "Yuto Hyakumoto" か "momopon1415" を持つ 32 件）と、所有者が 2026-10-13 に貼った提出一覧（21 件、金額は Git 外）。

## 1. 型ごとの件数と、機械で拾えるか

| 型 | 件数 | 報酬（21 件の表から） | 例 | 掃き出し層で拾えるか |
| --- | ---: | ---: | --- | --- |
| 反射型 XSS（request param → echo） | 8 | 667 USD | WBW `wpf_fid`、Newsletter `nn`、Ad Inserter Referer | 拾える。ただし 2026-09 以降は Wordfence の対象外 |
| SQLi（`order` / `sorting` / `fields` の連結） | 5 | 1,301 USD | SSA `fields`、Unlimited Elements、WPML `sorting`、WBW 3.4.6 | 拾える。taint 規則の典型形 |
| 格納型 XSS、未認証（公開面の入力 → 保存 → 描画） | 4 | 約 750 USD | Relevanssi コメント、Brizy FileUpload、Smash Balloon FB コメント、RTMKit | 半分。sink の列挙は機械、DB をまたぐ流れは AI の確認 |
| 格納型 XSS、Subscriber+（プロフィール・meta → 別画面） | 4 | 約 340 USD | SEOPress `display_name`、GeoDirectory `business_hours`、TP 承認コメント → 翻訳画面 | 半分。同上 |
| ロジック・認可（ATO、価格操作、missing authz、IDOR、LFI） | 11 | 975 + 50 USD（他は対象外か却下） | TP パスワードリセット URL 漏洩、EDD PayPal guest checkout → 管理者 ATO、Booking Package `amount` | 拾えない。入口の列挙までは機械、意味の判断は深掘り |

- 32 件中 10 件は同じプラグインの 2 回目以降の発見（TranslatePress 3、RTMKit 3、Unlimited Elements 2、WBW 2）。修正版が出た後に同じ対象へ戻る動きで稼いでいた。
- 21 件の表に無い 11 件（EDD の ATO、WBW の SQLi、Countdown Timer、Classified Listing、Frisbii、Location Weather、Everest Forms など）は mirror が所有者名で持つ。提出先か時期が表の外。

## 2. アーキテクチャと型の適合

| 形 | 当たる型 | 1 件あたりの費用 | 拡がり方 | 今の位置 |
| --- | --- | --- | --- | --- |
| 対象ごとの深掘り（Argus 型、v8 deep） | ロジック・ATO | 高い（2 時間 × 対象） | 席の数 | 名指しのみ |
| 対象ごとの広い探索（PRISM 型、v14 / v19 wide） | 格納型 XSS、SQLi | 高い | 席の数 | 主経路。本物 0.06 / Trial |
| 全プラグインの掃き出し + 候補の確認 | SQLi、格納型 XSS の半分 | 低い（候補 1 件 20 分） | プラグイン数 | 無い |
| 新版の差分監視 + 再探索 | 全型。所有者の 10 / 32 件がこの動き | 低い（差分だけ） | 新版の数 | 版上昇 90 日の再訪のみ |

## 3. 読み

- 報酬の 58%（SQLi + 格納型 XSS）は掃き出し + 確認で届く型。24%（TP の ATO）は深掘りでしか出ない型。残りは今は払われない。
- WordPress に合うのは単一の形ではなく、掃き出しで量を取り、差分監視で競争の少ない再発見を取り、深掘りは identity・決済・会員の流れを持つ大型プラグインに名指しで当てる、という組み合わせ。
- 判断は所有者。v19 の 20 Trial の後に、掃き出し層の規則 1 本（SQLi の `order`/`sorting` 型）で上位プラグインを掃いた候補数と確認通過数を測ってから決める。

## 4. 追記（2026-10-31 夜）: 戦力を型で分ける案は、上位ハンターの公開手法と一致するか

出典は [2026-10-25 の調査](2026-10-25-wordpress-bug-hunter-methods.md) と [2026-10-24 の具体手法の調査](2026-10-24-wordpress-concrete-hunting-methods.md)、および本日の Web 検索。

| ハンター（公開件数） | 本人が語った手順 | 対応する戦力 |
| --- | --- | --- |
| Kinorth（2024-10 に 275 件） | SVN から全プラグインを取得 → 確かめた 1 件ごとに型の正規表現を書いて全体を検索 → 明らかなものから速く出す | 掃き出し + 変種 |
| stealthcopter（2024 上半期 180 件、23,000 USD） | 独自の自動化で低労力の報告を大量に。母集団は 1,000 インストール以上の約 8,300 本 | 掃き出し |
| Ananda Dhakal（直近 30 日 157 件、1 位） | SVN の revision を監視し、5,000 インストール以上の trunk に追加された PHP 行だけを見る → 今は Claude / Codex に解析を任せ、自分は外から確かめる | 差分監視 + 確認層 |
| Denver Jackson | changelog と修正差分を読み「見落とされた所」を探す。修正済み報告の再現の先で 0-day | 差分監視 |
| Eddie Zhang（14 CVE） | WordPress.org API で更新のあったプラグインを取得 → Semgrep → DB → 人の triage。AI 無し | 掃き出し + 差分監視 |
| Muhan Luo（7 件） | 上位 10,000 本に Semgrep join → 11,000 候補を LLM で採点 → 1,400 に絞る → Docker で確認 | 掃き出し + 確認層 |
| Austin Ginder | 上位 5,000 本の最新版だけ、ハッシュで同一ビルドを 1 回に。並列の子で全 PHP を読み → 使い捨て WordPress で発火 → 提出 | 広い探索 + Lab |
| Night-Wolf | 10 種の静的 scanner → 短命の Claude 子（8 並列、tool call 10 回上限）→ Lab → scanner 規則へ還流 | 掃き出し + 確認層 + 変種 |
| Dutafi（上位 20 名） | Semgrep → 整理と重複排除 → 軽い AI triage → 深い AI → Claude Code で確認 | 掃き出し + 確認層 |
| Sucuri（Herbrandson、16 件） | 更新の止まったニッチなプラグインを深く読む | 深掘り（低量） |

- 公開手法を持つ上位ハンターのほぼ全員が「安い機械の絞り込み → AI の確認 → 実環境の再現」の順で、掃き出しか差分監視を入口にしている。対象ごとに AI へ 2 時間読ませる形を主経路にしている人は、Sucuri の低量の例を除いて見当たらない。PRISM は Wordfence の社内実装で内部は非公開。
- 見つからなかったもの: 提出前に公開履歴とどう重複照合しているかを書いた人はいない。1 本あたりの時間の公開値も無い。
- 本日の検索で足せたもの: Dhakal の 2026 年の論文題は「Baselines Before Architecture: Evaluating Coding Agents for Autonomous Penetration Testing」（本人の about ページ）。公開 repo の WP-Hunter（fsevkli/v-hunter）と web-cve-hunt は Semgrep → 人の読解 + Claude Code の形。新しい手法の型は増えていない。
