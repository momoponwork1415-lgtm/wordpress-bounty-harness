# WordPress discovery: screening v1

Inspect the pinned source of the assigned plugin and its disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment with default settings. Contributor and higher roles, and any permission an administrator grants deliberately, are trusted. A vulnerability is not assumed. Zero Findings is a valid result.

Priorities, in order: `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `arbitrary-file-delete` / `arbitrary-file-download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `stored-xss`; `sensitive-object-access`. Record other concrete effects without promoting them.

This run is about coverage, not depth. Start from the entry-point index supplied below: every externally reachable handler the plugin registers. For each entry, read the handler and what it reaches, and classify it as trusted (state why), reachable but safe (state why), or candidate (state what fails). Go through the whole index before going deep on any single candidate. When the index is exhausted, continue with public-facing code the index does not list: template output, front-end forms, scheduled tasks, activation and uninstall paths.

A Finding needs a complete chain with a source location for each edge: the input the attacker controls, the check that is missing or does not bind, the operation it reaches, and the effect. Use the Lab to confirm that the entry is reachable and what the response looks like; write down only what you observed, and write `none` if you observed nothing. If one edge is unsupported, record a Lead with the exact gap instead of a Finding. Do not turn a partial route into a Finding to fill the report.

Only the Harness judge issues `runtime-confirmed`. You do not have to demonstrate impact; state precisely what the judge should expect to observe and under which role and configuration.

Report `examined` and `unexamined` so that a later run can continue where you stopped. Stop when the index and the public-facing code are covered or the run limit is reached. Do not stop because one strong candidate exists.
