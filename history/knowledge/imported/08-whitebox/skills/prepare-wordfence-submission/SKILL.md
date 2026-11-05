<!-- provenance: /home/dev/wp-bounty-deploy/skills/prepare-wordfence-submission/SKILL.md, mtime 2026-08-22, imported 2026-10-13, generation 08-whitebox -->

---
name: prepare-wordfence-submission
description: From a WordPress Finding that verify-wordpress-leads marked reproduced, or a compatible Finding group, build an evidence-bound private Wordfence report, canonical fill-only JSON, and tested PoC attachment. Use for "Wordfence report", "write the submission text", "write the Description and PoC", "submission JSON". Does not launch another Skill and does not submit a live form.
---

# Prepare a Wordfence Submission

Accept only a Report Group that `verify-wordpress-leads` marked `reproduced`. Write the form-facing report body in English and keep claims within the range of the verification package and the tested PoC.

## Preparation

1. Read `references/wordfence-report.md`.
   Then run `python3 tools/past_pocs.py --class <class>` and read the Description and Proof of
   Concept of at least one package of the same class that was paid, with `--show <package>`. The
   template sets the shape; the corpus sets the register, the length and the level of detail that
   this program has actually accepted. The same class has shipped at 158 words and at 1,998.
2. Re-confirm the current official Wordfence scope, target release, active installs, and public duplicate status.
3. Confirm the Report Group does not combine incompatible attackers, root causes, impacts, or fixes.
4. Confirm the verification package, successful observation, environment, tested PoC, evidence hashes, and the walked `walk.md` are present. A near-miss control belongs in the form-facing PoC only when the observation is an inference — a delay, a size difference, a race, an out-of-band callback. When the observation is a dialog naming the target host, a database value in the response, a file that appeared or an account that logged in, ship it alone; the verification package keeps its Negative Control either way.
5. Write the English Description, environment/configuration, a concise numbered PoC, the impact statement, and the smallest tested code that preserves the demonstrated path. Start the numbered procedure from normal WordPress login and product configuration when installation and activation are already stated as prerequisites.
   **The PoC comes from the Case's `walk.md` as the human left it after walking it**, in the fixed
   per-class shape in `assets/wordfence-report-template.md`. Do not compose it from the verification
   package and hand it over to be checked: that is what made the steps performed and the steps
   claimed drift apart. A step the human did not perform does not appear, and a step they added
   while walking does.
6. Remove research-only interaction, state rendering, telemetry, artifact management, worker orchestration, and unused impact stages from the submission PoC. Keep the per-step PASS/FAIL diagnostics, the runtime self-discovery of nonces, ids and version, and the control lines — a triager runs this against their own site. When the submission code differs from the verification harness, run the exact compact code end to end through the claimed terminal before using it.
7. Build `wordfence-fill-only/2` JSON conforming to `assets/wordfence-fill.schema.json` and pass schema validation.
8. Run `python3 tools/report_check.py check --package <output dir>` and fix everything it names.
   Schema validation is not this check: the schema types `authentication` as a string, so all three
   packages written before this existed say `Unauthenticated` — a value the form's dropdown does not
   have, which stops the Fill-Only Extension on the field. It also counts the Description against
   its 120-word cap, the Impact Statement against 150 characters, and the PoC against the per-class
   step shape, none of which anything counted before. `report.md` is checked against the fill JSON
   and never the other way round: the extension submits the JSON.
9. Compare the report, exact compact PoC, evidence hash, and fill JSON for drift in version, endpoint, parameter, payload, and step.
10. Include a recording in the attachments only when a valid video package has already been provided and it materially helps understanding of the report. Do not launch another Skill to produce a video.
11. Save the submission package to a non-Git root such as `/mnt/d/wordfence/submissions` and update the private Case to `drafted`.

## Fill-Only Extension

`assets/fill-only-extension/` is a helper that fills private JSON into the Wordfence form.

- Do not automate Submit.
- A human performs Other Details, researcher identity, AI-use disclosure, legal confirmation, CAPTCHA/2FA, and the final review.
- Release the guard feature only after the human final confirmation.

## Confidentiality Boundary

Do not write the report body, fill JSON, tested PoC, source trace, payload, request/response, evidence, or vendor communication into Git. Do not generate them temporarily inside the repository and delete them later either.

## Stop

Advance to `human-confirmed` only after a human has manually reproduced with the tested PoC. Only a human can change it to `submitted`, after the actual form operation. The Skill does not operate the live form.
