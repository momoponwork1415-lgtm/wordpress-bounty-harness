# Patchstack Bug Bounty の対象範囲（写し、2026-10-21）

所有者が 2026-10-21 に Patchstack の報告フォームの前置き「Before you submit — review the Bug Bounty scope」から貼った文の写しである。原文は英語のまま置く。2026-10-08 の写し（`patchstack-scope-2026-10-08.md`）は履歴として残し、以後はこの写しを読む。Submission requirements の節は `patchstack-submission-requirements-2026-10-21.md` と同文である。段 1 の篩（#436）、段 5 の提出先（#438）、報告書 skill（#439）が読む。探索エージェントには渡さない。

## 原文

As of June 1, 2026, submitted reports must meet at least one of the criteria below. Reports that fall outside of these criteria will be rejected. Please read the [Bug Bounty guidelines & rules](https://patchstack.com/articles/bug-bounty-guidelines-rules/) before submitting. The Patchstack bug bounty program will only accept reports that have a real and significant security impact.

### What we accept

In scope (meet at least one)

* Zero-day reports that meet every requirement in [guideline 22.4](https://patchstack.com/articles/bug-bounty-guidelines-rules/) — latest stable version, default settings, working exploit, full site compromise as Unauthenticated, Subscriber, or Customer.
* One of the accepted vulnerability types listed below, with the listed conditions met.
* Reports targeting software included in the Patchstack mVDP scope, demonstrating measurable security impact. The contributor role remains in scope for mVDP submissions, though they may no longer receive XP.

Accepted vulnerability types

* SQL injection
* Arbitrary file upload, deletion, or download — Must provide full control over the path and extension.
* Remote / Arbitrary Code Execution
* PHP Object Injection
* Arbitrary settings change — Must involve WordPress options or settings with significant impact on the site.
* Privilege escalation — Must lead to contributor access or higher.
* Local file inclusion or remote file inclusion — Must provide full control over the path and extension.
* Broken access control — Must result in access to significant or sensitive objects — e.g. API keys or secrets (with demonstrated impact), password hashes, or backup / SQL files.
* IDOR — Must lead to significant security impact. PII leakage alone, or interactions with attachments, tickets, events, orders, or appointments, are only processed for software in the mVDP scope.
* CSRF — Must result in one of the accepted write-related actions listed above.
* Cross-Site Scripting (XSS) — Stored XSS is accepted even if it affects only one page. Stored or reflected XSS must execute JavaScript immediately when the affected page is opened, without further user interaction (e.g. an onfocus handler triggered automatically by autofocus). Contributor-level stored XSS, HTML-only injection, and reflected XSS that involves nonces are out of scope.
* Shortcode execution — Shortcode execution is accepted only for Unauthenticated, Subscriber, and Customer cases. Contributor-and-higher shortcode execution is out of scope, including for software in the mVDP scope.
* Denial of Service (DoS) — Must crash or deface the entire site, be demonstrable on any environment, and not depend on excessive user input volume or expected functionality.

### What we reject

Reports falling into any of the categories below are out of scope and will be rejected — even if they overlap with an accepted vulnerability type above.

User roles

* Contributor-and-higher pre-requisite — only Unauthenticated, Subscriber, Customer, and similar custom roles remain in scope for the standard program.
* Custom roles whose capabilities exceed those of a Subscriber or Customer.
* Contributor-and-higher shortcode execution — unlike other types, this stays out of scope for software in the mVDP scope too.

Vulnerability types not in the accepted list

* Sensitive data exposure, enumeration, content spoofing, full path disclosure, and similar low-impact information disclosures.
* Race conditions and blind SSRF.
* Open redirects, CRLF injection, XXE on non-impactful sinks, unvalidated redirects, CSV injection, clickjacking, and cross-frame scripting.

Accepted types submitted without their conditions

* XSS that requires further user interaction after opening the affected page — such as clicking a link or button, hovering, pressing a key, or manually focusing an element. Contributor-level stored XSS, HTML-only injection, and reflected XSS involving nonces are also out of scope.
* DoS that does not crash or deface the entire site, depends on excessive user input volume, or is just expected functionality.
* File upload / deletion / download or LFI / RFI without full control over both path and extension.
* Privilege escalation that does not lead to contributor access or higher.
* Settings change without significant site impact.
* CSRF that does not chain into one of the accepted write actions.
* Broken access control on non-sensitive objects.

Not processed outside the mVDP program

* Price tampering or price manipulation — e.g. altering product prices, cart totals, discounts, or coupon values.
* Payment bypass — obtaining paid products, subscriptions, or access without completing payment.
* IDOR or broken access control limited to PII leakage, attachments, tickets, events, orders, or appointments.
* Components with fewer than 1,000 active installations, unless the resulting CVSS score is 8.5 or higher. Fewer than 100 active installations is always out of scope.

Submission requirements

* Reports must be written in English.
* Reports must be tested against the latest available version of the component.
* Attach the correct component slug, link, and version — e.g. do not report a pro-version issue against the free version.
* PoCs must contain detailed, step-by-step reproduction from a remote attacker's perspective, including HTTP requests, screenshots, or videos. WP-CLI or other server-side-only steps are not accepted.
* Upload PoCs and other files as attachments — links to third-party sources that can expire are not accepted.
* Duplicates of earlier reports or already-published CVEs.
* Multiple findings of the same vulnerability type must be consolidated into a single report.
* Vendor or developer self-submissions — accepted for disclosure but not eligible for bounties.
* Incomplete, inaccurate, or unverifiable information, or invalid vulnerability claims.
* Unrealistic pre-requisites or exploitation scenarios.
* Closed, inaccessible, abandoned, or non-publicly-distributed components.
* For premium components, attach the original, unmodified archive so we can validate.

Configuration & expected functionality

* Vulnerabilities that only exist because a high-privilege user explicitly configured the component that way.
* Vulnerabilities where the plugin's own Permissions UI lets administrators grant a capability to a lower-priv role, exposing the issue to that role.
* Expected functionality is not a vulnerability — e.g. a contact form that allows uploads does not qualify as DoS just because someone could submit large quantities of entries.
* Re-ordering data, clearing cache, or manually triggering cronjobs / scheduled tasks.
* Vulnerabilities that stem from the underlying WordPress core version rather than the component itself.

These criteria existed before the June 1, 2026 update and continue to apply. They are listed here as a reminder; nothing in this list has been relaxed.

Severity & scoring thresholds

* Any report involving Attack Complexity: High (AC:H).
* Subscriber-or-higher vulns with minor / insignificant data leakage, minor data modification, or minor availability impact (CVSS 5.4 with two CIA at L, 6.3 with three at L).
* Unauthenticated vulns with only one CIA at Low impact (CVSS 5.3).
* Actions that require a non-guessable or unrealistic identifier to be impactful — e.g. cancelling a subscription that requires knowing a long, randomly-generated subscription hash.
* Most race conditions (below CVSS 7.1).

Authentication & access control

* 2FA bypass — typically Attack Complexity: High since you need the password to exploit.
* Lack of brute-force protection / rate-limiting (e.g. login). Excludes the login TOTP feature and sequential filenames.
* Account creation or registration with a low-privilege role (below Contributor).
* Arbitrary user registration unless it leads to a Contributor-or-higher account.

Information disclosure

* Full path disclosure.
* Private or draft post, page, or content disclosure — unless the post type can leak extremely sensitive data.
* Enumeration that does not expose significant information (only confidentiality at Low impact).
* API key leakage that does not result in significant impact.

XSS, HTML & CSS injection

* Contributor-level (or higher) stored XSS.
* HTML-only injection without JavaScript execution — e.g. injection into emails or rendered output where script execution is not possible.
* CSS injection.

CSRF specifics

* Multi-step CSRF exploits — e.g. CSRF to an admin action that then requires the admin to perform a second action to trigger the impact.
* CSRF or access-control issues that only affect admin-notice dismissal, or IP bypass for non-critical actions.

File operations

* Non-arbitrary LFI — only accepted with full control over the path AND extension.
* Constrained-path LFI without a working directory-traversal exploit. Windows-specific bypass techniques are excluded.
* Non-arbitrary file uploads involving legacy extensions such as .phtml.

Other historical exclusions

* Open redirect is inherently out of scope.
* DoS via excessive user-input volume against expected functionality.
* Blind SSRF — must demonstrate concrete impact.
* AI feature token exhaustion.
* CSV injection, CAPTCHA bypasses, and IP spoofing.
* Closed, inaccessible, or non-publicly-distributed components, or reports based on non-standard user roles.
* Shortcode execution reachable only by a Contributor or higher.

### Automatic one-week bans

To reduce repeated abuse of the program, submitting any of the following will result in an immediate one-week ban:

* Reports containing incorrect AI-generated assumptions.
* Reports that were clearly not tested against the actual plugin or theme.
* Reports that clearly do not meet the Patchstack bug bounty program rules.

## 読み方（段 1 と段 5 で使う行）

- 標準プログラムの前提は Unauthenticated / Subscriber / Customer とそれに相当する custom role に限る。Contributor 以上は mVDP の対象ソフトでだけ受ける（shortcode 実行は mVDP でも受けない）。
- 1,000 未満の active installations は CVSS 8.5 以上のときだけ、100 未満は常に対象外。
- 競合状態、blind SSRF、AC:H は落ちる。
- 「Automatic one-week bans」があるので、試していない報告や推測を含む報告は出さない。
