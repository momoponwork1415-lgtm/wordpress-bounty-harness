# Patchstack Bug Bounty 対象範囲（報告フォームの写し）

取得日: 2026-10-08。取得者: 判断者（ブラウザで閲覧した報告フォームの本文を貼り付け）。出典: Patchstackの "Report new vulnerability" 画面（2026-06-01改定）。詳細規則は https://patchstack.com/articles/bug-bounty-guidelines-rules/ 。差分が出たら新しい日付のファイルを隣に置き、`programme-scope.md` の参照を更新する。

## What we accept — In scope (meet at least one)

- Zero-day reports that meet every requirement in guideline 22.4: latest stable version, default settings, working exploit, full site compromise as Unauthenticated, Subscriber, or Customer.
- One of the accepted vulnerability types listed below, with the listed conditions met.
- Reports targeting software included in the Patchstack mVDP scope, demonstrating measurable security impact. The contributor role remains in scope for mVDP submissions, though they may no longer receive XP.

## Accepted vulnerability types

- SQL injection
- Arbitrary file upload, deletion, or download: must provide full control over the path and extension.
- Remote / Arbitrary Code Execution
- PHP Object Injection
- Arbitrary settings change: must involve WordPress options or settings with significant impact on the site.
- Privilege escalation: must lead to contributor access or higher.
- Local file inclusion or remote file inclusion: must provide full control over the path and extension.
- Broken access control: must result in access to significant or sensitive objects, e.g. API keys or secrets (with demonstrated impact), password hashes, or backup / SQL files.
- IDOR: must lead to significant security impact. PII leakage alone, or interactions with attachments, tickets, events, orders, or appointments, are only processed for software in the mVDP scope.
- CSRF: must result in one of the accepted write-related actions listed above.
- Cross-Site Scripting (XSS): accepted only as site-wide stored XSS or reflected XSS with JavaScript execution. Contributor-level stored XSS, HTML-only injection, and reflected XSS that involves nonces are out of scope.
- Denial of Service (DoS): must crash or deface the entire site, be demonstrable on any environment, and not depend on excessive user input volume or expected functionality.

## What we reject

Out of scope even if they overlap with an accepted type.

### User roles

- Contributor-and-higher pre-requisite: only Unauthenticated, Subscriber, Customer, and similar custom roles remain in scope for the standard program.
- Custom roles whose capabilities exceed those of a Subscriber or Customer.

### Vulnerability types not in the accepted list

- Sensitive data exposure, enumeration, content spoofing, full path disclosure, and similar low-impact information disclosures.
- Race conditions and blind SSRF.
- Open redirects, CRLF injection, XXE on non-impactful sinks, unvalidated redirects, CSV injection, clickjacking, and cross-frame scripting.

### Accepted types submitted without their conditions

- XSS that is contributor-level stored, HTML-only, reflected involving nonces, or otherwise not site-wide stored / reflected with JS execution.
- DoS that does not crash or deface the entire site, depends on excessive user input volume, or is just expected functionality.
- File upload / deletion / download or LFI / RFI without full control over both path and extension.
- Privilege escalation that does not lead to contributor access or higher.
- Settings change without significant site impact.
- CSRF that does not chain into one of the accepted write actions.
- Broken access control on non-sensitive objects.

### Not processed outside the mVDP program

- Price tampering or price manipulation (product prices, cart totals, discounts, coupon values).
- Payment bypass.
- IDOR or broken access control limited to PII leakage, attachments, tickets, events, orders, or appointments.
- Stored XSS that does not affect all frontend or backend pages.
- Components with fewer than 1,000 active installations, unless the resulting CVSS score is 8.5 or higher. Fewer than 100 active installations is always out of scope.

### Submission requirements

- Reports must be written in English.
- Reports must be tested against the latest available version of the component.
- Attach the correct component slug, link, and version (do not report a pro-version issue against the free version).
- PoCs must contain detailed, step-by-step reproduction from a remote attacker's perspective, including HTTP requests, screenshots, or videos. WP-CLI or other server-side-only steps are not accepted.
- Upload PoCs and other files as attachments; expiring third-party links are not accepted.
- Duplicates of earlier reports or already-published CVEs are rejected.
- Multiple findings of the same vulnerability type must be consolidated into a single report.
- Vendor or developer self-submissions: accepted for disclosure but not eligible for bounties.
- Incomplete, inaccurate, or unverifiable information, or invalid vulnerability claims are rejected.
- Unrealistic pre-requisites or exploitation scenarios are rejected.
- Closed, inaccessible, abandoned, or non-publicly-distributed components are rejected.
- For premium components, attach the original, unmodified archive.

### Configuration & expected functionality

- Vulnerabilities that only exist because a high-privilege user explicitly configured the component that way.
- Vulnerabilities where the plugin's own Permissions UI lets administrators grant a capability to a lower-priv role, exposing the issue to that role.
- Expected functionality is not a vulnerability (e.g. a contact form that allows uploads is not DoS because of many entries).
- Re-ordering data, clearing cache, or manually triggering cronjobs / scheduled tasks.
- Vulnerabilities that stem from the underlying WordPress core version rather than the component itself.

### Severity & scoring thresholds (pre-2026-06-01 rules that still apply)

- Any report involving Attack Complexity: High (AC:H).
- Subscriber-or-higher vulns with minor data leakage, minor data modification, or minor availability impact (CVSS 5.4 with two CIA at L, 6.3 with three at L).
- Unauthenticated vulns with only one CIA at Low impact (CVSS 5.3).
- Actions that require a non-guessable or unrealistic identifier to be impactful.
- Most race conditions (below CVSS 7.1).

### Authentication & access control

- 2FA bypass.
- Lack of brute-force protection / rate-limiting (excludes the login TOTP feature and sequential filenames).
- Account creation or registration with a low-privilege role (below Contributor).
- Arbitrary user registration unless it leads to a Contributor-or-higher account.

### Information disclosure

- Full path disclosure.
- Private or draft post, page, or content disclosure, unless the post type can leak extremely sensitive data.
- Enumeration that does not expose significant information.
- API key leakage that does not result in significant impact.

### XSS, HTML & CSS injection

- Contributor-level (or higher) stored XSS.
- HTML-only injection without JavaScript execution.
- CSS injection.

### CSRF specifics

- Multi-step CSRF exploits.
- CSRF or access-control issues that only affect admin-notice dismissal, or IP bypass for non-critical actions.

### File operations

- Non-arbitrary LFI: only accepted with full control over the path AND extension.
- Constrained-path LFI without a working directory-traversal exploit. Windows-specific bypass techniques are excluded.
- Non-arbitrary file uploads involving legacy extensions such as .phtml.

### Other historical exclusions

- Open redirect.
- DoS via excessive user-input volume against expected functionality.
- Blind SSRF without concrete impact.
- AI feature token exhaustion.
- CSV injection, CAPTCHA bypasses, and IP spoofing.
- Closed, inaccessible, or non-publicly-distributed components, or reports based on non-standard user roles.
- Authenticated shortcode issues without sensitive data disclosure.
