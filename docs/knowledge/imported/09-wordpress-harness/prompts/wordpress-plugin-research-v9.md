<!-- provenance: /home/dev/wordpress-harness/prompts/wordpress-plugin-research-v9.md, mtime 2026-10-08, imported 2026-10-13, generation 09-wordpress-harness -->

# WordPress Plugin Research v9

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

The target's active-installation and repository eligibility were decided before Research; do not recompute them. A complete source-supported route from an explicitly eligible attacker position to any listed impact is a success. Do not require RCE escalation when another listed impact is already complete. A suspicious primitive, possible chain, or excluded attacker position is not a Candidate.

Use native subagents aggressively when they can produce real parallel investigation or adversarial checking. The root dynamically chooses their tasks. Do not use a fixed assignment such as a fixed number of agents for one strategy. Across the team, no more than four native agents may be active at once: the root plus at most three subagents. Only the root launches subagents.

Manage the search with these heuristics:

- Begin with a genuinely diverse portfolio grounded in the plugin. Explore request and input parsing, charsets, REST/AJAX and direct entry points, capabilities and nonces, validation order and type confusion, query construction, stored state and later consumers, output contexts, file uploads and operations, serialization and deserialization, caching, races, encryption sanity checking, typing, mass assignment, error handling, built-in routes, and any other meaningfully attacker-facing surface you identify. These are idea prompts, not a sink checklist.
- Maintain an explicit scratch registry of approach families, grouped by the underlying research idea rather than superficial wording. Track active routes, blocked routes, Candidates, parked Programme Leads, concrete evidence, counterevidence, and remaining gaps. It is not a Harness work queue, a coverage ledger, or a persisted completeness claim.
- If many agents converge on one approach family, redirect some toward underexplored families. Do not let one route dominate merely because it initially appears promising or suspicious.
- When an approach stalls, mark it blocked. Reopen it or assign more work only when someone proposes a materially new mechanism, construction, or source-grounded idea.
- Keep several incompatible routes alive through multiple rounds. Let independent investigations develop far enough to reveal their real strengths and gaps before cross-pollinating their ideas.
- Use adversarial subagents throughout. Double-check every concrete bug by challenging attacker control, reachability, privileges, guards, transformations, persistence, consumers, ordinary-deployment preconditions, and counterevidence.
- The root repeatedly synthesizes results, challenges assumptions, redirects effort, and launches new rounds. Failure of the current approaches or the first wave is not a reason to stop. Search for fresh source-grounded ideas and chain intermediate bugs when they can connect to an eligible impact.

Read pinned dependency source, including WordPress core when supplied, to establish framework, library, PHP, database, or companion-component behavior instead of relying on memory or internet lookup. Dependencies complete the source world and may reveal a missing link in a chain, but they are not separate audit targets; report only security claims attributable to the target plugin. Do not invent unlikely configuration assumptions or attacker capabilities.

Treat the Programme Research Boundary as a hard Candidate gate:

- Before parking a read, inspect every material producer of its store; for a write, inspect its privileged consumers.
- Candidate attackers must be explicitly eligible. Roles are distinct (Contributor is not Subscriber), and omission from `explicitExclusions` grants nothing.
- Set exact Candidate `attackerPosition` and `priorityImpact` IDs from `candidateAdmission`; otherwise the run is rejected.
- A Candidate must have an end-to-end `sourceTrace` from that eligible position to a `priorityImpact`. Do not promote a primitive or partial chain whose eligible high-impact effect is still hypothetical.
- If source proves only an ineligible attacker position or excluded maximum effect, preserve a lightweight `parkedProgrammeLead` with its attacker premise, primitive, exact evidence, maximum source-supported effect, and `eligibleEscalationAssessment=no-concrete-source-bound-path`. Do not delegate a parked Programme Lead to a subagent or adversarially validate it. Promote it only when a concrete source-bound edge reaches an eligible impact.
- If source cannot establish attacker eligibility, reachability, or maximum effect, continue focused source work or return a blocked Assessment. Do not use human scope challenge as a way to promote an unresolved route.
- Put only deployment or runtime facts that source cannot settle in Candidate `unresolvedFacts`. Final programme scope remains a post-verification decision, but it does not weaken this Research gate.

Record a Candidate only after the complete eligible route survives source-level adversarial review. Once one exists, spend remaining effort on the highest-value concrete frontier: refute or close its source-answerable gaps, test a materially different high-ceiling route, or stop. Do not continue merely to broaden surface coverage, increase record count, or cosmetically revise an earlier Candidate. Unexamined files alone are not an actionable frontier.

Every report must include a run-local `evidenceSummary` describing the source areas actually examined, the material areas not examined, and the concrete observations supporting its decisions. It is evidence of this run's work, not proof of complete coverage.

On a continuation Native Run, consult the restored checkpoint before reading new areas. Return only Candidates and parked Programme Leads first established during that run; the Harness retains earlier records. A new Candidate needs a materially distinct source trace and security effect, not a renamed variant or minor correction. If new evidence materially changes an immutable earlier record, use a new ID as required by the contract, but that record repair alone does not justify another continuation.

Before stopping, review the approach-family registry for unresolved high-ceiling routes, unexplained source behavior tied to an eligible impact, and concrete compositions. Continue only when a named source question can materially establish, refute, or strengthen such a route. Stop when no such actionable frontier remains and explain the evidence basis. Do not merely return because current approaches failed or agents reported no findings.
