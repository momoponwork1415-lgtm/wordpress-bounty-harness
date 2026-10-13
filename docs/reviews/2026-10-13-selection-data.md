# 選定の data: install 帯とタグ（2026-10-13）

調べて報告。正本ではない。所有者の指示（2026-10-13）: 「候補タグは所有者が決めるのではなく Wordfence Intelligence の database から plugin のタグを分類して選ぶ。install 下限は公式情報で確かめる」。

出典は 4 つ。Wordfence 月次報告 2026 年 6 月分（公式、所有者が 2026-10-13 に貼付）、所有者の 2026-08 の分析（`wp-bounty-workspace/selection/target-pool.md`、`superseded-20260820/SELECTION.md`、公式月次報告 10 か月分を集計したもの）、ローカルの Wordfence ミラー（`history.sqlite`、41,923 件、2026-10-13 更新）、WordPress.org の人気順一覧 10,000 件（タグと install 数、2026-10-13 取得）。

## 0. 結論

- **install 下限は 100,000 にする。** 公式の平均報奨は 100k〜999k で 205〜307 USD、50k〜99k で 105〜209 USD、1k〜49k で 108〜128 USD、1,000 未満で 22〜35 USD。所有者自身の実績は 300k〜999k で 1 件 244 USD、10k〜99k で 38 USD（2026-08 の 51 件）。所有者の 2026-08 の規則 Gate 1「100k 未満には理由なしに行かない」と一致する。除外作者を除いた pool は 100k 以上で 442 件（1M 以上 58、100k〜999k 384）。再訪条件（版が変わったら戻る、最低 3 回）と組み合わせると数か月分ある。
- **タグは「低権限で報奨対象の記録が plugin 1 件あたり多い」順に、ミラーと WordPress.org のタグから機械的に出す。** 上位はフォーム系（form-builder 3.4、custom-form 3.1、forms 2.4、contact-form 2.3）、membership 2.8、Elementor 系（1.1〜1.6）、page-builder 0.9、multilingual 0.8、backup 0.7。所有者の有償 plugin のタグ（multilingual、page-builder、elementor-addons、search、booking、lms、newsletter、directory）はこの表の中位〜上位にある。既定は `forms`、`contact-form`、`membership`、`page-builder`、`elementor-addons`、`multilingual`、`backup`、`booking`（schema 上限 8）。
- **タグの yield は選定の signal としてまだ検証されていない。** 所有者の 2026-08 の backtest では plugin 単位の履歴 signal 6 種は全部効かず、効いたのは「同じ plugin に 3 回戻る」だけだった。タグ単位は別の問いなので、台帳の `target-selected` にタグの出典を残し、半年後に有償率で測る。それまで重みは付けず、タグは入口の列挙だけに使う。
- **ADR 0030 の修正が要る。** 0030 は「公開履歴を選定候補の列挙・除外・採点に使わない」。タグの yield 計算は履歴をタグ単位で列挙に使うので、「plugin 単位では使わない。タグ単位の yield は列挙にだけ使い、採点には使わない」に 1 段落足す。

## 1. 公式: 2026 年 6 月の月次報告

| 項目 | 値 |
| --- | --- |
| 提出 | 1,066（in-scope 185、out-of-scope 1、rejected 578、duplicate 302） |
| 報奨合計 / 平均 | 42,553 USD / 230 USD |
| 認証別の平均 | Unauthenticated 360（89 件）、Subscriber 89（37 件）、Contributor 50、Author 19、Custom 1,143（10 件） |
| install 帯別の平均 | 0〜499: 22、500〜999: 27、1k〜49,999: 108（63 件）、50k〜99k: 209、100k〜999k: 205（36 件）、1M〜4.99M: 1,502（4 件）、5M+: 72（1 件）、Off-Repo: 671 |
| 種別別の平均 | XSS 95（60 件）、SQLi 92、Path Traversal 118、File Upload 222、Privilege Management 307、Improper Authentication 2,826（4 件）、Cryptographic Signature 5,363（2 件） |

所有者の 2026-08 の 10 か月集計も同じ形: 5M+ 781、1M〜4.99M 446、100k〜999k 307、1k〜49k 128、50k〜99k 105、1k 未満 35。XSS は in-scope の 34% で平均 92、File Upload は 538。Unauthenticated 305、Subscriber 222、Contributor 51。

## 2. pool と帯（WordPress.org 人気順 10,000 件、除外作者 5 社を除く）

| 帯 | plugin 数 | 365 日に公開記録が 0 の plugin |
| --- | --- | --- |
| 1M+ | 58 | 22 |
| 100k〜999k | 384 | 146 |
| 50k〜99k | 321 | 152 |
| 10k〜49k | 1,382 | 834 |

365 日間（2025-10-13〜2026-10-13）の plugin 向け公開記録は 10,397 件、4,892 plugin。低権限（未認証 / Subscriber+）で報奨対象の種別に入る記録の帯別件数:

| 種別 | 1M+ | 100k〜999k | 50k〜99k | 10k〜49k |
| --- | --- | --- | --- | --- |
| stored-xss | 11 | 155 | 78 | 186 |
| sqli | 1 | 17 | 33 | 70 |
| privesc / ATO / auth bypass | 4 | 29 | 20 | 44 |
| info disclosure | 10 | 69 | 68 | 95 |
| file read / delete / traversal | 0 | 12 | 9 | 32 |
| file upload | 0 | 7 | 10 | 9 |
| rce / code injection | 0 | 10 | 2 | 7 |
| options update | 1 | 3 | 3 | 3 |

## 3. タグ別の yield（plugin ≥10k、タグ内 plugin 15 件以上、上位 20）

「低権限・報奨対象 / plugin」が順位。「記録あり」は 365 日に 1 件以上の公開記録がある plugin の割合で、混雑の目安。

| タグ | plugin ≥10k | ≥100k | 低権限・報奨対象 | / plugin | 記録あり | 研究者数 | 主な種別 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| form-builder | 25 | 7 | 85 | 3.40 | 88% | 126 | stored-xss、info、sqli |
| custom-form | 17 | 7 | 52 | 3.06 | 88% | 91 | stored-xss、info、poi |
| membership | 15 | 2 | 42 | 2.80 | 80% | 99 | privesc-ato、stored-xss |
| forms | 31 | 11 | 74 | 2.39 | 81% | 114 | stored-xss、info、poi |
| contact-form | 38 | 9 | 87 | 2.29 | 74% | 126 | stored-xss、info、sqli |
| elementor-templates | 18 | 7 | 29 | 1.61 | 94% | 84 | stored-xss |
| elementor-widgets | 25 | 9 | 33 | 1.32 | 88% | 98 | stored-xss |
| form | 16 | 5 | 20 | 1.25 | 75% | 50 | stored-xss、sqli |
| elementor-addons | 32 | 10 | 34 | 1.06 | 88% | 101 | stored-xss、info、sqli |
| schema | 17 | 6 | 18 | 1.06 | 88% | 56 | stored-xss、info |
| ai | 19 | 4 | 19 | 1.00 | 63% | 61 | stored-xss、info、privesc-ato |
| optimize | 19 | 8 | 19 | 1.00 | 58% | 37 | stored-xss、file-ops |
| page-builder | 36 | 11 | 32 | 0.89 | 81% | 99 | stored-xss、info |
| popup | 16 | 5 | 13 | 0.81 | 69% | 34 | stored-xss、sqli |
| multilingual | 15 | 7 | 12 | 0.80 | 53% | 24 | stored-xss、info |
| lightbox | 21 | 6 | 16 | 0.76 | 57% | 37 | stored-xss、sqli |
| cache | 31 | 7 | 21 | 0.68 | 58% | 39 | stored-xss、info |
| backup | 30 | 10 | 20 | 0.67 | 73% | 48 | privesc-ato、info、sqli |
| ecommerce | 33 | 9 | 21 | 0.64 | 64% | 73 | stored-xss、info、sqli |
| security | 76 | 24 | 28 | 0.37 | 55% | 54 | stored-xss、privesc-ato |

現行の `login`（0.28、36 件）と `upload`（15 件未満で表外）は下位。`login` は AI が入れた値で、本番 15 対象中 9 件が login / security 系に偏った原因。

## 4. 所有者の 2026-08 の規則で今も使えるもの

- Gate 1「100k 未満に行かない」、Gate 5「同じ plugin に最低 3 回。次の release が戻る合図」。本リポの `revisitPolicy: version-or-prompt-changed` は Gate 5 と同じ。
- 「選定側の signal 6 種は backtest で全部無効（静的 code 形状 AUC 0.37、unauth surface は逆符号、recency 差なし、vendor 相関は逆、50k 下限 p=0.156、履歴再発 shortlist は Fisher p=1.0 で上位 20 が 0 USD）」。competitor 密度も予測しない（p=1.0）。
- 「早期停止が run の 18% で最大の失敗」。本リポの Root 自主停止の観測と同じ。

## 5. 選定方針への反映（#184 の前に小 PR）

| 項目 | 今 | 変更 |
| --- | --- | --- |
| minimumActiveInstallations | 10,000 | 100,000 |
| candidateSource.tags | upload, login | forms, contact-form, membership, page-builder, elementor-addons, multilingual, backup, booking |
| candidateSource.popularPages / pagesPerTag / perPage / maxCandidates | 1 / 1 / 20 / 40 | 2 / 2 / 50 / 500（100k 以上を取り切る） |
| highThreatTags / surfaceTagWeights / scoreWeights.highThreat・surface | 21 個 / 7 個 / 15・1 | 削除。順位は installs 10 + recency 5 |
| runBudget | 20 / 40 | 削除（#189 の条件付き追加 Trial に置き換え） |
| wordpressVersion | 6.8.3 | 7.1.3 |
| タグの出典 | — | `target-selected` に `candidateTag` と yield 表の日付を残す |

## 6. 未確認の仮定

- 種別と認証レベルは Wordfence の title 文字列から分類した。title の表記揺れで数 % の誤分類がある。
- WordPress.org のタグは作者が自由に付けるので、同じ機能の plugin が別のタグに散る。`forms` / `contact-form` / `form-builder` のように重なるタグは 1 つの族として扱う。
- 公式の帯別平均は in-scope 提出の平均で、所有者が実際に見つけられる確率は含まない。
