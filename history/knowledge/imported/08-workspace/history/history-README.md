<!-- provenance: /home/dev/wp-bounty-workspace/history/README.md, mtime 2026-08-13, imported 2026-10-13, generation 08-workspace. 取り込み時に所有者の氏名を除き、件別 file は名前だけ残した -->

# Wordfence submission history (private record) — directory index

Researcher: the owner（handle は Git 外）.

This directory is the durable record of submissions and their outcomes. It lives **outside both
git repositories** by design — `wp-bounty-harness-v1/CLAUDE.md` requires that unpublished leads,
PoCs, HTTP evidence, reports and run metrics never be committed to git.

Last updated: 2026-08-13.

## Files

| File | What it is |
|---|---|
| `submission-ledger.json` | All 60 known submissions (80 by 2026-09-12), structured, with outcome classification and crowding metrics computed against the Wordfence Intelligence DB. **Git 外。** |
| `reports/verbatim-submitted-reports.md` | Full text of 6 submitted Descriptions + PoCs, with triage transcripts and post-mortems. **Git 外。** |
| `wordfence-verdicts.md` | Wordfence's **actual triage rationale**, extracted from `~/wp-bounty-workspace/cases/*/case-status.json`. Ground truth for why things were rejected. **Git 外。** |
| `competitor-profile-report.txt`, `competitor-*-verified.md` | Computed distributions and per-competitor profiles, adversarially re-verified against the raw corpus. **Git 外（研究者名付き profile）。** |
| `self-profile-and-loss-modes.md` | The owner's own hunting profile and where the effort leaks. → `imported/08-workspace/history/`（集計と規則だけ） |
| `payout-decision-rule.md` | What the program actually pays for, as a pre-verification go/no-go rule. → 同上 |
| `whitespace-analysis.md` | Where coverage is thin across the 38,456 records. → 同上 |
| `rejection-reasons-verbatim.md` | Wordfence's rejection wording, verbatim, with the 8-category taxonomy. → 同上 |
| `class-outcome-analysis.txt` / `structural-edge-analysis.txt` | Class-level outcome splits; Japanese-market / multilingual / chained-bug edge tests. **Git 外。** |
| `target-selection-doctrine-v2.PROPOSED.md`, `target-selection-priors.PROPOSED.md` | Proposed replacement of the selection gate (never shipped). → `imported/08-workspace/history/` |
| `wordfence-description-template.PROPOSED.md`, `wordfence-poc-template.PROPOSED.md` | Reverse-engineered house style and PoC template. → 同上（payload と harness code は除く） |
| `attested-form-options.md` | Dropdown values observed on the live Wordfence form. → 同上 |
| `scored-candidates.json`, `missing-report-details.md` | Scored candidate list (121) and the list of triage texts not held locally. **Git 外。** |

## Reading order

1. `payout-decision-rule.md` — the go/no-go gates.
2. `rejection-reasons-verbatim.md` — why the arguable-impact bucket loses.
3. `self-profile-and-loss-modes.md` — where the owner's effort leaked and where the edge is.
4. `whitespace-analysis.md` and `target-selection-doctrine-v2.PROPOSED.md` — selection, including the parts later refuted by the 2026-08-20 backtests in `selection/SELECTION.md`.
