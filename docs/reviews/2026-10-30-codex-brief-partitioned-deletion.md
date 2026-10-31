# Codex への依頼文: 区画分配型の削除（2026-10-30）

所有者が Codex に貼る文。詳細は Issue #685 にある。所有者の指示（2026-10-30）: 区画分配型は廃止し、残す部品はスキルへ移す。Claude は並行してスキル本文（`wbh-tools` 以降）を書く。

## 共通の前置き

```text
リポジトリ momoponwork1415-lgtm/wordpress-bounty-harness。先に読む: AGENTS.md、docs/DEVELOPMENT.md 第 5 節、docs/adr/0043-exploration-skills-in-the-sandbox.md、Issue #685。
origin/main（PR #684 merge 後、2026-10-30）から branch codex/issue-685-delete-partitioned。worktree は /home/dev/worktree/685。1 Issue 1 PR。pnpm check と pnpm build を通す。
触らない: SPEC §2、judges.ts、docs/adr/ の中身、prompt と skill の本文の中身（削除と git mv だけ可）、policy/、programme-impacts.ts、台帳の既存 event 型、~/.local/state、docker、本番ランナー、Trial の起動、merge、close、ラベル。
```

## タスク

```text
Issue #685 を解く。受入条件は Issue 本文の 1〜8、この順で。
先に tag archive/pre-partitioned-deletion を origin/main に打つ（受入 1）。次に失敗する受入試験 2 つ（受入 2 の拒否、受入 3 の旧 event 読み取り）、次に削除。
対象 file は Issue の「消すもの」。列挙 script 3 本は git mv で src/profiles/wordpress/prompts/skills/wbh-tools-v1/ へ（受入 5）。
追加は test と拒否文だけ（200 行以内）。それ以外は削除。
PR 本文は 5 項目。adr-guard が赤になるのは想定内（削除だけ）。Claude がレビューして owner-approved を付ける。
終わったら #685 に、消した行数と grep の残り（受入 4）を 1 行で書く。
```

## 分担

- ADR 0042 の `superseded` 追記、`wbh-tools-v1/SKILL.md` の本文、数字は Claude が書く。Codex は書かない。
- 探索の再開と計測の campaign 起動は、所有者の指示の後に Codex が行う（2026-10-27 の決定）。計測の設定は `discovery.skills: ["wbh-recon-v1"]` の有無と `discovery.minimumActiveMinutes: 0` で腕を分ける（#686）。コード変更は要らない。
