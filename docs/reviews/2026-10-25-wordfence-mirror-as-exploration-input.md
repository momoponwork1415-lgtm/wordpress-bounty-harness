# Wordfence mirror の公開事例を探索の入力にする（2026-10-25）

**問い。** 直近 1 年の公開事例（未認証または subscriber から届く SQLi・stored XSS・file/RCE・ATO・object injection）から、探索の方法を良くできるか。比較の基準は公開ハーネスではなく、WordPress プラグインのバグハンターが実際にやっていることと、Wordfence が実際に公開したものにする。

数字はローカル mirror `/home/dev/wp-bounty-workspace/intelligence/history.sqlite`（2026-10-23 21:31 UTC まで、42,842 件）から読み取り専用で集計した。期間は 2025-10-24〜2026-10-23、`informational = 0`、`software.type = 'plugin'`、研究者クレジット付きに限る。到達可能性は description の定型句（"unauthenticated attackers" / "Subscriber-level"）で、種別は title で分類した。集計スクリプトはこの session の scratchpad にあり、Git には入れない。

## 先に答え

1. **mirror は探索の入力に使ってよい。** [ADR 0012](../adr/0012-known-vulnerabilities-cutoff-and-variant-input.md) は (a) 一般的な脆弱性パターンの語彙は prompt に短く置いてよい、(b) 対象自身の公開履歴はカタログ情報まで渡してよい、(c) 答えと PoC は渡さない、と分けている。[ADR 0034](../adr/0034-harness-control-only-deletions.md) が消したのは (b) を Harness が生成する code で、ablation でしか使っていなかったからである。渡すこと自体は不変条件 1 が今も許している。
2. **市場は「少数の専業が大量に回す」形をしている。** 到達可能で Programme 内の記録は 1 年で 2,812 件、1,648 plugin、1,468 名。上位 10 名で 23%、上位 50 名で 50% を出し、1 件だけの研究者が 345 名いる。月別では 2025-11 の 218 件から 2026-10 の 742 件へ 3.4 倍に増えている。
3. **我々の Finding は XSS に偏り、SQLi・file/RCE・object injection が市場より大きく少ない。** 下の表 3 を見る。v8 の面の列挙（input parsing, charsets, file uploads, … の行）は面を等価に並べていて、事例の頻度も報酬の傾斜も入っていない。
4. **使い方は 3 つで、順番もこの順にする。** A: 探索プロンプトの着眼語彙を事例の頻度から作り直す（prompt の版上げだけ、Harness の code は変えない）。B: `sweep`（#520）の種を直近事例の機構文と修正差分から起こす（エコシステム規模の変種分析）。C: 対象自身の公開履歴の節を Harness が生成して渡す（ADR 0034 で消した経路の小さい復活。所有者判断）。
5. **やらないこと。** Harness の code に「この面を読め」「この種別を何件」の dispatch を入れない（ADR 0034、LESSONS 14）。事例の PoC・payload・再現手順は渡さない。dev-set の答えに当たる記録は時点と slug で切る。

## 1. 直近 1 年の公開事例の形

表 1. 種別 × 到達位置（研究者クレジット付き plugin 記録、Programme 内 5 種、5,475 件のうち到達可能 2,812 件）

| 種別 | 未認証 | subscriber | 合計 | 到達可能の中の割合 |
| --- | ---: | ---: | ---: | ---: |
| stored XSS | 918 | 203 | 1,121 | 40% |
| SQLi | 401 | 145 | 546 | 19% |
| file / RCE / LFI / path traversal | 364 | 140 | 504 | 18% |
| ATO / privesc / auth bypass | 374 | 125 | 499 | 18% |
| PHP object injection | 110 | 32 | 142 | 5% |

contributor 以上の stored XSS は 1,199 件あるが、本 Programme の trust 境界では内側なので数えない。

表 2. 入口の語（title と description の語で多重分類、到達可能 2,812 件）

| 入口の語 | 件数 |
| --- | ---: |
| 名前付き parameter（"via '…' parameter"） | 1,197 |
| shortcode | 639 |
| WooCommerce（order / checkout / cart） | 528 |
| user profile / registration / display name | 467 |
| upload | 443 |
| widget / block | 439 |
| booking / appointment / event / ticket | 394 |
| form submission | 393 |
| AJAX | 302 |
| login / password reset / OTP | 293 |
| post meta / custom field | 237 |
| webhook / callback / API key / token | 170 |
| REST | 132 |
| review / rating / testimonial | 125 |
| comment | 92 |
| import / export | 78 |
| search | 70 |
| SVG | 49 |
| HTTP header（User-Agent / IP header） | 26 |

description の "This is due to …" の機構文は 1,192 件にあり、大半は定型（"insufficient input sanitization and output escaping"、"insufficient escaping on the user supplied parameter and lack of sufficient preparation on the existing SQL query"）だが、ATO と object injection では個別の機構（identity を確かめずに password を更新する、OTP をサーバ側で検証しない、自分で role を付けられる、署名の無い値を decode して cookie を発行する、など）が書かれている。

同じ slug に到達可能な記録が 2 件以上ある plugin は 493、3 件以上は 225 ある。既に ADR 0037 が件数を選定の採点に使っている。

## 2. 誰が出しているか

表 3. 到達可能 Programme 内の記録数の上位（研究者名は公開クレジット）

| 研究者 | 到達可能 | 全記録 | 種別の内訳 | 対象 plugin 数 |
| --- | ---: | ---: | --- | ---: |
| daroo | 177 | 349 | XSS 93, file/RCE 30, SQLi 28, ATO 16, POI 10 | 137 |
| Nguyen Ba Khanh | 63 | 134 | XSS 41, SQLi 14, file/RCE 8 | 59 |
| dutafi | 63 | 75 | XSS 41, SQLi 13, POI 5 | 58 |
| Phat RiO | 61 | 204 | file/RCE 18, SQLi 16, ATO 14, POI 9 | 53 |
| Jakub Herman | 58 | 160 | XSS 18, SQLi 13, ATO 13, file/RCE 10 | 50 |
| Wordfence PRISM | 46 | 355 | ATO 15, XSS 13, SQLi 9, file/RCE 7 | 42 |
| Rafie Muhammad | 42 | 56 | SQLi 16, XSS 12, file/RCE 7 | 37 |
| Nabil Irawan | 42 | 342 | XSS 16, ATO 10, file/RCE 9 | 42 |
| 0xd4rk5id3 | 42 | 66 | ATO 16, file/RCE 14, SQLi 8 | 37 |
| Ananda Dhakal | 39 | 405 | XSS 18, ATO 9, file/RCE 9 | 37 |

読み取れること。

- 上位は 1 人で年に 37〜137 plugin から出している。1 plugin を数か月掘る型ではなく、多数の plugin を短く回す型が多い。
- 上位でも種別は XSS 一色ではなく、SQLi・file/RCE・ATO を 3〜5 割含む。
- 「Wordfence PRISM」は Wordfence 自身のクレジットで、全記録 355 件のうち到達可能 Programme 内が 46 件。何であるかは §4 で扱う。
- Nabil Irawan、Ananda Dhakal、Phat RiO は全記録に対して到達可能 Programme 内の比率が低い（1〜3 割）。残りは missing authorization、CSRF、contributor 以上の XSS で、本 Programme の外である。

## 3. 我々の Finding との差

表 4. 本番台帳の scope 内 Finding 198 件（2026-10-10〜10-25、parked 分を含む）と市場の到達可能記録の種別比

| 種別 | 我々の件数 | 我々の割合 | 市場の割合（表 1） |
| --- | ---: | ---: | ---: |
| stored XSS | 89 | 45% | 40% |
| sensitive-object-access（parked） | 44 | 22% | （Programme 外） |
| ATO | 18 | 9% | 18% |
| other / options-update / csrf / missing-authz（parked） | 35 | 18% | （Programme 外） |
| LFI / file write / file download | 10 | 5% | 18% |
| SQLi | 2 | 1% | 19% |
| PHP object injection | 0 | 0% | 5% |

runtime-confirmed 26 件はすべて ATO で、同じ dev-set 対象の再発見である。SQLi と file/RCE は市場で合わせて 37% を占め、Wordfence の報酬額も XSS より高いが、我々の候補は 6% しか無い。object injection は 0 件である。探索が「HTML に出るところ」へ寄り、「SQL に入るところ」「ファイル名・パス・unserialize に入るところ」へ行っていない。

## 4. バグハンターの公開手法

web 調査の全文（34 出典、研究者別）は [2026-10-25-wordpress-bug-hunter-methods.md](2026-10-25-wordpress-bug-hunter-methods.md) にある。要点は次のとおり。

- **上位 20 名のうち手法を自分で語っているのは 2 名だけ**で、他は profile と CVE のクレジットしか無い。Ananda Dhakal（Patchstack 所属）は 2026-08 に「コード解析の大半は Claude と Codex がやり、自分の仕事はモデルが誤魔化していないかを外から PoC で確かめること」と書いている。Kinorth（João Pedro Soares de Alcântara）は 2025 年の対談で、SVN から全 plugin を落とし、新規追加分だけを残し、権限を見ない AJAX hook から正規表現で当たり、確かめた 1 件ごとに正規表現を書いて全体へ当てた、と述べている（2024-10 に 275 件）。
- **Wordfence PRISM は Wordfence 自身の自律 AI 研究者**で、2026-04 ごろに始まり、種別ごとの専門 agent が「WordPress の ground truth」に沿って掃き、PoC を実行して確かめる。Wordfence はこれを breadth-first、Argus を depth-first と呼ぶ。累計 355 件、1 日 2.8 件。モデルと prompt は非公開。
- **提出の市場は 2026 年に変わった。** Wordfence では AI 支援の報告が 16% から約 66% に増え、AI 使用の申告と人手での検証を規約で求め、大量生成の提出を禁じ、未検証 PoC を幻覚として数える。Patchstack は 2026-06 から contributor 権限を範囲から外し、未検証の報告に 1 週間の停止を科す。Patchstack の月間提出は 1,124 → 2,141 件、受理率は 66.5% → 13.5%、重複は 2026-03 に 429 件で、1 件に 20 件超の重複が付いた例がある。
- **大量監査の公開例。** Austin Ginder は上位 5,000 plugin の最新版を Claude Code の 4 つの slash command（監査 → 導入して発火 → 提出 → 追跡）で回した。Muhan Luo は Semgrep と Claude で約 11,000 候補を約 1,400 に絞り、約 120 USD で 7 件を得た。TrendAI / CHT は 72 時間で 300 件超（1 件約 20 USD）を出し、人手の確認 30〜60 分 / 件が律速だと書いている。
- **共通する型。** 入口は AJAX / REST の登録点と nonce・capability の取り違えから。安い絞り込み（regex / semgrep）を前、LLM の読み取りを後、確定は実環境の再現だけ。確かめた 1 件を型にして全 plugin へ横に広げる。対象は最新版だけ。重複が最大の損失要因で、「明らかなものから先に、速く出す」が対策として語られる。提出前に公開履歴とどう照合するかを書いた人はいなかった。

本リポジトリへの含意。

- 市場の主流は「安い型 × 全 plugin × 実環境で確定」で、Harness の判定器と Lab はこの「確定」の部分をすでに持っている。足りないのは型の供給で、それが §6 の sweep の種に当たる。
- 重複が受理率を 13.5% まで下げている以上、探索の後の `wbh-dedupe` と、同じ slug の直近公開を先に見る `wbh-screen` の前倒しは、探索の改善と同じ重さを持つ。
- PRISM と Argus の breadth / depth の分け方は、#518 の wide / deep と同じ区別である。

## 5. 使い方 A: 着眼語彙を事例から作る（prompt の版上げ）

v8 の面の列挙の段落を、表 1・表 2 の頻度に沿った語彙に置き換える。要点は次の 3 つで、いずれも ADR 0012 (a) の範囲に収まる。

- 種別の並びに頻度を付ける。SQL に入る値、ファイル名・パス・include に入る値、unserialize に入る値、identity を確かめずに user を更新する経路を、HTML に出る値と同じ重さで先に挙げる。
- 入口の語を事例の頻度順にする。shortcode 属性、WooCommerce の注文・会計、profile と登録、upload、widget / block、予約・イベント、form 送信、AJAX、login / reset、post meta、webhook / token の順。
- 「設定に依存する stored XSS は 2025 年以降 63 件が受理されている」のように、受理の先例がある前提を前提として書いてよいと伝える。

書き方の規則は従来どおり。対象固有の関数名・オプション名・URL は入れない。出典対照表に mirror 集計の行（表 1・表 2 の出典として本文書）を足し、版を上げ、digest を固定する。v8 を deep の現行として残し、v8.1（または v10）を deep の次の候補にする。wide の v9-wide にも同じ段落を入れるのは、v9-wide の 3 Trial の数字が出てからにする。

測り方。同じ 3 対象で v8 と新版を 3 Trial ずつ回し、種別別の候補数、SQLi + file/RCE + POI の候補数、provider 時間当たりの候補数、Programme 外（parked）比率を比べる。

## 6. 使い方 B: `sweep` の種（#520）

直近事例から「1 パターン × 多数の plugin」の種を起こす。

- 種の元は 2 つ。(i) 機構文が個別に書かれている記録（ATO・POI・SQLi に多い）。(ii) 事例 plugin の影響版と修正版の差分。影響版は `software[].affected_versions` にあり、修正版は WordPress.org の次の tag で、どちらも `profiles/wordpress/` の取得器で機械的に取れる。差分から「何を直したか」を agent が読み、同じ形を他の plugin で探す。これは Big Sleep や Project Zero の変種分析をエコシステム規模でやることに当たる。
- 種の選び方は skill の仕事であり、Harness は種の一覧と時点と digest を記録するだけにする。
- 除外。対象 slug 自身の記録、dev-set と benchmark の slug の記録、Snapshot の時点以降の記録。PoC・再現手順は種に入れない。
- 1 sweep は wide より短い（1 パターン、1 plugin、数分）。候補は通常の Finding として受理し、同じ判定器に掛ける。

## 7. 使い方 C: 対象自身の公開履歴の節（所有者判断）

ADR 0012 (b) を小さく復活させる案。Snapshot の版より前に公開された対象 slug の記録の title・種別・影響版・公開日を、Harness が節として渡す。狙いは修正の回避と、同じパターンの別関数である。2026-10-23 の照合では、本番対象のいくつかに Snapshot の 1 つ下の版の公開があった（`reference` memo）。

残るリスクは錨付けで、ADR 0012 が書いたとおり「履歴あり / なし」で候補数と時間を比べる必要がある。ADR 0034 で消した code を戻すので、所有者の判断を要する。A と B を先にやり、C は数字を見てから決める。

## 8. 順番と Issue

1. A（prompt の版上げ）。#518 の deep の次版として起票する。dev-set 3 Trial。
2. B（sweep の種）。#520 に本文書の §6 を書き足す。skill として書く。
3. C（対象履歴の節）。所有者判断の Issue を起票し、A の数字が出るまで止める。

## 参照

- ADR 0012、0034、0037。
- `docs/reviews/2026-10-13-prompt-source-comparison.md`（出典対照表）。
- `docs/reviews/2026-10-24-wordpress-concrete-hunting-methods.md`、`2026-10-24-austin-ginder-deep-exploration-analysis.md`（公開手法の既存調査。本文書の §4 はそれに研究者別の資料を足す）。
- `~/.local/state/wordpress-bounty-harness/review-notes/precedents-2026-10-23.md`（先例照合、Git 外）。
