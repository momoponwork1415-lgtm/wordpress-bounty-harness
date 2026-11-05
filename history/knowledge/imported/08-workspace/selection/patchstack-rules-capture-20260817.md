<!-- provenance: /home/dev/wp-bounty-workspace/selection/patchstack-rules-capture-20260817.md, mtime 2026-08-17, imported 2026-10-13, generation 08-workspace. 取り込み時に契機となった却下 1 件の plugin 名・版・function 名・file path・設定値を除き、規則と教訓だけ残した -->

# Patchstack bug bounty rules — 2026 June edition

Captured 2026-08-17 from `https://patchstack.com/articles/bug-bounty-guidelines-rules/`
after a stored-XSS rejection. Update date on the page: **2026-06-01**.

Quoted clauses are verbatim from the page.

---

## §3 Scope

| § | rule |
|---|---|
| 3.1 | WordPress core, plugins (free/premium), themes (free/premium) |
| 3.2 | "A vulnerability is considered valid only if it falls within the defined program scope and demonstrates a clear, measurable security impact." |
| 3.3 | Premium components require "the original, unmodified archive file" |
| 3.4 | "Only the base metrics defined in CVSS v3.1 are used" |
| 3.5 | "Reported components should have 1,000 or more active installs." |
| 3.6 | "Only the latest version of a component is eligible for submission. Additionally, the most recent release must not be older than three years from its last update date." |
| 3.7 | "Only vulnerabilities that can be exploited by unauthenticated users or by users with default Subscriber or Customer roles are eligible." |
| 3.8 | Custom roles only if "equivalent or closely aligned with those of the Subscriber or Customer roles" |

## §3.9 — accepted types and their conditions

| type | condition |
|---|---|
| SQL injection | (none stated) |
| **Cross-Site Scripting (XSS)** | **"Must have an impact on the entire site, or be reflected"** |
| Arbitrary file upload / deletion / download | "Must provide full control over the path and extension" |
| Remote/Arbitrary Code Execution | (none stated) |
| PHP Object Injection | (none stated) |
| Arbitrary settings change | "Must involve WordPress options or settings with significant impact on the site" |
| Privilege escalation | "Must lead to contributor access or higher" |
| LFI / RFI | "Must provide full control over the path and extension" |
| Broken access control | "Must result in access to significant or sensitive objects" |
| IDOR | "Must lead to significant security impact" |
| CSRF | "Must result in one of the accepted write-related actions listed above" |

## §4.5 — rejected, XSS/HTML/CSS

- "Contributor-level (or higher) stored XSS."
- "HTML-only injection without JavaScript execution – e.g. injection into emails or rendered
  output where script execution is not possible."
- "CSS injection."

---

## The gate that killed the stored-XSS report

**§3.9: a stored XSS must have an impact on the entire site.**

[件別の表は Git 外: /home/dev/wp-bounty-workspace/selection/patchstack-rules-capture-20260817.md の該当節]

The report's own CVSS rationale had already documented that no site-wide surface exists: the
public listing page rendered nothing to a logged-out visitor under the default privacy setting
(tested, and stated in the report as a claim deliberately not relied on), and a second public
delivery path was dropped from the report because it needed an administrator to approve the
attacker's first action. That left one delivery route — a notification email to administrators
linking to the attacker's own object. **One page, reached by one role, via an email.** Good delivery
evidence; not "an impact on the entire site".

Everything else passed: install count (§3.5), latest version (§3.6), unauthenticated attacker
(§3.7), not Contributor-level (§4.5).

### What this changes going forward

**Before writing a stored-XSS report for Patchstack, prove a site-wide render surface first**
— a page any visitor or any logged-in user reaches without the admin being the only audience.
If the only proven sink is the attacker's own object (profile, entry, submission), the report
fails §3.9 no matter how strong the chain is. Wordfence has no equivalent site-wide clause,
so that finding routes there instead — but §5.3 makes the choice one-way, so decide before
submitting, not after a rejection.

The same test applied earlier would have caught this: the report contained the disproof of
its own site-wide reach and it was read as CVSS caution rather than as a scope failure.

## The form's type vocabulary is not the guidelines' vocabulary

The submission form's type select contains **`Stored Cross-Site Scripting (XSS)`** verbatim —
the label leads with the modifier and ends with `(XSS)`. `Cross-Site Scripting (Stored)` does
not exist in the list and synthesising it from an OWASP class field fails the form. The
remaining ~50 options have not been captured; paste the list when convenient.

Observed option names, for style: `Account Takeover (Admin)`, `Account Takeover
(Limited/User)`, `Authentication Bypass (Admin)`, `Authentication Bypass (Non-Admin)`,
`Insecure Direct Object Reference (IDOR) with Availability|Confidentiality|Integrity Impact`,
`Missing Authorization with Availability|Confidentiality|Integrity Impact`,
`Privilege Escalation (Admin)`.
