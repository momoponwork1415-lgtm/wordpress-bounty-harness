# 探索の網羅性と対象範囲文の見直し計画（prompt v6 の準備、2026-10-17）

調べて報告。正本ではない。**この文書は prompt 本文を書かない。** 所有者の「検索を徹底的にしてみるべき」（2026-10-17）を受けて、何を変えるか、どの出典から採るか、どう測るかをまとめる。本文は第 4 節の対照表で採った行だけから所有者（または委任を受けた AI）が組み、`owner-approved` が付くまで `src/profiles/wordpress/prompts/` に入れない（DEVELOPMENT.md 第 5 節）。

## 0. 結論

1. 本番 2026-10-16〜17 の 111 Trial（完了分）は Root wall 中央値 7 分、最長 20 分で、60 分の上限に届いた Trial は 0。候補は長い Trial ほど多く、対象範囲内 Finding 4 件はすべて 8 分以上の Trial から出た。探索は浅い。
2. 候補 46 件のうち 37 件が sensitive-object-access。agent に渡している Programme Boundary 文（campaign.json、`wordfence-2026-10-08`）が「sensitive information disclosure は対象内」と書いており、2026-10-17 に出口で park すると決めた判断と食い違っている。v1.7 にあった「落とす種類」「弱い形」の段は v5 で外した。
3. 対象範囲内 Finding 4 件はすべて `incomplete(precondition)`。これは prompt では解けず、Lab 側（#244、ADR 0026 の型付き手順）の課題。
4. 提案: (a) Programme Boundary 文を 2026-10-17 の判断に合わせる、(b) v6 で v1.7 の種類の規律を戻す、(c) 入口索引の全項目を `observed` / `blocked` にすることを Root の終了条件にし、wall 上限を広げる。(c) は ADR 0029 の改訂を要する。
5. 測定は開発セット 3 対象 × 3 Trial と、本番で候補が出た 10 対象の再実行。v5 の既存結果と並べて、候補の種類・wall・token を比べる。TranslatePress 3.2.6 の ATO と stored-xss が消えないことを merge 条件にする。

## 1. 症状（本番 prod-20261016-1 〜 prod-20261017-5、2026-10-17 02:00Z 時点）

| 項目 | 値 |
|---|---|
| batch / 選定対象 / 探索 Trial | 26 / 130 / 115（完了 111） |
| Lab 失敗 / provider 拒否 / run-failed | 15 / 4 / 1 |
| 対象範囲内 Finding（review queue） | 4（ultimate-addons-for-gutenberg 2、smart-slider-3 2） |
| parked | 42（sensitive-object-access 36、other 4、privesc-to-contributor+ 2） |
| Lead | 394 |
| runtime-confirmed | 0 |

Root wall と候補の関係:

| Root wall | Trial | 子 agent 平均 | Lead 平均 | Finding | parked |
|---|---|---|---|---|---|
| 0〜5 分 | 7 | 2.1 | 2.7 | 0 | 0 |
| 5〜8 分 | 62 | 2.6 | 3.1 | 0 | 10 |
| 8〜12 分 | 36 | 2.7 | 4.2 | 2 | 27 |
| 12〜20 分 | 6 | 2.7 | 5.0 | 2 | 5 |

大きい plugin ほど長く走る相関を含むので因果ではない。ただし「時間を与えても候補は増えない」という証拠は無い。開発セット（docs/evaluation/2026-10-16-prompt-v5-comparison.md）でも v5 の Root は 4〜11 分で、v1.7 arm より短い。

対象範囲内 Finding 4 件の検証はすべて `incomplete(precondition)`。前提は「管理者が特定の block / slider 設定を公開している」で、Lab の既定状態には無い。Verifier は source 上の成立を確認するところまでで止まっている。

## 2. 原因の切り分け

| 症状 | 原因の所在 | 根拠 |
|---|---|---|
| 候補が情報露出に偏る | agent に渡る文章（Programme Boundary 文、v5 本文） | campaign.json の文が sensitive information disclosure を対象内に置く。v5 は v1.7 の「落とす種類」（v1.7 第 23 行）と「弱い形」（第 21 行）を外した（docs/reviews/2026-10-16-wp2shell-bounty-v5-draft.md「外したもの」） |
| 探索が浅い | agent に渡る文章と ADR 0029 | v5 に最低時間も網羅条件も無い。ADR 0029 は「最低実行時間を強制しない」「全入口の処理を正常終了の条件にしない」 |
| 確定 0 | Lab の前提 | 4 件とも `incomplete(precondition)`。#244、ADR 0026 |

## 3. Programme Boundary 文の変更点（campaign.json、所有者が本文を書く）

版を `wordfence-2026-10-17` に上げ、旧版の文は台帳照合のため docs に残す。変更点:

- 対象内から **sensitive information disclosure を外す**（2026-10-17 の所有者決定、ADR 0032 同日節）。
- 対象内に **arbitrary file read / download / delete、LFI / RFI、directory traversal** を加える（programme-scope.md「その他」の列。現行文に無い）。
- 対象外に **非公開 / 下書き / パスワード保護コンテンツの閲覧、基本的な情報露出、管理者が明示的に設定または権限付与することを前提とする経路、非管理者への権限昇格 / 認証回避、任意コンテンツ削除、options 更新** を明記する（programme-scope.md「明示的に対象外の種別」と 2026-10-17 の park 決定）。
- 攻撃者の立場（未認証、subscriber、customer）と Contributor 以上の除外は現行どおり。

この文は `programme-impacts.ts` の除外一覧と一致していること（2026-10-17 の 10 分類）を PR で確認する。

## 4. v6 の出典対照表

採否列は空欄。所有者（または第 5 節の委任を受けた AI）が埋め、採った行だけで本文を組む。出典に無い要素は足さない。

| # | 要素 | 出典 | 備考 | 採否 |
|---|---|---|---|---|
| 1 | v5 本文の全段（第一原理、CVE 記憶・差分の禁止、false negative の扱い、攻撃者が制御するデータ、core source を読む、複数 agent の指針、記録条件、検索の健全性、対象内文章の不信、0 件は正常） | `wp2shell-bounty-v5.md` 全文 | v5 draft の対照表（2026-10-16）で出典済み | |
| 2 | 削除と秘密の露出は、それ自体では受理種類でない。先の種類へ続くときだけ、その種類として記録する | v1.7 第 19 行 | 2026-10-17 の park 決定と一致 | |
| 3 | 「弱い形」の判定: stored XSS の書き込み点は未認証か既定登録 role、self-XSS は含まない、描画場所と見る主体を記録する | v1.7 第 21 行（前半） | Programme Boundary 文と重複しない範囲で | |
| 4 | 「弱い形」の判定: 任意ファイル系は path と拡張子の両方の制御を明示する | v1.7 第 21 行（中） | | |
| 5 | 「弱い形」の判定: options 更新は値が権限・実行コード・削除・秘密を決めるものだけ | v1.7 第 21 行（後半） | 2026-10-17 に options-update を park したので、入れるなら「対象外だが先へ続く場合」の文脈に限る | |
| 6 | 落とす種類の一覧と「そこに agent を使わない」 | v1.7 第 23 行 | programme-scope.md の対象外一覧と重複する項目は Programme Boundary 文へ寄せ、本文には「対象外の種類に agent を使わず、そこで終わる chain は落とす」の規則だけ残す案もある | |
| 7 | 未認証経路があれば未認証を取る。Contributor 以上で始まる経路は Lead でない | v1.7 第 15 行 | trust 境界の節と重複。重複を許すか | |
| 8 | 入口索引の全項目を registry で `observed` か `blocked` にするまで Root は閉じない | 所有者の指示 2026-10-17「検索を徹底的に」＋ ADR 0029 の入口索引（カタログとして既に渡している） | **新規要素。** ADR 0029 の改訂が前提（第 5 節） | |
| 9 | 最低時間（v1.7 は 45 分） | v1.7 第 53 行 | 所有者が 2026-10-16 に「信憑性が無い」として外した。#8 を採るなら不要の可能性 | |
| 10 | 十分に裏付けられた弱い経路が、裏付けのない強い経路に勝つ | v1.7 第 43 行 | v5 の「迷ったら穴を書いて記録」と両立させる書き方が要る | |

v1.7 の行番号は `src/profiles/wordpress/prompts/wp2shell-whitebox-v1.7.md`（digest は prompt 登録で固定済み）。

## 5. ADR 0029 の改訂案

ADR 0029 に 2026-10-17 の節を追記する（既存本文は残す）。

- **入口索引の扱い**: 「全入口の処理を正常終了の条件にしない」を改め、Root は索引の全項目を `observed` か `blocked` として registry に記録してから閉じる。索引は引き続き経路や子の分担を指示しない。索引が `incomplete`（source が大きく走査が切れた）なら、その事実を記録して終了条件から外す。
- **最低実行時間**: 置かない方針は維持する。網羅条件が時間の下限の役を果たす。
- **wall 上限**: 60 分から 120 分に広げる。wall 到達は従来どおり理由付き `incomplete`。索引の項目数に応じた可変上限は、まず 120 分固定で測ってから検討する。
- **比較分母**: 網羅条件あり（v6）と無し（v5）の Trial を同じ分母に混ぜない。
- **理由**: 本番 111 Trial で wall 中央値 7 分、上限到達 0、長い Trial ほど候補が多い（第 1 節）。「索引はカタログであり網羅を強制する根拠がない」とした 2026-10-11 時点の判断は、索引なし arm との比較で索引が原因でないことが分かった後（docs/evaluation/2026-10-16-prompt-v5-comparison.md）も、網羅を終了条件にした arm を一度も測っていない。

ADR の変更は所有者本人の `owner-approved` が要る（DEVELOPMENT.md 第 5 節）。

## 6. 測定計画

| arm | prompt | Programme Boundary | wall | 対象 |
|---|---|---|---|---|
| A（基準） | v5 | 2026-10-08 版 | 60 分 | 既存の結果を使う（開発セット: docs/evaluation/2026-10-16-prompt-v5-comparison.md、本番: 第 1 節） |
| B | v5 | 2026-10-17 版 | 60 分 | 開発セット 3 対象 × 3 Trial |
| C | v6 | 2026-10-17 版 | 120 分 | 開発セット 3 対象 × 3 Trial ＋ 本番で候補が出た 10 対象 × 1 Trial |

開発セット: TranslatePress 3.2.6、Relevanssi 4.28.3、Brizy 2.8.11（既存 state dir と Snapshot を使う）。本番 10 対象: the-events-calendar、popup-maker、members、pojo-accessibility、speedycache、smart-slider-3、ultimate-addons-for-gutenberg、formidable、breeze、wp-google-maps（候補が出た plugin のうち parked 数の多い順と対象範囲内 Finding の出た 2 件）。

記録する数字: completed / incomplete の理由、Finding と Lead の件数と impact 分類、parked 件数、Root wall 中央値と最大、索引項目の observed / blocked 比率、noncache token、検証結果（runtime-confirmed / incomplete の理由）。

merge 条件: C で TranslatePress 3.2.6 の ATO と stored-xss 候補が 3 Trial 中 2 以上で出ること、sensitive-object-access の候補が A より減ること、wall 到達による `incomplete` が 3 対象で 1 件以下であること。満たさなければ v5 のまま、理由を docs/evaluation に残す。

## 7. 費用と運用

- 現在: 1 Trial 50〜100 万 noncache token、batch 5 対象で約 20 分、1 日約 300 対象。
- C の見込み: token 3〜5 倍、batch 60〜90 分、1 日約 100 対象。収率 0 の対象数に意味は無いので許容する。
- 本番 runner は測定中も v5 で続ける。既定の切替は測定結果の PR で行い、prod checkout を切り替える（docs/OPERATIONS.md）。

## 8. 手順

1. この文書を PR で merge する（docs のみ、`owner-approved` 不要）。
2. 所有者が第 3 節の Programme Boundary 文と、第 4 節の採否と v6 本文を書く。v6 本文と日本語訳、新しい Programme Boundary 文を PR 本文に貼る。prompt 登録（`prompts/index.ts` の ID 追加、v5 を残す）と ADR 0029 の追記を同じ PR に入れる。所有者本人が `owner-approved` を付ける（campaign.json と ADR が含まれるため）。
3. AI が第 6 節の B・C を走らせ、数字を PR comment と docs/evaluation に置く。
4. 条件を満たせば campaign.json の既定を v6 にし、prod checkout を切り替える。

## 9. この文書に書けなかったこと

- v6 の本文そのもの。AI がここで書こうとしたところで出力が止められたため、出典対照表までに留めた。本文は所有者が第 4 節の行から組む。
- Lab 前提の解決（#244、ADR 0026 の型付き手順で Finding の `configurationPrecondition` を Lab に適用する案）。prompt と独立した課題なので別文書にする。
