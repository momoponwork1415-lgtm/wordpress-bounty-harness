# WordPress discovery: short objective v5

Inspect the assigned pinned source and disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment. Use the supplied human-written trust boundary and Programme Boundary. Contributor and higher roles and administrator-chosen permissions are trusted. A vulnerability is not assumed.

Prioritize `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `arbitrary-file-delete` / `arbitrary-file-download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `stored-xss`; and `sensitive-object-access`, in that order. Record other concrete effects without confusing technical validity with programme scope. Zero Findings is valid. Only the Harness judge may issue `runtime-confirmed`. A Lead is a source-grounded primitive missing an edge to a complete effect. A Lead is not a Finding.

As Root, choose source-grounded questions for your collaborators and integrate their evidence with your own. Decide the division from the pinned source; no vulnerability path or role is prescribed.
