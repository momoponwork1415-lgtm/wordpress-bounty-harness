# Codex への依頼文: 実装の前の整理（2026-10-28）

所有者が Codex に貼る文。詳細は Issue #654 にある。所有者の指示（2026-10-28 夜）: 実装（#647 → #646 → …）に入る前に、文書・Issue・worktree・branch を整理する。

## 共通の前置き

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。先に読む: AGENTS.md、docs/agents/issue-tracker.md、docs/agents/pr-review-merge.md。
触らない: 本番ランナーのプロセス、/home/dev/worktree/prod26、~/.local/state、~/.config、SPEC、ADR、Issue の本文。
消す前に、消す branch と worktree の tip の sha を Issue #654 の comment に残す。
```

## タスク（順に）

```text
Issue #654 を解く。受入条件 A（文書の PR 1 本）→ B（Issue の close と付け替え）→ C（worktree と branch）の順。
A は origin/main から branch codex/issue-654-docs。本体 checkout /home/dev/wordpress-bounty-harness の untracked 27 本を commit し、docs/reviews/README.md に 1 行ずつ足す。内容は変えない。PR 本文は 5 項目。
B は gh で行う。close の comment は「triage（2026-10-28、所有者の委任で AI）: <理由>。<移した先>」の型。
C は受入 8〜11 の規則どおり。PR 無しで未取り込み commit のある branch は消さず一覧を comment に出す。
終わったら #654 に、残った worktree・branch・open Issue の数を 1 行で書く。
```

整理が終わったら、[2026-10-28-codex-brief-codex-one-shot.md](2026-10-28-codex-brief-codex-one-shot.md) のタスク 1（#647）から実装に入る。
