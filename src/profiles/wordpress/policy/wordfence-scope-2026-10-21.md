# Wordfence Bug Bounty Program の対象範囲（写し、2026-10-21）

所有者が 2026-10-21 に Wordfence の Bug Bounty Program のページから貼った文の写しである。原文は英語のまま置く。2026-10-08 の写し（`wordfence-scope-2026-10-08.md`）は履歴として残し、以後はこの写しを読む。段 1 の篩（#436）と段 5 の提出先（#438）、報告書 skill（#439）が読む。探索エージェントには渡さない。

## 原文

### In Scope Assets

🚨 High Threat Vulnerabilities 🚨

All WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) with >= 25 Active Installations for selected High Threat Vulnerabilities exploitable by unauthenticated or low-level authenticated (i.e. Subscriber, Customer) attackers:

* Arbitrary PHP File Upload or Read
* Arbitrary PHP File Deletion
* Arbitrary Options Update
* Remote Code Execution
* Authentication Bypass to Admin
* Privilege Escalation to Admin

Note: High Threat Vulnerabilities in plugins and themes with between 25 and 999 Active Installations must be listed in the WordPress.org Plugin Repository to be in-scope.

⚠ Common and Dangerous Vulnerabilities ⚠

All WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) with >= 500 Active Installations for selected Common and Dangerous Vulnerabilities exploitable by unauthenticated or low-level authenticated (i.e. Subscriber, Customer) attackers:

* Stored Cross-Site Scripting
* SQL Injection

Note: Common and Dangerous Vulnerabilities in plugins and themes with between 500 and 999 Active Installations must be listed in the WordPress.org Plugin Repository to be in-scope. Premium plugins and themes are excluded from the scope below 1,000 active installations.

All Other Vulnerabilities

For other vulnerabilities, all WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) are in scope with active installation thresholds that vary with your Researcher tier:

* Standard Researchers: >= 50,000 Active Installations
* Resourceful Researchers: >= 10,000 Active Installations
* 1337 Researchers: >= 500 Active Installations

If in doubt on what's in scope for your tier, [use our bounty estimator](https://www.wordfence.com/threat-intel/bug-bounty-program/#rewards) to check if your discovery is in scope, or out of scope.

### Out of Scope Assets

There are some assets explicitly out of scope of our bug bounty program which are listed below. Please note this list is non-exhaustive and there may be other products not currently listed in our Out-Of-Scope Asset List that are considered out of scope. If you would like to confirm whether a specific product is in-scope prior to submission, please [contact us at wfi-support@wordfence.com](mailto:wfi-support@wordfence.com).

* WordPress Core — [Bug Bounty Program](https://hackerone.com/wordpress), [Software](https://wordpress.org/)
* All Automattic Products — [Bug Bounty Program](https://hackerone.com/automattic/), [Software](https://profiles.wordpress.org/automattic/)
* All Facebook Products — [Bug Bounty Program](https://www.facebook.com/whitehat), [Software](https://profiles.wordpress.org/facebook/)
* All Google Products — [Bug Bounty Program](https://bughunters.google.com/), [Software](https://profiles.wordpress.org/google/)
* All Siteground Products — [Bug Bounty Program](https://us.siteground.com/viewtos/responsible_disclosure_policy?scid=4&lang=en), [Software](https://profiles.wordpress.org/siteground/)
* All Yoast Products — [Bug Bounty Program](https://yoast.com/security-program/), [Software](https://profiles.wordpress.org/yoast/)

Additionally, Plugins or Themes Closed to Downloads or Sales at the time of submission, or any web service associated with a WordPress plugin or theme that is not run locally (such as an API running on a plugin vendor's website) is considered out of scope.

We will no longer assign CVEs to any vulnerabilities discovered in the products outlined above and they will not be eligible for a bounty through our bug bounty program.

### Explicitly In-Scope Vulnerabilities

All issues in WordPress Plugins and Themes with a considerable impact to the confidentiality, integrity, and availability of a WordPress site are considered in scope of this program as long as they do not require high level permissions, such as administrator or editor (i.e. CVSSv3.1 PR:H) to exploit. The following is a list of some common vulnerabilities that will be accepted.

* Stored Cross-Site Scripting
* Arbitrary Content Deletion
* SQL Injection
* Arbitrary File Upload
* Arbitrary File Download/Read
* Arbitrary File Deletion
* Local File Include/Remote File Include
* Directory Traversal
* Privilege Escalation to Admin
* Privilege Escalation to Non-Admin
* Authentication Bypass to Admin
* Authentication Bypass to Non-Admin
* Remote Code Execution/Code Injection
* Sensitive Information Disclosure
* PHP Object Injection with a useable gadget in the software (or any required pieces of software)
* Intentional Backdoors Added by Developers that are Accessible by Threat Actors

### Explicitly Out of Scope Vulnerabilities

Vulnerabilities that have a minimal impact on the security of WordPress sites, or are unlikely to be successfully exploited in the wild will likely be considered out of scope for the program and will be rejected for CVE assignment upon submission.

* Anything listed in our 'Common False Positive Reports' is automatically considered Out of Scope as they are not considered valid vulnerabilities
* Business Logic Flaws where the demonstrated impact is primarily business-related rather than security-related. This includes, but is not limited to, issues such as payment bypasses, pricing manipulation, discount or coupon abuse, order workflow abuse, or other logic flaws that affect revenue, transactions, or business operations without introducing a direct security impact.
* All DoS Vulnerabilities
* Limited File Uploads
* Reflected Cross-Site Scripting
* Arbitrary Shortcode Execution
* Cross-Site Request Forgery
* Missing Authorization
* Insecure Direct Object Reference
* Basic Information Exposure
* PHP Object Injection w/o a Gadget
* Software containing vulnerable packages or dependencies that are not verifiably exploitable in that plugin or theme
* Any Vulnerability requiring PR:H to Exploit. Administrator, Editor, and Shop Manager roles, along with any other role that has the `unfiltered_html` capability fall into this category.
* Any Vulnerability requiring mid-level authentication to exploit. This includes Contributor and Author roles, along with any other role that needs to be granted by an administrator (i.e. not a common default registration role).
* Open Redirect
* Server-Side Request Forgery
* Vulnerabilities dependent on successfully exploiting a race condition that is not easily replicable in a common configuration
* Cache Poisoning, where this is not a considerable and demonstrable impact to site's security
* Server-Side Request Forgery via DNS Rebinding (i.e. if `wp_safe_remote_*` or `wp_http_validate_url()` is in use, we do not consider the issue a valid SSRF vulnerability)
* API Key Updates/Overwrites/Reads
* Vulnerabilities that can only be exploited by an administrator explicitly granting access to a lower-privileged user where the likelihood of an administrator granting access is minimal or the administrator is granting access to functionality and features that can be abused
* Vulnerabilities that require excessive brute force to exploit. Please note we may accept vulnerabilities as in scope where brute force is required and the likelihood of success is relatively high. Scope eligibility will be determined on a case-by-case basis.
* Private/Hidden/Draft/Pending/Password Protected Post Access

### Common False Positive Reports

The following issues are frequently reported to our program but are not considered valid vulnerabilities and are routinely rejected. This list is not exhaustive and there may be other issues that we reject, these are just some of the most common issues we reject. Please do not submit reports for the following:

* Low-Impact or Theoretical Issues
  * Theoretical vulnerabilities
  * Issues that lead to username enumeration
  * Lack of HTTP security headers
  * Clickjacking
  * Full path disclosure
  * Coupon code exposure
  * Wishlist updates
  * Google Maps API key access
  * Endpoints without brute-force or rate limiting protections (rate limiting is considered a server-side control)
  * Any vulnerability with a CVSS 3.1 score lower than 4.0 that cannot be leveraged to achieve a higher impact
* Injection & Client-Side Issues (Non-Exploitable/Low Impact)
  * CSV Injection
  * CSS Injection
  * HTML Injection
  * Self Cross-Site Scripting (i.e. the payload is not stored and only rendered upon the initial action)
  * Reflected Cross-Site Scripting via headers
  * Cross-Site Scripting via SVG file uploads
  * File uploads containing embedded client-side scripts or macros (e.g., XSS in PDFs)
  * Malicious content stored in safe file types (e.g., PHP code inside a `.jpg` file)
  * Double extension file upload attacks (e.g., `.php.png`)
  * Safe filetype uploads (e.g., `.jpg`, `.png`) where upload functionality is intentional
* Authentication, Authorization & Access Control (Expected or Intentional Behavior)
  * IP Spoofing
  * CAPTCHA bypasses
  * CORS issues
  * Tabnabbing
  * TOCTOU
  * Dismissing notices via CSRF or missing authorization
  * Cross-Site Request Forgery: on unauthenticated forms with no sensitive actions; on read-only actions
  * Missing authorization where: a valid nonce protects the action; the nonce is not exposed to lower-privileged users
  * Access keys or tokens used for authorization when adequately secure
  * Arbitrary shortcode execution by Contributor-level users or higher
  * High-level (Administrator, Editor, Shop Manager) XSS requiring `unfiltered_html`
  * Intentional functionality restricted to administrators (e.g., PHP snippet plugins, tracking script insertion)
  * Intentional functionality where scope is appropriately limited (i.e. user can submit a post with a featured image due to the plugin enabling such functionality as a well documented feature)
  * User registration bypass where registration is intentionally enabled through the software functionality or does not lead to privilege escalation
  * Unlimited voting, liking, or counting issues (i.e. a page counter where the count can be increased by several requests)
  * 2 Factor Authentication Bypasses
  * Missing authorization without a consequential confidentiality, integrity, or availability impact.
* Environmental/Configuration-Based Issues
  * Vulnerabilities only exploitable on EOL software (PHP, MySQL, Apache, Nginx, OpenSSL, etc.)
  * Any SQL injection requiring `wp_magic_quotes` to be disabled
  * Vulnerabilities requiring local server access
  * Vulnerabilities requiring unsafe PHP configuration changes (e.g., enabling `allow_url_fopen`)
  * Secrets stored in plaintext that cannot be exploited through another vulnerability
  * Uploaded files in publicly accessible directories where exposure does not lead to site compromise
  * Software containing vulnerable dependencies that are not verifiably exploitable within the plugin or theme
  * Information exposed when `WP_DEBUG` is enabled.
  * Vulnerabilities dependent on an administrator misconfiguring or insecurely configuring their settings or environment.
* Browser Version Requirements
  * Vulnerabilities that only affect users of outdated or unpatched browsers (defined as two stable versions behind the latest release.)

We no longer assign CVE IDs to any vulnerabilities found in the out of scope list above and they will not be eligible for a bounty through our bug bounty program.

## 読み方（段 1 の篩で使う行）

所有者の 2026-10-21 の決定では、段 1 で落とすのは「確実に受理されない」ものだけである。原文のうち、前提の厳しさを理由に明示で除外している行は次のとおり。

- PR:H（Administrator、Editor、Shop Manager、`unfiltered_html` を持つ役割）を要するもの。
- 中間の権限（Contributor、Author、管理者が付与する役割）を要するもの。
- 一般的な構成で容易に再現できない競合状態に依存するもの。
- 管理者が明示的に権限を付与する可能性が低い場合に限って成立するもの。
- 過大な brute force を要するもの（成功率が高い場合は個別判断）。
- Common False Positive Reports に挙がる種類。

受理が怪しい程度のもの（Explicitly In-Scope にあり、上の行に当たらないもの）は落とさない。
