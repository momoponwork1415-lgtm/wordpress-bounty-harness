# Issue tracker

作業Issueは、このリポジトリの GitHub Issues に置く。`gh` は Git remote から対象を決める。外部 PR は triage の依頼面に含めない。

- 読み取り: `gh issue view <number> --json number,title,body,labels,comments`、`gh issue list --state open`。
- 作成: `gh issue create --title <title> --body-file <path>`。本文には利用者に届く振る舞い、受入条件、先行Issueを記す。
- 更新: `gh issue edit`、`gh issue comment`、`gh issue close`。既存Issueは内容を読んでから編集する。
- 依存: GitHubの依存関係が使えるときは native の `blocked_by` を使う。使えなければ本文に `Blocked by: #<number>` を記す。
- 親Issue: sub-issue が使えるときは親に結び付ける。使えなければ本文に `Part of #<number>` を記す。

Issueを公開するときは、実装の内部ファイル名より、完了時に観測できる振る舞いを先に書く。

## triage の 4 束（2026-10-16 から）

open Issue を見直すときは次の 4 つに分け、束ごとに扱いを決める。ラベルは [triage-labels.md](triage-labels.md) の 5 つだけ。

| 束 | 中身 | ラベル | 扱い |
| --- | --- | --- | --- |
| 起動前 | runner の起動に要るもの。依存順に並べる | `ready-for-agent` | Codex に依頼文を出す。起動の条件はこの束の先頭だけにする |
| Step 1 の週 | 最初の提出までに要るもの（重複照合、Lab の前提、ベンチマーク） | `ready-for-agent` | 起動後に並行 |
| 所有者の判断 | provider の追加、Programme の条件、外部行動の承認（owner-approved path は 2026-10-18 以降、委任済みの AI が扱う） | `ready-for-human` | AI も Codex も先に進めない。所有者に質問を 1 つずつ |
| 閉じる・止める | 吸収済み、置き換え済み、先回り、優先度低 | `wontfix` | close。先回りと優先度低は PARKING に行を足す |

- 閉じる comment の型: `triage（<日付>、所有者の委任で AI）: <理由>。<吸収先 / 置き換え先 / PARKING の条件>`。
- 観測だけの Issue（provider の拒否など）は、原因を直す PR の merge 時に閉じる。再発したら新しい観測として起票する。
- 親 Issue は子が閉じたら閉じる。
- 進行中の状態（計測、起動）は Git に置かず、該当 Issue の comment に書く。
