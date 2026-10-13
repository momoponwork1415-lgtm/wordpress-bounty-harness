<!-- provenance: /home/dev/wp-bounty-workspace/selection/wordfence-scope-capture-20260816.md, mtime 2026-08-16, imported 2026-10-13, generation 08-workspace. 取り込み時に Hall of Fame の件別一覧（公開 page の top-20、1,359 行まで）と page 末尾の UI / script 断片を省いた -->

# Wordfence bug bounty scope — captured 2026-08-16

Source: https://www.wordfence.com/threat-intel/bug-bounty-program/ (the `#scope` tab, which
is present in the HTML but not rendered until the tab is activated). Read through a local
headless Chrome because the site sits behind an AWS WAF JS challenge that returns the
challenge page to a plain HTTP client.

Captured verbatim below, tags stripped. This is public program documentation, not target data.

---

Explicitly In-Scope Vulnerabilities

All issues in WordPress Plugins and Themes with a considerable impact to the confidentiality, integrity, and availability of a WordPress site are considered in scope of this program as long as they do not require high level permissions, such as administrator or editor (i.e. CVSSv3.1 PR:H) to exploit. The following is a list of some common vulnerabilities that will be accepted.

- Stored Cross-Site Scripting
- Reflected Cross-Site Scripting
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

Vulnerabilities that have a minimal impact on the security of WordPress sites, or are unlikely to be successfully exploited in the wild will likely be considered out of scope for the program and will be rejected for CVE assignment upon submission.

- Anything listed in our 'Common False Positive Reports' is automatically considered Out of Scope as they are not considered valid vulnerabilities
- Business Logic Flaws where the demonstrated impact is primarily business-related rather than security-related. This includes, but is not limited to, issues such as payment bypasses, pricing manipulation, discount or coupon abuse, order workflow abuse, or other logic flaws that affect revenue, transactions, or business operations without introducing a direct security impact.
- All DoS Vulnerabilities
- Limited File Uploads
- Cross-Site Request Forgery
- Missing Authorization
- Insecure Direct Object Reference
- Basic Information Exposure
- PHP Object Injection w/o a Gadget
- Software containing vulnerable packages or dependencies that are not verifiably exploitable in that plugin or theme
- Any Vulnerability requiring PR:H to Exploit. Administrator, Editor, and Shop Manager roles, along with any other role that has the unfiltered_html capability fall into this category.
- Any Vulnerability requiring mid-level authentication to exploit. This includes Contributor and Author roles, along with any other role that needs to be granted by an administrator (i.e. not a common default registration role).
- Open Redirect
- Server-Side Request Forgery
- Vulnerabilities dependent on successfully exploiting a race condition that is not easily replicable in a common configuration
- Cache Poisoning, where this is not a considerable and demonstrable impact to site's security
- Server-Side Request Forgery via DNS Rebinding (i.e. if wp_safe_remote_* or wp_http_validate_url() is in use, we do not consider the issue a valid SSRF vulnerability)
- API Key Updates/Overwrites/Reads
- Vulnerabilities that can only be exploited by an administrator explicitly granting access to a lower-privileged user where the likelihood of an administrator granting access is minimal or the administrator is granting access to functionality and features that can be abused
- Vulnerabilities that require excessive brute force to exploit. Please note we may accept vulnerabilities as in scope where brute force is required and the likelihood of success is relatively high. Scope eligibility will be determined on a case-by-case basis.
- Private/Hidden/Draft/Pending/Password Protected Post Access

## Common False Positive Reports

The following issues are frequently reported to our program but are not considered valid vulnerabilities and are routinely rejected. This list is not exhaustive and there may be other issues that we reject, these are just some of the most common issues we reject. Please do not submit reports for the following:

- Low-Impact or Theoretical Issues

- Theoretical vulnerabilities
- Issues that lead to username enumeration
- Lack of HTTP security headers
- Clickjacking
- Full path disclosure
- Coupon code exposure
- Wishlist updates
- Google Maps API key access
- Endpoints without brute-force or rate limiting protections (rate limiting is considered a server-side control)
- Any vulnerability with a CVSS 3.1 score lower than 4.0 that cannot be leveraged to achieve a higher impact

- Injection & Client-Side Issues (Non-Exploitable/Low Impact)

- CSV Injection
- CSS Injection
- HTML Injection
- Self Cross-Site Scripting (i.e. the payload is not stored and only rendered upon the initial action)
- Reflected Cross-Site Scripting via headers
- Cross-Site Scripting via SVG file uploads
- File uploads containing embedded client-side scripts or macros (e.g., XSS in PDFs)
- Malicious content stored in safe file types (e.g., PHP code inside a .jpg file)
- Double extension file upload attacks (e.g., .php.png)
- Safe filetype uploads (e.g., .jpg, .png) where upload functionality is intentional

- Authentication, Authorization & Access Control (Expected or Intentional Behavior)

- IP Spoofing
- CAPTCHA bypasses
- CORS issues
- Tabnabbing
- TOCTOU
- Dismissing notices via CSRF or missing authorization
- Cross-Site Request Forgery:

- On unauthenticated forms with no sensitive actions
- On read-only actions

- Missing authorization where:

- A valid nonce protects the action
- The nonce is not exposed to lower-privileged users

- Access keys or tokens used for authorization when adequately secure
- Arbitrary shortcode execution by Contributor-level users or higher
- High-level (Administrator, Editor, Shop Manager) XSS requiring unfiltered_html
- Intentional functionality restricted to administrators (e.g., PHP snippet plugins, tracking script insertion)
- Intentional functionality where scope is appropriately limited (i.e. user can submit a post with a featured image due to the plugin enabling such functionality as a well documented feature)
- User registration bypass where registration is intentionally enabled through the software functionality or does not lead to privilege escalation
- Unlimited voting, liking, or counting issues (i.e. a page counter where the count can be increased by several requests)
- 2 Factor Authentication Bypasses
- Missing authorization without a consequential confidentiality, integrity, or availability impact.

- Environmental/Configuration-Based Issues

- Vulnerabilities only exploitable on EOL software (PHP, MySQL, Apache, Nginx, OpenSSL, etc.)
- Any SQL injection requiring wp_magic_quotes to be disabled
- Vulnerabilities requiring local server access
- Vulnerabilities requiring unsafe PHP configuration changes (e.g., enabling allow_url_fopen)
- Secrets stored in plaintext that cannot be exploited through another vulnerability
- Uploaded files in publicly accessible directories where exposure does not lead to site compromise
- Software containing vulnerable dependencies that are not verifiably exploitable within the plugin or theme
- Information exposed when WP_DEBUG is enabled.
- Vulnerabilities dependent on an administrator misconfiguring or insecurely configuring their settings or environment.

- Browser Version Requirements

- Vulnerabilities that only affect users of outdated or unpatched browsers (defined as two stable versions behind the latest release.)

We no longer assign CVE IDs to any vulnerabilities found in the out of scope list above and they will not be eligible for a bounty through our bug bounty program.

## Program Rules Key Highlights & Important Things to Know

- Our rewards go all the way up to
$31,200 for Standard Researchers
, and
$32,760 for 1337 Researchers
. Use our bounty estimator to get an idea of what bounties you may be awarded for different vulnerability types, or check out our Bounty Hall of Fame to see real examples of the bounties we have awarded. Researchers are also eligible for additional bonuses that may increase bounties further.
- You must be a registered researcher on the Wordfence website, and be authenticated at the time of submission, in order to submit a vulnerability for the Bug Bounty Program.
- Vulnerabilities that require more than one CVE assignment may only earn a single bounty for the higher awarding CVE (i.e. Cross-Site Request Forgery and Missing Authorization in a single function)
- Researchers can be banned or throttled from the program if they are continuously submitting low-quality or spammy false positive reports, or appear to be gaming the rules of the program in a harmful fashion.
- Developers cannot report vulnerabilities in their own software for bounties, though they can submit issues for CVE ID assignments.
- Wordfence must handle the responsible disclosure process for any reported vulnerabilities, and you must keep the information confidential until we publicly disclose the issue in our database. This means Wordfence must be the only organization you submit the vulnerability to.
- The first researcher to submit a vulnerability with a valid and working proof of concept will be the only one to receive a bounty in the event of a duplicate report.
- Bounty payments are processed in bulk on the 1st and 15th of every month.
- In-Scope submissions are triaged according to the priority level shown to you on the researcher dashboard, with critical issues having a much faster turnaround. Out-of-Scope submissions are triaged as time allows or rejected immediately upon submission.
- You may be eligible for a monthly streak bonus reward depending on the quality and volume of submissions you make in any calendar month. Review our monthly streak bonus details here.
- Once registered, you will have access to our researcher dashboard where you can track and manage all of your vulnerability submissions, reward payments, profile details, and referral information.
- Remember that when you participate in our Bug Bounty program, you are giving back to the security of the WordPress ecosystem. All of the vulnerabilities submitted to us are added to the Wordfence Intelligence vulnerability database which is given back to the community through webhook and API access completely for free. All other WordPress-centric vulnerability databases charge for this level of access.
- All newly registered researchers will be considered ‘New Researchers’ and limited to 15 total reports pending triage, with 10 of those being in-scope, until they have submitted at least 10 validated vulnerability submissions, or unlocked the 1337 Researcher or Resourceful Researcher Tier.

- These researchers will also be subject to Out of Scope report throttling:

- If a New Researcher submits too many out of scope reports in a short period of time, their ability to submit new vulnerabilities will be throttled.
- If a New Researcher submits 10 out of scope vulnerabilities in a period of 7 days, they will be blocked from any further submissions for at least 7 days.

- You may be temporarily throttled from any further submissions to Wordfence if you submit too many false positive, low-quality, or AI hallucinated reports.

- You may be throttled from any further submissions:

- For 7 days, if 5 False Positives are reported in a period of 7 days
- For 14 days, if 10 False Positives are reported in a period of 14 days
- For 30 days, if 20 False Positives are reported in a period of 30 days
- For 30 days, if 2 AI hallucinated reports are submitted

- You may be banned permanently from the program if you:

- Submit 4 or more AI hallucinated reports (where the code reported does not exist in the codebase)
- Submit 30 or more false positive reports

## Pending In-Scope Report Limits
All researchers have a limit to the number of vulnerabilities that can be actively submitted and pending triage at one time for participation in the Bug Bounty Program. The following outlines these pending report limits:

### Standard Researchers
10
 pending in-scope reports

### Resourceful Researchers
25
 pending in-scope reports

### 1337 Researchers
50
 pending in-scope reports

This allows us to control the flow of submissions to ensure we can sustain reasonable triage times for all of our researchers and everyone has a fair chance at submitting qualifying vulnerabilities.

### When do in-scope reports roll over?
Only vulnerabilities in triage or pending triage will count against your pending report limit. This means that as soon as a vulnerability is validated by our team, you are eligible to submit another in-scope report.

Pro-Tip:
 You can track and manage how many submissions you have available on the researcher dashboard. In addition, you will know if you are at your pending report limit by accessing the vulnerability submission form. If you get a notice that you are at your limit then you can not submit any more vulnerabilities for participation in the Bug Bounty Program. If you do not get a notice, then you are all clear to submit another bounty-eligible report.

For a more detailed overview, please read our terms and conditions.

There are various researcher tiers that control what your scope is and how many pending vulnerability submission reports you can have at any given time.

### Standard Researchers

Every registered researcher starts out in our standard researcher tier.

This tier allows:

-
up to 10 in scope reports
 pending triage at any given time
- all predefined
high threat vulnerabilities
 in WordPress plugins/themes with
>= 25 active installations
 to be in scope. See Program Scope for more details on high threat vulnerabilities.
- all predefined
common and dangerous vulnerabilities
 in WordPress plugins/themes with
>= 500 active installations
 to be in scope. See Program Scope for more details on common and dangerous vulnerabilities.
- all
other in-scope vulnerabilities
 in WordPress plugins/themes with
>= 50,000 active installations
 to be eligible.

### Resourceful Researchers

These are researchers who have proven they have what it takes to provide significant and meaningful contributions to security of the WordPress ecosystem.

This tier allows:

-
up to 25 in scope reports
 pending triage at any given time
- all predefined
high threat vulnerabilities
 in WordPress plugins/themes with
>= 25 active installations
 to be in scope. See Program Scope for more details on high threat vulnerabilities.
- all predefined
common and dangerous vulnerabilities
 in WordPress plugins/themes with
>= 500 active installations
 to be in scope. See Program Scope for more details on common and dangerous vulnerabilities.
- all
other in-scope vulnerabilities
 in WordPress plugins/themes with
>= 10,000 active installations
 to be in eligible.

To unlock this tier, you must:

- submit 1 critical severity, high impact, in scope vulnerability
-
or
 3 high severity, high impact, in scope vulnerabilities
-
or
 10 high or critical severity, medium impact, in scope vulnerabilities

and:

- you
must not
 have submitted more than 5 False Positive or Low Quality Reports.

Additional Benefits

- an exclusive achievement badge added to your profile

### 1337 Researchers

These are researchers who have demonstrated exceptional and meaningful research in the WordPress ecosystem.

This tier allows:

-
up to 50 in scope reports
 pending triage at any given time
- all predefined
high threat vulnerabilities
 in WordPress plugins/themes with
>= 25 active installations
 to be in scope. See Program Scope for more details on high threat vulnerabilities.
- all predefined
common and dangerous vulnerabilities
 in WordPress plugins/themes with
>= 500 active installations
 to be in scope. See Program Scope for more details on common and dangerous vulnerabilities.
- all WordPress plugins/themes with
>= 500 active installations
 to be in scope.

To unlock this tier, you must:

- submit 5 critical severity in scope vulnerabilities
-
or
 10 high severity in scope vulnerabilities

and:

- submit proof of a certification (OSCP, OSWA, OSWE, OSEP, OSED, eWPTx, eWPT, CISSP, CISM, CISA, GWAPT)
-
or
 submit 15 high quality valid vulnerabilities in total

and:

- submit no more than 10 False Positive or Low Quality reports.

Additional Benefits

- 5% automatic bonus on all eligible submissions
- an exclusive achievement badge added to your profile

Special Note:
 Anything in the lists of examples below, in software with 1,000 to 50,000 Active Installs is considered a 'Medium' impact issue and will count towards earning the Resourceful Researcher tier.

### What are critical or high severity vulnerabilities in our eyes?
Qualifying vulnerabilities are not based on CVSS score, but rather a combination of CVSS scoring and the threat factor (i.e. likelihood of mass exploitation) of the vulnerability. The following outlines vulnerabilities that are critical and high "severity" qualifying vulnerabilities. This list is exhaustive, but exceptions may be made for vulnerabilities on a case by case basis. Please note that these all assume there are no prerequisites to exploit (i.e. settings or user interaction). In order for a vulnerability to qualify, the vulnerable plugin or theme should have >=50,000 active installations.

### Critical Severity Examples

- Unauthenticated Arbitrary File Deletion
- Unauthenticated Arbitrary File Read
- Unauthenticated Arbitrary File Upload to Remote Code Execution
- Unauthenticated Remote Code Execution
- Unauthenticated Privilege Escalation
- Unauthenticated SQL Injection
- Unauthenticated Stored Cross-Site Scripting
- Missing Authorization to Unauthenticated Data Alteration or Read in a Critical Way
- Authentication Bypass to Admin

### High Severity Examples

- Authenticated (Subscriber/Customer) Remote Code Execution
- Authenticated (Subscriber/Customer) Arbitrary File Upload to Remote Code Execution
- Authenticated (Subscriber/Customer) Arbitrary File Deletion
- Authenticated (Subscriber/Customer) Arbitrary File Read
- Authenticated (Subscriber/Customer) Privilege Escalation to Admin
- Authenticated (Subscriber/Customer) SQL Injection
- Authenticated (Subscriber/Customer) Stored Cross-Site Scripting
- Missing Authorization to Authenticated (Subscriber/Customer) Data Alteration or Read in a Critical Way

Our goal with the Wordfence Bug Bounty Program is to get the most impactful and harder to find vulnerabilities remediated before threat actors can find and exploit them as an 0-day. This means we award the highest bounty rewards for things like authentication bypasses, privilege escalation, arbitrary file uploads, and arbitrary options updates while easier to find vulnerabilities like Cross-Site Scripting, or less likely to be exploited vulnerabilities, like vulnerabilities that require contributor-level access or user interaction to exploit, are awarded far less. We hope this encourages researchers to spend more time focusing on harder to find critical issues that greatly increase the overall security of the WordPress ecosystem.

All bounty rewards are based on how many active installations the vulnerable piece of software has, the type of vulnerability being reported, the authentication requirements to exploit the vulnerability, the impact of the vulnerability, and what, if any, prerequisites to exploit.

Our rewards go all the way
up to $31,200
 for standard researchers, and
$32,760
 for 1337 Researchers. Use our bounty estimator to get an idea of what bounties you may be awarded for different vulnerability types, or check out our Bounty Hall of Fame to see real examples of the bounties we have awarded.

### Bounty Estimator

Researcher TierStandard Researcher1337 ResearcherResourceful Researcher

Install Count 1< 2525 - 499500 - 9991,000 - 4,9995,000 - 9,99910,000 - 14,99915,000 - 29,99930,000 - 49,99950,000 - 99,999100,000 - 499,999500,000 - 999,9991,000,000 - 4,999,9995,000,000+

Vulnerability TypeRemote Code Execution/Code InjectionIntentional Backdoors Accessible by Threat ActorStored Cross-Site ScriptingReflected Cross-Site ScriptingSQL InjectionLocal File Include/Remote File IncludeArbitrary File Download/ReadDirectory TraversalArbitrary File UploadSensitive Information DisclosureArbitrary File DeletionArbitrary Options UpdateAuthentication Bypass to AdminPrivilege Escalation to AdminArbitrary Shortcode ExecutionAuthentication Bypass to Non-AdminPrivilege Escalation to Non-Admin

Privileges RequiredLow-Level Authentication (Subscribers, Customers, Students)Mid-Level Authentication (Contributor, Authors)High-Level Authentication (Shop Manager, Administrator, Super Admin, Editor)No Authentication

1  For any software with an estimated active install count lower than 1,000, the plugin or theme must be available in the WordPress.org repository to be considered in scope. This means that premium plugins and themes are excluded from our scope if the software has fewer than 1,000 estimated active installations.
By using the Bounty Estimator you agree that the tool provides an estimated reward amount only and does not guarantee that the reward amount is accurate or will be paid to you. Your use of the Bounty Estimator is subject to the Defiant Terms of Service.

Please note that the bounty estimator provides an estimated reward amount only and is subject to change at any time. Any estimate provided by the bounty estimator is not a guarantee of a specific reward amount. Many factors can impact the bounties we award such as:

- Prerequisites to exploit, such as software settings or specific server configuration
- Ease and replicability of exploitation (i.e. if the vulnerability can be automatically exploited across various environments)
- Active user interaction, or unlikely passive user interaction, as a requirement to exploit
- The impact the vulnerabilities has on the site as a whole (i.e. to what extent does the vulnerability impact the CIA of the site).
- Dependency on another vulnerability not present in the same vulnerable piece of software. Typically the payout is divided by at least half.
- We have a minimum bounty award of $5.

Other important things to consider with the bounties we typically award:

- PHP Object Injection will be awarded at the highest level of impact if a
newly
 documented usable gadget is present in the software, or in the current version of WordPress Core, and exploitation of it is demonstrated in the submitted report. Otherwise, PHP Object Injection is awarded at a lower rate to account for the fact that no usable gadget means no real impact or the presence of a useable gadget is already known and has been demonstrated to earn a maximum reward. Note: “newly documented” means the POP Chain present in the plugin has not been previously leveraged to earn a bounty in the Wordfence Bug Bounty Program.
- The ‘Basic Information Disclosure’ type is often used when information is exposed to unauthorized users, but the information is not incredibly sensitive (i.e. email disclosure, log file exposure, phpinfo access, etc.)
- For premium plugins and themes without public active installation counts, we defer to number of sales as a 1-to-1 count of active installations. This means that if a plugin has 150,000 sales then we would consider that 150,000 active installations. If no sales information is available, we use an internal metric to ballpark estimate active installation counts. Please note that active sales for a premium plugin or theme does not automatically equate to a 1-to-1 comparison for any plugins and themes bundled in that software. We determine active install counts in these scenarios at our discretion.
- If there is a premium version of a free plugin or theme where the premium version of the software is in an in-scope installation range, we may consider the premium version of the software in-scope based on the free plugin's install count. However, the reward will be based on the premium version of the plugin or theme's installation counts.

## Monthly Bug Detector Streak Bonus
Each calendar month (for example, January 1–31), you can earn a
Monthly Bug Detector Streak Bonus
 based on the
quality, diversity, and impact
 of your vulnerability submissions.

Bonuses are
not cumulative.
 Your reward is determined by the
highest bonus tier you qualify for within that month.
 For example, if you qualify for the $200 tier after submitting 20 vulnerabilities, your total bonus for the month will be
$200
, not the sum of lower tiers.
Vulnerabilities must always be in-scope to count towards increasing the monthly streak bonus.

To encourage high-quality and varied research, certain limits apply to how submissions count toward streak progression. These are outlined below.

### Bonus Qualification StructureApprentice Bug Detector
(Submissions 1-10 each month)

You may qualify for:

-
$35 bonus
 for at least
5 valid submissions.

-
$75 bonus
 for
10 valid submissions.

Trainee Bug Detector
(Submissions 11-30 each month)

You may qualify for:

-
$200 bonus
 for 20 total valid submissions.
-
$300 bonus
 for 30 total valid submissions.
Professional Bug Detector
(Submissions 31+ each month)

For higher-volume contributors:

-
Only vulnerabilities from our High-Threat list count
 toward increasing your bonus

You may qualify for:

-
$600 bonus for 40 valid submissions
, with at least:

- 30 in-scope
- 10 from the high-threat list.

-
$1,000 bonus for 50 valid submissions
, with at least:

- 30 in-scope
- 20 from the high-threat list.

-
$1,200 bonus for 60 valid submissions
, with at least:

- 30 in-scope
- 30 from the high-threat list.

### Additional Quality Safeguards
To promote meaningful and diverse research:

-
Out of Scope submissions will not count toward streak progression

- Only
5 vulnerabilities per calendar year
 will count toward streak bonuses for any unique combination of:

-
Vulnerability type (CWE)

-
Required authentication level

Once this annual limit is reached for a specific CWE + authentication combination, additional submissions of that same type may still be submitted and rewarded normally, but will not increase your Monthly Streak Bonus.

### Payout Schedule
Monthly Bug Detector Streak Bonuses are paid on the same schedule as bounty rewards —
the 1st and 15th of each month
 — after review and approval by our team.

## Bounty Bonuses
In addition to our bounties, we offer bonuses for exceptional, well documented, and unique researchers. Please find all of the additional bonuses we may award listed below:

###  Proof of Active Exploitation on an 0-day?
15%

If you are able to supply sufficient evidence that a vulnerability is being actively exploited, without a patch in place, and we can corroborate that evidence, you may receive this multiplier.

###  Chaining Master!
15%

If you are able to successfully chain multiple vulnerabilities together in a single piece of software to achieve a higher impact vulnerability, such as privilege escalation to admin, you may receive this multiplier.

###  Creative Vulnerability Finder
10%

If you find a new technique or vulnerability type that hasn’t received much coverage, you may receive this multiplier.

###  Meaningful Researcher
10%

If you submit a vulnerability report with ample documentation and an easy to use proof of concept to verify the vulnerability, you may receive this multiplier.

###  1337 Wordfence Vulnerability Researcher Program Bonus
5%

Once you earn 1337 Wordfence Vulnerability Researcher status, you are automatically eligible to receive this bonus on all vulnerabilities found and reported to the Wordfence bug bounty program.

###  Affects Multiple Assets?
Varies

If you submit a vulnerability that affects multiple pieces of software (i.e. the same code is present in multiple pieces of software) and you detail all the software, you may receive a multiplier of
+10% for every 10 pieces of software affected
.

 This may be limited to 100 affected software pieces. A researcher is only eligible for this bonus if they have documented all affected software and versions in their report.

###  Affects Multiple Functions?
Varies

If you submit a vulnerability type that affects multiple functions (i.e. the vulnerability type is present in multiple functions or pieces of functionality) and you detail all the functions, widgets, and/or functionality you may receive a multiplier of
+20% for each of the first 5 functions or widgets affected, +10% for every 5 functions affected from 6 to 20, and then +5% for every 5 functions affected from 21-50.

This may be limited to 50 affected functions. A researcher is only eligible for this bonus if they have documented all affected functions adequately in their report.

The Achievement Badges for the Wordfence Bug Bounty Program are designed to recognize the contributions and skills of participants in enhancing the security of the WordPress open-source community. Through a system of badges named "Achievements," individuals are rewarded for their expertise, perseverance, and collaborative efforts in making the WordPress environment safer. These badges signify not only personal growth and discovery but also professional development, as they are displayed on the researcher's profile, enhancing their reputation and providing clear milestones in their bug-hunting career.

This initiative encourages both seasoned and novice security researchers to engage actively, pursue continual improvement, and gain acknowledgment within the open-source ecosystem, with the promise of expanding the badge offerings in the future to further incentivize and track progress in contributing to a more secure open-source community.

## Submitted LFI Vulnerability
This achievement is awarded to individuals who have submitted at least one valid Local File Include (LFI) vulnerability to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted SQLi Vulnerability
This achievement is awarded to individuals who have submitted at least one valid SQL Injection (SQLi) vulnerability to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted XSS Vulnerability
This achievement is awarded to individuals who have submitted at least one valid Cross-Site Scripting (XSS) vulnerability to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## WordPress Superhero
This achievement is awarded to individuals who have submitted at least one critical or high severity vulnerability in a plugin or theme with over 5,000,000 Active Installations to the Wordfence Bug Bounty Program.

## Resourceful Researcher
This achievement is exclusively for researchers who earn the Resourceful Researcher status. These individuals have demonstrated significant and meaningful research in the WordPress Security space.

## 1337 Vulnerability Researcher
This achievement is exclusively for researchers who earn 1337 Wordfence Vulnerability Researcher status. These individuals have demonstrated exceptional and meaningful research in the WordPress Security space.

## Submitted 1 Vulnerability
This achievement is awarded to individuals who have submitted at least one valid vulnerability to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 5 Vulnerabilities
This achievement is awarded to individuals who have submitted at least five valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 10 Vulnerabilities
This achievement is awarded to individuals who have submitted at least ten valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 25 Vulnerabilities
This achievement is awarded to individuals who have submitted at least twenty five valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 50 Vulnerabilities
This achievement is awarded to individuals who have submitted at least fifty valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 75 Vulnerabilities
This achievement is awarded to individuals who have submitted at least seventy five valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 100 Vulnerabilities
This achievement is awarded to individuals who have submitted at least one hundred valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 200 Vulnerabilities
This achievement is awarded to individuals who have submitted at least two hundred valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 300 Vulnerabilities
This achievement is awarded to individuals who have submitted at least three hundred valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 400 Vulnerabilities
This achievement is awarded to individuals who have submitted at least four hundred valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 500 Vulnerabilities
This achievement is awarded to individuals who have submitted at least five hundred valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Submitted 750 Vulnerabilities
This achievement is awarded to individuals who have submitted at least seven hundred and fifty valid vulnerabilities to the bug bounty program. Please note, in order for a researcher to earn this badge the vulnerability must be submitted directly to Wordfence and must have a registered researcher account at the time of submission.

## Wordfence Vulnerability Researcher
This achievement is exclusively for employees and contractors of Wordfence. The only way to earn this achievement is to be an employee of Wordfence, or a contractor working with Wordfence, and discover at least one vulnerability.

## Refer a Researcher
This achievement is awarded to researchers who have referred at least one contributing researcher to the Wordfence Bug Bounty Program.

[Hall of Fame の件別一覧は省略: 公開 page の All-Time Bounty Payouts $917,993 / All-Time Published Submissions 9,038（2026-08-16 時点）だけを残す。元 file /home/dev/wp-bounty-workspace/selection/wordfence-scope-capture-20260816.md の 595〜1,358 行]

## Refer-A-Researcher Program
Introducing the
Wordfence Refer-A-Researcher Program
! This initiative rewards our top security researchers for bringing new talent to our Bug Bounty Program. If you're an active contributor, you can refer researchers and earn commissions while helping to strengthen WordPress security.

Eligible researchers will be notified by email once they’ve met the Wordfence Refer-A-Researcher Program eligibility requirements. At that point, access to apply to the Wordfence Refer-A-Researcher Program can be found on the researcher dashboard. Note that researchers who do not meet the eligibility requirements will not be able to view or complete the application until the requirements are met.

Researchers that are a part of the Wordfence Refer-A-Researcher Program will receive a special referral link that can be shared to new researchers for signing-up that will allow referring researchers to earn a commission based on the first few submissions of a newly referred researcher.

### Benefits
Earn a 20% commission on the cumulative bounties from the
first five validated reports
 submitted by your referrals. It's a rewarding way to help expand our community of security experts! The commission earnings are unlimited, meaning there are no caps to how much you can earn by referring researchers.

Maximize your commissions by encouraging and helping other researchers learn how to hunt for the most impactful and critical vulnerabilities in WordPress, which will ultimately lead to a bigger reward for you, your referral, and the WordPress ecosystem.

To provide an example, if a researcher submits 5 vulnerabilities earning $100 each, then the referring researcher would earn a bonus of $100 after those 5 vulnerabilities have been submitted, validated, and their bounties approved.

### Eligibility
To qualify, you must:

- Be registered as a researcher for at least one month
- Submit at least 10 valid in-scope vulnerabilities
- Actively promote meaningful vulnerability research in WordPress
- Receive approval from the Wordfence Bug Bounty Team
- Once eligible, you will receive an email letting you know that you can apply. You can also track your eligibility in your Researcher Dashboard.

### How it Works
After you're approved, here's how it works:

- You share your unique referral link to a researcher who is not already registered as part of our program.
- The researcher signs up using the link you've provided them. Our team approves their profile.
- You help and encourage the referred researcher to submit their first 5 in-scope reports.
- You can track their progress from your Researcher Dashboard.
- After the researcher submits their first 5 in-scope validated reports, you earn a commission bonus of 20% of the total bounties that were awarded for those submissions.
Review the full terms and conditions.

Did you know Wordfence Intelligence provides free personal and commercial API access to our comprehensive WordPress vulnerability database, along with a free webhook integration to stay on top of the latest vulnerabilities added and updated in the database? Get started today!
Learn more

Want to get notified of the latest vulnerabilities that may affect your WordPress site?
 Install Wordfence on your site today to get notified immediately if your site is affected by a vulnerability that has been added to our database.
Get Wordfence

 The Wordfence Intelligence WordPress vulnerability database is completely free to access and query via API. Please review the documentation on how to access and consume the vulnerability data via API.
Documentation

Our business hours are 9am-8pm ET, 6am-5pm PT and 2pm-1am UTC/GMT excluding weekends and holidays.
 Response customers receive 24-hour support, 365 days a year, with a 1-hour response time.

- Terms of Service
- Privacy Policy and Notice at Collection
- Do Not Sell or Share My Personal Information

-

-

-

-

Products

- Wordfence Free
- Wordfence Premium
- Wordfence Care
- Wordfence Response
- Wordfence CLI
- Wordfence Intelligence
- Wordfence Central

Support

- Documentation
- Learning Center
- Free Support
- Premium Support

News

- Blog
- In The News
- Vulnerability Advisories

About

- About Wordfence
- Affiliate Program
- Employment
- Contact
- Security
- CVE Request Form

Stay Updated

Sign up for news and updates from our panel of experienced security professionals.

Email


[page 末尾の newsletter form、cookie banner、window.* 設定の断片は省略]
