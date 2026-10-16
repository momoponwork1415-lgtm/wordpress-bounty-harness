# Codex への依頼文の書き方（AI 向け）

所有者は実装を Codex に渡し、依頼文は Claude が書く。所有者の指示（2026-10-16）: **簡潔に**。詳細は Issue 本文と PR comment に置き、依頼文はそれを指す。正本は [DEVELOPMENT](../DEVELOPMENT.md) §4〜§5、[FACTORY](../FACTORY.md) §3〜§4。

## 置き場

- 依頼文: `docs/reviews/<日付>-codex-<用途>.md`。所有者に貼ってもらう。
- 詳しい受入条件: Issue 本文（番号付き）。依頼文に写さない。
- 修正の指摘: PR のレビュー comment。依頼文は「<日付> のレビュー comment を直す」と指す。

## 型（1 タスク 5〜8 行）

```text
Issue #<番号> を解く。対象 file: <path>（<行付近>）。
受入条件は Issue 本文の 1〜<n>。先に失敗する受入試験 1 つ、次に最小実装。
触らない: <正本や owner-approved path のうち近いもの>。
追加 <n> 行以内。PR 本文は 5 項目。配線なら Draft のまま「数字待ち」。
```

## 共通の前置き（セッションの先頭に 1 回）

```text
リポジトリ <owner>/<repo>。先に読む: AGENTS.md、docs/DEVELOPMENT.md 第 5 節、docs/FACTORY.md 第 4 節。
origin/main から branch codex/issue-<番号>-<語>。1 Issue 1 PR。pnpm check と pnpm build を通す。
触らない: SPEC §2、judges.ts、prompt と skill の本文、docs/adr/、policy/、programme-impacts.ts、台帳の既存 event 型、~/.local/state、docker、Trial の起動、merge、close、ラベル。
open PR が 3 本を超えたら新しい PR を出さず、branch を push して Issue に comment。
```

## オーケストレーター（複数タスクを 1 セッションで）

作業列を順に書き、並行は 2 本まで、同じ file を触る組は並行しないと明記する。止まる条件（CI 2 回赤、正本と矛盾、500 行超）と報告の 1 行形式を付ける。実例: [2026-10-16-codex-one-prompt.md](../reviews/2026-10-16-codex-one-prompt.md)。

## 監視セッション

読むだけ。止める・消す・設定を変える・Private Evidence を開く・git と GitHub に書く、を禁止と書く。実例: [2026-10-16-codex-monitor-brief.md](../reviews/2026-10-16-codex-monitor-brief.md)。

## 分担

- 数字（3 Trial、実 Lab の計測）は Claude が貼る。依頼文に「数字は Claude が貼る」と書く。
- agent に渡る文章の変更が必要になったら Codex は止まり、Issue に理由を書く。所有者の `owner-approved` が要る。

## 書かないこと

- 設計の選択肢の列挙。決めてから渡す。決まっていなければ Issue に戻す。
- 「できれば」「検討する」。やるかやらないか。
- Private Evidence の本文、payload、対象固有の関数名・URL。
