# 対象選定の基準を公開統計から決める（2026-10-19）

調べて報告。正本ではない（[docs/reviews/README.md](README.md)）。所有者の指示「選定については公開情報から統計を取ったほうがいい。それであなたに決めてもらう」に答える。この報告を読んだ AI session が採否を決め、採る場合は `selection.json`・contracts・ADR 0030 の改訂を別 PR で行う。この PR は文書と集計 script だけで、code も方針も変えない。

## 0. 結論（数字だけ）

| 項目 | 数字 |
| --- | --- |
| 主要 outcome C（paying class かつ PR:N/PR:L の公開記録が窓内に 1 件以上）の base rate | 全体 8.3%（T1、半年窓）/ 11.2%（T2、1 年窓）。100k–1M 帯 33.6% / 39.1% |
| 最も強い単独特徴（全体、lift） | 直近 365 日の記録者数 4+：8.95× / 6.72×。帯内では paying class 記録 2+：2.40× / 2.19×（C 率 80.7% / 85.7%） |
| 提案 score の帯内 top-50 精度（C） | 82% / 86%（base 33.6% / 39.1%。現行 score は 52% / 60%） |
| 提案 score の帯内 top-50 の報酬 proxy 平均 | 573 / 727 USD-proxy（現行 295 / 366。約 1.9〜2.0 倍） |
| 所有者 21 件の sanity check | 帯内 10 件の帯内順位 中央値 91.5（現行 104）、top-50 に 3 件（現行 0）。21 件中 18 件が報告前日時点で paying class 記録 ≥1、13 件が最終記録から 90 日以内 |
| 重複圧 | Wordfence 2025-07〜2026-06：投稿 10,270、in-scope 2,044、duplicate 1,870。dup/in-scope は 0.13 → 1.6〜2.2。同じ plugin の outcome C 記録のうち同一記録者による続報は 11.5% |
| 推奨 | 帯 100k–1M を維持。score = paying class 件数（365 日、上限 3）×1 ＋ 最終記録の新しさ ×1 ＋ 0.5×log10(install)。WordPress.org 更新鮮度の加点は 0。再訪は版上昇かつ 90 日経過。帯が尽きたら 50k へ下げる前に ≥1M（paying class ≥2）を許す（所有者の順と逆。§5.4） |

## 1. 問い

Wordfence Intelligence の公開履歴と WordPress.org の公開 metadata だけで、「次の半年〜1 年に programme boundary 内（未認証 / 低権限）の paying class 脆弱性が公開される plugin」を今の選定（install 数と WordPress.org 更新鮮度）より高い精度で当てられるか。当てられるなら、`selection.json` に手で書ける形の規則は何か。

## 2. データ

すべて公開情報。件数・日付・CVSS 成分・class signal だけを使い、記録の題名・本文・CVE id・記録者名は使わない（記録者は hash 化した匿名 id の件数のみ）。

| 源 | 内容 | 時点 |
| --- | --- | --- |
| Wordfence Intelligence mirror（`wordfence-history/v1` projection、SQLite） | 42,211 記録。plugin 記録 41,887 行（slug 単位）。`published`、`informational`、CVSS vector の `PR:` 成分、`signals`（primitive / terminal）、記録者数 | 2026-10-14 |
| WordPress.org plugin API `query_plugins` | popular 40 page × 250 ＝ 9,980 件 ＋ 方針 tag 8 種 × 1 page → 重複を除き 11,299 slug。`active_installs`、`last_updated`、`added`、`tags`、`requires_plugins` | 2026-10-19（取得は ≤2 req/s、生データは Git 外） |
| Wordfence Bug Bounty Program Monthly Report（公開 blog、2025-07〜2026-06 の 12 本） | 月次の投稿数・in-scope・duplicate・報酬総額、install 帯別・認証レベル別・type 別の件数と平均報酬 | 各月の公開日 |
| 所有者の 21 報告（2026-03〜2026-09） | slug と報告日のみ。金額は使わない | 既知 |

Install 帯の分布（11,299 件）：<100k 10,835、100k–200k 182、200k–500k 151、500k–1M 63、1M–5M 57、>5M 11。100k–1M 帯は 396 件で、popular 上位 500 件（現行 `popularPages: 10 × perPage: 50`）に 396 件すべてが入る。50k–100k の 327 件は上位 1,000 件にすべて入る。

## 3. 方法

遡及予測。各 cutoff T で、T 以前に公開された記録だけから特徴を作り、(T, T+窓] の記録で outcome を判定する。

- cutoff：T1 ＝ 2026-04-14、窓 183 日（mirror 終端まで）。T2 ＝ 2025-10-14、窓 365 日。
- outcome（plugin 単位）：A ＝ 非 informational 記録 ≥1。B ＝ paying class 記録 ≥1。C ＝ B かつ CVSS `PR:N` または `PR:L`（主要 outcome）。D ＝ C 記録に報酬 proxy を付けて合計した USD-proxy（§4.7）。
- paying class ＝ signals の値が `stored-xss`、`sql-injection`、`privilege-escalation(-to-admin)`、`authentication-bypass(-to-admin)`、`arbitrary-file-upload`、`remote-code-execution` のいずれか（primitive / terminal を問わない）。signal の無い記録（CSRF、missing authorization、情報漏えい等 15,394 件）は A のみに数える。
- 特徴：install 帯（今日の値。過去時点の値は取れないので軽い leak と明記）、直近 365 日の記録数、同 paying class 記録数、最終記録からの日数、同 365 日の記録者数、plugin 年齢（`added`）、`last_updated` からの日数（今日の値。パッチ公開が outcome の結果なので強い leak。参考のみ）、方針 tag 8 種の有無、`requires_plugins` の有無。
- 指標：群ごとの件数・outcome 率・base rate に対する lift。score は加法 ≤4 項で、重みは表を読んで手で選び、帯内と全体の top-50 / top-100 精度と、所有者 21 件の順位で確かめる。
- script：[`scripts/analysis/selection-statistics.py`](../../scripts/analysis/selection-statistics.py)（mirror path と WordPress.org の取得 dir を引数に取る。集計のみ出力）。

## 4. 結果

### 4.1 base rate と install 帯

| 帯 | n | C 率 T1 | lift T1 | C 率 T2 | lift T2 | 報酬 proxy D 平均 T1 / T2 |
| --- | --- | --- | --- | --- | --- | --- |
| <10k | 9,119 | 5.0% | 0.60 | 7.3% | 0.65 | 20 / 26 |
| 10k–30k | 1,092 | 17.0% | 2.06 | 22.7% | 2.02 | 67 / 89 |
| 30k–50k | 297 | 20.2% | 2.44 | 28.3% | 2.51 | 79 / 112 |
| 50k–100k | 327 | 21.7% | 2.62 | 26.9% | 2.39 | 96 / 157 |
| 100k–200k | 182 | 30.8% | 3.72 | 35.2% | 3.13 | — |
| 200k–500k | 151 | 32.5% | 3.92 | 37.7% | 3.36 | — |
| 500k–1M | 63 | 44.4% | 5.37 | 54.0% | 4.80 | — |
| 100k–1M 計 | 396 | 33.6% | 4.06 | 39.1% | 3.48 | 156 / 207 |
| ≥1M | 68 | 42.6% | 5.15 | 44.1% | 3.92 | 262 / 286 |
| 全体 | 11,299 | 8.3% | 1.00 | 11.2% | 1.00 | 35 / 46 |

帯内では 500k–1M が 100k–200k の 1.4 倍。帯の外では ≥1M がさらに高く、50k–100k は帯の 6〜7 割。

### 4.2 公開履歴の特徴（全体 11,299 件、outcome C）

| 特徴 | 値 | n | C 率 T1 | lift T1 | C 率 T2 | lift T2 |
| --- | --- | --- | --- | --- | --- | --- |
| 直近 365 日の paying class 記録数 | 0 | 10,032 / 9,913 | 5.3% | 0.65 | 7.9% | 0.70 |
|  | 1 | 907 / 939 | 22.7% | 2.74 | 23.4% | 2.08 |
|  | 2+ | 360 / 447 | 53.6% | 6.48 | 60.2% | 5.35 |
| 最終記録からの日数 | なし | 6,494 / 6,818 | 1.9% | 0.23 | 3.4% | 0.31 |
|  | >365 | 2,478 / 2,118 | 9.2% | 1.12 | 16.1% | 1.43 |
|  | 91–365 | 1,522 / 1,525 | 18.0% | 2.18 | 25.9% | 2.30 |
|  | ≤90 | 805 / 838 | 38.1% | 4.61 | 36.0% | 3.20 |
| 直近 365 日の記録数 | 0 | 8,977 / 8,942 | 3.9% | 0.48 | 6.4% | 0.57 |
|  | 1 | 1,429 / 1,457 | 12.5% | 1.51 | 16.0% | 1.42 |
|  | 2–4 | 734 / 720 | 38.3% | 4.63 | 44.2% | 3.93 |
|  | 5–9 | 131 / 163 | 71.0% | 8.58 | 78.5% | 6.98 |
|  | 10+ | 28 / 17 | 100% | 12.08 | 94.1% | 8.37 |
| 直近 365 日の記録者数 | 0 | 8,978 / 8,949 | 3.9% | 0.48 | 6.4% | 0.57 |
|  | 1 | 1,482 / 1,543 | 13.7% | 1.66 | 17.4% | 1.54 |
|  | 2–3 | 623 / 610 | 35.0% | 4.23 | 45.4% | 4.04 |
|  | 4+ | 216 / 197 | 74.1% | 8.95 | 75.6% | 6.72 |

n は T1 / T2。paying class 記録数と最終記録の新しさの交差（T1）：2+ かつ ≤90 日 ＝ 64.7%（n 215、lift 7.81）、2+ かつ 91–365 日 ＝ 37.2%（n 145）、1 かつ ≤90 日 ＝ 34.3%（n 251）、0 かつ ≤90 日 ＝ 24.2%（n 339）。T2 も同じ順（63.9% / 56.2% / 25.5% / 25.4%）。

### 4.3 100k–1M 帯の中だけで見る（outcome C、base 33.6% / 39.1%）

| 特徴 | 値 | n T1 / T2 | C 率 T1 | lift T1 | C 率 T2 | lift T2 |
| --- | --- | --- | --- | --- | --- | --- |
| paying class 記録数（365 日） | 0 | 283 / 293 | 21.6% | 0.64 | 28.0% | 0.72 |
|  | 1 | 56 / 47 | 46.4% | 1.38 | 53.2% | 1.36 |
|  | 2+ | 57 / 56 | 80.7% | 2.40 | 85.7% | 2.19 |
| 最終記録からの日数 | なし | 84 / 91 | 7.1% | 0.21 | 9.9% | 0.25 |
|  | >365 | 139 / 148 | 23.0% | 0.69 | 32.4% | 0.83 |
|  | 91–365 | 70 / 100 | 41.4% | 1.23 | 57.0% | 1.46 |
|  | ≤90 | 103 / 57 | 64.1% | 1.91 | 71.9% | 1.84 |
| 記録者数（365 日） | 0 | 223 / 239 | 17.0% | 0.51 | 23.8% | 0.61 |
|  | 1 | 66 / 80 | 31.8% | 0.95 | 42.5% | 1.09 |
|  | 2–3 | 73 / 47 | 58.9% | 1.75 | 80.9% | 2.07 |
|  | 4+ | 34 / 30 | 91.2% | 2.71 | 86.7% | 2.21 |

帯内の候補 pool（T1 / T2 時点）：paying class ≥1 ＝ 113 件（C 率 63.7%）/ 103 件（70.9%）。≥2 ＝ 57 件（80.7%）/ 56 件（85.7%）。≥1 かつ最終記録 ≤90 日 ＝ 72 件（73.6%）/ 45 件（80.0%）。全期間で記録なし ＝ 84 件（7.1%）/ 91 件（9.9%）。

### 4.4 効かなかった特徴（全体、lift）

| 特徴 | 値 | n | lift C T1 | lift C T2 |
| --- | --- | --- | --- | --- |
| 方針 tag 8 種 | あり | 1,880 | 0.95 | 0.89 |
| `requires_plugins` | あり | 1,026 | 0.87 | 0.80 |
| plugin 年齢 | <2 年 | 1,112 | 0.30 | 0.33 |
|  | 2–4 / 5–9 / 10+ 年 | 1,430 / 4,299 / 4,458 | 1.02 / 1.06 / 1.11 | 1.03 / 1.07 / 1.09 |
| `last_updated` からの日数（leak） | ≤30 | 2,983 | 2.58 | 2.29 |
|  | >365 | 3,774 | 0.04 | 0.08 |

tag と依存は選定の信号にならない（tag は列挙の入口としてだけ意味を持つが、tag 由来の 1,319 件はほぼ <100k）。`last_updated` は強く見えるが、脆弱性公開に伴うパッチ版の公開が原因側にあるので採点に使わない。>365 日更新なしで C 率 0.3% なのは、現行の適格条件 `maximumUpdateAgeDays: 365` を支持する。

### 4.5 score と精度

score は加法。`payingClass` ＝ 直近 365 日の paying class 記録数（上限 3）、`recordRecency` ＝ max(0, 1 − 最終記録からの日数/365)、`records` ＝ 直近 365 日の記録数（上限 5）、`installations` ＝ log10(1+install)。現行 ＝ 10×log10(1+install) ＋ 5×WordPress.org 更新鮮度。

| 重み | 帯 top-10 T1 / T2 | 帯 top-25 | 帯 top-50 | 帯 top-100 | 全体 top-50 | 帯 top-50 D 平均 T1 / T2 |
| --- | --- | --- | --- | --- | --- | --- |
| 現行（install + WP.org 鮮度） | — | — | 52% / 60% | 46% / 54% | 46% / 48% | 295 / 366 |
| pay 1 | 90% / 80% | 88% / 84% | 84% / 86% | 68% / 71% | 80% / 70% | 554 / 685 |
| pay 1, cap 2 | 90% / 80% | 80% / 76% | 82% / 84% | 68% / 71% | 56% / 56% | — |
| pay 1 ＋ rec 1 | 90% / 100% | 96% / 92% | 84% / 86% | 66% / 73% | 90% / 72% | — |
| **pay 1 ＋ rec 1 ＋ inst 0.5（提案）** | 90% / 90% | 92% / 96% | 82% / 86% | 66% / 71% | 92% / 92% | 573 / 727 |
| pay 1 ＋ rec 1 ＋ n 0.25 ＋ inst 0.5 | 90% / 90% | 96% / 96% | 80% / 86% | 67% / 72% | 86% / 90% | 564 / 727 |
| pay 1 ＋ hv 1 ＋ rec 1 ＋ inst 0.5（高額 class を二重に数える） | — | — | 78% / 88% | — | 86% / 86% | 546 / 771 |
| rec 1 のみ | 70% / 80% | 76% / 68% | 68% / 68% | 63% / 69% | 54% / 34% | — |
| n 0.25 のみ | 100% / 70% | 88% / 84% | 86% / 86% | 69% / 77% | 88% / 78% | — |

読み取り：帯内の精度は paying class 件数だけでほぼ決まる（84% / 86%）。新しさの項は top-25 を上げる（88 → 96%、84 → 92%）。install の項は帯内では効かないが、帯の外へ広げたとき（下限切り下げ、≥1M 許可）に全体 top-50 を 72 → 92%（T2）へ上げる。記録総数の項と高額 class の二重計上は帯内精度を上げない。上限を 2 にすると全体 top-50 が 80 → 56% に落ちる。

### 4.6 所有者 21 件での sanity check

各報告日の前日を cutoff にし、提案 score（pay 1 ＋ rec 1 ＋ inst 0.5）で全 11,299 件を順位付けした。帯は今日の install で判定。

| 区分 | 件数 | 結果 |
| --- | --- | --- |
| 今日の install が 100k–1M の報告 | 10 | 帯内順位 中央値 91.5 / 396（現行 score 104）。top-50 に 3 件（現行 0）、top-100 に 5 件（現行 5） |
| 今日の install が <100k の報告 | 10 | 帯外。全体順位は 54〜3,067。20 件の全体順位の中央値は 236.5、top-300 に 11 件 |
| WordPress.org に無い plugin | 1 | 対象外 |
| 報告前日時点で paying class 記録 ≥1 | 18 / 21 | ≥2 は 11 / 21 |
| 最終記録から 90 日以内 | 13 / 21 | 直近 365 日に記録 ≥1 は 20 / 21 |

帯内 10 件のうち順位 193 と 196 の 2 件は同じ plugin への再報告で、cutoff 時点で paying class 記録 0、最終記録から 300 日超だった。履歴では当てられない型（所有者自身が前に見つけた plugin を版上昇後に再び見る）で、再訪規則で拾う。帯外 10 件は現行の下限 100k が所有者の過去の報告の半分を切っていることを示す。ただし §4.7 の通り、その帯の平均報酬は 100k–1M 帯の 4 割弱。

### 4.7 報酬の経済（Wordfence 月次報告、2025-07〜2026-06）

出典は Wordfence blog の "Wordfence Bug Bounty Program Monthly Report"（[2025-07](https://www.wordfence.com/blog/2025/08/wordfence-bug-bounty-program-monthly-report-july-2025/)、[2025-08](https://www.wordfence.com/blog/2025/09/wordfence-bug-bounty-program-monthly-report-august-2025/)、[2025-09](https://www.wordfence.com/blog/2025/10/wordfence-bug-bounty-program-monthly-report-september-2025/)、[2025-10](https://www.wordfence.com/blog/2025/11/wordfence-bug-bounty-program-monthly-report-october-2025/)、[2025-11](https://www.wordfence.com/blog/2025/12/wordfence-bug-bounty-program-monthly-report-november-2025/)、[2025-12](https://www.wordfence.com/blog/2026/01/wordfence-bug-bounty-program-monthly-report-december-2025/)、[2026-01](https://www.wordfence.com/blog/2026/02/wordfence-bug-bounty-program-monthly-report-january-2026/)、[2026-02](https://www.wordfence.com/blog/2026/03/wordfence-bug-bounty-program-monthly-report-february-2026/)、[2026-03](https://www.wordfence.com/blog/2026/05/wordfence-bug-bounty-program-monthly-report-march-2026/)、[2026-04](https://www.wordfence.com/blog/2026/07/wordfence-bug-bounty-program-monthly-report-april-2026/)、[2026-05](https://www.wordfence.com/blog/2026/09/wordfence-bug-bounty-program-monthly-report-may-2026/)、[2026-06](https://www.wordfence.com/blog/2026/09/wordfence-bug-bounty-program-monthly-report-june-2026/)）。公開表の集計値のみ。

12 か月計：投稿 10,270、in-scope 2,044、duplicate 1,870、rejected 3,643、報酬総額 350,121 USD、in-scope 1 件あたり平均 171 USD。活動研究者は月 69 → 306。

| install 帯 | 報奨件数 | 割合 | 平均報酬 USD |
| --- | --- | --- | --- |
| 0–999 | 217 | 10.9% | 31–43 |
| 1k–50k | 724 | 36.4% | 125 |
| 50k–100k | 344 | 17.3% | 114 |
| 100k–1M | 496 | 24.9% | 312 |
| 1M–5M | 71 | 3.6% | 499 |
| 5M+ | 23 | 1.2% | 608 |
| Off-Repo | 102 | 5.1% | 428 |

| 認証レベル | 件数 | 割合 | 平均 USD |
| --- | --- | --- | --- |
| Unauthenticated | 765 | 38.4% | 316 |
| Subscriber | 387 | 19.4% | 216 |
| Unauthenticated – UI Required | 108 | 5.4% | 106 |
| Author | 135 | 6.8% | 85 |
| Contributor | 549 | 27.5% | 53 |

| type（月次 top-10 表の合算） | 件数 | 平均 USD |
| --- | --- | --- |
| Improper Authentication | 9 | 1,620 |
| Unrestricted File Upload | 75 | 471 |
| Code Injection | 33 | 455 |
| Improper Privilege Management | 76 | 434 |
| Path Traversal | 86 | 361 |
| SQL Injection | 179 | 175 |
| Missing Authorization | 240 | 166 |
| XSS | 700 | 92 |

この表から次を引く。

- **帯**：100k–1M は報奨の 24.9% を占めて平均 312 USD。50k–100k は 114 USD、1k–50k は 125 USD で、帯を下げると 1 件の価値が 4 割弱に落ちる。1M–5M は 499 USD だが plugin が 68 件しかない。期待値（C 率 × 平均報酬）で比べると、100k–1M ≈ 0.34×312 ≈ 105、50k–100k ≈ 0.22×114 ≈ 25、≥1M ≈ 0.43×499 ≈ 213（T1。proxy 列 D も同じ順：156 / 96 / 262）。
- **権限**：未認証 316、Subscriber 216、Contributor 53。programme boundary を PR:N / PR:L で切る outcome C の定義と、Contributor 以上を trust 境界の内側に置く現行規則に合う。
- **class**：XSS は件数最多（700）で平均 92 USD、SQLi 175、upload 471、権限管理 434、認証 1,620（n 9）。outcome B の class 一覧は高額 type を含む。ただし高額 class を二重に数える score 変種は帯内精度を上げず（§4.5）、採らない。
- **報酬 proxy D**：記録ごとに class 平均（上表）× 認証倍率（PR:N 316/282、PR:L 216/282）を付け、窓内の C 記録で合計した。周辺表からの近似で、支払予測ではない。帯内で paying class 記録 2+ の plugin の D 平均は 540 / 705、0 の plugin は 79 / 121（T1 / T2）。提案 score の帯 top-50 は 564 / 727、現行は 295 / 366。

### 4.8 重複の側

- dup / in-scope は 2025-07 の 0.13 から 2026-03 以降 1.09 → 2.06 → 2.24 → 1.63。今は in-scope 1 件につき約 2 件が重複で落ちる。
- mirror 側：直近 365 日に記録 ≥2 の plugin（T1 893 件）の記録者数は 1 人 66、2 人 457、3 人 156、4 人以上 214。窓内の outcome C 記録（T1 1,876 件、T2 2,644 件）のうち、同じ plugin の先行記録と同じ記録者による続報は 11.5%（365 日以内の先行に限ると 10.3%）。
- 読み取り：記録者が多い plugin ほど次の記録が出る（4+ で 74〜76%）。混雑を避けると当たりも減る。選定で重複を避ける手は無く、速さで決まる。具体的には (1) mirror を毎日更新して「最終記録 ≤90 日」の信号を使える状態に保つ（≤90 日 38% vs 91–365 日 18%。鮮度が 4 日落ちるだけで ≤90 日の境目がずれる）、(2) Finding から報告までを短くする、(3) 提出前の `wbh-dedupe` で公開済みを落とす。

### 4.9 再訪の根拠

帯内 plugin の、2023-10-14 以降の記録の公開日間隔（同一 plugin、同日は 1 つ）：全記録で中央値 36 日（p25 11、p75 99）、≤90 日が 72.8%。outcome C 記録だけで中央値 42 日（p25 14、p75 114）、≤90 日が 69.7%、≤180 日が 83.6%。所有者の 18 件のうち 5 件は同じ plugin への版上昇後の再報告。

### 4.10 今の pool（2026-10-14 時点、特徴のみ）

| 帯 | N | paying class ≥1 | ≥2 | 最終記録 ≤90 日 | ≥1 かつ ≤90 日 | 記録なし |
| --- | --- | --- | --- | --- | --- | --- |
| 100k–1M | 396 | 168 | 101 | 169 | 130 | 67 |
| 50k–100k | 327 | 103 | 67 | — | — | — |
| 30k–50k | 297 | 94 | 41 | — | — | — |
| ≥1M | 68 | 36 | 19 | — | — | — |

週 5 対象・再訪なしなら、帯内の paying class ≥1 の 168 件で約 34 週分ある。

## 5. 提案

### 5.1 `selection.json` に書く数字

| 項目 | 値 | 根拠 |
| --- | --- | --- |
| `minimumActiveInstallations` / `maximumActiveInstallations` | 100,000 / 1,000,000（現行どおり） | C 率 33.6% / 39.1%（<100k の 4〜5 倍）、平均報酬 312 USD（50k–100k の 2.7 倍）、報奨の 24.9%。帯内 396 件は popular 上位 500 件で網羅 |
| `historyWindowDays` | 365 | 最終記録 >365 日の lift は 1.12 / 1.43 で base 近傍。91–365 日 2.2 / 2.3、≤90 日 4.6 / 3.2 |
| `scoreWeights.payingClass` | 1（1 件 1 点、上限 `payingClassCap: 3`） | 帯内で 0 → 21.6%、1 → 46.4%、2+ → 80.7%（T1）。単独で帯 top-50 84% / 86%。上限 2 にすると全体 top-50 が 80 → 56% |
| `scoreWeights.recordRecency` | 1（max(0, 1 − 最終 paying/非 informational 記録からの日数/365)） | 帯 top-25 を 88 → 96%、84 → 92%。paying 2+ の中でも ≤90 日 64.7% vs 91–365 日 37.2% |
| `scoreWeights.installations` | 0.5（× log10(1+install)。現行 10） | 帯内では効かない（500k–1M の lift 1.3〜1.4 を弱く反映）。帯の外へ広げたときに全体 top-50 を 72 → 92%（T2）。paying class 1 件（1 点）> install 1 桁（0.5 点）の順を保つ |
| `scoreWeights.recency`（WordPress.org 更新鮮度） | 0（現行 5） | 強い leak で採点根拠にならない。放置 plugin は `maximumUpdateAgeDays: 365` の適格条件で落とす（>365 日更新なしの C 率 0.3%） |
| `scoreWeights.history`（記録総数） | 0 | paying class 件数と重なり、帯内精度を上げない（80 vs 82%） |
| paying class の定義 | `stored-xss`、`sql-injection`、`privilege-escalation`、`authentication-bypass`、`arbitrary-file-upload`、`remote-code-execution`（to-admin 変種を含む）。権限条件は付けない | 選定の特徴としては PR を見ない方が単純で、outcome C 用に PR:N/L に絞った特徴（`outcome_c_class_365`）との差は lift 6.95 vs 6.48 で小さい |
| `maximumTargets` | 5（現行どおり） | pool 168 件で 34 週分。schema 上限も 5 |
| 再訪規則 | `revisitPolicy: version-increased` ＋ 前回 Trial から 90 日以上 | C 記録の同一 plugin 間隔 中央値 42 日、≤90 日 69.7%。所有者 5 / 18 が再報告。未公開 Finding がある対象は再訪しない（現行どおり） |
| 下限の cascade | 帯の paying class ≥1 が尽きたら、**≥1M で paying class ≥2**（今 19 件）を先に許し、その後 50k（103 件）→ 30k（94 件） | §5.4 |
| `candidateSource` | `popularPages: 10` でよい（帯は上位 500 で網羅）。50k まで下げるなら 20。`tags` は採点に無関係で、tag 由来 1,319 件はほぼ <100k | §4.4、§2 |

score は `payingClass × min(n_paying365, 3) + recordRecency × max(0, 1 − days/365) + installations × log10(1+install)`。帯内の値域は 0–3 ＋ 0–1 ＋ 2.5–3.0 で、paying class 件数が順位を決め、新しさが同点を割り、install が最後に効く。

### 5.2 期待できる数字

- 帯内 top-50 の C 精度 82% / 86%（現行 52% / 60%）。報酬 proxy 平均 1.9〜2.0 倍。
- 所有者の過去 10 件（帯内）に対して中央値 91.5 位 → 現行 104 位、top-50 が 0 → 3 件。履歴のない再報告 2 件は再訪規則の側。
- 選定で重複は避けられない（同一記録者の続報 11.5%、dup/in-scope ≈ 2）。mirror の日次更新と Finding → 報告の速さが報酬を決める。

### 5.3 ADR と正本への影響（この PR では触らない）

- ADR 0030「対象選定では公開履歴を採点しない」は、同 ADR の結果節「履歴と受理率の関係が測れた場合は別 Issue と ADR で規則を改める」に該当する。測ったのは受理率ではなく公開記録の出現率だが、所有者 21 件のうち 18 件が報告前に paying class 記録を持っていたことと合わせ、改訂の根拠として足りる。
- DEVELOPMENT 第 2 節「選定方針の構造は凍結」：`scoreWeights.payingClass` / `recordRecency` / `payingClassCap` / `historyWindowDays` と再訪の最小間隔は構造の追加。OPERATIONS 第 1 節「install 下限は runner が無人で変えない」は cascade と衝突する。2026-10-18 の所有者決定（docs/reviews/2026-10-18-operating-policy-gap-report.md §0）が優先。
- 選定が mirror を読むので、mirror の鮮度を選定の適格条件にする（例：`history-stale` reason。mirror が 2 日より古ければ選定しない）。#231 の日次更新が前提。

### 5.4 所有者の決定と食い違う点

所有者の cascade は 100k → 50k → 30k → ≥1M の順。データでは ≥1M 帯の C 率 42.6% / 44.1%、paying class ≥1 なら 72.2% / 78.9%、平均報酬 499〜608 USD で、50k–100k（21.7% / 26.9%、114 USD）より期待値が約 8 倍高い。≥1M は 68 件しかなく、`excludedAuthors`（Automattic 等）でさらに減るが、paying class ≥2 の 19 件を 50k へ下げる前に使う方が数字は良い。採否はレビューする session が決める。採らないなら所有者の順のまま、下限を下げる条件を「帯内の paying class ≥1 が尽きたとき」と定義する。

## 6. 使わなかったもの・限界

1. **install の leak**。帯は今日の install で判定した。T2（1 年前）に 100k 未満だった plugin が今 100k 以上なら帯に入っている。成長 plugin は記録も多い傾向があり、帯内の C 率を少し高く見せる。方向は変わらない（<100k 全体でも paying class 2+ の lift は同じ順）。
2. **outcome は「公開記録が出た」であり「自分に支払われた」ではない**。公開記録は Wordfence 以外（Patchstack、WPScan 等）の CVE も含む。記録が多い plugin は研究者の注目が多い plugin でもあり、重複の確率も上がる（§4.8）。
3. **報酬 proxy D** は月次報告の周辺表（type 別平均、認証レベル別平均）の積で、同時分布ではない。Improper Authentication 1,620 USD は n 9。D は順位の比較にだけ使い、金額の予測には使わない。
4. **重みは T1・T2 両方を見て手で選んだ**。格子は 12 通りで過学習の余地は小さいが、out-of-sample ではない。2026-10-14 以降の記録で半年後に再計測する（§7）。
5. 記録 309 件は複数 slug を持ち、slug ごとに数えた。`informational` 121 件は除いた。signal の無い記録 15,394 件は outcome A にだけ入る。
6. 月次報告の表は月ごとに項目名が揺れるため（例：Off-Repo は 4 か月のみ）、12 か月合算は submissions 加重の近似。
7. `requires_plugins`、方針 tag、plugin 年齢、記録者数は提案 score に入れなかった。記録者数は最強の単独特徴だが paying class 件数とほぼ同じ plugin を指し（T1 で 4+ の 216 件のうち 194 件が paying ≥1、146 件が paying 2+。T2 は 197 件のうち 181 / 162）、匿名化しても記録者を数える code を Harness に置く理由が無い。

## 7. 消し方

- この報告と `scripts/analysis/selection-statistics.py` を削除すれば元に戻る。code・方針・schema は変えていない。
- 提案を採った場合の消し方：`selection.json` の `payingClass` / `recordRecency` を 0 に戻し、`installations` を 10、`recency` を 5 に戻せば現行の順位に戻る。field 自体は optional にして残さず、ADR で止めたら schema からも消す。
- 再計測：2027-04 に cutoff 2026-10-14、窓 183 日で同じ script を回し、帯 top-50 精度が 70% を下回れば重みを見直す。

## 付録：集計 script の実行

```
python3 -I scripts/analysis/selection-statistics.py \
  --mirror <wordfence-history mirror .sqlite> \
  --wporg <query_plugins の生 JSON を置いた dir>
```

出力は集計表のみ。mirror と WordPress.org の生データは Git に入れない。
