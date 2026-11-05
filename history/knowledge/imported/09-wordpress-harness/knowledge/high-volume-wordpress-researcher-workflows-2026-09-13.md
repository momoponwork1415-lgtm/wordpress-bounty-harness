<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/high-volume-wordpress-researcher-workflows-2026-09-13.md, mtime 2026-10-08, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: 多数のWordPress脆弱性を報告する調査者の探索手順

状態: 一次資料に基づく調査、2026-09-13
取得日: 2026-09-13（追補: 2026-09-15）

## 結論

公開情報から確認できるのは、この二人の**公開Finding数が多いこと**であって、監査したTarget数に対する**hit rateが高いことではない**。プロフィールには監査Target数、費やした時間、棄却、duplicate、何も出なかったrunがなく、分母を作れない。特にWordfenceの`All Time Discoveries`はold/new vulnerabilityの追加とalias統合を許すdatabase creditであり、現在のprospective researchの提出数ではない（[Wordfence Hall of Fame](https://www.wordfence.com/threat-intel/vulnerabilities/researchers/)）。

むしろRafieが公開したproduction-like pipelineは、alertの約80%がfalse positiveだと説明する。成立条件は高いalert precisionではなく、59K pluginからchangesetで候補を絞り、false positive一件を30秒未満で捨て、当たりの周辺とshared codeへfan-outできることである（[BSides talk: false-positive rate](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=1488s)、[triage cost](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=1350s)）。「彼らだけ一発で当て続ける」のではなく、**安い高recall frontier + 速い棄却 + 当たりの増幅**が公開情報に最も整合する。

それでも高volumeを生む仕組みはかなり見える。

1. **機械でfrontierを狭める。** Rafie Muhammadが共同発表した手法は、WordPress.org Plugin RepositoryのSVN changesetを継続監視し、multi-threaded static analysisでsensitive functionと危険な変更を検出してresearcherへ通知する。全pluginを同じ深さで人手監査する方式ではない（[Catching WordPress 0-Days on the Fly](https://pretalx.com/bsides-canberra-2025/talk/XLN9H3/)）。
2. **alertを人がsource-to-impactへ伸ばす。** Rafie本人のGiveWP記事では、`file_get_contents` / `file_put_contents`を検索して候補を得た後、call path、attacker-controlled filename、nonce取得、capability、別のimport/export機能とのchainを追い、同一featureからLFIとRCEを作っている（[GiveWP LFI/RCE write-up](https://yeraisci.com/authenticated-lfi-and-rce-on-givewp-donation-wordpress-plugin-less-2202-cve-2022-31475-and-cve-2022-28700)）。sink検索だけで終わる手法ではない。
3. **一つの弱点familyを多数Targetへ横展開し、よいTargetは複数routeまで掘る。** darooの公開portfolioは年ごとにclass構成が大きく変わり、2025年はBroken Access Control、2026年はXSS / SQLi / PHP Object Injectionへ集中している。一方RafieはWPLMS、ListingPro、XStore / XStore Core等から繰り返し複数Findingを出している。前者はcross-target campaign、後者はecosystem内deepeningと整合する。ただし、これは公開時系列からの**推論**であり、本人が手法を説明した事実ではない（[daroo Patchstack profile](https://patchstack.com/database/researchers/9f3ffb0b-5ad7-4756-86d2-cd63a1d09469)、[Rafie Patchstack profile](https://patchstack.com/database/researchers/38daedf8-3237-4768-ae6e-be8e32979a65)）。
4. **現在はLLMもthroughput multiplierになっている。** Rafieの公開LinkedIn activityにはrecent FindingをClaudeと見つけたとの本人記述がある（[Rafie public profile](https://id.linkedin.com/in/rafiemuhammad)）。また、上記SVN監視talkの共同発表者Ananda Dhakalは、現在は複数codebaseへClaude/Codexをbackground投入し、modelがinteresting pathやPoCを出し、人がcheating確認・triage・validationを行うと説明する。ただしこれは同時期の隣接workflowであり、darooまたはRafieの全Findingへ帰属させない（[More Criticals, Less Dopamine](https://dhakal-ananda.com.np/misc/more-criticals-less-dopamine/)）。

従って現行Harnessへの主要な含意は、agentを一Targetへ長時間当てるだけでなく、**oracle-freeな変更signalで調査frontierを作ること、Rootが異種仮説を回すこと、見つけたbroken security semanticsを関連componentへ横展開すること、最後は独立Validationでfalse positiveを落とすこと**である。単純なsink count、accepted profile count、または一つのclass campaignをrecallの代用品にしてはならない。

## 証拠の境界

- **Observed**は本人、公式conference abstract、Patchstack、Wordfenceが公開した内容、または公開profile表の再集計である。
- **Inference**はObservedなclass・Target・時系列分布と公開workflowから導く仮説である。
- profile表の再集計は2026-09-13時点のsnapshotであり、後日の追加・alias統合・publicationにより変わる。
- 公開情報には監査したTarget総数、時間、棄却、duplicate、非発見runがない。二人のprecision、recall、Findings/Target、Findings/hourは算出しない。

## 観測事実: Rafie Muhammad

### 追補: 公開動画と既知脆弱性の履歴（2026-09-15）

今回の利用目的は、**指定したプラグインで、同種の脆弱性が過去に公開報告されたかを確認すること**。これは本セッションの利用者要件であり、Rafie本人の発言や、全件保存を採用した設計判断として扱わない。

| 資料 | 今回確認できたこと |
| --- | --- |
| [Catching WordPress 0-Days on the Fly — BSides Canberra 2025](https://pretalx.com/bsides-canberra-2025/talk/XLN9H3/) / [動画](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=270s) | 公式概要でAnanda DhakalとRafie Muhammadの共同発表を確認。公開コードの変更を監視し、人による調査を補助する内容。概要には既知脆弱性DBの保存範囲への言及がない。 |
| [Uncharted Depths Navigating Overlooked Vulnerabilities in the Sea of Million WordPress Sites — Off-by-One 2024](https://www.youtube.com/watch?v=foOyhOUreno&t=277s) | [本人の公開プロフィール](https://id.linkedin.com/in/rafiemuhammad)で題名と動画リンクを確認。[主催者の公開資料一覧](https://offbyone.sg/archive/2024)には動画集とスライド集へのリンクがある。 |

今回、YouTubeの本文・字幕と該当スライドの内容は取得できなかった。したがって、過去の報告をどう使うかという本人の具体的な説明や「全件をローカルDBに保存すべき」という推奨は確認できていない。本追補は、既存の時刻付き動画要約を再検証したものでもない。

保存範囲とは別に、取得元の制約がある。Wordfence v3のProduction / Scanner Feedはともに全件を返し、絞り込み用の追加パラメーターを受け付けない。CWE（弱点の種類）はProduction Feedだけにあり、値が未設定の場合もある。**全件を取得する制約と、全件を永続保存する必要性は別の判断になる**（[Wordfence公式API仕様](https://www.wordfence.com/help/wordfence-intelligence/v3-accessing-and-consuming-the-vulnerability-data-feed/)）。

### 公開実績

Patchstack profileの公開表を全pageから再集計した。`Reported`が日付の731行だけをpublished observationとして扱い、`No date`の1,325行はpending等の意味を公式説明から確定できないためFinding数から除外した。profile headerの`42 Reports`とも意味を整合できない。従って以下はheader countではなく、同じprofileに表示されたdated database recordsの集計である（[Rafie Patchstack profile](https://patchstack.com/database/researchers/38daedf8-3237-4768-ae6e-be8e32979a65)）。

| 観点 | 2026-09-13 snapshot |
| --- | ---: |
| dated records | 731 |
| unique product names | 396 |
| 2022 / 2023 / 2024 / 2025 / 2026 | 12 / 343 / 308 / 62 / 6 |
| Broken Access Control | 200 (27.4%) |
| XSS | 169 (23.1%) |
| CSRF | 71 (9.7%) |
| SQLi | 57 (7.8%) |
| Privilege Escalation | 48 (6.6%) |
| Arbitrary File Upload / LFI | 39 / 39 (各5.3%) |
| PHP Object Injection | 32 (4.4%) |

2023–2024に651/731件、89.1%が集中する。これは2022年11月から2026年3月までPatchstackでSecurity Researcher / Lead Security Researcherを務めた公開経歴と整合し、片手間の単発bug bountyとの比較にはならない（[Rafie public profile](https://id.linkedin.com/in/rafiemuhammad)）。Wordfenceの2024 State of WordPress Securityも、2023年のindividual contributor上位としてRafieの299件を掲載している（[Wordfence 2024 report](https://www.wordfence.com/wp-content/uploads/2024/02/The-Wordfence-2024-State-of-WordPress-Security-Report.pdf)）。

同じproduct nameへのdated recordsはWPLMS 17、ListingPro 12、XStore 10、XStore Core 8、GiveWP 7だった。名前が別でもtheme/core/add-onを同じecosystemと見なせる例があり、単一FindingでTargetを捨ててはいない。Patchstackの2024 reportにも、人気pluginのEssential Addons for Elementor、Gravity Forms、Fusion BuilderでRafieの高severity Findingが並ぶ（[State of WordPress Security in 2024](https://patchstack.com/whitepaper/state-of-wordpress-security-in-2024/)）。

### 公開された探索の反復手順

GiveWPの本人記事で観測できるloopは次の通りである（[GiveWP LFI/RCE write-up](https://yeraisci.com/authenticated-lfi-and-rce-on-givewp-donation-wordpress-plugin-less-2202-cve-2022-31475-and-cve-2022-28700)）。

1. 100K+ installsの具体的featureを持つTargetを選ぶ。
2. `file_get_contents` / `file_put_contents`というrisky operationから候補を列挙する。
3. callerへ遡り、request parameterからfilenameへのdata flowを確認する。
4. nonceが必要だと判明したら生成・取得routeを探し、capabilityと実際のroleを確認する。
5. 直接のread/write primitiveだけで止まらず、import data、export row、writable pathを組み合わせてRCEまで伸ばす。
6. 実requestで再現し、patchがどのdata flowを切ったか確認する。

これに加えて共同talkは、SVN changesetのcontinuous monitoring、multi-threading、sensitive-function static analysis、researcher alertを明記する。これは**cheap candidate generation + expensive semantic validation**の二層構造である（[BSides Canberra session](https://pretalx.com/bsides-canberra-2025/talk/XLN9H3/)）。

発表内ではこのpipelineをさらに具体化している。1時間ごとにSVN revision差分を取得し、active installs 5,000以上、`trunk`、PHP、added linesへ絞り、WordPress/PHPのsensitive functionを検出してSlackへ送る。これは59K pluginの「どこを読むか」を決めるinitial footholdであり、alert line自体をverdictにはしない（[pipeline](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=270s)、[initial foothold](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=1312s)）。scannerが`unlink` / `file_put_contents`をalertしたのに実際の脆弱性が別箇所にあったcaseも示している（[case study](https://www.youtube.com/watch?v=-K5BZGWrtqM&t=868s)）。

2024年の本人talkでは、million-install pluginは既に多く監査されcode qualityも高いためhitしにくく、10K/50K install帯ではFinding確率が上がるというTarget trade-offを説明する。また、sink-to-sourceとsource-to-sinkの両方を使うが主にsource側から追い、Target本体にFindingがなくてもshared libraryへpivotして多数pluginへ展開したcaseを示した（[target selection](https://www.youtube.com/watch?v=foOyhOUreno&t=277s)、[shared-library pivot](https://www.youtube.com/watch?v=foOyhOUreno&t=555s)、[source-first answer](https://www.youtube.com/watch?v=foOyhOUreno&t=2483s)）。

## 観測事実: daroo

### 公開件数を発見率へ使えない理由

Wordfence profileは`331 All Time Discoveries`、`39 90 Day Published Submissions`を表示する。一方、Achievementは2026-03-20の`Submitted 1`から、05-01に5、05-27に10、07-28に25、09-10に50へ進んでいる（[daroo Wordfence profile](https://www.wordfence.com/threat-intel/vulnerabilities/researchers/daroo-2)）。Wordfenceはこのbadgeを、registered accountで同社bug bounty programへ**直接提出したvalid vulnerability**の累積として定義する（[Researcher Achievements](https://www.wordfence.com/threat-intel/bug-bounty-program/achievements)）。

従って直接確認できる2026年の実績下限は、174日で少なくとも50 valid direct submissions、約2件/週である。331件はこれと同義ではない。Hall of Fameはold/new vulnerabilityの追加と複数aliasの統合を明示しているため、database上のAll Time Discoveriesには別route・過年度のcreditが混ざり得る（[Wordfence Hall of Fame](https://www.wordfence.com/threat-intel/vulnerabilities/researchers/)）。

### 種類と対象の分布

同じidentityへlinkされたPatchstack profileの公開3 pageは、headerの`300 Reports`に対してdated rowを280件表示した。差の20件の状態は公開UIから確定できないため、以下は280件だけの集計である。対象期間は2025–2026、unique product nameは218で、そのうち170製品、78.0%は一件だけだった（[daroo Patchstack profile](https://patchstack.com/database/researchers/9f3ffb0b-5ad7-4756-86d2-cd63a1d09469)）。

| Class | 2025 | 2026 | Total |
| --- | ---: | ---: | ---: |
| Broken Access Control | 69 | 1 | 70 |
| XSS | 6 | 58 | 64 |
| SQLi | 4 | 35 | 39 |
| PHP Object Injection | 2 | 26 | 28 |
| Sensitive Data Exposure | 16 | 1 | 17 |
| Privilege Escalation | 4 | 8 | 12 |
| CSRF | 12 | 0 | 12 |
| RCE | 1 | 7 | 8 |
| その他 | 11 | 19 | 30 |
| **Total** | **125** | **155** | **280** |

上位4 classで201/280件、71.8%を占める。2025年はBroken Access Controlだけで55.2%、2026年はXSS / SQLi / PHP Object Injectionで119/155件、76.8%である。報告日は同日に最大7件、6件の日も複数あり、単発の偶然よりbatch状の提出である。GitHub profileはpublic repository 0で、本人によるtool、interview、write-upは今回の公開調査では確認できなかった（[supahackaa GitHub](https://github.com/supahackaa)）。

Wordfenceの2026年3月実績では、darooはvalid in-scope 13件、$4,993、平均$384.08でvolume上位5人かつearnings 3位だった。同月Rafieは2件、$4,453、平均$2,226.50だった。二人とも成功しているが、darooはbreadth/volume、Rafieは少数high-impactという異なるproduction shapeが同じleaderboardに現れている（[Wordfence March 2026 report](https://www.wordfence.com/blog/2026/05/wordfence-bug-bounty-program-monthly-report-march-2026/)）。

同月のprogramme全体では1,718 submissions中、in-scopeは318件、18.5%に過ぎず、306 OOS、748 rejected、346 duplicateだった。これは個人のprecisionではないが、トップ研究者が活動する市場全体でも多数の棄却を前提にthroughputが成立していることを示す（[submission outcomes](https://www.wordfence.com/blog/2026/05/wordfence-bug-bounty-program-monthly-report-march-2026/#wordpress-software-vulnerability-submission-insights-march-2026)）。

## 推論: 何が報告数を生んでいるか

### 確信度が高いもの

- Rafieのworkflowはmass monitoring/static analysisで候補を安く作り、人がdata flow・authority・precondition・chainを確認する。これは本人の共同talkと本人記事の両方に直接根拠がある。
- Rafieの公開pipeline自体が約80% false positiveを許容し、一件30秒未満でtriageする。高いhit rateではなく、候補生成と棄却のunit cost差がthroughputを作る。
- Rafieの2023–2024 volumeはfull-time specialistとしての組織的researchと重なる。同じ時間budgetの単発diagnosisとの比較ではない。
- darooは少なくとも50件のvalid direct submissionを半年未満で作った。公開portfolioのclass shift、single-product比率、同日batchは、狭いsecurity-semantics familyを多数Targetへ横展開するcampaignと整合する。

### 確信度が中程度のもの

- darooの2025 Broken Access Control campaignは、WordPress固有のAJAX/REST hook、nonce、capability、object ownershipを横断的に確認するchecklistまたはqueryを使った可能性が高い。
- 2026年のXSS / SQLi / object injectionへの急なshiftは、使えるquery、automation、Target source、programme incentiveの変化を示す可能性がある。
- Rafieの反復product群は、同じvendor、framework、theme + core/add-onに共通するcode patternを一つのFinding後に追跡している可能性が高い。

### 根拠不足

- darooがcustom scanner、Semgrep、LLMまたは特定promptを使うとは断定できない。
- Rafieの全731件が2025年talkのSVN monitorで発見されたとは言えない。dated recordsの大半はtalk以前であり、premium theme/pluginはWordPress.org SVN monitoringの対象外である。
- accepted/public record数からhit rate、precision、recall、監査速度は出せない。
- 高volume class campaignがhigh-impact recallを最大化するとは言えない。反復しやすいFindingの件数が増えただけの可能性もある。

## Harnessにとっての意味

1. **Hit rateを定義し直す。** `published Findings / profile`ではなく、固定snapshot上の`validated Findings / researched Targets`、`validated Findings / Research Native Run`、time-to-first actionable Candidate、class/route diversityを分けて測る。non-finding runとrejectionも分母へ残す。
2. **Lead precisionとResearch yieldを分ける。** `alerts -> inspected leads -> Candidates -> admitted Candidates -> validated Findings`を別々に記録し、false-positive率と一件当たり棄却時間を一緒に見る。80% FPでも秒単位triageならfrontier generatorとして有用である。
3. **Change-first frontierを評価する。** WordPress.org SVNの新規changesetをoracle-free signalとして使い、new/changed risky operation、public entry point、authority checkの変化をRootへ渡すablationを行う。static outputはnavigationであってCandidateやcompletion proofにしない。
4. **Primitiveからsecurity semanticsへ進む。** risky functionを見つけた後、caller、input control、nonce、capability、role、object ownership、ordinary configuration、final impactをRootが追う。GiveWP型のmissing link探索をResearch Promptへ保つ。
5. **Pattern propagationをRoot decisionにする。** concrete Finding候補が出たら、同一Targetのsibling feature、bundled framework、vendor sibling、free/pro counterpartへ同じbroken semanticsがないか確認する。ただし固定class routerやHarness-owned checklistにはしない。
6. **Breadthとdepthを両方残す。** daroo型cross-target campaignはthroughputを上げ、Rafie型product/ecosystem deepeningは一つのprimitiveを高impact chainへ伸ばす。Rootがapproach-family convergenceを検知し、異種routeを維持する。
7. **AI throughputとvalidationを分離する。** 複数codebaseへのbackground model投入は候補数を増やすが、Candidate admission、fresh source-only Independent Validation、fresh isolated reproductionを短絡しない。model出力をFinding countにしない。WordfenceではAI利用のself-reportが2025年末の16%から約66%へ増え、全体の報告volumeも453%増えたが、個人darooのAI利用証拠にはならない（[Wordfence AI report](https://www.wordfence.com/blog/2026/04/the-increasing-role-of-ai-in-vulnerability-research/)）。
8. **比較可能なbaselineを先に作る。** 同じpublic frozen corpus、同じGrant、同じprovider条件でsingle run、複数run union、validated Finding数を測る。外部researcher profileは成功例の観察であり、Harness recall baselineではない。

## 付録: Rafieの直近公開20件と現在の有効インストール数

### 抽出基準

2026-09-13に[RafieのPatchstack profile](https://patchstack.com/database/researchers/38daedf8-3237-4768-ae6e-be8e32979a65)の全公開pageを取得し、埋め込みdataの`disclosure_date`降順で先頭20 vulnerability recordsを採った。profile表が表示する`Reported`は別fieldの`report_date`なので、両日付を残した。「直近」は**公開順**を意味し、報告順ではない。

20件は19 unique productで、plugin 15件・14 unique plugin、theme 5件だった。唯一の重複はpixfort Coreの2件である。以下の`active installs`は同日にWordPress.org Plugin Information APIでslugを照合し、公式plugin pageでも表示を確認した**2026-09-13現在のrounded lower bound**である。Patchstackの報告日・公開日とは観測時点が違う。

| # | 公開日 | `Reported` | Product / slug | WordPress.org current active installs / status |
| ---: | --- | --- | --- | --- |
| 1 | 2026-09-04 | 2025-10-15 | [WP Rentals](https://patchstack.com/database/wordpress/theme/wprentals/vulnerability/wordpress-wp-rentals-theme-3-16-0-insecure-direct-object-references-idor-vulnerability) / `wprentals` | Theme: 対象外 |
| 2 | 2026-09-03 | 2026-08-26 | [Enfold](https://patchstack.com/database/wordpress/theme/enfold/vulnerability/wordpress-enfold-theme-8-0-cross-site-scripting-xss-vulnerability) / `enfold` | Theme: 対象外 |
| 3 | 2026-08-13 | 2026-06-30 | [Visitors Traffic Real Time Statistics](https://patchstack.com/database/wordpress/plugin/visitors-traffic-real-time-statistics/vulnerability/wordpress-visitors-traffic-real-time-statistics-plugin-8-11-cross-site-scripting-xss-vulnerability) / `visitors-traffic-real-time-statistics` | [30,000+](https://wordpress.org/plugins/visitors-traffic-real-time-statistics/) |
| 4 | 2026-07-31 | 2026-07-03 | [Facebook for WordPress](https://patchstack.com/database/wordpress/plugin/official-facebook-pixel/vulnerability/wordpress-facebook-for-wordpress-plugin-5-2-1-cross-site-scripting-xss-vulnerability) / `official-facebook-pixel` | [400,000+](https://wordpress.org/plugins/official-facebook-pixel/) |
| 5 | 2026-07-31 | 2026-07-03 | [Facebook for WooCommerce](https://patchstack.com/database/wordpress/plugin/facebook-for-woocommerce/vulnerability/wordpress-facebook-for-woocommerce-plugin-3-7-5-cross-site-scripting-xss-vulnerability) / `facebook-for-woocommerce` | [400,000+](https://wordpress.org/plugins/facebook-for-woocommerce/) |
| 6 | 2026-07-31 | 2026-07-10 | [Rank Math SEO](https://patchstack.com/database/wordpress/plugin/seo-by-rank-math/vulnerability/wordpress-rank-math-seo-plugin-1-0-274-1-cross-site-scripting-xss-vulnerability) / `seo-by-rank-math` | [4,000,000+](https://wordpress.org/plugins/seo-by-rank-math/) |
| 7 | 2026-07-02 | 2025-10-15 | [Shopify](https://patchstack.com/database/wordpress/plugin/shopify-plugin/vulnerability/wordpress-shopify-plugin-1-0-0-local-file-inclusion-vulnerability) / `shopify-plugin` | [API no match](https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=shopify-plugin); distribution不明 |
| 8 | 2026-06-30 | 2025-10-15 | [Motors](https://patchstack.com/database/wordpress/theme/motors/vulnerability/wordpress-motors-theme-5-6-80-broken-access-control-vulnerability) / `motors` | Theme: 対象外 |
| 9 | 2026-06-25 | 2026-06-17 | [JetEngine](https://patchstack.com/database/wordpress/plugin/jet-engine/vulnerability/wordpress-jetengine-plugin-3-8-10-2-sql-injection-vulnerability) / `jet-engine` | [commercial/off-repo](https://crocoblock.com/plugins/jetengine/) |
| 10 | 2026-04-23 | 2025-09-12 | [MasterStudy LMS Pro](https://patchstack.com/database/wordpress/plugin/masterstudy-lms-learning-management-system-pro/vulnerability/wordpress-masterstudy-lms-pro-plugin-4-7-16-broken-access-control-vulnerability-2) / `masterstudy-lms-learning-management-system-pro` | [commercial/off-repo](https://stylemixthemes.com/wordpress-lms-plugin/pricing/) |
| 11 | 2026-03-17 | 2025-12-19 | [Ave Core](https://patchstack.com/database/wordpress/plugin/ave-core/vulnerability/wordpress-ave-core-plugin-2-9-1-broken-access-control-vulnerability) / `ave-core` | [theme-bundled/off-repo](https://ave.liquid-themes.com/) |
| 12 | 2026-03-17 | 2025-12-19 | [Listeo Core](https://patchstack.com/database/wordpress/plugin/listeo-core/vulnerability/wordpress-listeo-core-plugin-2-0-21-reflected-cross-site-scripting-xss-vulnerability) / `listeo-core` | [theme-bundled/off-repo](https://docs.purethemes.net/listeo/knowledge-base/) |
| 13 | 2026-03-02 | 2025-09-12 | [pixfort Core: BAC](https://patchstack.com/database/wordpress/plugin/pixfort-core/vulnerability/wordpress-pixfort-core-plugin-3-2-22-broken-access-control-vulnerability) / `pixfort-core` | [theme-bundled/off-repo](https://themeforest.net/item/essentials-multipurpose-wordpress-theme/27889640) |
| 14 | 2026-03-02 | 2025-09-12 | [pixfort Core: XSS](https://patchstack.com/database/wordpress/plugin/pixfort-core/vulnerability/wordpress-pixfort-core-plugin-3-2-22-reflected-cross-site-scripting-xss-vulnerability) / `pixfort-core` | 同上 |
| 15 | 2026-02-26 | 2025-08-15 | [ListingPro](https://patchstack.com/database/wordpress/plugin/listingpro-plugin/vulnerability/wordpress-listingpro-plugin-2-9-8-reflected-cross-site-scripting-xss-vulnerability) / `listingpro-plugin` | [theme-bundled/off-repo](https://docs.listingprowp.com/knowledgebase/do-i-need-extra-plugins/) |
| 16 | 2026-02-26 | 2025-08-13 | [RH Frontend Publishing Pro](https://patchstack.com/database/wordpress/plugin/rh-frontend/vulnerability/wordpress-rh-frontend-publishing-pro-plugin-4-3-2-reflected-cross-site-scripting-xss-vulnerability) / `rh-frontend` | [commercial/off-repo](https://rehubdocs.wpsoul.com/docs/rehub-plugins-add-ons/rh-frontend-publishing-pro/) |
| 17 | 2026-02-26 | 2025-08-07 | [UDesign](https://patchstack.com/database/wordpress/theme/u-design/vulnerability/wordpress-udesign-theme-4-14-0-reflected-cross-site-scripting-xss-vulnerability) / `u-design` | Theme: 対象外 |
| 18 | 2026-01-18 | 2025-12-19 | [Sober](https://patchstack.com/database/wordpress/theme/sober/vulnerability/wordpress-sober-theme-3-5-12-broken-access-control-vulnerability) / `sober` | Theme: 対象外 |
| 19 | 2026-01-13 | 2025-09-12 | [JNews - Video](https://patchstack.com/database/wordpress/plugin/jnews-video/vulnerability/wordpress-jnews-video-plugin-11-0-2-reflected-cross-site-scripting-xss-vulnerability) / `jnews-video` | [theme-bundled/off-repo](https://support.jegtheme.com/documentation/plugin/) |
| 20 | 2026-01-13 | 2025-09-12 | [JNews - Pay Writer](https://patchstack.com/database/wordpress/plugin/jnews-pay-writer/vulnerability/wordpress-jnews-pay-writer-plugin-11-0-0-local-file-inclusion-vulnerability) / `jnews-pay-writer` | [theme-bundled/off-repo](https://support.jegtheme.com/documentation/plugin/) |

### 集計

WordPress.orgでcurrent値を取得できたのは4/14 unique plugin、28.6%だった。plugin report単位では4/15、26.7%、直近20 vulnerability全体では4/20、20.0%である。取得できた4 pluginの`active_installs` lower boundは最小30,000、中央値400,000、最大4,000,000だった。4件だけに条件づけた統計であり、全14 pluginの代表値ではない。

| Current active-install / availability bucket | Unique plugins | 全14 plugin比 |
| --- | ---: | ---: |
| `< 10,000` | 0 | 0.0% |
| `10,000–99,999` | 1 | 7.1% |
| `100,000–999,999` | 2 | 14.3% |
| `1,000,000+` | 1 | 7.1% |
| 公式vendor資料でcommercial/theme-bundled、WP.org API no match | 9 | 64.3% |
| WP.org API no match、distribution未確定 | 1 | 7.1% |

off-repo 9 unique pluginは公式vendor/product資料でcommercialまたはtheme-bundledと確認した。Shopifyだけは公式Plugin Information APIが`Plugin not found.`を返し、旧directory URLも現行entryへ解決しないが、公開dataだけでcommercial、削除、slug変更を区別できない。いずれもactive installsを0とは置かず、最小・中央値・最大から除外した。

このsampleの75%はpluginだが、11/15 plugin reportsはWordPress.orgのcurrent active installsで規模を観測できない。つまり直近portfolioには、public directory pluginだけでなくcommercial themeのcore/add-onを横展開した成果が多い。公式directoryに現在残る4件も30Kから4M+まで幅があり、このsampleから「large-installだけ」または「small-installだけ」とは言えない。

最後に、このprofileは**公開された成功例だけ**を並べる。監査して何も出なかったplugin、棄却、duplicate、投入時間は含まれない。現在のactive installsを過去のTarget選定のproxyにしても、hit rateの分母または当時のpopularityは復元できない。

## 限界

- Patchstack profile headerとtableには、Rafieの`42 Reports`対731 dated rows + 1,325 `No date` rows、darooの`300 Reports`対280 dated rowsという未解消の差がある。異なるprogramme/report/database creditを混ぜないため、dated table rowsだけを分布集計に使った。
- Wordfenceのprofile publication dateとoriginal discovery/submission dateは同じとは限らない。90-day publication数を研究速度へ直接変換しない。
- conference abstractはautomationの存在と大枠を示すが、rules、false-positive rate、coverage、source、tool実装を公開していない。
- LinkedInのClaude記述と共同研究者のLLM workflowは現在の利用例であり、過年度portfolio全体の因果説明ではない。
- daroo本人の方法を直接説明する公開記事、talk、repository、interviewは確認できなかった。darooに関するworkflow説明はportfolio patternからの推論に留める。
