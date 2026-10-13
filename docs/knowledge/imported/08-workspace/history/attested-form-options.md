<!-- provenance: /home/dev/wp-bounty-workspace/history/attested-form-options.md, mtime 2026-09-12, imported 2026-10-13, generation 08-workspace. 取り込み時に観測の契機となった提出 2 件の plugin 名・版・分類を除いた -->

# Wordfence submission form — attested dropdown options

Values observed on the live form. Only what was actually seen on screen goes here;
anything inferred belongs in a package README, not in this file.

## Vulnerability Type — "File System Access" group

Observed 2026-09-11 while preparing a submission. The group was scrolled, so the list may
continue above and below; these nine were on screen.

- Arbitrary File Deletion (Non-PHP)
- Arbitrary File Deletion (PHP Included)
- Arbitrary File Read / Download (Non-PHP)
- Arbitrary File Read / Download (PHP Included)
- Arbitrary File Upload (Leading to RCE)
- Arbitrary File Write / Overwrite (Non-PHP)
- Arbitrary File Write / Overwrite (PHP Included)
- Directory Traversal
- Limited File Upload (Non-RCE Impact)

### How to pick

Every file-system primitive is split Non-PHP / PHP Included, so the PHP question is
answered by measurement before the form is opened: check what file types core's
`wp_check_filetype_and_ext()` admits for the target. Claiming "PHP Included" when core
rejects the PHP type is a false statement on the form.

When a finding is both a read and a deletion, the dropdown takes one value while the
Description carries both. Prefer the deletion entry: anchored on deletion alone the CVSS
vector is C:N/I:H/A:H = 9.1, anchored on read alone it is C:H/I:N/A:N = 7.5, and the read
is not lost because it stays in the Description and the PoC. Precedent for the downside: a
published record titled "Limited Arbitrary File Read and Deletion" was scored 7.5.

## "What is your Proof of Concept?" — observed 2026-09-12

Reported back from the live form when a guessed value was rejected. The six options are:

- PHP
- Python
- JavaScript
- HTML
- URL (e.g. GitHub repository or Gist)
- Other, or text instructions

Picking rule. The field names the *artefact*, not the finding. When a script is attached,
pick its language. When the walk is a browser procedure carried entirely in the Proof of
Concept field with nothing attached — the normal shape for stored and reflected XSS, where
the evidence is the payload executing rather than a string comparison — pick **Other, or
text instructions**. There is no "Written Steps" entry; that guess was refused on a
2026-09-12 submission and is the reason this section exists.

Do not pick "HTML" for an XSS report merely because the payload is markup. The earlier
entries are the language of an attached proof-of-concept file; "HTML" means an attached
.html file that drives the attack, such as a CSRF form.

## "Vulnerability Type" — Cross-Site Vulnerabilities group, observed 2026-09-12

Screenshot of the live dropdown. This group holds five entries:

- Cross-Site Request Forgery (CSRF) with Availability Impact
- Cross-Site Request Forgery (CSRF) with Confidentiality Impact
- Cross-Site Request Forgery (CSRF) with Integrity Impact
- Reflected Cross-Site Scripting (XSS)
- Stored Cross-Site Scripting (XSS)

The labels carry the "(XSS)" suffix and the full words; the short forms "Stored XSS" and
"Reflected XSS" seen in an earlier capture of a different dropdown are not what this
control accepts. Write the label exactly.

Stored vs Reflected: pick Stored when the payload is persisted server-side by one request
and executes later in a different session with the attacker absent (e.g. a value stored in
postmeta and rendered in an administrator's edit screen).

All three CSRF entries are in this group even though CSRF is out of scope for the
programme (`wf/oos/csrf`). Their presence in the dropdown is not an invitation; the scope
gate settles that before the form is reached.
