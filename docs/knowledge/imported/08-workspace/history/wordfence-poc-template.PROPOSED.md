<!-- provenance: /home/dev/wp-bounty-workspace/history/wordfence-poc-template.PROPOSED.md, mtime 2026-08-13, imported 2026-10-13, generation 08-workspace -->

# Wordfence PoC Template + Harness — `wf-poc-template.md`

> Derived from the owner's verbatim submissions and Wordfence's recorded triage rationale. Every rule below traces to a specific outcome. Sections marked **[SHOWS]** are read directly off the record; **[INFER]** are reconstruction. [件別の表は Git 外: /home/dev/wp-bounty-workspace/history/wordfence-poc-template.PROPOSED.md の該当節]

---

## 0. The governing principle

Triage friction, not validity, is the cost driver. Two of the owner's reports written in the same period were both validated with a bounty proposed; one (an Urgent-priority account takeover) cost ~10h across 5 triage rounds, the other (an unauthenticated SQLi) had zero friction. The delta was entirely in PoC construction, not bug quality. **[SHOWS]**

The template's job: make the triager unable to reach a wrong conclusion, and unable to get stuck without the PoC itself telling them why.

---

## 1. Canonical PoC structure (numbered sections)

Use these section headings verbatim, in this order. Sections 9–11 are what separate the paid reports from the unpaid-but-accepted ones. **[SHOWS]**

```
1.  Title
2.  Description
3.  Affected Component
4.  Preconditions  (general rule → one concrete instantiation)
5.  Environment Specification  (field-path triples + machine-checkable assertions)
6.  Reproduction
7.  Expected Output  (verbatim stdout / verbatim response bytes)
8.  Negative Controls
9.  Vulnerable Code  (path + line numbers + quoted source)
10. Attack Chain Summary  (numbered causal steps: why each layer fails)
11. Known Confusing Artifacts  (false-negative pre-emption)
12. Observed Result / Expected Result
13. Impact
14. Suggested Remediation
15. Disclosure  (AI-assistance statement — program requirement)
```

### 1.1 Title

Wordfence's own naming convention, as published:

```
<Plugin Name> <= <ver> - [Unauthenticated | Authenticated (<Role>+)] <Class> via '<param>'
```

Evidence — the owner's published titles follow exactly this shape. **[SHOWS]** [件別は Git 外]

### 1.2 Description — write it in Wordfence house style

Wordfence rewrites descriptions into a fixed boilerplate. Submitting text already in that shape means nothing gets lost in translation. The SQLi boilerplate is literally:

> "…is vulnerable to SQL Injection via the '<param>' parameter in all versions up to, and including, <ver> due to insufficient escaping on the user supplied parameter and lack of sufficient preparation on the existing SQL query. This makes it possible for <priv> attackers to append additional SQL queries into already existing queries that can be used to extract sensitive information from the database."

That clause appears verbatim both in one of the owner's *published* SQLi records and in the frictionless report as submitted. **[SHOWS]** The Missing-Authz boilerplate is *"…due to a missing capability check on the `<fn>()` function… This makes it possible for authenticated attackers, with <Role>-level access and above, to <effect>."*

Then append one sentence Wordfence's boilerplate does **not** contain but which pre-empts the "nonce = protection" objection: state that the action performs no capability check, which callers it is registered for, and that the nonce guarding it is served at the attacker's privilege level. Wordfence keeps that detail in the published text when you supply it. **[SHOWS]**

### 1.3 Preconditions — the F4 shape

Two paragraphs, always in this order:

1. **General rule.** The full class of environments in which this fires.
2. **Concrete instantiation.** One specific setting, labelled as an example, not as the condition.

F4 happened because the report stated one concrete value of a setting where the real condition was "the victim's WordPress core locale matches ANY published non-default language of the plugin"; it was later proved with a second value. Stating the instance as the rule made the finding look narrower than it was and forced a clarification round. **[SHOWS]**

Template:

```markdown
### 4. Preconditions

**General condition (the actual rule):**
<precise class statement, quantified — "ANY", "at least one", "of any role that can X">

**Concrete instantiation used in this PoC (one example of the above, not the condition itself):**
<the specific values in the reproduction environment>

**Verified generality:** reproduced additionally with <second instantiation>, confirming the
condition is <rule> and not <the narrow instance>.
```

Also state what you did **not** rely on (e.g. that a given table held no rows during the run). That single sentence forecloses "your DB was seeded". **[SHOWS]**

---

## 2. Environment Specification rule set (the F2 fix)

F2 cost ~4 hours and nearly killed a valid Urgent report: a setup step named a setting by its label, and the page carried **two** controls with that label — one owned by WordPress core, one by the plugin. The triager set the plugin one; only the core one works. **[SHOWS]**

### Rule ENV-1 — every setup step is a *field-path triple*

No setup step may be prose. Each is:

```markdown
- **Screen:** <exact admin screen + URL path>
- **Section:** <exact heading text of the enclosing fieldset/section as rendered>
- **Field:** <exact label text of the control, as rendered>
- **Set to:** <exact option string as rendered in the dropdown/input>
- **NOT the field named:** <same-or-similar-named neighbour> in section <its section>.
  Setting that one does not reproduce the issue.
- **Verify:** <wp-cli / SQL / HTTP assertion that proves the state was set>
```

Worked example: [件別の手順は Git 外: 元 file 第 2 節。失敗した 1 手順を field-path triple（Screen / Section / Field / Set to / NOT the field named / Verify）に書き直した例]

### Rule ENV-2 — every UI step carries a machine-checkable assertion

The `Verify:` line must be a command or request whose output the triager can compare, not a visual check. UI state is where ambiguity lives; `wp user meta get`, `wp option get`, `wp plugin list --status=active`, or a `curl | grep` are unambiguous. **[INFER]** — supported by the fact that the *only* step in Report A that ever went wrong was the one with no assertion.

### Rule ENV-3 — disambiguate proactively, not on request

Before writing the spec, load the settings screen and grep the rendered HTML for duplicate/near-duplicate label text. Any label appearing twice, or any label whose words appear in another control's label, gets an explicit `NOT the field named:` line. This is mechanical and cheap; F2 shows the cost of skipping it is four hours.

### Rule ENV-4 — prefer zero-configuration

Report B's step 1 reads: *"No further configuration is needed and the plugin's widget library may be empty."* Zero-config PoCs have no ENV steps to get wrong, and that report had zero friction. **[SHOWS]** Where a vector exists in both a configured and an unconfigured form, submit the unconfigured one.

### Rule ENV-5 — configure through the product UI, never by seeding tables

Report D states it explicitly: *"Configure this through the normal settings UI rather than seeding the plugin's tables directly, so the result reflects ordinary product state."* This pre-empts the single most damaging triage objection — that the vulnerable state is artificial. That objection is exactly what killed three of the owner's reports on one backup/migration plugin: all three were rejected because the entry point was a one-time installer script the site owner is expected to remove. Unrealistic premise = rejection even with a confirmed RCE chain. **[SHOWS]**

---

## 3. The Python harness skeleton

[PoC harness skeleton（Python、約 360 行）は Git 外: 元 file 第 3 節。要点: 全 ID / nonce / version を runtime で discover して print する（scan 上限を hardcode しない）、環境手順 1 行 = `step()` 1 つで PASS/FAIL と likely_causes / how_to_fix を出す、positive が成立し全 negative control が不成立のときだけ `terminal_reproduced` を立てる、`--no-controls` は開発用で提出物に入れない]

### 3.1 Harness invariants (enforce in review)

| Invariant | Failure it prevents |
|---|---|
| No literal hostname, user, password, ID, or bound anywhere outside `build_argparser` | F1 |
| Every unknown quantity goes through `discover_*` or `expanding_scan`, and is echoed via `record()` | F1 — the frictionless report printed the detected plugin version; the high-friction one hardcoded a scan bound and the row landed above it |
| One environment-spec line ⇒ one `step()` with causes + fixes naming the wrong field | F2, F3 |
| `terminal_reproduced` is set only if all steps PASS **and** all controls are NEGATIVE | prevents shipping a green run whose control also fired |
| A POSITIVE control prints `INCONCLUSIVE`, never `VULNERABLE` | protects against environment-attributed false positives |
| `--no-controls` exists but is documented as not-for-submission | keeps the fast dev loop without letting it into the package |

The diagnostic mode is not a separate script. In the high-friction report the researcher had to build a separate diagnostic script mid-triage — *"THAT is what finally unblocked it"*. **[SHOWS]** This skeleton makes the exploit script and the diagnostic script the same artifact, so the diagnostic ships first by construction.

---

## 4. Pre-submission checklist

Run top to bottom. Anything unticked blocks submission. The F-column names the documented failure each item catches.

### A. Harness integrity

- [ ] **(F1)** `grep -nE "https?://|localhost|range\(|\b(admin|victimadmin|NewPass|wp_)[A-Za-z0-9_]*\b" poc.py` — every hit is inside `build_argparser` defaults or a docstring. No literal in exploit logic.
- [ ] **(F1)** Every ID-space walk uses `expanding_scan` with `cap=args.max_scan`. Zero `range(` literals in exploit logic.
- [ ] **(F1)** The failure message for an exhausted scan tells the triager the flag to raise and by how much.
- [ ] **(F1)** Ran once with `--max-scan` set to a *deliberately too-small* value; confirmed the FAIL output alone is enough to self-correct.
- [ ] **(F3)** Ran once against a **clean, unconfigured** site: confirmed the first FAIL names the missing configuration step and its exact field path.
- [ ] **(F3)** Every `step()` has ≥2 `likely_causes` and ≥2 `how_to_fix`, and each `how_to_fix` is a runnable command or an exact UI path — not advice.
- [ ] The run prints a single JSON dict ending in `"terminal_reproduced": true`.
- [ ] Deliberately broke one precondition and confirmed the output says `NOT REPRODUCED`, never `VULNERABLE`.

### B. Environment specification

- [ ] **(F2)** Every setup step is a field-path triple: Screen + Section + Field + exact value.
- [ ] **(F2)** Grepped the rendered settings/profile HTML for duplicate or overlapping label text; every collision has an explicit `NOT the field named: …` line.
- [ ] **(F2)** Every UI step carries a `Verify:` command whose expected output is pasted.
- [ ] **(F2)** A second person (or a clean session with no prior context) followed the spec verbatim and reached `terminal_reproduced: true` without asking a question.
- [ ] **(ENV-5)** All state was created through the product UI, not by seeding DB tables — and the report says so.
- [ ] **(ENV-4)** Configuration was minimised; if a zero-config variant of the vector exists, that one is the submission.

### C. Precondition generality

- [ ] **(F4)** Preconditions are written as a **general rule first**, with the concrete setting labelled as one instantiation.
- [ ] **(F4)** The rule was tested with a **second** instantiation (a second value of the same setting) and that fact is in the report.
- [ ] **(F4)** No sentence in the report names the example value where the rule is meant.
- [ ] Everything *not* relied on is stated ("the addon table held no rows during this run").

### D. Controls and evidence

- [ ] At least two negative controls, each removing **exactly one** variable.
- [ ] Where the sink is browser-rendered, an **inline near-miss control** differing by one character ships in the same artifact as the payload.
- [ ] XSS payloads use `alert(location.host)`, not `alert(1)`.
- [ ] XSS payloads set a JS global so the result survives dismissing the dialog.
- [ ] Verbatim expected stdout / response bytes pasted into the report.
- [ ] **Vulnerable Code** section: file path + line number + the offending lines quoted. *(Present in both of the owner's highest-paid reports.)*
- [ ] **Attack Chain Summary**: numbered causal steps stating why each sanitisation layer fails. *(The model: a numbered chain explaining how a store-time encoding is reversed at render time and then reaches an unescaped sink.)*
- [ ] **Known Confusing Artifacts** section written. Anything a triager could misread as a failed exploit is called out in advance. *(e.g. an unrelated HTTP 500 returned after the write, which would otherwise read as a false negative although the data is persisted.)*

### E. Program-fit gates (from `wordfence-verdicts.md`)

- [ ] **Realistic-premise gate.** No step in the chain depends on an artifact the site owner is expected to delete or on a non-default stack the plugin doesn't itself require. Three of the owner's reports on one backup/migration plugin were rejected on exactly this (one-time installer script expected to be removed); another report was voluntarily held for stacking a second plugin plus a specific public-page artifact on top of the plugin's own dependency. **[SHOWS]**
- [ ] **Impact gate.** The terminal effect reaches credentials, account material, arbitrary tables, PII, or a state change of value. One of the owner's SQLi candidates was marked not-planned because the injection only widened one query over already-visible content and reached no arbitrary tables, credentials, or account material. **[SHOWS]**
- [ ] **Crowding gate.** Count records published on this slug in the prior 180 days. The owner's scored submissions give mean prior-180 crowding of **1.45 for PAID** vs **3.25 REJECTED / 2.75 DUPLICATE / 3.12 accepted-unpaid**. At ≥3, expect a duplicate; either find a materially distinct route or accept the odds knowingly. **[SHOWS]**
- [ ] **Duplicate pre-emption.** If the parameter may be covered by an existing advisory, say so and invite the duplicate ruling explicitly, and attach the version diff proving the published patch did not touch this sink. **[SHOWS]**
- [ ] **Environment factual audit.** Rebuild the lab from scratch and re-verify every factual claim in the report. One of the owner's cases caught a false Environment claim this way: the plugin created a default record on activation, so a claim that a listing returned 0 rows was wrong. **[SHOWS]**
- [ ] AI-assistance disclosed (program requirement, recorded on every submitted case).

---

## 5. curl-only vs Python

### 5.1 Decision rule

**Use curl-only** when *all four* hold:

1. Every input is a literal or a single greppable token.
2. The whole chain is ≤ ~5 requests.
3. No ordering, timing, or session-state dependency.
4. The proof is **visible text in a response body** the triager can read directly.

**Use the Python harness** when *any* hold:

1. An ID/row/offset must be found in an unbounded space → `expanding_scan`. *(This is precisely F1.)*
2. Multi-step state transition where an intermediate value feeds the next request (nonce → dictionary read → reset key → redeem).
3. The proof is a **before/after boolean** rather than a visible string (old password fails / new password works).
4. Preconditions can be mis-set, so the artifact needs to self-diagnose.
5. More than two negative controls, or controls needing programmatic comparison.

### 5.2 What the record shows

The curl-only reports are the two highest payouts in the owner's record (one SQLi proved in four curl steps, one stored XSS). **[SHOWS]** I read this as *correlation with bug simplicity, not causation from the tool* — a bug whose whole proof fits in four curl lines is a bug with almost no surface for the triager to get lost on. **[INFER]** The high-friction report needed Python and would have needed it regardless; its cost came from the harness lacking discovery and diagnostics, not from being Python. [件別は Git 外]

### 5.3 Hybrid — the recommended default for anything non-trivial

Ship both, labelled:

1. **Primary vector (curl):** the minimal request that causes the effect — copy-pasteable, no interpreter, no dependency.
2. **Verification harness (python):** discovery, staged PASS/FAIL, controls, JSON observation dict.

The curl block gets the triager to a result in 30 seconds; the harness tells them why when it doesn't work. Report B effectively achieved both in one script because the bug was simple enough (self-fetching nonce, printed version, exact stdout, two controls) — that is the target shape.

---

## 6. Inline near-miss controls

### 6.1 Rules

1. **One character.** The control differs from the payload by exactly one character, and the report names which one (e.g. one letter of an event-handler name, or one character of a marker token). **[SHOWS]**
2. **Same artifact, same request.** Both arms go in **one** submission, sent together. Same author, same moderation, same processing pass, same render. The triager cannot attribute the difference to the environment because there is only one environment.
3. **Both arms machine-checkable.** A two-sided assertion on two JS globals (payload set, control unset), both evaluated after dismissing the dialog. A dialog alone is not evidence once dismissed.
4. **Prove delivery independently of execution.** Report D step 7: *"The control's payload text remains visible on the page, so the difference in outcome is in the decoding and not in delivery."* The control must demonstrably *arrive* and merely not *fire*; otherwise "your control was filtered upstream" is live.
5. **`alert(location.host)`, never `alert(1)`.** Proves same-origin execution rather than mere script execution.
6. **Enumerate what is held constant.** Report D: *"the search surface, JavaScript body, theme, browser, and translated page are identical."* Write that list out.

### 6.2 Canonical inline pair (stored XSS)

[payload と control の対、および verdict 行は Git 外: 元 file 第 6.2 節。payload と 1 文字だけ違う control を同一 artifact で送り、両 arm を JS global で機械判定し、両者が同じ保存・変換・描画経路を通ったことを verdict 行に書く]

### 6.3 Harness-side controls (non-browser sinks)

The frictionless report's model: run the positive, then two controls each removing exactly one thing — **(A)** the parameter shape that triggers the defect replaced by the benign shape, **(B)** the nonce omitted — and print `VULNERABLE` only if the positive returns data **and** both controls return nothing. Quote the byte counts of the control responses: a byte count is a diffable fact, "nothing happened" is not. **[SHOWS]** Add a third control where possible that changes the *code path* rather than the request — a patch-side control (restricting the input to a fixed list removed the behaviour with the request unchanged) is the strongest form of proof available.

---

## 7. One-page quick reference

```
TITLE      Plugin <= ver - [Unauth|Auth (Role+)] Class via 'param'
DESC       Wordfence boilerplate + one sentence on why the nonce is not a guard
PRECOND    general rule FIRST, concrete instance SECOND, second instance as proof
ENV        Screen / Section / Field / Set to / NOT the field named / Verify
REPRO      curl primary vector  +  python harness (discovery, STEP n PASS/FAIL)
STDOUT     pasted verbatim
CONTROLS   >=2, each removes exactly one variable; inline near-miss for browser sinks
CODE       file path : line number : quoted offending lines
CHAIN      numbered steps, why each sanitisation layer fails
ARTIFACTS  pre-empt anything that looks like a failed exploit
VERDICT    one JSON dict, one boolean: terminal_reproduced
GATES      realistic premise / real impact / prior180 crowding < 3 / duplicate pre-empted
```

**The three lines that most reliably remove friction, verbatim from the frictionless report (B):** *"No further configuration is needed."* · *"The output should look like the following: [exact stdout]"* · *"Each removes exactly one thing from the request that produced those values."*