# Wordfence Bug Bounty Program 対象範囲（公式ページの写し）

取得日: 2026-10-08。取得者: 判断者（ブラウザで閲覧した本文を貼り付け）。出典: https://www.wordfence.com/threat-intel/bug-bounty-program/ 。wordfence.comはbot検査のためHarnessからは自動取得できない。差分が出たら新しい日付のファイルを隣に置き、`programme-scope.md` の参照を更新する。

## In Scope Assets

### High Threat Vulnerabilities

All WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) with >= 25 Active Installations for selected High Threat Vulnerabilities exploitable by unauthenticated or low-level authenticated (i.e. Subscriber, Customer) attackers:

- Arbitrary PHP File Upload or Read
- Arbitrary PHP File Deletion
- Arbitrary Options Update
- Remote Code Execution
- Authentication Bypass to Admin
- Privilege Escalation to Admin

Note: High Threat Vulnerabilities in plugins and themes with between 25 and 999 Active Installations must be listed in the WordPress.org Plugin Repository to be in-scope.

### Common and Dangerous Vulnerabilities

All WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) with >= 500 Active Installations for selected Common and Dangerous Vulnerabilities exploitable by unauthenticated or low-level authenticated (i.e. Subscriber, Customer) attackers:

- Stored Cross-Site Scripting
- SQL Injection

Note: Common and Dangerous Vulnerabilities in plugins and themes with between 500 and 999 Active Installations must be listed in the WordPress.org Plugin Repository to be in-scope. Premium plugins and themes are excluded from the scope below 1,000 active installations.

### All Other Vulnerabilities

For other vulnerabilities, all WordPress plugins and themes, free and premium (excluding those listed in Out of Scope Assets) are in scope with active installation thresholds that vary with your Researcher tier:

- Standard Researchers: >= 50,000 Active Installations
- Resourceful Researchers: >= 10,000 Active Installations
- 1337 Researchers: >= 500 Active Installations

## Out of Scope Assets

Non-exhaustive. Confirm with wfi-support@wordfence.com if unsure.

- WordPress Core (HackerOne)
- All Automattic Products (HackerOne)
- All Facebook Products
- All Google Products
- All Siteground Products
- All Yoast Products

Additionally, Plugins or Themes Closed to Downloads or Sales at the time of submission, or any web service associated with a WordPress plugin or theme that is not run locally (such as an API running on a plugin vendor's website) is considered out of scope. No CVEs and no bounty for the products above.

## Explicitly In-Scope Vulnerabilities

All issues in WordPress Plugins and Themes with a considerable impact to the confidentiality, integrity, and availability of a WordPress site are considered in scope of this program as long as they do not require high level permissions, such as administrator or editor (i.e. CVSSv3.1 PR:H) to exploit.

- Stored Cross-Site Scripting
- Arbitrary Content Deletion
- SQL Injection
- Arbitrary File Upload
- Arbitrary File Download/Read
- Arbitrary File Deletion
- Local File Include/Remote File Include
- Directory Traversal
- Privilege Escalation to Admin
- Privilege Escalation to Non-Admin
- Authentication Bypass to Admin
- Authentication Bypass to Non-Admin
- Remote Code Execution/Code Injection
- Sensitive Information Disclosure
- PHP Object Injection with a useable gadget in the software (or any required pieces of software)
- Intentional Backdoors Added by Developers that are Accessible by Threat Actors

## Explicitly Out of Scope Vulnerabilities

Vulnerabilities that have a minimal impact on the security of WordPress sites, or are unlikely to be successfully exploited in the wild will likely be considered out of scope and rejected for CVE assignment.

- Anything listed in 'Common False Positive Reports'
- Business Logic Flaws where the demonstrated impact is primarily business-related rather than security-related (payment bypasses, pricing manipulation, discount or coupon abuse, order workflow abuse, etc.)
- All DoS Vulnerabilities
- Limited File Uploads
- Reflected Cross-Site Scripting
- Arbitrary Shortcode Execution
- Cross-Site Request Forgery
- Missing Authorization
- Insecure Direct Object Reference
- Basic Information Exposure
- PHP Object Injection w/o a Gadget
- Software containing vulnerable packages or dependencies that are not verifiably exploitable in that plugin or theme
- Any Vulnerability requiring PR:H to Exploit. Administrator, Editor, and Shop Manager roles, along with any other role that has the `unfiltered_html` capability fall into this category.
- Any Vulnerability requiring mid-level authentication to exploit. This includes Contributor and Author roles, along with any other role that needs to be granted by an administrator (i.e. not a common default registration role).
- Open Redirect
- Server-Side Request Forgery
- Vulnerabilities dependent on successfully exploiting a race condition that is not easily replicable in a common configuration
- Cache Poisoning, where this is not a considerable and demonstrable impact to site's security
- Server-Side Request Forgery via DNS Rebinding (if `wp_safe_remote_*` or `wp_http_validate_url()` is in use, not a valid SSRF)
- API Key Updates/Overwrites/Reads
- Vulnerabilities that can only be exploited by an administrator explicitly granting access to a lower-privileged user where the likelihood of an administrator granting access is minimal or the administrator is granting access to functionality and features that can be abused
- Vulnerabilities that require excessive brute force to exploit (case-by-case where likelihood of success is relatively high)
- Private/Hidden/Draft/Pending/Password Protected Post Access

## Common False Positive Reports

Routinely rejected. Non-exhaustive.

Low-Impact or Theoretical Issues:
- Theoretical vulnerabilities
- Issues that lead to username enumeration
- Lack of HTTP security headers
- Clickjacking
- Full path disclosure
- Coupon code exposure
- Wishlist updates
- Google Maps API key access
- Endpoints without brute-force or rate limiting protections
- Any vulnerability with a CVSS 3.1 score lower than 4.0 that cannot be leveraged to achieve a higher impact

Injection & Client-Side Issues (Non-Exploitable/Low Impact):
- CSV Injection
- CSS Injection
- HTML Injection
- Self Cross-Site Scripting (payload is not stored and only rendered upon the initial action)
- Reflected Cross-Site Scripting via headers
- Cross-Site Scripting via SVG file uploads
- File uploads containing embedded client-side scripts or macros (e.g., XSS in PDFs)
- Malicious content stored in safe file types (e.g., PHP code inside a `.jpg` file)
- Double extension file upload attacks (e.g., `.php.png`)
- Safe filetype uploads (e.g., `.jpg`, `.png`) where upload functionality is intentional

Authentication, Authorization & Access Control (Expected or Intentional Behavior):
- IP Spoofing
- CAPTCHA bypasses
- CORS issues
- Tabnabbing
- TOCTOU
- Dismissing notices via CSRF or missing authorization
- Cross-Site Request Forgery on unauthenticated forms with no sensitive actions, or on read-only actions
- Missing authorization where a valid nonce protects the action, or the nonce is not exposed to lower-privileged users
- Access keys or tokens used for authorization when adequately secure
- Arbitrary shortcode execution by Contributor-level users or higher
- High-level (Administrator, Editor, Shop Manager) XSS requiring `unfiltered_html`
- Intentional functionality restricted to administrators (e.g., PHP snippet plugins, tracking script insertion)
- Intentional functionality where scope is appropriately limited (e.g., featured image via a documented feature)
- User registration bypass where registration is intentionally enabled through the software functionality or does not lead to privilege escalation
- Unlimited voting, liking, or counting issues
- 2 Factor Authentication Bypasses
- Missing authorization without a consequential confidentiality, integrity, or availability impact

Environmental/Configuration-Based Issues:
- Vulnerabilities only exploitable on EOL software (PHP, MySQL, Apache, Nginx, OpenSSL, etc.)
- Any SQL injection requiring `wp_magic_quotes` to be disabled
- Vulnerabilities requiring local server access
- Vulnerabilities requiring unsafe PHP configuration changes (e.g., enabling `allow_url_fopen`)
- Secrets stored in plaintext that cannot be exploited through another vulnerability
- Uploaded files in publicly accessible directories where exposure does not lead to site compromise
- Software containing vulnerable dependencies that are not verifiably exploitable within the plugin or theme
- Information exposed when `WP_DEBUG` is enabled
- Vulnerabilities dependent on an administrator misconfiguring or insecurely configuring their settings or environment

Browser Version Requirements:
- Vulnerabilities that only affect users of outdated or unpatched browsers (two stable versions behind the latest release)
