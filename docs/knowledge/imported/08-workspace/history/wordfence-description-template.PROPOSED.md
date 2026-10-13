<!-- provenance: /home/dev/wp-bounty-workspace/history/wordfence-description-template.PROPOSED.md, mtime 2026-08-13, imported 2026-10-13, generation 08-workspace -->

# Wordfence Intelligence — Description house style, reverse-engineered

Derived from 38,456 published Wordfence Intelligence records (refreshed 2026-08-12), the record corpora of
three high-volume researchers, the owner's published records, the owner's verbatim submitted descriptions
with outcomes, and the owner's rejected / unpaid triage outcomes. [件別の表は Git 外: /home/dev/wp-bounty-workspace/history/wordfence-description-template.PROPOSED.md の該当節]

Everything in quotes below is a **literal string counted in the corpus**. Counts are in `[n]`.

---

## 0. What the data actually says about style

| Claim | Evidence |
|---|---|
| "is vulnerable to" is the mandatory opening verb phrase | present in 34,176 / 38,456 descriptions (**88.9%**) |
| "This makes it possible for" is the mandatory impact-sentence opener | 33,221 (**86.4%**) |
| Version range clause is fixed boilerplate | "in all versions up to, and including," 15,737 (40.9%); "in versions up to, and including," is the older variant |
| The house style is enforced at publication, not at submission | the owner's two highest-paid reports were submitted in **non-canonical** prose ("has an unauthenticated ... vulnerability in versions up to ...") and Wordfence rewrote them into canonical form before publishing |

**Therefore — the honest calibration:** writing in house style does **not** buy severity or bounty. What it
buys is that the triager reads your impact clause as-written instead of rewriting it, and your
*chosen impact nouns survive into the published record*. The measurable severity lever is **which
impact nouns you use**, not prose polish (see §7).

Measured: for 2026 Missing Authorization records, descriptions whose impact clause is the generic
"to perform an unauthorized action." average **CVSS 4.92** [n=876]; descriptions with a
plugin-specific impact clause average **CVSS 5.43** [n=490]. Same class, +0.51 mean CVSS.

---

## 1. Reverse-engineered house style rules

### 1.1 Sentence order (canonical, in this order, no exceptions)

```
S1  IDENTITY + CLASS + VECTOR + VERSION + [inline root cause]
S2  ROOT CAUSE — "This is due to ..."          (omit when S1 carried the boilerplate cause)
S3  MECHANISM — 1-2 sentences, source-level, optional
S4  IMPACT — "This makes it possible for <PRIV> to <ACTION> ..."
S5  CONDITIONS — only when material
```

There are exactly **two legal shapes** for S1+S2:

- **Fused** (used when the root cause is one of the ~6 boilerplate causes):
  `... is vulnerable to <Class> via <Vector> in all versions up to, and including, <Ver> due to <boilerplate cause>.`
  Example [775 SQLi records]: *"...is vulnerable to SQL Injection in versions up to, and including, VER due to insufficient escaping on the user supplied parameter and lack of sufficient preparation on the existing SQL query."*

- **Split** (used when the root cause is plugin-specific — this is what PRISM and 2026-era
  records overwhelmingly use, and what Wordfence rewrote the owner's reports into):
  `... is vulnerable to <Class> via <Vector> in all versions up to, and including, <Ver>. This is due to <specific cause>.`
  Real example: [所有者の公開 record の実例は Git 外: 元 file 第 1.1 節。split 形で S2 に function 名と機構の順序を書いた published record]

**Use the split shape.** It is the only shape that lets you name a function, a file, and a hook,
and it is the shape the specific-impact records (higher mean CVSS) use.

### 1.2 Hard rules

1. **Subject is always the plugin, never the researcher, never "we", never "I".**
   `The <FULL wp.org plugin display name> plugin for WordPress is vulnerable to ...`
   Themes use `The <Name> theme for WordPress`. The name is the **full** display name including the
   marketing tail — corpus records really do read *"The GamiPress – Gamification plugin to reward
   points, achievements, badges & ranks in WordPress plugin for WordPress is vulnerable to..."*
   The double "plugin ... plugin for WordPress" is correct house style. Do not shorten.
2. **Present tense, indicative, third person, active voice.** "is vulnerable to", "makes it possible
   for", "does not verify". Never "was found to be", never "could allow", never "an attacker could".
3. **Never say "has a vulnerability"** — the corpus verb is *is vulnerable to*. One of the owner's
   submissions used "has an unauthenticated ... vulnerability" and was rewritten.
4. **Version clause is a fixed string.** Prefer `in all versions up to, and including, <VER>`
   (dominant from 2024 onward: 5,599 in 2024, 6,591 in 2025, 2,851 in 2026). Legal variants only:
   `in versions up to, and including, <VER>` (older house form, still in use),
   `in all versions up to <VER> (exclusive)` [90 in 2026] when the fix landed in `<VER>` itself,
   `in versions <A> to <B>` when the flaw was introduced mid-range.
   **Never claim a range wider than you tested and can support from source.**
5. **One paragraph. No headings, no bullets, no line breaks, no markdown inside the Description field.**
   Max ~160 words.
6. **Parameter names in single straight quotes**: `the 'addontype' parameter`. Function names get
   parentheses: `the save_widget() function`. Hooks/actions/endpoints appear bare or in backticks —
   both occur; single quotes are the safer default.
7. **No severity rhetoric.** No "critical", "severe", "trivially", "devastating", "high impact",
   "full compromise" as an adjective. Severity is the triager's field, not yours. Impact is stated
   as a *capability*, not as an adjective.
8. **No meta-commentary.** No "this report", "as demonstrated", "I verified", "in my lab", "the PoC
   shows", "AI-assisted", "reproducible". None of that appears in any published record.
9. **No CVSS, no CWE number, no CVE in the description body.** Those are separate form fields.
10. **Chained findings**: state the chain inside S3 as ordered mechanism, but the class in S1 must be
    the **single** class you selected in the dropdown.

### 1.3 The vector clause (`via ...`)

`via` is used in 9,380 records (24.4%) and is optional in S1 but strongly preferred. Legal forms,
all attested:

| Form | Use when | Example count |
|---|---|---|
| `via the '<param>' parameter` | HTTP/AJAX/REST parameter | dominant across SQLi/RXSS |
| `via the '<attr>' shortcode attribute` | shortcode attribute | GamiPress `'heading_size'` [PRISM] |
| `via the '<attr>' block attribute` | Gutenberg block attribute | WP Delicious `'steps'` [PRISM] |
| `via admin settings` | settings page field, no single param | 662 StoredXSS records |
| `via the '<fn>' function` | no user-facing param name | ArbFileUpload/SSRF |
| `via deserialization of untrusted input` | PHP Object Injection — **mandatory** | 359+107 |
| `via a missing capability check on the '<fn>' function` | Missing Authorization | 1,200+933 |
| `via account takeover` | privilege escalation ending in ATO | 71 |
| `via the '<param>' user controlled key` | IDOR | 137 |

---

## 2. Master template (named slots)

```
The {PLUGIN_DISPLAY_NAME} plugin for WordPress is vulnerable to {CLASS} via {VECTOR} in all versions
up to, and including, {TESTED_VERSION}. This is due to {ROOT_CAUSE}. {MECHANISM} This makes it
possible for {PRIVILEGE} to {ATTACKER_ACTION}{IMPACT_TAIL}. {CONDITIONS}
```

| Slot | Fill rule | Failure mode if wrong |
|---|---|---|
| `{PLUGIN_DISPLAY_NAME}` | Exact wp.org display name, full marketing tail, en-dash included | mismatch to their DB record → triage friction |
| `{CLASS}` | The exact Wordfence class string from §3 — must match the form dropdown | reclassification, severity drop |
| `{VECTOR}` | From §1.3 table | vague vector reads as unverified |
| `{TESTED_VERSION}` | Highest version you actually ran the PoC against | over-claim → partial rejection |
| `{ROOT_CAUSE}` | Boilerplate from §3 **or** the specific source-level cause naming a function | generic cause invites "duplicate of known class sweep" |
| `{MECHANISM}` | 0–2 sentences. Name file, function, and the ordered mistake. Omit if the cause is self-evident | missing → triager must read source themselves |
| `{PRIVILEGE}` | Verbatim string from §4 — never invent | wrong role string → severity recomputed against you |
| `{ATTACKER_ACTION}` | Concrete verb + concrete object from §3 | generic verb → mean CVSS −0.51 (measured) |
| `{IMPACT_TAIL}` | The corpus's canonical consequence clause for the class | omitted → reads as low impact |
| `{CONDITIONS}` | §5 pattern, only when material | see §5 — costs severity, but omitting a real one costs the report |

---

## 3. Per-class variants

Each block gives: **S1 skeleton**, the **canonical root cause string**, and the **canonical impact
clause** (`{ATTACKER_ACTION}{IMPACT_TAIL}` combined). Impact clauses are quoted verbatim from the
corpus with their counts.

### 3.1 SQL Injection

```
The {PLUGIN} plugin for WordPress is vulnerable to SQL Injection via the '{PARAM}' parameter in all
versions up to, and including, {VER} due to insufficient escaping on the user supplied parameter and
lack of sufficient preparation on the existing SQL query. {MECHANISM} This makes it possible for
{PRIVILEGE} to append additional SQL queries into already existing queries that can be used to
extract sensitive information from the database{, including usernames, email addresses, and password hashes}.
```
- Root cause is **fused into S1**, verbatim: *"due to insufficient escaping on the user supplied
  parameter and lack of sufficient preparation on the existing SQL query"* [1,971 records]. This is
  the one class where the fused shape is still dominant.
- Impact clause verbatim: *"append additional SQL queries into already existing queries that can be
  used to extract sensitive information from the database"* [1,068 in 2025+; 745 unauth / 223 admin /
  199 contributor / 183 subscriber variants].
- The optional tail *", including usernames, email addresses, and password hashes"* is attested and
  is attested in one of the owner's published SQLi records — **use it whenever you actually read
  `wp_users` in the PoC.** It is the difference between "DB read" and "credential material".
- Wordfence's form distinguishes `SQL Injection (Standard DB Read)` from `SQL Injection (Full Access
  - DB Read/Write)`. Only pick the latter if you demonstrated a safe write. The description must
  match the dropdown.
- `generic SQL Injection` [40+ in first sentences, heavily used by PRISM] is used when the sink is a
  general-purpose query builder rather than one named query. Prefer plain `SQL Injection`.
- Multi-parameter form is attested: *"insufficient escaping on the user supplied 'order-by',
  'order-type', and 'selectedCourses' parameters and lack of sufficient preparation on the existing
  SQL queries"* — note the pluralised "queries".

**Owner reference (frictionless SQLi submission):** the submitted text added one mechanism sentence after the
boilerplate, saying how the parameter's shape reached the SQL clause, plus a nonce-reachability sentence.
That is the ideal `{MECHANISM}` length. [件別の文面は Git 外]

### 3.2 Stored Cross-Site Scripting

```
The {PLUGIN} plugin for WordPress is vulnerable to Stored Cross-Site Scripting via {VECTOR} in all
versions up to, and including, {VER} due to insufficient input sanitization and output escaping.
{MECHANISM} This makes it possible for {PRIVILEGE} to inject arbitrary web scripts in pages that
will execute whenever a user accesses an injected page. {CONDITIONS}
```
- Root cause verbatim: *"due to insufficient input sanitization and output escaping"* [13,402 = 34.9%
  of the entire DB].
- Impact clause verbatim: *"inject arbitrary web scripts in pages that will execute whenever a user
  accesses an injected page"* [3,719 contributor / 1,081 admin / 736 unauth].
- **Note the tense: "that WILL execute".** Stored XSS uses `will execute`; Reflected XSS uses
  `execute if`. This is a reliable discriminator in the corpus.
- When the victim surface is an admin screen rather than a public page, replace the tail with a
  named surface — attested PRISM form: *"...that will execute whenever a user (such as an editor or
  administrator previewing the pending post) accesses an injected page and clicks the malicious
  link."* one of the owner's published records uses *"...that execute when an administrator views
  the form Leads page."* Naming the admin surface is what upgrades this from Contributor-XSS
  boilerplate to an admin-session finding.
- If save-time sanitization exists and you bypassed it, say so explicitly — PRISM's GamiPress record
  models this: *"The wp_kses_post filter applied at post save does not neutralize this payload
  because only the inert shortcode text is stored in post_content; the dangerous HTML is synthesized
  at render time by the shortcode handler, entirely bypassing save-time sanitization."*
- Standard conditions tail for Contributor-level: *"This only affects multi-site installations and
  installations where unfiltered_html has been disabled."* [1,500 records]. Include it when true; its
  absence on a Contributor+ HTML-field XSS is a known triage question.

### 3.3 Reflected Cross-Site Scripting

```
The {PLUGIN} plugin for WordPress is vulnerable to Reflected Cross-Site Scripting via the '{PARAM}'
parameter in all versions up to, and including, {VER} due to insufficient input sanitization and
output escaping. {MECHANISM} This makes it possible for unauthenticated attackers to inject
arbitrary web scripts in pages that execute if they can successfully trick a user into performing an
action such as clicking on a link. {CONDITIONS}
```
- Impact clause verbatim, effectively mandatory: *"inject arbitrary web scripts in pages that execute
  if they can successfully trick a user into performing an action such as clicking on a link"*
  [3,540 — 80% of all 4,423 Reflected XSS records use this exact string].
- Alternate root cause for `add_query_arg` sinks, attested [112]: *"due to the use of add_query_arg
  without appropriate escaping on the URL"* (this one sits in S1 **after** the version clause).
- DOM-based variants are still filed as Reflected Cross-Site Scripting; add the sink in `{MECHANISM}`.
- One of the owner's published reflected-XSS records is the model for a non-boilerplate reflected cause: the
  bypass is described as a *decoding step that runs after WordPress has already escaped*. If your
  finding beats core escaping, that sentence is the whole value of the report — put it in S2.

### 3.4 Missing Authorization

Two attested shapes. Pick by whether you can name the function.

**Named-function shape (preferred):**
```
The {PLUGIN} plugin for WordPress is vulnerable to unauthorized {access|modification|access of sensitive}
{data} due to a missing capability check on the {FN}() function in all versions up to, and including,
{VER}. {MECHANISM} This makes it possible for {PRIVILEGE} to {SPECIFIC_ACTION}.
```
**Generic shape (avoid — it is the low-CVSS shape):**
```
The {PLUGIN} plugin for WordPress is vulnerable to authorization bypass in all versions up to, and
including, {VER}. This is due to the plugin not properly verifying that a user is authorized to
perform an action. This makes it possible for {PRIVILEGE} to perform an unauthorized action.
```
- Root cause strings: *"due to a missing capability check on a function"* [2,133]; *"This is due to
  the plugin not properly verifying that a user is authorized to perform an action."* [89 as a
  standalone sentence, but it is the dominant S2 for the `authorization bypass` framing].
- **The impact clause is the whole game.** *"to perform an unauthorized action."* [1,075 unauth /
  507 subscriber] → 2026 mean CVSS 4.92. A named action → 5.43. Always name the table, option,
  record type, or credential you touched.
- **Nonce-only guard sentence.** When a nonce is the sole barrier and it is exposed, say so, naming the hook
  that emits it and the lowest-privileged page that carries it. This is the single most valuable extra
  sentence for this class; one of the owner's published Missing Authorization records does it. [件別の文面は Git 外]
  PRISM's WCFM record does the same: *"...the nonce that serves as the sole barrier is embedded into
  every public page load without any login gate."*
- **Sibling-branch comparison** is a strong attested move (PRISM, WCFM): *"Unlike sibling controller
  branches (wcfm-enquiry and wcfm-enquiry-manage), the wcfm-my-account-enquiry-manage branch performs
  no is_user_logged_in() or current_user_can() check."* It pre-empts "intended behaviour".

### 3.5 IDOR / Insecure Direct Object Reference

```
The {PLUGIN} plugin for WordPress is vulnerable to Insecure Direct Object Reference in all versions
up to, and including, {VER} via the {FN}() function due to missing validation on the '{KEY}' user
controlled key. This makes it possible for {PRIVILEGE} to {SPECIFIC_ACTION_ON_ANOTHER_USERS_OBJECT}.
```
- Root cause verbatim: *"due to missing validation on a user controlled key"* [137] — the singular
  named form *"on the '{KEY}' user controlled key"* is the owner's own published IDOR-record
  wording and is preferred.
- Alternate S2 [7]: *"This is due to the plugin providing user-controlled access to objects, letting
  a user bypass authorization and access system resources."*
- Impact must name **whose** object and **what changes**. one of the owner's published IDOR records: *"...to
  activate a free subscription pack for any user on the site, overwriting their existing paid
  subscription and causing loss of paid features."* Note the explicit victim-harm tail; the bare
  *"to perform an unauthorized action"* [41] is the low-value form.

### 3.6 Authentication Bypass

```
The {PLUGIN} plugin for WordPress is vulnerable to authentication bypass in all versions up to, and
including, {VER}. This is due to {SPECIFIC_CAUSE}. This makes it possible for unauthenticated
attackers to log in as any existing user on the site, such as an administrator, if they have access
to the {email|username|user id}.
```
- Impact clause verbatim [13 / 9 / 8 / 4 by qualifier]: *"log in as any existing user on the site,
  such as an administrator, if they have access to the email"* — the trailing `if they have access
  to the X` is **required** and is what keeps this from being downgraded as unproven.
- Attested specific cause: *"This is due to the plugin failing to verify that the email provided in
  the authentication request matches the email from the validated OAuth token."*

### 3.7 Local File Inclusion

```
The {PLUGIN} plugin for WordPress is vulnerable to Local File Inclusion in all versions up to, and
including, {VER} via the '{PARAM}' parameter of the '{ACTION}' AJAX action. This makes it possible
for {PRIVILEGE} to include and execute arbitrary files on the server, allowing the execution of any
PHP code in those files. This can be used to bypass access controls, obtain sensitive data, or
achieve code execution in cases where PHP files can be uploaded and included.
```
- Impact clause verbatim: *"include and execute arbitrary files on the server, allowing the execution
  of any PHP code in those files"* [887 unauth / 244 contributor].
- The third sentence is verbatim from one of the owner's published LFI records and is the standard
  LFI consequence tail — **include it**, it is what carries LFI to CVSS 8.8.
- If restricted to `.php`: *"include and execute arbitrary .php files on the server..."* [16].

### 3.8 Path Traversal / Arbitrary File Read

```
The {PLUGIN} plugin for WordPress is vulnerable to Path Traversal in all versions up to, and
including, {VER} via the '{PARAM}' parameter. This makes it possible for {PRIVILEGE} to read the
contents of arbitrary files on the server, which can contain sensitive information.
```
- Impact clause verbatim [33 unauth / 37 in ArbFileRead]: *"read the contents of arbitrary files on
  the server, which can contain sensitive information"*.
- `Directory Traversal` [37] and `Path Traversal` [54] are both attested; prefer **Path Traversal**.
- Weaker variant when you only proved out-of-directory writes/moves: *"perform actions on files
  outside of the originally intended directory"* [11]. Only use if you did not achieve a read.

### 3.9 Arbitrary File Upload

```
The {PLUGIN} plugin for WordPress is vulnerable to arbitrary file uploads due to missing file type
validation in the {FN}() function in all versions up to, and including, {VER}. This makes it
possible for {PRIVILEGE} to upload arbitrary files on the affected site's server which may make
remote code execution possible.
```
- Root cause verbatim: *"due to missing file type validation"* [219+52+20+14 across S1 forms]. Note
  it sits **before** the version clause in this class — that ordering is house style here.
- Impact clause verbatim: *"upload arbitrary files on the affected site's server which may make
  remote code execution possible"* [241 unauth]. Keep the hedge **"may make ... possible"** unless
  you executed code; if you did, file it as RCE instead.
- Attested partial-validation cause: *"This is due to insufficient file type validation where the
  validate_classic method validates file extensions and sets error messages but does not prevent the
  file upload process from continuing."*

### 3.10 Arbitrary File Deletion

```
The {PLUGIN} plugin for WordPress is vulnerable to arbitrary file deletion due to insufficient file
path validation in the {FN}() function in all versions up to, and including, {VER}. This makes it
possible for {PRIVILEGE} to delete arbitrary files on the server, which can easily lead to remote
code execution when the right file is deleted (such as wp-config.php).
```
- Root cause verbatim: *"due to insufficient file path validation"* [65+17+12].
- Impact clause verbatim, including the parenthetical: *"delete arbitrary files on the server, which
  can easily lead to remote code execution when the right file is deleted (such as wp-config.php)"*
  [77 unauth / 50 subscriber]. **The `(such as wp-config.php)` parenthetical is load-bearing** — it is
  the corpus's own justification for the elevated score. Do not paraphrase it.

### 3.11 PHP Object Injection

```
The {PLUGIN} plugin for WordPress is vulnerable to PHP Object Injection in all versions up to, and
including, {VER} via deserialization of untrusted input from the '{PARAM}' parameter. This makes it
possible for {PRIVILEGE} to inject a PHP Object. No known POP chain is present in the vulnerable
software. If a POP chain is present via an additional plugin or theme installed on the target
system, it may allow the attacker to delete arbitrary files, retrieve sensitive data, or execute
code depending on the POP chain present.
```
- `via deserialization of untrusted input` is **mandatory** in S1 [466 records].
- Impact clause verbatim: *"to inject a PHP Object."* [381 unauth]. It is deliberately short — do
  not inflate it.
- The POP-chain sentence is boilerplate and is quoted verbatim above from the corpus. Two forms:
  "No known POP chain is present in the vulnerable software" vs naming the chain if one exists in
  the same plugin (which materially raises severity — say so plainly and name the gadget class).

### 3.12 Privilege Escalation

```
The {PLUGIN} plugin for WordPress is vulnerable to privilege escalation in all versions up to, and
including, {VER}. This is due to {the '{FN}' function not restricting what user roles a user can
register with | the plugin not properly validating a user's identity prior to updating their
password}. This makes it possible for {PRIVILEGE} to elevate their privileges to that of an
administrator. {CONDITIONS}
```
- Attested S2 causes: *"This is due to the plugin not properly validating a user's identity prior to
  updating their password."* [12]; *"This is due to the '{FN}' function not restricting what user
  roles a user can register with."* [8]; *"This is due to the plugin allowing users who are
  registering new accounts to set their own role."* [3].
- Impact clauses: *"elevate their privileges to that of an administrator."* [50]; role-injection
  variant *"supply the '{PARAM}' role during registration and gain administrator access to the site."* [11].

### 3.13 Account Takeover

There are only **31** records classed as AccountTakeover in 38,456. **Wordfence normalises account
takeover into Privilege Escalation.** Use their framing or your title will be rewritten:

```
The {PLUGIN} plugin for WordPress is vulnerable to privilege escalation via account takeover in all
versions up to, and including, {VER}. This is due to {SPECIFIC_CAUSE}. This makes it possible for
unauthenticated attackers to change arbitrary user's passwords, including administrators, and
leverage that to gain access to their account. {CONDITIONS}
```
- S1 verbatim: *"is vulnerable to privilege escalation via account takeover in all versions up to,
  and including, VER"* [71].
- Impact clause verbatim: *"change arbitrary user's passwords, including administrators, and leverage
  that to gain access to their account"* [22]; email-pivot variant: *"change linked user's email
  addresses, including administrators ... and leverage that to reset the user's password and gain
  access to their account if the customer ID is known."*
- Conditions clause is near-mandatory for this class — see §5 and the SMS Alert exemplar:
  *"This is only vulnerable on sites with OTP verification for password resets enabled, and where the
  administrator (or other user) has set a phone number for OTP verification."*

### 3.14 Cross-Site Request Forgery

```
The {PLUGIN} plugin for WordPress is vulnerable to Cross-Site Request Forgery in all versions up to,
and including, {VER}. This is due to missing or incorrect nonce validation on the {FN}() function.
This makes it possible for unauthenticated attackers to {SPECIFIC_ACTION} via a forged request
granted they can trick a site administrator into performing an action such as clicking on a link.
```
- **S1 carries no `due to` clause for CSRF** — 3,285 of 4,168 CSRF records end S1 at the version.
  The cause always lands in S2.
- Root cause verbatim: *"This is due to missing or incorrect nonce validation on the '{FN}'
  function."* [964 generic "a function" / 153 named / 132 "an unknown function" / 113 "one of its
  functions" / 82 "several functions"]. **Name the function** — "a function" is the sweep-report form.
- Impact clause verbatim: *"perform an unauthorized action via a forged request granted they can
  trick a site administrator into performing an action such as clicking on a link"* [388]; named
  variants *"modify the plugin's settings via a forged request granted..."* [110], *"invoke this
  function via a forged request granted..."* [88].
- **"granted they can trick a site administrator into..."** is a fixed idiom. Not "if", not
  "provided that". Keep `granted`.
- CSRF→Stored XSS chain: file the class as Cross-Site Request Forgery and put the XSS in the action
  slot; 631 StoredXSS-CWE records open with the CSRF sentence.

### 3.15 Server-Side Request Forgery

```
The {PLUGIN} plugin for WordPress is vulnerable to Server-Side Request Forgery in all versions up to,
and including, {VER} via the '{PARAM}' parameter. This is due to the use of wp_remote_get() instead
of wp_safe_remote_get() which lacks protections against requests to internal/private IP addresses
and localhost. This makes it possible for {PRIVILEGE} to make web requests to arbitrary locations
originating from the web application which can be used to query and modify information from internal
services.
```
- Impact clause verbatim: *"make web requests to arbitrary locations originating from the web
  application which can be used to query and modify information from internal services"* [53 unauth].
- The `wp_remote_get()` vs `wp_safe_remote_get()` S2 is attested verbatim and is the highest-signal
  SSRF cause you can state; alternates: *"insufficient validation of user-supplied URLs before
  passing them to the download_url() function"*, and hostname-substring-match bypasses.

### 3.16 Sensitive Information Exposure

```
The {PLUGIN} plugin for WordPress is vulnerable to Sensitive Information Exposure in all versions up
to, and including, {VER} via the {FN}() function. This is due to {SPECIFIC_CAUSE}. This makes it
possible for {PRIVILEGE} to extract sensitive {NAMED_DATA}.
```
- Class string is **"Sensitive Information Exposure"** [361], not "Information Disclosure".
- Impact clause verbatim: *"extract sensitive user or configuration data."* [230] — this is the
  **generic** form. Named forms score better: *"extract sensitive private, pending, and draft
  template data"* [15], or a form that names each category of secret exposed (one of the owner's published
  records does this). **Name the secrets.**
- Log-file variant: *"through publicly exposed log files"* [21] + *"view potentially sensitive
  information contained in the exposed log files"* [20].

### 3.17 Auxiliary classes (short forms)

| Class | S1 tail | Impact clause (verbatim) |
|---|---|---|
| Remote Code Execution | `is vulnerable to Remote Code Execution in all versions up to, and including, {VER}` | *"to execute code on the server."* [50] |
| Open Redirect | `is vulnerable to Open Redirect in all versions up to, and including, {VER}` | *"redirect users to potentially malicious sites if they can successfully trick them into performing an action."* [95] |
| Arbitrary Options Update | `is vulnerable to unauthorized modification of data due to a missing capability check on the {FN}() function` | *"update arbitrary options on the WordPress site."* [11] |
| Arbitrary File Write | as ArbFileUpload but `insufficient path validation` | *"write to arbitrary files on the server, which can make remote code execution possible."* |
| Content Injection | `is vulnerable to Content Injection in all versions up to, and including, {VER}` | *"inject content that may alter the content and display of select pages."* |
| Denial of Service | as above | *"slow the response time of the vulnerable service to an unusable speed and/or completely deny it."* |

---

## 4. Attacker privilege vocabulary — exact strings

Use one of these **verbatim**. Anything else gets rewritten and risks the severity being recomputed.

| Privilege | Exact string to paste after "This makes it possible for" | Count |
|---|---|---|
| Unauthenticated | `unauthenticated attackers` | 16,364 |
| Subscriber | `authenticated attackers, with Subscriber-level access and above,` | 1,880 (cap) / 1,552 (lower) |
| Contributor | `authenticated attackers, with contributor-level access and above,` | 4,528 (lower) / 1,449 (cap) |
| Author | `authenticated attackers, with Author-level access and above,` | 314 / 251 |
| Editor | `authenticated attackers, with editor-level access and above,` | 97 / 73 |
| Administrator | `authenticated attackers, with administrator-level permissions and above,` | 1,109 |
| Administrator (alt) | `authenticated attackers, with administrator-level access and above,` | 954 |
| Shop Manager (WooCommerce) | `authenticated attackers, with shop manager-level access and above,` | 55 / 39 |
| Customer (WooCommerce) | `authenticated attackers, with customer-level access and above,` | 9 |
| Plugin-defined role | `authenticated attackers, with Custom-level access and above,` | 39 |

Notes grounded in the data:

- **Capitalisation is genuinely mixed and both are accepted.** Among 2025-06→2026 records, 46% of
  role tokens are capitalised. Contributor skews lowercase (4,528 vs 1,449); Subscriber skews
  capitalised (1,880 vs 1,552). Pick one and be internally consistent; nobody will reject either.
- **"access" vs "permissions"**: `access` is the default (5,632 vs 235 for subscriber). The one
  systematic exception is Administrator, where `administrator-level permissions and above` [1,109]
  slightly outnumbers `access and above` [954]. Either is safe.
- **The `and above` suffix is mandatory.** `with subscriber-level access` without it appears but is
  the minority form and reads as narrower than reality.
- **Custom/plugin roles**: use `Custom-level access and above` and then **explain the role in the
  same sentence**. Attested form from one of the owner's published records: *"authenticated attackers, with
  Instructor-level access and above who have the edit_post capability on the quiz, to append..."*
  PRISM's Groundhogg form puts it in the conditions clause instead: *"Exploitation requires the
  attacker to hold a Groundhogg custom role with the view_contacts capability, which is granted by
  default to several built-in Groundhogg roles above the base subscriber level."* The second is
  better — it separates the privilege token from the capability caveat.
- Bare `authenticated attackers` with no role [1,828] means "any logged-in user" — only use it when
  you genuinely proved the lowest role works and there is no role gate at all. Prefer
  `Subscriber-level access and above`, which is the same claim in the corpus's own vocabulary.
- Never write: "low-privileged users", "any user", "a malicious actor", "an attacker with minimal
  permissions" (28 legacy records use *"with minimal permissions such as a subscriber"* — it is
  deprecated house style, do not copy it).
- **Title mirror**: the title uses the compressed form — `Unauthenticated` or
  `Authenticated (Subscriber+)` / `(Contributor+)` / `(Author+)` / `(Administrator+)` / `(Custom+)`.
  Title skeleton: `{Plugin} <= {VER} - {Unauthenticated|Authenticated (Role+)} {Class} via '{param}'`.
  For Missing Authorization the attested 2026 title form is
  `{Plugin} <= {VER} - Missing Authorization to {Unauthenticated|Authenticated (Role+)} {Specific Action} via {fn}`.

---

## 5. The conditions clause

### 5.1 Attested openers (use one of these; do not invent)

| Opener | Count | Use for |
|---|---|---|
| `This only affects ...` / `This only impacts ...` | 1,993 | environment-level facts (multisite, unfiltered_html) |
| `This requires ...` | 43 | a setting that must be enabled |
| `Exploitation requires ...` | 61 | a setting **plus** a rationale for why it is common |
| `This is only exploitable when/on/with ...` | 36 | a fixture that must exist |
| `Successful exploitation requires ...` | 17 | a victim action in the chain |
| `Note: ...` / `Note that ...` | 100 | a caveat about practicality, or a dependency plugin |
| `... granted they can trick a site administrator into ...` | fixed idiom | CSRF and Reflected XSS victim interaction only |
| `This is only vulnerable on sites with ...` | attested (SMS Alert) | non-default but supported feature |

The single most-copied literal: *"This only affects multi-site installations and installations where
unfiltered_html has been disabled."* [1,500].

### 5.2 The cost, measured

Records published 2025-01-01 onward containing any conditions clause: **n=793, mean CVSS 4.87**.
Records without: **n=15,852, mean CVSS 6.27**. That is a −1.40 mean gap.

This is correlational, not causal — genuinely conditional bugs *are* less severe. But the practical
lesson holds: **a conditions clause is a severity tax, so it must buy something.** It buys two
things: (a) it stops the triager discovering the precondition themselves and re-reading the whole
report distrustfully, and (b) if worded as *supported, common configuration*, it neutralises the
"unrealistic premise" rejection (§6.1).

### 5.3 The pattern: general precondition, then one concrete instantiation, then commonality

The best-in-corpus form is PRISM's Ad Inserter record:

> *"Exploitation requires that iframe mode (AI_OPTION_IFRAME) is enabled on at least one ad block
> displayed on the targeted page, **which is a non-default but supported configuration commonly used
> for AdSense and JavaScript-based ads.**"*

Three parts: (1) the exact setting, named as the code constant; (2) where it must be active;
(3) **a commonality justification**. Part 3 is what converts a liability into a neutral fact.

Compare another PRISM record: *"Exploitation requires the `allow_cancellation` or
`allow_rescheduling` setting to be enabled on the site, **both of which are common configurations for
active booking deployments**; an attacker can obtain the inputs needed to reconstruct a victim's key
by booking their own appointment..."* — same three parts plus a fourth: *how the attacker satisfies
the precondition themselves*. That fourth part is the strongest possible move, because it converts a
precondition into a step.

### 5.4 The owner's account-takeover conditions clause — analysis (generalised)

One of the owner's submissions (validated **Urgent**, bounty proposed, but 5 rounds / ~10h of triage friction)
carried a conditions clause fused into the impact sentence. [件別の表は Git 外: /home/dev/wp-bounty-workspace/history/wordfence-description-template.PROPOSED.md の該当節]

**What it did right:**
- The condition is fused into the impact sentence rather than trailing as a separate hedge, so it reads as
  *scope of the attack*, not as *doubt about the attack*.
- It is a **conjunction of named, checkable states**, each of which maps to a UI toggle the triager can verify.
  No vague "under certain configurations".
- It names the attacker's own prerequisite (knowledge of a target username or email) separately and up front —
  attacker knowledge is not a site condition and should not be mixed into the conditions clause.
- It leads with capability and only then narrows. Severity is anchored before the tax is paid.

**What it got wrong — and this is the reusable lesson (friction root cause F4):**
The description stated one concrete value of a setting as if it were the general rule. The real condition was
"the victim's WordPress core locale matches ANY published non-default language of the plugin". Triage could not
generalise, and the researcher had to re-prove it with a second value mid-triage.

> **Rule: the Description states the GENERAL precondition. The PoC states ONE concrete instantiation of it.**
> Never let the concrete instance leak upward into the description. Append the commonality justification (§5.3),
> e.g. "which is the plugin's default state after adding a secondary language".

A second friction lesson bears on wording precision (F2, ~4 hours lost): the environment step named a setting by
its label, but the page carried two same-named fields — one owned by WordPress core, one by the plugin — and only
the core one is the vulnerable input. **Any noun that names a setting which has a same-named neighbour must be
qualified with its owner (core vs plugin) in the description itself.**

## 6. Anti-patterns

### 6.1 Preconditions that read as site-owner misuse → outright rejection

Wordfence rejected three of the owner's reports on one backup/migration plugin (an RCE chain, a path-traversal
deletion, a reflected XSS) with a single verbatim rationale: the entry point was a one-time installer script that
the site owner is expected to remove, so its continued presence is user misuse, not a plugin vulnerability.
[件別の表は Git 外: /home/dev/wp-bounty-workspace/history/wordfence-description-template.PROPOSED.md の該当節]

The technical chains were confirmed. The **premise** was ruled out of scope. Any description whose
conditions clause amounts to *"a file the vendor tells the owner to delete is still present"*,
*"the setup wizard was never completed"*, or *"debug mode was left on"* is a rejection, not a
low-severity finding.

**Test before writing:** could the conditions clause be restated as "the site owner did not follow
the documented cleanup/hardening step"? If yes, do not submit.

Related, from the same history: one of the owner's reflected-XSS reports was **held from submission** for
stacking preconditions — a second plugin active, plus a specific widget present on a public page, plus the
plugin's own dependency. Stacked independent preconditions read like the installer-script premise even
when each one individually is fine.

### 6.2 Generic impact verbs → out-of-scope / no-bounty

Of the owner's 8 unpaid-but-accepted outcomes, **7 are `OutOfScope`** and **6 of those 7 are
Missing Authorization**. [件別の表は Git 外: /home/dev/wp-bounty-workspace/history/wordfence-description-template.PROPOSED.md の該当節] The published impact clauses for these all read as
configuration churn: reset or modify site-wide widget configuration, disable blocks and purge caches, add notes
and trigger notification emails, reorder or detach content items.

Every one of these describes **configuration churn or nuisance**, not data exfiltration, not
persistence, not privilege gain. The corpus-wide pattern is consistent: Missing Authorization records
with the generic *"perform an unauthorized action"* clause average **CVSS 4.92** in 2026 vs **5.43**
with named impact.

**Rule:** if the strongest true sentence you can write for `{ATTACKER_ACTION}` uses verbs like
*modify settings, reset, purge, disable, reorder, trigger emails, add a note*, the finding is
probably below the bounty floor regardless of how you word it. Do not try to word around it — that
is what produces an OutOfScope, which costs the same triage time as a paid report and returns zero.

Honest caveat from the same data: one of those records **did** name the payment-gateway secret keys it exposed
and was **still** ruled OutOfScope. Strong impact nouns are necessary, not sufficient. Nonce-gated Subscriber+
reads of admin-side config appear to sit below the program's floor irrespective of what the config contains.

### 6.3 Impact you did not demonstrate

One of the owner's SQLi candidates was withheld with the reasoning that the injection only widened one query
over already-visible content and reached no arbitrary tables, raw email addresses, credentials, or account
material. Writing *"extract sensitive information from the database"* when you only widened one query is an
overclaim that triage will find. Write the narrower true clause, or do not file. [件別は Git 外]

Corollary on hedges: keep *"which may make remote code execution possible"* (file upload) and
*"which can easily lead to remote code execution when the right file is deleted"* (file deletion)
exactly as the corpus writes them. Upgrading the hedge to a flat RCE claim without executing code is
the same overclaim.

### 6.4 Prose-level anti-patterns (each of these gets rewritten or read as unverified)

| Do not write | Write instead |
|---|---|
| "has a Stored XSS vulnerability" | "is vulnerable to Stored Cross-Site Scripting" |
| "an attacker could potentially" | "This makes it possible for {PRIVILEGE} to" |
| "was found to be vulnerable" / "we discovered" | present-tense statement about the plugin |
| "critical", "severe", "trivially exploitable", "full site compromise" | the impact clause, no adjectives |
| "in all versions" (no bound) / "all versions before X" untested | "in all versions up to, and including, {tested version}" |
| "the PoC demonstrates", "verified in a local lab", "reproducible" | nothing — the PoC field carries this |
| "This is a valid vulnerability and not a duplicate" | nothing |
| "due to a lack of security" / "improper handling" | one of the six boilerplate causes, or a named function |
| "if certain settings are enabled" | the named setting + a commonality justification (§5.3) |
| "low-privileged users" / "any user" | a §4 role string |
| bullets, headings, bold, line breaks inside the field | one paragraph |

Two more, from the reference doc and confirmed by absence in the corpus: **no local-only
disclaimers**, and **no harness/tooling narration**. Neither appears in a single published record.

### 6.5 Crowding is not a description problem — check it before you write

Established from the 47 decided submissions: mean count of records published on the same plugin in
the 180 days before submission was **1.45 for PAID** vs **2.75 DUPLICATE / 3.25 REJECTED / 3.12
unpaid**. No description wording recovers a plugin that is already being swept. Run the crowding
check first; the template is for targets that pass it.

---

## 7. Pre-submit checklist

1. S1 opens `The {full display name} plugin for WordPress is vulnerable to` — verbatim.
2. Class string matches the form dropdown exactly.
3. Version clause is `in all versions up to, and including, {tested version}` and the version is one
   you actually ran against.
4. Root cause is either a §3 boilerplate string or a `This is due to ...` sentence that names a
   function or file.
5. `{MECHANISM}` names the ordered mistake and, where relevant, the nonce-exposure path.
6. Impact sentence opens `This makes it possible for` and the privilege string is copied verbatim
   from §4, `and above` included.
7. `{ATTACKER_ACTION}` names a table, option, file, credential, or account — not "an unauthorized
   action".
8. Conditions clause, if present, uses a §5.1 opener, states the **general** precondition, and ends
   with a commonality justification.
9. Conditions clause does not restate a documented cleanup step the site owner was told to perform.
10. No adjectives of severity, no meta-commentary, no CVSS/CWE/CVE, no markdown, one paragraph,
    ≤160 words.
11. Every named setting that has a same-named neighbour is qualified by its owner (WordPress core vs
    plugin).
12. Title mirrors the description: `{Plugin} <= {VER} - {Unauthenticated|Authenticated (Role+)}
    {Class} via '{param}'`.
