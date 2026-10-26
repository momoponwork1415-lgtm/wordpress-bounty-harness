# Codex brief: wp2shell-bounty-v14-wide (2026-10-26)

Paste-ready. Worktree is prepared at `/home/dev/wbh-v14-wide` (branch `wbh-v14-wide` from origin/main 9f25b8a, dependencies installed). Read `docs/reviews/2026-10-26-wp2shell-bounty-v14-wide-source-table.md` first; it lists the only elements you may write. Do not add elements that are not in that table.

```
You are working in /home/dev/wbh-v14-wide (branch wbh-v14-wide). Read AGENTS.md, docs/adr/0039-*.md, docs/adr/0029-*.md, src/profiles/wordpress/prompts/index.ts and docs/reviews/2026-10-26-wp2shell-bounty-v14-wide-source-table.md.

Task: create the wide discovery objective wp2shell-bounty-v14-wide from v13-wide by changing exactly two fragments. Every other fragment stays byte-identical and is reused by file name.

1. Add src/profiles/wordpress/prompts/sections/strategy/sinks-v14.md, derived from sinks-v13.md, with these four edits and nothing else:
   a. The entry-point ordering becomes guidance by example ("for example, roughly in this order of observed frequency"), not a required order.
   b. Remove the sentence that forbids multi-step chains and makes a short route the unit of work. Replace it with one non-binding sentence: routes are usually one or two hops, and a longer chain is welcome when the source supports every hop.
   c. Add one sentence: content the plugin imports from third-party services (for example a social feed, external reviews, a webhook sender, a remote API response) is attacker-placeable input, and whoever can place that content is treated as an unauthenticated attacker. Keep it as an example list, not an exhaustive one.
   d. Add one sentence: a shared helper that assembles a query, a path or markup is examined once at the helper, including how each argument behaves when it arrives as an array or an unexpected type, and the callers that reach it are then listed.
2. Add src/profiles/wordpress/prompts/sections/coordination/fixed-v14.md, derived from fixed-v13.md, with one edit: replace the "doubly checks every concrete bug for sanity before it is reported" clause with: a source-grounded chain is reported even when an uncertainty remains, with that uncertainty stated; the later human review tolerates some false positives, and a missed route is the costlier error. Keep the rest of the paragraph, including its last sentence, unchanged.
3. Register wp2shell-bounty-v14-wide in src/profiles/wordpress/prompts/index.ts as the current wide objective (same fragment list as v13-wide with sinks-v14 and fixed-v14 substituted), move v13-wide to archived keeping its digest, and write src/profiles/wordpress/prompts/wp2shell-bounty-v14-wide.md as the composed text. Let the existing composition/digest tests tell you the sha256 and pin it.
4. Update the lines that name v13-wide as the only wide objective (docs/SPEC.md §6, docs/OPERATIONS.md, AGENTS.md if present) and add a dated addendum to docs/adr/0039 saying v14-wide is current and why (two fragments, owner guidance of 2026-10-26: examples not mandates, some false positives accepted, no hop count). Keep deep v11 unchanged.
5. Run pnpm check. Commit as the repo identity (git user is already Codex) with the trailer "Co-Authored-By: Claude Mythos 5.1 <noreply@anthropic.com>". Push the branch and open a PR against main with the five Japanese headings (問い / 変えたこと / 変えなかったこと / 測った数字 / 消し方). Under 測った数字 write "再計測は merge 前に同じ 6 件で行い、結果をこの PR に貼る" and paste the full v14-wide text plus a Japanese translation in the PR body or in docs/reviews/2026-10-26-wp2shell-bounty-v14-wide-source-table.md.
6. Do not merge. Do not touch src/discovery, the exit routing, schemas, skills, or the deep objective. Do not start any Trial.
```

After Codex pushes: `cd /home/dev/wbh-v14-wide && pnpm build`, then launch `~/.local/state/wordpress-bounty-harness-devset-wide-v14-20261026/run-devset-v14.sh` (prepared; it waits until no other `campaign run` process is alive, runs the six cases three at a time as `dsw14-*`, and does not restart the production runner).
