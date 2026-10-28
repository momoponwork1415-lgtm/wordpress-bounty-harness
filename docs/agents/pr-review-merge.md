# PR のレビューと merge（AI 向け）

所有者は merge の判断を AI に委任している（2026-10-13、DEVELOPMENT §5）。委任があっても、書かれた門は AI にも効く。正本は [DEVELOPMENT](../DEVELOPMENT.md) §5 と [FACTORY](../FACTORY.md) §3〜§5。

## 見る順

1. **本文の 5 項目**（問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方）が日本語で埋まっているか。欠けていれば comment して止める。
2. **正本との矛盾**。SPEC §2 の不変条件、最終設計（2026-10-14）§1「変えないもの」と §13「やらないこと」、該当 ADR。矛盾があれば NEEDS_FIX。コードが正本を上書きしていないか（例: SPEC §6 の「Trial に数えない run」の判定を消していないか）。
3. **owner-approved path**。`docs/adr/`、`docs/SPEC.md`、`trust-boundary-v1.md`、`policy/campaign.json`、`policy/programme-scope.md`、`programme-impacts.ts`、`judges.ts`、prompt 本文、`.claude/skills/` の本文。触っていれば `owner-approved` ラベルが付くまで merge しない。AI が委任で付けるときは、読んだ範囲と出典対照を PR comment に書く。
4. **差分の大きさ**。追加 500 行以内。超えていれば分割を求める。
5. **テスト**。公開 interface からの受入試験が 1 つ先にあるか（TEST-STRATEGY）。内部関数をなぞるだけのテストは数に入れない。
6. **数字**。探索・配線・runtime・選定を触る PR は数字の表が要る。agent 入力は開発セット 6 case × 各 3 run と DEVELOPMENT §5 の 6 段、配線・runtime・選定は初回 3 Trial（[measurement.md](measurement.md)）。無ければ Draft のまま「数字待ち」。
7. **CI**。required check 3 つが緑。strict ruleset なので base が古いと merge できない。

## 判定 comment の形

```text
レビュー（<日付>、所有者の委任で AI）: <OK | NEEDS_FIX | BLOCKED>
- 見た正本: SPEC §<n>、最終設計 §<n>、ADR <番号>
- 指摘 <n> 件（番号付き、file:行、正本の文を引く）
- 残してよいもの
- merge 条件（数字、ラベル、修正）
```

指摘は「正本のどの文と食い違うか」を引く。好みは書かない。

## merge の手順

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch   # BEHIND のとき
gh pr checks <n> --watch --interval 20
gh pr merge <n> --squash
```

- 積み上がった PR（例 #265 の上に #266 #267 #269）は下から順に。下が変わったら上に main を merge し直してから。
- **下の PR を merge したら、上の PR の base を main に変える**（`gh pr edit <n> --base main`）。変えずに merge すると、上の PR は下の branch に merge されて main に入らない（2026-10-16 の #264。#289 で回収した）。下の branch を消しておけば GitHub が自動で付け替える。
- `gh pr checks --watch` は全 check の完了前に返ることがある。merge 前に `gh pr view <n> --json mergeStateStatus` が `CLEAN` か確かめる。`BLOCKED` なら check が残っている。
- merge の comment に「委任: 所有者の <日付> の指示に基づき AI が merge」と、根拠になった数字（campaign ID）を書く。
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
