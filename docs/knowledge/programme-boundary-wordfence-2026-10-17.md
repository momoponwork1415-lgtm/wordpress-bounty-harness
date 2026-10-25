# Wordfence Programme Boundary（2026-10-17 版）

`src/profiles/wordpress/policy/campaign.json` の `wordfence-2026-10-17` 版から保存した旧文。過去 Trial の入力照合に使う。2026-10-26 版では、最後の節の「an administrator's explicit configuration」を、管理者が明示的に付与する権限と、通常のサイトが有効にし得る設定の扱いに書き直した（ADR 0038 の 2026-10-26 追記 11）。

```text
Wordfence Bug Bounty Program, campaign boundary revised 2026-10-17. In scope for this campaign: impact reachable by an unauthenticated visitor, a Subscriber or a Customer. Highest value: arbitrary PHP file upload or read, arbitrary PHP file deletion, remote code execution, authentication bypass to admin, privilege escalation to admin. Also in scope: account takeover, stored XSS, SQL injection, arbitrary file read, download or delete, local or remote file inclusion, and directory traversal. Out of scope for this campaign: sensitive information disclosure; access to private, draft or password-protected content; basic information disclosure; arbitrary content deletion; arbitrary options update; privilege escalation or authentication bypass that stops below admin; reflected XSS; CSRF; missing authorization; IDOR; denial of service; business-logic-only impact; and routes requiring Contributor, Author, Editor, Shop Manager or Administrator, or an administrator's explicit configuration or grant of permissions.
```
