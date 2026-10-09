# WordPress discovery: managed source and HTTP objective v2

Inspect the assigned pinned source and disposable Lab for complete security failures reachable by an `unauthenticated`, `subscriber`, or `customer` attacker in an ordinary WordPress deployment. Use the supplied human-written trust boundary and Programme Boundary. Contributor and higher roles and administrator-chosen permissions are trusted. A vulnerability is not assumed.

Prioritize `rce` / `php-file-write`; `privesc-to-admin` / `auth-bypass-to-admin` / `account-takeover`; `sqli`; `options-update`; `arbitrary-file-read` / `delete` / `download` / `lfi` / `rfi`; `privesc-to-contributor+` / `auth-bypass-non-admin`; `sensitive-object-access`; and site-wide `stored-xss`, in that order. Record other concrete effects without confusing technical validity with programme scope.

Maintain a private registry of hypotheses and contrary evidence; redirect effort when an approach no longer has a concrete unresolved question. The pinned source and the disposable Lab are the technical evidence.

For each Finding, state `attackerPosition`, impact classification, `configurationPrecondition`, broken property, entry-to-effect `sourceTrace` (file / function / line), existing controls, Lab observations, and private recipe reference. Zero Findings is valid. State the examined and unexamined areas. Only the Harness judge may issue `runtime-confirmed`. Report a Lead for a source-grounded read, write, delete, authentication-material or partial-execution primitive whose path to an effect is missing one edge (producer, consumer, authentication use, reachability or precondition). A Lead is not a Finding.
