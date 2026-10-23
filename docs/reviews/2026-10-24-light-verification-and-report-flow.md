# 軽量な発火観測と Wordfence 報告への経路（2026-10-24 調査）

これは現行実装と次の変更案を分けた調査記録であり、判定基準の正本ではない。未公開 Finding の名前、経路、payload、HTTP 本文、画面は記載しない。

## 現状

2026-10-24 02:14 JST 時点の本番台帳の読み取り専用集計では、handoff 検証は延べ **62 attempt、`runtime-confirmed` 15、`incomplete` 47**。Finding ごとの最新 attempt は **33 件、`runtime-confirmed` 14、`incomplete` 19** で、最新 `incomplete` の内訳は precondition 11、observation 5、recipe 2、evidence 1 だった。延べ attempt と最新 Finding の分母は異なる。`incomplete` は偽の判定ではない（[SPEC.md:16-18](../SPEC.md#L16-L18)）。

現行の Stored XSS 観測では、Harness の Lab browser が被害者画面を開いた記録や screenshot を残せるが、`review export` の `observations.victim.firing: observed` は canary beacon 等を読んでいる（[verifier-record.ts:52-89](../../src/profiles/wordpress/verification/verifier-record.ts#L52-L89)、[export.ts:202-224](../../src/review/export.ts#L202-L224)）。被害者画面を訪れたが beacon が無い場合は、診断画像を残して `incomplete(observation)` にする経路がある（[judges.ts:1663-1690](../../src/profiles/wordpress/verification/judges.ts#L1663-L1690)）。画面を開いた事実やクリックを行った事実だけでは JavaScript の発火を示さない。本調査時点では、新しい軽量発火 signal の成功例を確認していない。

`runtime-confirmed` は nonce 付き canary を回収した Harness 判定器だけの結果である（[SPEC.md:15-18](../SPEC.md#L15-L18)、[verification result schema:35-89](../../src/verification/reproduction-package.ts#L35-L89)）。canary が届かなくても、観測の失敗を `contradicted` に変えない。軽量なブラウザ signal は、取得できた場合もこの判定と別に記録する。

追記（2026-10-24）: PR #497 で数値 alert を Lab browser が直接捕捉する軽量 signal を実装した。使い捨ての実 gVisor Lab で、宣言したクリック時の dialog 検出、未クリック時の非検出、被害者入力に marker を混ぜた場合の拒否を 1 回確認した。これは配線の試験であり、本番 Finding の発火・因果関係を示す数字ではない。signal があっても `verification.status` は `incomplete` のままである。

## 報告作成で止まる箇所

`review export` は `incomplete` の検証結果と被害者側の観測 path を返す（[export.ts:144-172](../../src/review/export.ts#L144-L172)、[export.ts:592-612](../../src/review/export.ts#L592-L612)）。一方、現行の `wbh-report` v6 は Wordfence の暫定版を `runtime-confirmed` に限定し、`incomplete` を拒否する（[SKILL.md:28-37](../../.claude/skills/wbh-report/SKILL.md#L28-L37)）。

CLI と Review API も `review scope`、`review draft`、`review decide --reproduced`、`lab up --for-review` を `runtime-confirmed` または `reproduced` に限定する（[CLI:1226-1230](../../src/cli/index.ts#L1226-L1230)、[CLI:1290-1304](../../src/cli/index.ts#L1290-L1304)、[CLI:1445-1451](../../src/cli/index.ts#L1445-L1451)、[CLI:1736-1751](../../src/cli/index.ts#L1736-L1751)、[Review:711-715](../../src/review/index.ts#L711-L715)、[Review:831-838](../../src/review/index.ts#L831-L838)）。現在の `reproduced` は人間の手動確認を意味しない。Harness の標準 HTTP 再現器が出す別の技術結果である（[verification result schema:47-60](../../src/verification/reproduction-package.ts#L47-L60)）。提出承認はさらに、人間の再現 `match`、人間が保存した最終文案、同じ人の最終 `accept` に結び付いている（[Review:1027-1062](../../src/review/index.ts#L1027-L1062)）。

## 推奨する最小経路

1. Harness 所有の被害者ブラウザが実際のコード実行を直接観測した場合、その根拠と被害者ロール、Snapshot digest、検証 ID を Private Evidence に保存し、`review export` に **canary 回収とは別名の signal** として出す。画面中の文字列の存在、ページ訪問、クリック、Verifier の自己申告を signal にしない。判定結果は canary の条件を満たさなければ `incomplete` のままにする。
2. `wbh-report` にこの signal から書く「内部作業版」を設ける。観測した発火、Harness 捕捉 HTTP、固定 source で裏付けられる記述だけを英語 Markdown にし、人間の再現・影響・最新版・重複・scope の未確認点を明示する。必要なフォーム値 16 件を根拠で満たせる場合だけ、同じ Private Evidence に `wordfence-fill-only/3` JSON を作り、`human_verification.status` を `pending` にする。値を補完して JSON を完成させない（[wbh-report:173-198](../../.claude/skills/wbh-report/SKILL.md#L173-L198)）。
3. この内部作業版は `review draft` に登録せず、`submission-package/v1` manifest と Submission Candidate を作らない。既存の Fill-Only 契約では `pending` JSON は確認表示だけでフォーム入力を拒否する（[wordfence-fill-only-v3.md:38-43](../../src/profiles/wordpress/policy/wordfence-fill-only-v3.md#L38-L43)）。動画は実在するときだけ添付候補にする。

この経路は人間が確認しやすい資料を早く作るためのもので、提出可能という判定ではない。現行の `lab up --for-review` は確認済みの再現パッケージが無い `incomplete` では起動できない。canary なしの候補を人間の手動再現から正式な scope 評価、文案保存、提出承認へ進めるなら、封印した Lab setup からの手動確認用 Lab、人間の再現結果を結ぶ独立した basis、scope facts と承認 gate を別途設計する必要がある。`runtime-confirmed` の意味と外部送信の承認条件は維持する（[SPEC.md:16-21](../SPEC.md#L16-L21)）。

`review reverify` には、`incomplete` の Finding を別 Snapshot の最新版へそのまま移す経路がない。元 Finding の証拠を別版の証拠として流用しないための gate である。最新版の軽量観測を得るには、別 Snapshot と新しい攻撃要求・被害者観測を用意し、その結果を元 Finding の正式な再検証とは区別する必要がある。

この調査を受けて `wbh-report` を v7 に上げ、旧 v6 を保存し、[Review README](../../src/review/README.md) と [OPERATIONS 第 3 節](../OPERATIONS.md) に内部プレビューと登録する暫定文案の区別を記した。人間の手動再現を正式な提出経路へ結ぶ Review API は別の設計課題として残る。
