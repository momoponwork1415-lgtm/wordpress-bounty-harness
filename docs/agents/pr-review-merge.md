# PR のレビューと merge（AI 向け）

所有者は merge の判断を AI に委任している（2026-10-13、DEVELOPMENT §5）。委任があっても、書かれた門は AI にも効く。設計の正本は [SPEC](../SPEC.md) と [ADR](../adr/)、開発の手順は [DEVELOPMENT](../DEVELOPMENT.md) §5。全体の流れは [FACTORY](../FACTORY.md) を参照する。

## 見る順

1. **本文の 5 項目**（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）が日本語で埋まっているか。欠けていれば comment して止める。
2. **正本との矛盾**。Issue の受入条件、SPEC §2 の不変条件、該当する現行 SPEC と ADR。矛盾があれば NEEDS_FIX。コードが正本を上書きしていないか（例: SPEC §6 の「Trial に数えない run」の判定を消していないか）。
3. **owner-approved path**。`docs/adr/`、`docs/SPEC.md`、`trust-boundary-v1.md`、`policy/campaign.json`、`policy/programme-scope.md`、`programme-impacts.ts`、`judges.ts`、prompt 本文、`.claude/skills/` の本文。触っていれば `owner-approved` ラベルが付くまで merge しない。AI が委任で付けるときは、読んだ範囲と出典対照を PR comment に書く。
4. **差分の大きさ**。追加 500 行以内。超えていれば分割を求める。
5. **テスト**。公開 interface からの受入試験が 1 つ先にあるか（TEST-STRATEGY）。内部関数をなぞるだけのテストは数に入れない。
6. **数字**。探索・配線・runtime・選定を触る PR は数字の表が要る。agent 入力は本番の同じ選定帯で旧版と新版を交互に回し、Trial 数をそろえて DEVELOPMENT §5 の 6 段で判断する。開発セット 6 case × 各 3 run は、本番で scope 内 Finding は出るのに人間の `match` が 1 週間 0 件の切り分け時だけ。配線・runtime・選定は異なる slug の初回 3 Trial（[measurement.md](measurement.md)）。無ければ Draft のまま「数字待ち」。
7. **CI**。対象 head の required checks `check` / `adr-guard` / `private-guard` がすべて成功しているか。未実行や skipped を成功の代わりにしない。strict ruleset なので base が古いと merge できない。

## 独立レビューと再レビュー

実装と別の文脈で、対象 Issue、正本、固定した head の実差分と周辺コード、検査結果を読む。実装者の要約だけを根拠にせず、変更が起こす不具合と影響を file:行や検査で示す。修正の要る指摘と、既存の問題・好みを分ける。

修正後は未解決項目と新しい差分を中心に読み、同じ指摘を繰り返さない。3 巡で収束しなければ、理由を Issue に残して変更の切り方や検査方法を見直す。未解決の不具合が残る間は NEEDS_FIX、方針や根拠が不足する間は BLOCKED とし、巡回数だけで OK にしない。この運用は [Anthropic のレビュー事例](https://claude.dev/blog/solving-code-review-at-anthropic/)を参考にする。

## 判定 comment の形

```text
レビュー（<日付>、所有者の委任で AI）: <OK | NEEDS_FIX | BLOCKED>
- 対象 head SHA: <sha>、レビュー <n> 巡目
- 見た Issue と正本: #<番号>、SPEC §<n>、ADR <番号>
- 検査: <コマンド・結果・対象 SHA・確認できていないこと>
- 指摘 <n> 件（番号付き、file:行、根拠と影響）
- 未解決項目と、前回の指摘を修正または理由付きで解消した記録
- 残してよいもの
- merge 条件（数字、ラベル、修正）
```

仕様への指摘は「正本のどの文と食い違うか」を引く。CI の緑や `owner-approved` ラベルだけでは、最新版をレビューした証拠にならない。

## merge の手順

base が古ければ `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch` で先に更新し、更新後の head を検査・レビューする。レビュー後に push や branch 更新があれば、その差分と検査を確認し直して新しい head の判定 comment を残す。

merge 直前に次を確認する。一つでも満たさなければ続けない。`reviewed_head` には判定 comment の SHA を使い、merge 時の最新 SHA で埋め直さない。

```bash
pr="<PR番号>"
reviewed_head="<OK の判定 comment に記録した head SHA>"
gh pr view "$pr" --json headRefOid,mergeStateStatus
gh pr checks "$pr" --required --watch --interval 20
# head が reviewed_head と一致し、3 checks の成功・未解決指摘なし・CLEAN を確認してから実行する。
gh pr merge "$pr" --squash --match-head-commit "$reviewed_head"
```

[`--match-head-commit`](https://cli.github.com/manual/gh_pr_merge) は head が変わっていたら merge を拒否する。拒否されたら新しい head を再レビューする。指摘は修正または根拠を添えた解消を記録し、未解決の指摘や review thread を残したまま進めない。

- 積み上がった PR（例 #265 の上に #266 #267 #269）は下から順に。下が変わったら上に main を merge し直してから。
- **下の PR を merge したら、上の PR の base を main に変える**（`gh pr edit <n> --base main`）。変えずに merge すると、上の PR は下の branch に merge されて main に入らない（2026-10-16 の #264。#289 で回収した）。下の branch を消しておけば GitHub が自動で付け替える。
- `gh pr checks --watch` だけで判断せず、merge 直前に head と `mergeStateStatus` を再取得する。`CLEAN` でなければ理由を確認し、base 更新が必要なら検査・レビューへ戻る。
- merge の comment に「委任: 所有者の <日付> の指示に基づき AI が merge」、レビューした SHA と、根拠になった数字（該当する場合は campaign ID）を書く。
- merge 済みと本番適用済みを分けて記録する。適用する変更は稼働版と確認結果を Issue に残し、戻し方も記す。コードの revert で追記済みの台帳を戻さず、記録の互換性を確認する。
- 1 コマンドで複数の PR を閉じる・merge するのは避け、1 件ずつ打つ。
- worktree が branch を使っていると `--delete-branch` が失敗する。先に worktree を外す。
- worktree は `/home/dev/worktree/<issue 番号>` だけに置く。
- merge 後に worktree と branch を消す。
- 本体 checkout は `main` に置く。

## 逆圧

open の PR（Draft 含む）が 3 本を超えている間は、新しい実装 PR を出さない・出させない。先に merge か close。所有者の読む量が上限で、agent の数ではない。

## 閉じるとき

- 置き換えられた PR: 「<PR 番号> に置き換え」と 1 行 comment して close。
- 止めた PR: PARKING に行を足し、「PARKING の理由で close」と comment。
- どちらも branch は消さない（参照用）。
