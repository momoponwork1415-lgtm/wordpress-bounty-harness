<!-- provenance: /home/dev/wordpress-harness/prompts/wordpress-plugin-research-v7.md, mtime 2026-10-08, imported 2026-10-13, generation 09-wordpress-harness -->

# WordPress Plugin Research v7

Conduct prospective zero-day research on the supplied WordPress plugin and pinned dependency source from first principles. Do not assume that a vulnerability exists. Seek concrete broken security semantics reachable by an unauthenticated visitor or a low-level authenticated Subscriber or Customer in an ordinary production deployment. Do not use vulnerability advisories, changelogs, Git history, patch diffs, the internet, or memory of known CVEs to infer a patched vulnerability.

Spend deep exploration on routes that can reach one of these programme-eligible impacts:

- Arbitrary PHP File Upload, Read, or Deletion
- Arbitrary Options Update
- Remote Code Execution
- Authentication Bypass to Administrator
- Privilege Escalation to Administrator
- Stored Cross-Site Scripting
- SQL Injection
- unauthorized data alteration or read only when the source-supported effect is critical under the Programme Research Boundary

The target's active-installation and repository eligibility were decided before Research; do not recompute them. A complete source-supported route to any listed impact is a success. Do not require RCE escalation when another listed impact is already complete.

Use native subagents aggressively when they can produce real parallel investigation or adversarial checking. Across the team, no more than four native agents may be active at once: the root plus at most three subagents. Only the root launches subagents. Do not use a fixed assignment such as a fixed number of agents for one strategy.

Manage the search using these heuristics:

- Begin with a genuinely diverse portfolio of approaches grounded in the plugin. Explore input and request parsing, charsets, REST/AJAX and direct entry points, capabilities and nonces, validation order and type confusion, query construction, stored state and later consumers, output contexts, file uploads and operations, serialization and deserialization, caching, races, encryption sanity checking, typing, mass assignment, error handling, built-in routes, and any other meaningfully attacker-facing surface you identify. These are idea prompts, not a sink checklist.
- Maintain an explicit scratch registry of approach families, grouped by the underlying research idea rather than superficial wording. Track active routes, blocked routes, Candidates, parked Programme Leads, concrete evidence, counterevidence, and remaining gaps. It is not a Harness work queue, a coverage ledger, or a persisted completeness claim.
- If many agents converge on one approach family, redirect some toward underexplored families. Do not let one route dominate merely because it initially appears promising or suspicious.
- When an approach stalls, mark it blocked. Reopen it or assign more work only when someone proposes a materially new mechanism, construction, or source-grounded idea.
- Keep several incompatible routes alive through multiple rounds. Let independent investigations develop far enough to reveal their real strengths and gaps before cross-pollinating their ideas.
- Use adversarial subagents throughout. Double-check every concrete bug by challenging attacker control, reachability, privileges, guards, transformations, persistence, consumers, ordinary-deployment preconditions, and counterevidence.
- The root repeatedly synthesizes results, challenges assumptions, redirects effort, and launches new rounds. Failure of the current approaches or the first wave is not a reason to stop. Search for fresh source-grounded ideas and chain intermediate bugs when they can connect to an eligible impact.

Read pinned dependency source to establish framework, library, PHP, database, WordPress core, or companion-component behavior instead of relying on memory or internet lookup. Dependencies complete the source world and may reveal a missing link in a chain, but they are not separate audit targets; report only security claims attributable to the target plugin. Do not invent unlikely configuration assumptions or attacker capabilities.

For every serious route, identify the lower-trust principal and starting capability, follow the exact source path from a real entry point to the smallest security-relevant effect, reconstruct the strongest source-visible controls, and state why they block or fail to block the route. Record decisive deployment or runtime facts that source cannot establish instead of assuming them either way.

Triage a discovered primitive before spending deep reasoning on it:

- Trace the exposed state across its full source-visible lifecycle before parking it. For a read primitive, inspect every material producer of the exposed store. For a write primitive, inspect the privileged consumers of the modified state.
- If it has a concrete source-bound edge to an eligible impact, keep it active, trace it end to end, challenge it adversarially, and look for source-supported intermediate bugs that complete the chain.
- If source supports only an excluded maximum effect and there is no concrete edge to an eligible impact, preserve a lightweight parkedProgrammeLead with the attacker premise, primitive, exact evidence, maximum source-supported effect, and eligibleEscalationAssessment=no-concrete-source-bound-path. Do not delegate a parked Programme Lead to a subagent or adversarially validate it. Promote it only when a concrete source-bound edge reaches an eligible impact.
- If programme eligibility remains materially ambiguous after focused source review, preserve the route for human challenge rather than silently dropping it.

Record a Candidate only after it survives source-level adversarial review. Its sourceTrace must start at a real lower-trust entrypoint, contain the necessary intermediate propagation steps, and end at the claimed effect. Its controlAssessments must cover the strongest source-visible controls. Put exact remaining facts in unresolvedFacts; use an empty array when none remain.

Every report must include a run-local `evidenceSummary` that describes the source areas actually examined during that run, the material areas not examined, and the concrete source observations supporting its decisions. On a continuation run, return only Candidates and parked Programme Leads first established during that run; the Harness retains earlier records. If new evidence materially revises an earlier record, preserve the earlier record and return a new ID.

Continue Research while a concrete source-bound active route or a materially different source-grounded approach remains, even when a Candidate is ready. Before stopping, review the approach-family registry for underexplored families, unexplained source behavior, remaining gaps, and fresh constructions. Stop only when no actionable frontier or materially new source-grounded approach remains, and explain the evidence basis. Do not merely return because current approaches failed or agents reported no findings.
