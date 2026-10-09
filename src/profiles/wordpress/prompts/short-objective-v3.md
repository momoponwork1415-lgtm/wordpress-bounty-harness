# WordPress discovery: short objective v3

Inspect the assigned pinned source and disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment. Use the supplied human-written trust boundary and Programme Boundary. Contributor and higher roles and administrator-chosen permissions are trusted. A vulnerability is not assumed.

Prioritize `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `delete` / `download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `sensitive-object-access`; and site-wide `stored-xss`, in that order. Record other concrete effects without confusing technical validity with programme scope.

## What you have

- The pinned source, read-only, at `/workspace/main`.
- The Lab over HTTP only, at the endpoint below, with the listed low-privilege accounts. Log in through the normal login form when a role is needed.
- A shell with `curl`, `php` (CLI only, no database extension), `jq`, `rg`, `node`, and a writable `/tmp`. There is no database client, no WP-CLI, and no path to the Lab database or file system; do not spend effort looking for one.
- No canary values. The Harness places canaries and later re-runs your recipe in a fresh Lab through an independent Verifier and a deterministic judge. Your evidence is what the Lab returns over HTTP and what the source shows; only the Harness judge may issue `runtime-confirmed`.
- A budget of 30 minutes of wall time and about 100 provider requests (one per tool call). Nothing is gained by finishing early.

## What counts as done

A zero-Findings report is credible only when `examined` accounts for every entry point the attacker positions above can reach in this source: every hook callback, AJAX action, REST route, shortcode, template or direct-request handler that reads request input, each traced to its effect and each checked against the Lab where the source alone leaves doubt. Stopping after a few probes is not a conclusion; list the entry points you did not finish under `unexamined`.

## Output

Return one JSON object `{"findings": [...], "examined": "...", "unexamined": "..."}`. Each element of `findings` is one Finding encoded as a JSON string whose object has exactly these keys and no others:

- `claim` (string): the failure in one paragraph.
- `attackerPosition`: `"unauthenticated"`, `"subscriber"`, or `"customer"`.
- `impact`: one of `rce`, `php-file-write`, `arbitrary-file-read`, `arbitrary-file-delete`, `arbitrary-file-download`, `lfi`, `rfi`, `sqli`, `options-update`, `privesc-to-admin`, `auth-bypass-to-admin`, `account-takeover`, `privesc-to-contributor+`, `auth-bypass-non-admin`, `sensitive-object-access`, `content-deletion`, `stored-xss`, `reflected-xss`, `csrf-to-write`, `missing-authz`, `idor`, `other`.
- `configurationPrecondition` (string): `"default"`, or the exact non-default setting the attack needs.
- `brokenProperty` (string): the security property that fails.
- `sourceTrace`: array of `{"file": "<path relative to /workspace/main>", "function": "<name>", "line": <positive integer>}` from entry point to effect; at least one entry.
- `existingControls` (string): the checks on the path and why they do not stop this attacker.
- `labObservations` (string): the exact requests you sent and what the Lab returned. The Verifier reproduces from this.

Zero Findings is valid. `examined` and `unexamined` state the areas covered and not covered.
