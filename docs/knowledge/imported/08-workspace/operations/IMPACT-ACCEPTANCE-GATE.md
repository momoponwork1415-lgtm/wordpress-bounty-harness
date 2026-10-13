<!-- provenance: /home/dev/wp-bounty-workspace/operations/IMPACT-ACCEPTANCE-GATE.md, mtime 2026-08-08, imported 2026-10-13, generation 08-workspace -->

# Impact and Acceptance Gate

Apply this gate after static source validation and before creating a disposable Lab.

## 1. Reachable impact

For every Lead, state the attacker role, prerequisite settings, victim interaction, exact security boundary crossed, and terminal confidentiality/integrity/authority outcome. A primitive or payload that merely fires is not enough.

### SQL Injection

- Separate control of SQL syntax from control of arbitrary database reads or writes.
- Name the exact reachable tables, columns, records, and raw fields.
- Distinguish application-rendered output from raw database material.
- Public or normally readable comments are not submission-grade by themselves.
- Promote when the route demonstrably reaches confidential records, credentials/account material, cross-object write/delete, or a stronger chain.

### Cross-Site Scripting

- Name the victim principal and same-origin execution page.
- State what authenticated authority becomes usable in that browser context.
- Require a realistic normal workflow that brings the victim to the sink.
- Record all settings, extensions, integrations, and clicks required.
- Drop self-XSS, intentional active-content uploads, and administrator-insecure configurations unless another independent boundary is bypassed.

## 2. Wordfence acceptance precedent

Use precedent only for an otherwise ambiguous impact decision.

- Check the current Wordfence scope and Common False Positive list first.
- Match attacker role, prerequisite settings, victim interaction, reachable asset, and terminal outcome—not just the vulnerability class name.
- A Wordfence vulnerability-database page shows that a record exists; it does not by itself prove that a bounty submission was accepted or paid.
- An older CVE or database record does not override an explicit current out-of-scope rule.
- Record the URL and why the precedent is materially equivalent or non-equivalent.

## 3. Disposition

- `verify`: source chain is real, prerequisites are realistic, impact is submission-grade, and no current exclusion applies.
- `premise-reduction`: one cheap source/runtime question decides whether the impact gate passes.
- `not-planned`: terminal impact is weak, an explicit exclusion applies, or only a non-matching historical precedent exists.
- `reopen`: define the exact stronger terminal or removed prerequisite required to reconsider the Lead.

## 4. Multi-agent verification

Use independent read-only reviews before creating a Lab:

- Scope reviewer: attacker ceiling, settings, victim interaction, current Wordfence exclusions, and materially matching precedent.
- Source/impact reviewer: exact writer-to-sink chain, reachable asset, terminal authority, and counterarguments.
- Portfolio reviewer: compare verification cost and rejection risk against the other queued Leads.

One verification operator owns Docker, browser actions, evidence capture, and the final case status. After reproduction, a separate reviewer should challenge the positive/control pair and the claimed impact. This keeps independent judgment without mixing Lab state or evidence ownership.
