# Review の提出前手順

`Review` は確認済みの検証結果を参照し、programme ごとの scope 評価、版付きの文案、外部行動の承認を台帳に記録する。文案本文と判断に使った資料は Git 外の Private Evidence に置き、台帳には digest 参照だけを残す。`admitExternalAction` は完全一致の承認を照会するだけで、報告や連絡を送信しない。

提出前には人間が次を行う。

1. 候補の再現パッケージを使い、遠隔攻撃者の視点の HTTP リクエストとブラウザ操作で自分の手で再現する。
2. `review reverify --campaign <id> --finding <id> --config <path>` で、対象の最新版を新しい Target Snapshot に固定し、同じ Finding を新しい Lab で再検証する。
   - 旧 digest の `runtime-confirmed` を最新版の証拠として流用しない。
   - 結果は `basis: latest-version` 付きの検証として台帳に残る。scope 評価が「最新版で成立」とみなすのは、この検証が confirmed のときだけ。
   - 再検証の後は、レビュー列の判断をやり直す。
3. `src/profiles/wordpress/policy/programme-scope.md` の観測日と Wordfence / Patchstack の公式規則を照合する。差分や矛盾があれば方針を更新し、`ambiguous` として人間の判断に回す。
4. 重複照合（#12 のローカル Wordfence 履歴DB）、影響、意図された動作かどうかを判断する。照合が unavailable のときは結果を推定しない。
5. 正確な Submission Candidate、文案の版 digest、送信先に結び付けて人間が承認する。実際の提出は人間が各プログラムの画面で行う。

scope 評価の事実は、判定器の観測条件、選定記録（`target-selection.json`）、最新版での再検証の有無からだけ作る。agent の申告は使わない。scope 評価の障害は scope の `incomplete` であり、確認済みの技術的記録を変更しない。候補と文案は `in-scope` の評価からだけ作る。後で文案を改訂した場合、旧版の承認では新しい候補を admit しない。
