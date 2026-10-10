# Issue tracker

作業Issueは、このリポジトリの GitHub Issues に置く。`gh` は Git remote から対象を決める。外部 PR は triage の依頼面に含めない。

- 読み取り: `gh issue view <number> --json number,title,body,labels,comments`、`gh issue list --state open`。
- 作成: `gh issue create --title <title> --body-file <path>`。本文には利用者に届く振る舞い、受入条件、先行Issueを記す。
- 更新: `gh issue edit`、`gh issue comment`、`gh issue close`。既存Issueは内容を読んでから編集する。
- 依存: GitHubの依存関係が使えるときは native の `blocked_by` を使う。使えなければ本文に `Blocked by: #<number>` を記す。
- 親Issue: sub-issue が使えるときは親に結び付ける。使えなければ本文に `Part of #<number>` を記す。

Issueを公開するときは、実装の内部ファイル名より、完了時に観測できる振る舞いを先に書く。
