# 「気づけば見つかる」か「推論が要る」か（2026-11-01）

> この文書は「調べて報告」の成果物で、正本ではない。正本は docs/SPEC.md と docs/adr/。
> Finding の本文、ペイロード、URL、関数名、資格情報は書かない。種類と数、Finding id の先頭 8 桁だけを書く。

## 結論

1. **Lab で成立した 20 件（Finding 42 件を同じ根で束ねたもの）は A 1 / B 11 / C 8（5% / 55% / 40%）。** 本番だけ（開発セットの TranslatePress を除く）だと 19 件で A 1 / B 11 / C 7。
2. **見逃し（他人が同じ版で見つけ、ファイルを特定できた 13 件）は、開いていない 3 / 開いたが Finding も Lead も無い 6 / Lead にはなった 4 / Finding になった 0。** 開いたのに何も残さなかった 6 件のうち 5 件は C、Lead で止まった 4 件はすべて B だった。
3. **2026 年のみ。上位ハンター 6 人の 2026 年の全記録 1,184 件（title からの推定）は A 507 / B 207 / C 464 / 不明 6（43% / 17% / 39%）。所有者自身の 32 件（すべて 2026 年）は A 15 / B 7 / C 10（47% / 22% / 31%）。** 市場の主力は A と C で、こちらが成立させた B 中心の分布とは形が違う。
4. **所有者の仮説は、見つけたものについては支持され、見逃したものについては支持されない。** 成立した 20 件の 6 割は「保存を 1 回またぐ」B で、気づけば取れる種類だった。ただし A（型で入口と sink が決まる）は 1 件だけで、B の大半は「WordPress 本体が保存した低権限者の値（コメント、表示名など）がプラグインの出力に入る」形か、「エスケープはあるが文脈や順序が違う」形だった。どちらも、型で入口と sanitizer を決める規則では落ちやすい。見逃しの側では、ファイルを開いていなかったのは 13 件中 3 件だけだった。開いたのに取れなかった 6 件は C（状態・時刻・権限・決済）が中心で、ここには推論が要る。B の 4 件は気づいて Lead にしたが、「連携先の設定次第」として Finding に上げなかったものを、他人は同じ前提のまま公開まで持っていった。
5. **設計への含意**: 機械の規則へ寄せる根拠は弱い。見逃し 13 件のうち A は 1 件で、10 件はすでに AI が開いていた。主経路は AI にソースを全部見せる仕組みのままにし、手を入れる先は (a) 開いたファイルで C を詰める深さ、(b) 「連携先や設定が前提」の B を Lead で止めない扱い、の 2 つにする。機械の規則は、AI が取りこぼした A 型（benchmark の SQLi 2 件はどちらも再発見できていない）を拾う補助に限る。

## 分類の基準

| 段 | 基準 | 例（型だけ） |
| --- | --- | --- |
| A | 入口と sink が機械の型で決まり、流れが同じ関数か 1 ファイルの中で閉じる。保存をまたがない | 要求パラメータ → SQL、要求パラメータ → 出力、shortcode 属性 → 出力（Contributor+） |
| B | sink は列挙できるが、保存を 1 回またぐ流れを追う必要がある（低権限者が保存した値が別の画面・テンプレート・別の要求で描画される） | 低権限者のコメント・表示名・フォーム値 → 管理画面や公開ページで描画 |
| C | 意味の理解が要る。認証・識別子の束縛、権限の意味、状態遷移（競合、cron による写し替え、失敗時の後始末、キャッシュ）、決済、データ形式の再解釈 | nonce が対象に束縛されていない、競合、ページキャッシュへの秘密の混入、pingback の URL 解釈の食い違い |

判定の決め事:

- 1 件の Finding が複数の段を通るときは、いちばん重い段を付ける。
- 「コメント → Latest Comments ブロック → do_shortcode」のような WordPress 本体の運び手や、既定の承認済みコメントの名前とメールを使った自動承認は、既知の型として B に含めた（保存を 1 回またぐ）。pingback の URL 解釈の食い違いを使うものは C にした。
- 保存を 2 回以上またぐもの（cron が別の保存先へ写す）は C（状態遷移）にした。
- Missing Authorization は「権限の意味」として C に入れた（問い 3 では A に寄せた場合の数も出す）。
- 問い 1 は Finding の claim / brokenProperty / sourceTrace を読んで分類した。問い 3 は title だけの**推定**である。

## 問い 1: Lab で成立したものは、見つけるのに何が要ったか

分母（所有者の指示 2026-11-01 で変更）: 次の和集合。重なりは 1 件に数え、同じ根の Finding は 1 件に束ねた。

- 人間の観測が match のもの: 台帳に `manual-observation-recorded` は 0 件。所有者が会話で match と言った 3 件（Git 外の review-notes の控え）を数えた（Anywhere Elementor の XSS と SQLi、BuddyPress）。
- 判定器があった時期の `runtime-confirmed`: Finding 32 件（開発セットの TranslatePress 12 件を含む）。
- Wordfence に提出した 11 件（台帳の `submission-recorded-externally` の Finding 18 件を報告単位で束ねた）。
- 加えて、`review decide --decision accept`（manual-alert-observed）の 2 件。どちらも上と重なる。

| 段 | 件数（根） | 比率 | Finding 件数 | うち本番 | うち Wordfence 提出 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 1 | 5% | 3 | 1 | 1 |
| B | 11 | 55% | 19 | 11 | 7 |
| C | 8 | 40% | 20 | 7 | 3 |
| 計 | 20 | 100% | 42 | 19 | 11 |

提出 11 件の内訳は A 1 / B 7 / C 3。台帳の結果記録で受理（報酬あり）の 1 件は B、Validated 後に対象外となった 3 件は B 1 / C 2、最新版で修正済みとして却下された 1 件は B。

C の 8 件の中身（型だけ）: 識別子の束縛 3（翻訳辞書の行 id、セッション cookie とキャッシュの鍵、フォームの nonce と項目一覧）、状態遷移 3（競合、cron による写し替え、ページキャッシュ）、URL 解釈の食い違い 1（pingback）、DOM の id 衝突と管理画面の返信操作 1。

B の 11 件に付いていた性質（重複あり）:

| 性質 | 件数（20 件中） |
| --- | ---: |
| 攻撃者の値の入口が WordPress 本体の保存欄（コメント本文・作者名・URL・User-Agent、表示名、再設定メール）で、プラグイン自身の入力ではない | 14 |
| エスケープや sanitizer はあるが、文脈か順序が違う（保存後のデコード、属性のクォート違い、検証した表現と出力した表現が別、`.text()` → `.html()` など） | 12 |
| エスケープが全く無い | 3 |

### 参考: 段 1b を通った 106 件（分母外）

所有者の指示で分母から外したが、指示の前に分類を済ませていたので数だけ残す。Lab で成立しなかったものを多く含む。

| 段 | Finding | 根（30） |
| --- | ---: | ---: |
| A | 2 | 1 |
| B | 78 | 21 |
| C | 26 | 8 |

## 問い 3: 上位ハンターと所有者の発見は A/B/C のどれか（2026 年のみ、title からの推定）

所有者の指示（2026-11-01）で、市場との比較は公開日 2026-01-01 以降の記録だけにした（AI を使った発見が主体の期間とみなす）。2025 年以前の記録は使っていない。mirror（`history.sqlite`、最新の公開日 2026-10-30）で、6 人の 2026 年の記録は 1,184 件あり、全件を title で分類した。

| 研究者（2026 年のみ） | 件数 | A | B | C | 不明 | C のうち Missing Authorization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ananda Dhakal | 411 | 198 | 19 | 188 | 6 | 72 |
| daroo | 289 | 126 | 99 | 64 | 0 | 27 |
| Phat RiO | 177 | 82 | 4 | 91 | 0 | 66 |
| Jakub Herman | 165 | 37 | 42 | 86 | 0 | 41 |
| dutafi | 79 | 32 | 43 | 4 | 0 | 2 |
| 0xd4rk5id3 | 63 | 32 | 0 | 31 | 0 | 13 |
| **計** | **1,184** | **507** | **207** | **464** | **6** | **221** |
| 比率 | | 43% | 17% | 39% | 1% | |
| 所有者（Yuto Hyakumoto / momopon1415、2026 年のみ） | 32 | 15 | 7 | 10 | 0 | 5 |
| 所有者の比率 | | 47% | 22% | 31% | | |

- Missing Authorization（221 件）を A に寄せると、上位ハンターは A 728 / B 207 / C 243（61% / 17% / 21%）になる。
- 未認証の stored XSS を主にする daroo・dutafi は B が 34%・54%。Jakub Herman は C（Missing Authorization と権限昇格）が 52% で、B は 25%。title に「保存後のデコード」「KSES の許可一覧の抜け」「パーサの復元」「本体の運び手（comment → render_block）」が並び、こちらの成立 20 件の B と同じ型である。
- Ananda Dhakal・Phat RiO・0xd4rk5id3 は A（Contributor+ の XSS、PHP Object Injection、SQLi、ファイル操作）と C（Missing Authorization、権限昇格、認証回避）がほぼ半々で、B はほとんど無い。
- 所有者の 32 件は A が多い（反射型 XSS 8、SQLi 5 ほか）。title が判別できない 2 件（価格の改ざん、他人のコースの並べ替え）は C に入れた。
- 推定の限界: title だけで、本文は読んでいない。「Unauthenticated Stored Cross-Site Scripting」とだけ書かれた記録（141 件）は B と置いた。Remote Code Execution、SSRF、ファイル削除は A、各種の Bypass・Takeover・登録は C と置いた。DoS と Backdoor（6 件）は不明にした。
- 直近 60 日・研究者ごと最大 25 件の標本 107 件（この版の前の集計）では A 39 / B 41 / C 26 / 不明 1 だった。2026 年全体より B が多いのは、直近の daroo と Jakub Herman が未認証の stored XSS に寄っているためである。

## benchmark の事例（repo 内の文書と公開 CVE の title から推定）

出典: docs/TRANSLATEPRESS-BENCHMARK.md、docs/evaluation/2026-10-12-rediscovery-benchmark.md、2026-10-16-prompt-v5-comparison.md、2026-10-19-v8-five-target-rediscovery.md、2026-10-26-exploration-lab-arm-v14.md。docs/reviews/2026-10-16-* には対象の記述が無かった。Git 外の資料は開いていない。

| 対象 | CVE | 推定の段 | この Harness の再発見（repo の文書の範囲） |
| --- | --- | --- | --- |
| TranslatePress 3.2.6 | CVE-2026-19632（未認証 ATO、再設定リンクの開示） | C | できた。v4・v5・v14 で同じ経路を名指しし、`runtime-confirmed` |
| TranslatePress 3.2.6 | CVE-2026-18510（未認証 stored XSS、コメント本文） | B | v5 の 1 run で同系統 3 件（`runtime-confirmed` 2）。v4 は 0 |
| TranslatePress 3.2.6 | CVE-2026-18512（Subscriber+ stored XSS、翻訳エディタ） | B | v5 では 18510 と束ねて同系統。v14 は「判定不能」（壊れる場所が違う） |
| Brizy 2.8.11 | CVE-2026-5324（未認証 stored XSS、FileUpload 欄の値） | B | できた。全 arm で候補、脆弱版で `runtime-confirmed`（修正版の対照は未成立） |
| Relevanssi 4.28.3 | CVE-2026-97641（未認証 stored XSS、コメント本文） | B | ソース上は一致（v5、v14）。実行時は未確認 |
| Smash Balloon CFF 4.13.0 | CVE-2026-93756（未認証 stored XSS、Facebook のコメント本文） | B | v14 Lab arm の 1 run で一致、Lab なしの 1 run は不一致 |
| Simply Schedule Appointments 1.6.10.0 | CVE-2026-3658（未認証 SQLi、`fields` 引数） | A | できなかった。SQLi の Finding は別の入口（別経路の SQLi は `runtime-confirmed`） |
| Unlimited Elements 2.0.16 | CVE-2026-18561（未認証 SQLi） | A | できなかった。SQLi の Finding は管理者前提の別経路 |

数: A 2（再発見 0）/ B 5（ソース上の再発見 5、うち実行時確認 2）/ C 1（再発見 1、実行時確認）。A 型の 2 件だけが取れていない。

## 問い 2: 見逃しは「見ていない」か「見たが気づかなかった」か

### 集め方

- 本番で探索した対象: 台帳の `target-selected`（本番の campaign、`prod*`・`codex-prod*`・`opus-prod*`・`production-*`・`p3-*`・`rr14-*`・`rerun-*`）のうち、`discovery-run-finished` がある slug と版。656 組。
- mirror から、同じ slug で、影響版がこちらの Snapshot の版を含み、公開日が最初の Trial の 7 日前以降のものを集めた。49 件で、公開日はすべて 2026-10-12〜2026-10-30（2026 年のみ）。
- 読んだファイル: run ごとの `read-paths`（Private Evidence）の和集合。`read-paths` の無い 2026-10-16〜17 の run と空の run は、Codex の rollout（provider-attachments の diagnostic）に出てくるコマンドの中のファイル名で代えた。この代用は「コマンドで名指ししたファイル」で、ディレクトリ全体への検索で中身を見たものは数えていない。Claude の run で transcript が無いもの（password-protected の 1 Trial、12 run）は数えていない。
- Finding と Lead: 同じ Trial の `finding-recorded`・`finding-parked`・`candidate-held`・`lead-recorded` の `sourceTrace` のファイルと、その本文が同じ仕組みを指しているかを読んで判定した。同じファイルでも別の仕組みの Lead は「無い」に数えた。
- 脆弱性が属するファイルは、mirror の title と description にある機能名・引数名・設定名で Snapshot のソースを grep して決めた。

### 49 件の内訳

| 区分 | 件数 |
| --- | ---: |
| 所有者自身の記録（こちらで見つけたもの） | 1 |
| こちらの対象範囲の外（Contributor+ / Author+ / Editor+ / 独自の管理ロール、Missing Authorization など park する impact） | 26 |
| 対象範囲の内だが、title と description が一般的でファイルを特定できない | 9 |
| **対象範囲の内で、ファイルを特定できた** | **13** |

特定できなかった 9 件のうち 1 件は、こちらが同じ対象で提出した Finding と同じ根の可能性がある（title だけでは判定できない）。

### 4 区分（ファイルを特定できた 13 件、2026 年のみ）

| 区分 | 件数 | 比率 | A | B | C |
| --- | ---: | ---: | ---: | ---: | ---: |
| 開いていない | 3 | 23% | 0 | 1 | 2 |
| 開いたが Finding も Lead も無い | 6 | 46% | 1 | 0 | 5 |
| Lead にはなった | 4 | 31% | 0 | 4 | 0 |
| Finding になった | 0 | 0% | 0 | 0 | 0 |
| 計 | 13 | 100% | 1 | 5 | 7 |

- 開いていない 3 件: キャッシュ系の HTML 圧縮の置き換え処理（時刻から予測できる置換キー）、ギャラリーの lightbox の JavaScript、寄付フォームの通貨と金額の検証規則。どれも Root が入口や主要クラスは読んだが、補助ライブラリや検証規則のファイルまで降りていなかった。
- 開いたが何も無い 6 件: 公開の登録処理で版の状態を取り違える権限昇格、ライセンス失効後に残る REST キャッシュ、時刻から予測できる圧縮の置換キー（別プラグイン）、フォーム値がメールのヘッダに入る、請求書の添付キャッシュの年次リセット、独自ロールの権限付与。A の 1 件（メールのヘッダ）を除き、状態・時刻・権限の意味が絡む C だった。
- Lead で止まった 4 件: 画像属性の組み直しで引用符が戻る、背景欄の未知の配列キー、グループ内の WYSIWYG 欄、同梱 SDK の購入完了通知。4 件とも仕組みは正しく名指ししていて、Lead の欠け（missingEdge）は「低権限者が書ける経路を本体プラグインが持たない」「連携先や設定が前提」だった。公開記録の 3 件は同じ前提（管理者が機能を有効にする、連携するテーマやプラグインが欄を公開する）を書いたまま受理されている。残る 1 件は、こちらは通知の偽装と読んで XSS としては書いていなかった。

### 読み方の注意

- 13 件は小さい。比率は傾向として読む。
- 13 件のうち 9 件は 2026-10-16〜17 の初期 Trial（当時の目的プロンプト）で、今の v14-wide 以降の結果ではない。
- 「開いた」は読んだ記録があることで、その関数まで読んだことは示さない。
- 公開日が Trial より後でも、公開記録の発見が Trial より前だった可能性はある。

## 付記: データの所在（Git 外、読み取りのみ）

- 台帳: `~/.local/state/wordpress-bounty-harness/ledger.sqlite`
- Finding・Lead・read-paths・receipt: `~/.local/state/wordpress-bounty-harness/private-evidence/`
- 初期 run の rollout: `~/.local/share/wordpress-bounty-harness/work/provider-attachments/diagnostic-*`
- Snapshot のソース: `~/.local/share/wordpress-bounty-harness/work/sources/<sourceDigest>`
- 人間の観測の控え: `~/.local/state/wordpress-bounty-harness/review-notes/owner-observations-2026-10-31.md`
- mirror: `/home/dev/wp-bounty-workspace/intelligence/history.sqlite`
- 作業用スクリプト: このセッションの scratchpad の `nr/`
