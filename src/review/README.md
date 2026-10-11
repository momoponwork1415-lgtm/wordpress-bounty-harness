# Review の提出前手順

`Review` は `runtime-confirmed` と `reproduced` の再現パッケージを参照し、programme ごとの scope 評価、版付きの文案、外部行動の承認を台帳に記録する。文案本文と判断に使った資料は Git 外の Private Evidence に置き、台帳には digest 参照だけを残す。`admitExternalAction` は完全一致の承認を照会するだけで、報告や連絡を送信しない。

`review --campaign <id>` は証拠付きの候補を個別に表示し、`incomplete` は理由別件数を表示する。`recipe`・`observation` は3回目、`provision` は2回目から再試行が尽きた件数に入る。`evidence`・`cleanup`・`digest-mismatch` は直ちに個別表示する。再試行の実行そのものはこの列では行わない。

提出前には人間が次を行う。

1. `review open --campaign <id> --finding <id>` で再現パッケージを読む。`lab up --for-review --campaign <id> --finding <id>` は封印済み setup manifest と Snapshot から新しい Lab を立て、手動クライアントの起動コマンドを表示する。遠隔攻撃者の視点の HTTP リクエストとブラウザ操作で自分の手で再現し、`review reproduced --campaign <id> --finding <id> --result match|mismatch|unavailable` で結果を残す。`reproduced` の文案は `match` の記録後にだけ作れる。
2. `review reverify --campaign <id> --finding <id> --config <path>` で、対象の最新版を新しい Target Snapshot に固定し、同じ Finding を新しい Lab で再検証する。
   - 旧 digest の検証結果を最新版の証拠として流用しない。
   - 結果は `basis: latest-version` 付きの検証として台帳に残る。scope 評価が「最新版で成立」とみなすのは、この検証が `runtime-confirmed` または `reproduced` のときだけ。
   - 再検証の後は、レビュー列の判断をやり直す。
3. `src/profiles/wordpress/policy/programme-scope.md` の観測日と Wordfence / Patchstack の公式規則を照合する。差分や矛盾があれば方針を更新し、`ambiguous` として人間の判断に回す。
4. 重複照合（#12 のローカル Wordfence 履歴DB）、影響、意図された動作かどうかを判断する。照合が unavailable のときは結果を推定しない。
5. 正確な Submission Candidate、文案の版 digest、送信先に結び付けて人間が承認する。実際の提出は人間が各プログラムの画面で行う。

scope 評価の事実は、判定器の観測条件、選定記録（`target-selection.json`）、最新版での再検証の有無、検証 Lab と版固定された通常利用 scenario の一致から作る。Verifier の `defaultSettings` 自己申告は設定範囲の判定に使わない。scenario の記録が欠ける・一致しない場合は設定範囲を `ambiguous` とし、確認済みの技術的記録を変更しない。scope 評価自体の障害は scope の `incomplete` である。候補と文案は `in-scope` の評価からだけ作る。後で文案を改訂した場合、旧版の承認では新しい候補を admit しない。

`review open`、`review reproduced`、提出・転帰記録では終了時に実作業の分数を尋ねる。`ledger funnel --campaign <id>` は台帳に追記された分数、開いた Finding 数、手動再現の一致率を campaign と分類ごとに集計する。分母がない指標は `unavailable` と表示する。
