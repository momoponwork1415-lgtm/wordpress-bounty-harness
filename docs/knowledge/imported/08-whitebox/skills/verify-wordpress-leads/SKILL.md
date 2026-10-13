<!-- provenance: /home/dev/wp-bounty-deploy/skills/verify-wordpress-leads/SKILL.md, mtime 2026-08-30, imported 2026-10-13, generation 08-whitebox -->

---
name: verify-wordpress-leads
description: Verify promoted Leads from one exact plugin Snapshot with independent source re-derivation and a falsification-first disposable local Docker Lab. Use for "verify Leads", "Docker verification", "fire a SQLi", "confirm XSS in the browser", "verify a file/auth/privilege route". This Skill is self-contained and does not launch another Skill.
---

# Verify WordPress Leads

Keep Discovery and dynamic verification separate. This Skill handles only human-promoted Leads, does not trust Discovery's account, and rebuilds independently from source and runtime. Do not probe public sites.

## Where the rules live

Read **`references/verification-playbook.md`** now, to the end. It is the procedure: batch order, the scope-only preflight, V0–V3, Lab discipline, chain verification, and what each `decision` means.

Do not read the rest up front. Each is for one moment in that procedure, and this table says when:

| Read | When |
| --- | --- |
| `contracts/verification-package.schema.json` | before filling the first `scope_assessment` |
| `references/vulnerability-determination.md` | at the preflight, before either scope gate |
| `references/wordfence-scope-gate.md` | at the preflight after gate zero, and again at V1 |
| `references/patchstack-scope-gate.md` | at the preflight after gate zero, and again at V1 |
| `references/target-classes.md` | at the preflight, to fill `target_class` |
| `references/vendor-programmes.md` | at the preflight, before either program gate |
| `references/premise-reduction.md` | at the preflight, whenever a Lead's premise is unresolved |
| `references/family-playbooks.md` | at V2/V3, only the section for that Lead's class |
| `references/lab-workspace.md` | before writing any script |
| `references/walk-card.md` | at step 9, for every Finding that ends `reproduced` |

`references/vulnerability-determination.md` is gate zero, and it is read first because it decides
whether the scope question arises at all. The scope gates answer "would this program accept it";
neither of them answers "is this a vulnerability", and running them first quietly assumes that second
question is already settled. Gate zero fills `scope_assessment.vulnerability_determination` —
`verdict`, `boundary_crossed`, `asset_owner`, `consequence` — and any `verdict` other than
`established` moots both program gates, because the Lead does not reach Stage 1 whatever they would
have said. Like the gates it is scope-only and opens no source: it judges whether the Lead *states* a
vulnerability, not whether one exists in the code. Keep `not-established` distinct from out of scope —
out of scope means a program's clause rejects a real vulnerability, `not-established` means we do not
yet know there is one — and do not let a program `cond` stand in for that doubt.

Before either program gate, settle one question that no capture states and no source answers:
**does the vendor run its own public bug bounty programme?** If it does, Wordfence rejects the
submission automatically on arrival — `wf/assets/vendor-own-programme` — whatever the severity, the
install count, or how recently Wordfence published other advisories against the same plugin. It cost
a Lab, a walk, a package and a submission slot to learn this once.

`python3 tools/vendor_gate.py check --slug <slug>` answers it. Exit 1 means the vendor takes its own
reports, and the output names where. The same check runs at `queue_discovery.py add`, so a Target
that came down the queue has already passed it -- but a Lead that entered any other way has not, and
a vendor confirmed after the lane started would not have been caught either.
`references/vendor-programmes.md` is the reasoning behind the data file the check reads.

The two scope gates are peers and neither is primary. Read both at the preflight and both again at V1: the same Lead legitimately gets opposite verdicts, so one gate's answer never stands in for the other's.

`references/scope-captures/` holds the verbatim published rules behind both gates, as received on 2026-08-20. Consult a capture when a gate document and a program's own text appear to disagree — the capture wins over the gate. The two captures are not built the same way, and reading one program's posture onto the other is the most expensive mistake available here. Only Wordfence uses non-exhaustive language, and only about its two rejection lists — Out of Scope Assets, and Common False Positive Reports. Its accept side is deliberately open: all issues with a considerable impact on a site's confidentiality, integrity, and availability are in scope, which is why a severe class matching no named id still has somewhere to land at `wf/in-scope/other-considerable-cia`. Patchstack's opening line says the opposite — a report must meet at least one of the listed criteria, and one falling outside them is rejected — and it closes its rejection list the same way. So a type Patchstack does not name is not accepted there however severe it is; do not carry Wordfence's open accept side across, and do not reach for the nearest-sounding `ps/in-scope/…` id to rescue an unlisted class. Neither posture is licence to invent a clause: a rejection that is in neither capture is not a rule, inventing an exclusion destroys the meaning of the ones that passed, and a rejection you cannot pin to an id in that program's own vocabulary is not a rejection.

The schema is the rule table and every enum — the two per-program `matched_rule_id` vocabularies under `programs.wordfence` and `programs.patchstack`, `terminal_class` and `premise_class` under `target_class`, plus `attacker_level`, `band` (Wordfence only), `decision`, `stage`, `rejection_category`. The two rule-id vocabularies are disjoint: a `wf/…` id is never valid under `patchstack` and a `ps/…` id is never valid under `wordfence`. The references name ids; the schema is where the ids are defined. The prose never overrides the contract: where a reference and the schema disagree, the schema is right.

## Execution

1. Read the playbook to the end, and the rest at the moments above.
2. Confirm the Target Snapshot ID, version, archive/source-tree hash, the four binding values in `leads.json`, and the Lead ID. Do not mix source, setup, or PoC from a different Snapshot or version.
3. Run the whole package through the batch order in the playbook §2: scope-only preflight → V0 → V1 for every Lead, before any V2/V3. The preflight is scope-only throughout: it works from `attacker_role`, `claim`, `terminal_outcome` and the Target metadata alone, never opens plugin source, and treats the technical claims as true. Settle gate zero first — `vulnerability_determination` — and run the two program gates only on an `established` verdict, producing **two** verdicts per Lead, one per program. A Lead proceeds only when gate zero says `established` **and** at least one program has not rejected it — `destinations` non-empty, `stage1_eligible` true. It stops at preflight either way: a `not-established` or `not-a-vulnerability` verdict ends it whatever the program gates would have said, and so does rejection by both programs. Do not start a Docker Lab until every Lead is a preflight decision, a V0 rejection, or a V1 decision.
4. Put only the Leads that need V2/V3 into a fresh, plain WordPress Docker Lab, one workspace per plugin under `$WP_BOUNTY_WORKSPACE/labs/<target-snapshot-id>/`, with WordPress, PHP, database, and plugin versions pinned. If there is no candidate, finish with `environment.lab_started=false`.
5. You **may** write Lead-specific setup / diagnostic / exploit-client scripts, only under the workspace's `research/` and recorded in `script-manifest.json`. Do not build a general-purpose exploit generator or a cross-class scanner framework. Use WP-CLI and `docker exec` only for installation, activation, fixtures, and limited observation; send exploits from the real HTTP or browser surface.
6. Follow `family-playbooks.md` for class-specific proof — not only SQLi/XSS but file actions, path traversal, authentication/account/privilege, options/site-state, deserialization/callback/code execution, and sensitive disclosure.
7. Save the Finding-specific tested PoC with no placeholders, the environment, the successful observation, the Negative Control, and the evidence hash to private storage.
8. Build a `verification-package/v4` and validate it with **both**:
   - `python3 tools/validate_artifact.py --contract verification-package PATH`
   - `python3 tools/check_source_quotes.py PATH --snapshot-root "$WP_BOUNTY_WORKSPACE"`

   v4 requires `scope_assessment` on every `lead_decision` — it is no longer optional — and inside it
   all twelve of `vulnerability_determination`, `terminal_primitive`, `reclassified_class`,
   `impact_dimensions`, `security_impact`, `attacker_level`, `premise_weight`,
   `decisive_scope_question`, `target_class`, `programs`, `destinations` and `stage1_eligible`.
   Gate zero comes first, and `programs` carries **two peer program verdicts** where v3 carried one.
   `reclassified_class` is not cosmetic: it is the vulnerability statement as the submission form
   would carry it — `Stored XSS (site-wide) (admin only)`, never `admin-panel XSS leading to RCE`
   and never a bare `IDOR` — because whether stored XSS is site-wide decides
   `ps/in-scope/xss-stored-site-wide` against `ps/mvdp/stored-xss-not-all-pages`, and the auth level
   decides the Wordfence attacker ceiling. `vulnerability_determination` is gate zero on the record: a `verdict` of
   `established`, `not-established` or `not-a-vulnerability`, with `boundary_crossed`, `asset_owner`
   and `consequence`. Omitting it fails validation. `programs.wordfence`
   and `programs.patchstack` each take their own `outcome` (`in` / `cond` / `out`), `matched_rule_id`
   and `matched_rule`; Wordfence additionally takes `band`. Beside them sits a program-independent
   `target_class` — `terminal_class`, `premise_class`, `rationale` — which is the researcher's own bar,
   not a program rule, and is never folded together with the program verdicts. Two derived fields close
   it out: `destinations`, the programs whose `outcome` is `in` or `cond`, and `stage1_eligible`, true
   exactly when `destinations` is non-empty. It requires a `role` on every `source_path` hop, a
   chain that runs from at least one `entry` to at least one `sink`, a `quote` on every `guard`,
   `transform` and `sink` hop, and a `defeat` on every `guard` and `transform` hop. The checker then
   binds each quote byte-for-byte to the pinned Target Snapshot; it exits 65 if a quote does not match
   the cited line and 74 if a path escapes the snapshot root. Paraphrasing the source will not pass, so
   paste it. Use `--contract verification-package-v2` or `verification-package-v1` only for legacy
   packages; those two are frozen and still carry stored work — 103 packages are v2 and 12 are v1.
   There is no v3 contract to name: v3 was designed but no package was ever written in it, so the
   schema was removed rather than left as a validation target that matches nothing. If you ended at
   preflight/V0/V1 and never started a
   Lab, set `environment.lab_started=false` and leave the runtime versions null rather than
   fabricating them.
9. Update the private Case's verification status to one of `not-planned`, `source-rejected`, `runtime-rejected`, `blocked`, or `reproduced`. Do not use the legacy `rejected` for new Cases.
10. For every Finding that ends `reproduced`, write `walk.md` beside the Case, in the shape
    `references/walk-card.md` sets: setup, artifact, trigger, success, and nothing else. It is the
    handover to the human, who builds the Lab with `python3 tools/lab_new.py new`, boots the
    compose file it prints, then does the WordPress install, plugin activation, and any account
    setup themselves in the browser -- the card is what guides that, so it starts from a reset
    Lab and not from a state a script left behind. Substitute every value for that lab — a card carrying `YOUR-SITE`
    or an unresolved id was written for nobody. What the human corrects while walking is what the
    submission's Proof of Concept is written from, so do not write the card as a transcript of the
    Lab's own twenty steps.

## Confidentiality boundary

- Do not write exact Leads, Findings, endpoints, source paths, payloads, PoCs, requests/responses, HAR, browser evidence, or verification packages into Git.
- Store Labs, evidence, Cases, and PoCs under `WP_BOUNTY_WORKSPACE` or a non-Git submission root.
- Do not leave credentials, cookies, nonces, or disposable secrets in ordinary logs or in Git.
- Do not send requests to public targets, third-party environments, or vendor systems.

## Completion

You may suggest `prepare-wordfence-submission` when moving on to submission prep, but do not launch it automatically. In the final response give only the private paths, the final stage/status per Lead, the Finding count, and the main rejection categories; do not needlessly duplicate payloads or unpublished details into the conversation.
