# Review の提出前手順

`Review` は `runtime-confirmed` と `reproduced` の再現パッケージを参照し、programme ごとの scope 評価、版付きの文案、外部行動の承認を台帳に記録する。文案本文と判断に使った資料は Git 外の Private Evidence に置き、台帳には digest 参照だけを残す。`admitExternalAction` は完全一致の承認を照会するだけで、報告や連絡を送信しない。

重複候補の比較、提出規則の文脈の解釈、提出先の提案は `wbh-dedupe`・`wbh-destination`、報告文と添付一覧の作成は `wbh-report` が受け持つ。Harness は形式と明示条件の照合、根拠・判断者・時点の保存、文案の版と承認対象の対応を保証する。最終査読、対象範囲や権限の拡張、外部送信の承認と実行は人間が行う。CLI は記録と照会の入口とし、解釈や執筆を重複実装しない。

現在の一覧と理由表示には、現在の検証 ID・Snapshot digest に対応する最後の判断を使う。後から古い検証への判断を追記しても、現在の表示を上書きしない。`review export` の判断は履歴上の最後の記録を保つため、現在の一覧とは異なる場合がある。単件の資料は台帳の参照で絞ってから読む。古い非標準 identity の scope 評価を ID で探すときだけ、互換性のため従来の全件読取りに戻る。

`review --campaign <id>` は証拠付きの候補と、対象範囲内の `incomplete` を全件個別に表示する（#185、ADR 0031）。あわせて `incomplete` の最新 1 件を Finding ごとに、runner がまだ自動再試行する `retry candidates by reason` と、再試行が尽きて人間の手に渡る `incomplete by reason` に分けて数える。この分け方は runner（`src/cli/pipeline.ts`）と同じ関数 `shouldAutomaticallyRetryVerification`（`src/verification/retry-budget.ts`、ADR 0022）で決め、attempt は Lab Setup digest・Verifier prompt 版・理由が同じものだけを数える。`recipe` は 3 回目、`provision`・`provider` は 2 回目から尽きた側に入る。`precondition`・`observation`・`awaiting-human-observation`・`evidence`・`cleanup`・`digest-mismatch`・`no-judge`・`sandbox` は 1 回目から尽きた側（`precondition` は Lab シナリオが変わったときだけ再試行していたが、シナリオは #353 で消した。`observation` の自動再試行は判定器とともに 2026-10-25 に止めた。ADR 0040）。再試行の実行そのものはこの列では行わない。

当面は Wordfence 向けに、AI 操作役が `review export --campaign <id> --finding <id>` の参照を読み、screen、skill による検証、重複照合、最新版での再検証、scope 評価、提出先選択、英語の暫定文案までを順に進める（SPEC §3、ADR 0038）。Patchstack 向けの追加自動化は報告が増えてから扱う。6 段を起動・引き継ぐ自動 orchestrator はまだ無い。AI 操作役は所有者に代わって中間記録を実行するが、各 skill の判断方法は変えない。旧運用を記す skill 本文の版更新は別 PR で行う。AI の中間判断は `review decide --by ai` として記録し、`--minutes` を付けて人間の作業時間に混ぜない。`incomplete` や根拠のない重複・scope 判定を提出可能な文案として扱わない。`incomplete(observation)` に攻撃要求との marker 一致と順序、別の被害者での Lab browser dialog 観測がある場合、`wbh-report` v7 は因果関係の確認待ちの内部プレビューだけを Private Evidence に作れる。各 skill と CLI の操作順は [OPERATIONS 第 3 節](../../docs/OPERATIONS.md)にある。

1. `review reverify --campaign <id> --finding <id> --config <path>` で、対象の最新版を新しい Target Snapshot に固定し、同じ Finding を新しい Lab で再検証する。
   - 旧 digest の検証結果を最新版の証拠として流用しない。
   - 新しい Snapshot では派生 Finding ID が作られ、CLI の `as <findingId>` に出る。同じ Snapshot なら元 ID のままになる。結果は `basis: latest-version` 付きの検証として台帳に残る。scope 評価が「最新版で成立」とみなすのは、この検証が `runtime-confirmed` または `reproduced` のときだけ。
   - 元 Finding の暫定 `accept` と重複結果は派生 ID に継承されない。以後は出力された ID を使い、最新版の証拠でレビュー列の判断をやり直す。元 Finding の文案は、派生 ID ができた時点で承認できない。
2. 出力された Finding ID で `review export`、`wbh-review`、`wbh-dedupe` を再実行する。受理案と重複 `no-match` が揃ったら同じ ID に AI の暫定 `accept` を記録し、`review scope` と `wbh-destination` を行う。`src/profiles/wordpress/policy/programme-scope.md` の観測日と Wordfence の公式規則を照合し、差分や矛盾があれば方針を更新する。scope が `ambiguous`、重複が `unavailable` / `possible-match` なら暫定文案には進めない。照合の記録は下の「重複照合の記録」に従う。
3. 今回の Wordfence 向け `wbh-report` は、出力された Finding ID に判定器が `runtime-confirmed` とした証拠から、英語 Markdown の暫定文案、`wordfence-fill-only/3` のフォーム入力用 JSON、添付一覧、`submission-package/v1` manifest を Git 外の Private Evidence に作る。Markdown に JSON の digest を結び付け、同じ ID の `review draft --programme wordfence --prepared-by ai` は文案版の digest を記録する。Review API は `reproduced` も人間の手動再現前に暫定 draft として保存できるが、今回の Wordfence skill は対象にしない。暫定文案には未観測の手順や結果を補わない。

`incomplete(observation)` の内部プレビューはこの 3 の正式な暫定文案に含めない。観測 signal と Snapshot / Lab Setup、攻撃要求との marker 一致と順序を照合した英語 Markdown、必須値が揃う場合だけ `pending` の Fill-Only JSON を Private Evidence に作れる。因果関係と既存コンテンツ由来かどうかは人間の確認待ちとする。`review draft` と manifest は作らず、scope assessment や提出用の人間の再現が済んだと扱わない。captured numeric-dialog の現在の `incomplete(observation)` は `lab up --for-review` で新しい Lab を開き、`review observe` で手動観測を別に記録できる。

`review observe --by` は本人認証ではなく人間の記名申告である。`--ordinary-site yes|no --ordinary-site-reason <text>` は、確かめた構成が通常の公開サイトの構成かの観測者の申告で、人間の観測の basis では scope の `defaultOrCommonSettings` になる（#578、ADR 0040 の 2026-10-26 追記 2）。指定された証拠ファイルは観測資料として保存するが、因果関係の自動証明にも `runtime-confirmed` にもならず、提出承認の条件を満たさない。

### `incomplete(observation)` の手動観測

captured numeric-dialog の Finding で `lab up --for-review --campaign <id> --finding <id>` を実行すると、Lab の ready 後に `manual observation receipt: <digest> (<path>)` を表示する。人間がその新しい Lab で手順を実行し、観測内容をローカルファイルに残した後、`review observe --campaign <id> --finding <id> --receipt <digest> --result match|mismatch|unavailable --evidence <path> --by <human>` で記録する。ready receipt と人間の証拠は Git 外の Private Evidence に封印し、台帳には digest のみを追記する。同じ検証でも次の Lab が ready になれば前の結果は現在の表示から外れ、古い receipt での追記を拒む。別の検証試行や最新版の派生 Finding ができた場合も旧記録は現在の表示から外れる。`review --campaign <id>` は現在の手動結果と証拠の可用性を表示する。既存の `review export` は厳密な `review-export/v1` のままなので、手動結果を含む資料には `review export --campaign <id> --finding <id> --version 2` を使う。これは判定器の `runtime-confirmed`、`review decide --reproduced`、scope、文案、提出承認を代えない。

### runtime-confirmed / reproduced の既存提出経路

以下は確認済み再現パッケージを持つ Finding の提出前手順である。`incomplete(observation)` の手動観測だけでは進めない。

1. 最新版再検証の出力 `as <findingId>` を使って `review export` で再現パッケージを開く。同じ ID の `lab up --for-review --campaign <id> --finding <id>` は封印済み setup manifest と Snapshot から新しい Lab を立て、手動クライアントの起動コマンドを表示する。遠隔攻撃者の視点の HTTP リクエストとブラウザ操作で自分の手で再現し、同じ ID の `review decide ... --decision defer --reason pending-final-review --reproduced match|mismatch|unavailable --by <name>` で結果を記録する。`mismatch` / `unavailable` なら提出を進めず、原因を調べる。
2. 暫定文案の手順、影響、版、提出先、フォーム欄と添付を査読し、Markdown、JSON、manifest を最終版に作り直す。確認した提出用 Markdown を `review draft --prepared-by human` で最終版として新たに保存する。内容を変えなくてもこの版の記録が必要である。その後、同じ人が `review decide --decision accept --reason reviewed-report --by <name>` で最終査読を記録する。
3. 最新の手動再現が同じ検証 ID と再現パッケージ digest で `match`、最新の文案が人間の確定版で、最終版より後の最後の判断が同じ人の `accept` のときだけ、正確な Submission Candidate・文案 digest・送信先に結び付けて `review authorize --by <同じ名前>` で承認する。後続の検証や同じ Finding の最新版再検証があれば、旧文案の承認と提出を止める。`admitExternalAction` もこれを再確認する。実際の Wordfence への提出は人間が画面で行う。

scope 評価の事実は、判定器の観測条件、選定記録（`target-selection.json`）、最新版での再検証の有無、検証 Lab と版固定された通常利用 scenario の一致から作る。Verifier の `defaultSettings` 自己申告は設定範囲の判定に使わない。scenario の記録が欠ける・一致しない場合は設定範囲を `ambiguous` とし、確認済みの技術的記録を変更しない。scope 評価自体の障害は scope の `incomplete` である。候補と文案は `in-scope` の評価からだけ作る。後で文案を改訂した場合、旧版の承認では新しい候補を admit しない。

`review decide`（`--reproduced` のときは再現の分数も）、提出・転帰記録では終了時に実作業の分数を尋ねる。`ledger funnel --campaign <id>` は台帳に追記された分数、開いた Finding 数、手動再現の一致率を campaign と分類ごとに集計する。分母がない指標は `unavailable` と表示する。

## `review export`（#186）

Claude Code の skill が読むのは `review export --campaign <id> --finding <id>` の JSON 1 本（`schema: review-export/v1`、`src/review/export.ts`）だけで、台帳の event schema には依存しない（ADR 0031）。中身は Finding の claim / attackerPosition / brokenProperty / impact、HTTP の method / path / status 行、反証メモ、検証 Lab の実行前後差分の要約、探索した版と台帳が知る最新版、install 数、Private Evidence の path。候補本文、payload、HTTP 本文、設定値は path と digest でだけ参照する。

`review.humanReproduction` は現行の検証 ID・Snapshot・再現パッケージ digest に一致する最後の手動結果だけを示す。後続の検証試行や同じ系統の最新版 Finding ができた場合は `null` とし、古い手動結果は追記専用の台帳に残す。`minutes` はその手動結果の直後に作業時間が記録された場合だけ表示する。

実行前後差分は `Verification` の `LabStateObserver` が Verifier の実行前後に取り、before / after / diff を Private Evidence に置いて `verification-finished` の `artifacts`（`lab-state-before` / `lab-state-after` / `lab-state-diff`）と `labStateDiff` に digest で残す。取得失敗は `labStateDiff: { status: "missing", reason }` として記録し、検証結果は変えない。差分は Verifier にも判定器にも渡さない。profile が差分ファイルを汎用の `StateDiffSummary`（settings / principals / tables）に要約して export に渡す。


## 検証の前の判断（#436、ADR 0038 の段 1）

- `review --campaign <id>` は、検証がまだ無い Finding も `not-verified` の項目として出す。`unverified` の件数は変えない。
- `review decide` は `not-verified` の項目にも記録できる。判断の記録の `ref` は検証 ID を持たず、`verificationStatus` は `not-verified` になる。`elapsedMs` は Finding の記録の時刻から数える。前からの記録はそのまま読める。`--reproduced` は付けられない。
- 規則の写しに照らす検証前の Wordfence 候補選別は skill `wbh-screen` v3 が行い、Review は値を判断しない。`採用` / `非採用` は検証投資の判断であり、技術的な真偽や programme 全体の scope ではない。`非採用` から `--decision reject` を自動記録しない。旧 v2.x の `提出不可` に基づく既存の review decision は履歴として残す。
- 最新の判断が `reject` の Finding は、handoff 列（`verify next`）に並ばない。`--finding` で名指ししたときだけ検証する。
- `review --campaign <id>` の `decision:` の行は、記録が読めれば理由のコードも出す（例: `decision: reject (out-of-scope)`）。

## 重複照合の記録（#442、ADR 0038 の段 4）

- 照合は skill `wbh-dedupe` が行い、所有者が `review decide --duplicate no-match|unavailable[:<理由>]|possible-match:<参照> --duplicate-note <path>` で結果を記録する。
- Review は結果を判断せず、値、記録した時刻、skill のメモ（Private Evidence の `dedupe-note.md`）の digest を判断の記録に残す。
- `--duplicate` を付けない後の判断（再現の記録など）は、記録済みの結果を引き継ぐ。一度も記録していない判断は `unavailable` を持ち、`checkedAt` は null になる。
- `review export` は、結果を `review.decision.duplicate`（1 本の文字列）と `review.duplicate`（参照、理由、時刻、メモの path と digest）に出す。`review --campaign <id>` も Finding ごとに `duplicate:` の行を出す。
- 提出前の**登録する暫定文案**（`wbh-report`）に進むのは、AI の中間判断が `accept`、`review.decision.duplicate` が `no-match`、Wordfence の scope が `in-scope` の Finding だけである。この `accept` は人間の最終査読を代えない。人間の再現 `match` は、最終文案の承認に必要である。内部プレビューは提出候補として登録しない。
- `possible-match` は照合先を残して所有者が最終判断し、`unavailable` は落とさずに再照合を待つ。
