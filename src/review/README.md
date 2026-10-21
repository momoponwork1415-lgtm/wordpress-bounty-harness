# Review の提出前手順

`Review` は `runtime-confirmed` と `reproduced` の再現パッケージを参照し、programme ごとの scope 評価、版付きの文案、外部行動の承認を台帳に記録する。文案本文と判断に使った資料は Git 外の Private Evidence に置き、台帳には digest 参照だけを残す。`admitExternalAction` は完全一致の承認を照会するだけで、報告や連絡を送信しない。

`review --campaign <id>` は証拠付きの候補と、対象範囲内の `incomplete` を全件個別に表示する（#185、ADR 0031）。あわせて `incomplete` の最新 1 件を Finding ごとに、runner がまだ自動再試行する `retry candidates by reason` と、再試行が尽きて人間の手に渡る `incomplete by reason` に分けて数える。この分け方は runner（`src/cli/pipeline.ts`）と同じ関数 `shouldAutomaticallyRetryVerification`（`src/verification/retry-budget.ts`、ADR 0022）で決め、attempt は Lab Setup digest・Verifier prompt 版・理由が同じものだけを数える。`recipe`・`observation` は 3 回目、`provision`・`provider` は 2 回目から尽きた側に入る。`precondition` は scenario ID が変わったときだけ runner が再試行するが、review 列は Lab Setup を持たず変化を予測できないので常に尽きた側に数える。`evidence`・`cleanup`・`digest-mismatch`・`no-judge`・`sandbox` は 1 回目から尽きた側。再試行の実行そのものはこの列では行わない。

提出前には人間が次を行う。

1. `review export --campaign <id> --finding <id>` で再現パッケージの参照を読む。`lab up --for-review --campaign <id> --finding <id>` は封印済み setup manifest と Snapshot から新しい Lab を立て、手動クライアントの起動コマンドを表示する。遠隔攻撃者の視点の HTTP リクエストとブラウザ操作で自分の手で再現し、`review decide ... --reproduced match|mismatch|unavailable` で判断と同時に結果を残す。`reproduced` の文案は `match` の記録後にだけ作れる。
2. `review reverify --campaign <id> --finding <id> --config <path>` で、対象の最新版を新しい Target Snapshot に固定し、同じ Finding を新しい Lab で再検証する。
   - 旧 digest の検証結果を最新版の証拠として流用しない。
   - 結果は `basis: latest-version` 付きの検証として台帳に残る。scope 評価が「最新版で成立」とみなすのは、この検証が `runtime-confirmed` または `reproduced` のときだけ。
   - 再検証の後は、レビュー列の判断をやり直す。
3. `src/profiles/wordpress/policy/programme-scope.md` の観測日と Wordfence / Patchstack の公式規則を照合する。差分や矛盾があれば方針を更新し、`ambiguous` として人間の判断に回す。
4. 重複照合（#12 のローカル Wordfence 履歴DB）、影響、意図された動作かどうかを判断する。照合が unavailable のときは結果を推定しない。照合の記録は下の「重複照合の記録」に従う。
5. 正確な Submission Candidate、文案の版 digest、送信先に結び付けて人間が承認する。実際の提出は人間が各プログラムの画面で行う。

scope 評価の事実は、判定器の観測条件、選定記録（`target-selection.json`）、最新版での再検証の有無、検証 Lab と版固定された通常利用 scenario の一致から作る。Verifier の `defaultSettings` 自己申告は設定範囲の判定に使わない。scenario の記録が欠ける・一致しない場合は設定範囲を `ambiguous` とし、確認済みの技術的記録を変更しない。scope 評価自体の障害は scope の `incomplete` である。候補と文案は `in-scope` の評価からだけ作る。後で文案を改訂した場合、旧版の承認では新しい候補を admit しない。

`review decide`（`--reproduced` のときは再現の分数も）、提出・転帰記録では終了時に実作業の分数を尋ねる。`ledger funnel --campaign <id>` は台帳に追記された分数、開いた Finding 数、手動再現の一致率を campaign と分類ごとに集計する。分母がない指標は `unavailable` と表示する。

## `review export`（#186）

Claude Code の skill が読むのは `review export --campaign <id> --finding <id>` の JSON 1 本（`schema: review-export/v1`、`src/review/export.ts`）だけで、台帳の event schema には依存しない（ADR 0031）。中身は Finding の claim / attackerPosition / brokenProperty / impact、HTTP の method / path / status 行、反証メモ、検証 Lab の実行前後差分の要約、探索した版と台帳が知る最新版、install 数、Private Evidence の path。候補本文、payload、HTTP 本文、設定値は path と digest でだけ参照する。

実行前後差分は `Verification` の `LabStateObserver` が Verifier の実行前後に取り、before / after / diff を Private Evidence に置いて `verification-finished` の `artifacts`（`lab-state-before` / `lab-state-after` / `lab-state-diff`）と `labStateDiff` に digest で残す。取得失敗は `labStateDiff: { status: "missing", reason }` として記録し、検証結果は変えない。差分は Verifier にも判定器にも渡さない。profile が差分ファイルを汎用の `StateDiffSummary`（settings / principals / tables）に要約して export に渡す。


## 検証の前の判断（#436、ADR 0038 の段 1）

- `review --campaign <id>` は、検証がまだ無い Finding も `not-verified` の項目として出す。`unverified` の件数は変えない。
- `review decide` は `not-verified` の項目にも記録できる。判断の記録の `ref` は検証 ID を持たず、`verificationStatus` は `not-verified` になる。`elapsedMs` は Finding の記録の時刻から数える。前からの記録はそのまま読める。`--reproduced` は付けられない。
- 規則の写しに照らす判断は skill `wbh-screen` が行い、Review は値を判断しない。`提出不可` は `--decision reject --reason out-of-scope` で記録する。
- 最新の判断が `reject` の Finding は、handoff 列（`verify next`）に並ばない。`--finding` で名指ししたときだけ検証する。
- `review --campaign <id>` の `decision:` の行は、記録が読めれば理由のコードも出す（例: `decision: reject (out-of-scope)`）。

## 重複照合の記録（#442、ADR 0038 の段 4）

- 照合は skill `wbh-dedupe` が行い、所有者が `review decide --duplicate no-match|unavailable[:<理由>]|possible-match:<参照> --duplicate-note <path>` で結果を記録する。
- Review は結果を判断せず、値、記録した時刻、skill のメモ（Private Evidence の `dedupe-note.md`）の digest を判断の記録に残す。
- `--duplicate` を付けない後の判断（再現の記録など）は、記録済みの結果を引き継ぐ。一度も記録していない判断は `unavailable` を持ち、`checkedAt` は null になる。
- `review export` は、結果を `review.decision.duplicate`（1 本の文字列）と `review.duplicate`（参照、理由、時刻、メモの path と digest）に出す。`review --campaign <id>` も Finding ごとに `duplicate:` の行を出す。
- 提出の文案（`wbh-report` v2）に進むのは、最後の判断が `accept`、人間の再現が `match`、`review.decision.duplicate` が `no-match` の Finding だけである。
- `possible-match` は照合先を残して所有者が最終判断し、`unavailable` は落とさずに再照合を待つ。
