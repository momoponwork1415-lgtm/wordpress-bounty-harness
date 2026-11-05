# WordPress attack classes and source questions

Select a class because the current plugin source exposes a relevant entry and boundary, not because a scanner found a word. The generated Programme Boundary and trust declaration decide which effects and attacker positions count. Start with stored output and SQL paths when they are present; other in-scope effects remain work when their source boundary is visible. Assign separate units for different writers, readers, roles or lifecycle modes that change the guard or effect.

## Dispatch and authority shared by all classes

Follow the plugin loader to the actual registration: hooks that run during ordinary requests, AJAX or REST handlers, shortcodes and blocks, admin form actions, public forms, callbacks, and any plugin-defined route or hook wrapper. Resolve the registration to a handler and the handler to its parameters. A handler on an early hook may execute without a named page. Check the low-trust role at the registration and through every relevant capability, ownership, nonce and session guard. A nonce may be public or may protect only intent; read the pinned WordPress source and the page that supplies it. Do not treat a WordPress API name as proof of the check's result.

A value imported from a service, feed or webhook is attacker-controlled only when a low-trust actor can place it at that source under ordinary use. Vendor-only content and content the administrator deliberately authors are not low-trust input. Record normal settings needed for a path. If the setting requires an administrator to write unsafe content, state that boundary rather than inventing a lower-trust actor.

## Stored output and browser rendering

Trace a low-trust field from its normal form or request through validation, encoding, storage and every later read that can render it to another principal. Include admin pages that show visitor or member data. Follow PHP template output and, separately, JSON or localized data that JavaScript inserts into the page; the final rendering context may be in a shipped script or template. Compare escaping and decoding at the final context, including transformations after a sanitizer and values embedded in attributes, HTML, scripts or URLs. A storage write alone is a producer primitive. A rendered value alone is a consumer primitive. A Finding requires a source-grounded path from low-trust entry to an in-scope result, with observations stated no stronger than the Lab actually showed.

## SQL construction

Locate the code that constructs and executes the final query, including plugin query builders, shared helpers and calls into pinned WordPress or dependencies. Follow both the value and its type from an actual low-trust parameter through any serialization, stored copy, array access or normalization. Read the exact guard or preparation at the point where SQL is assembled. Distinguish value placeholders from dynamic identifiers, operators, clauses, nested keys and orderings that may be inserted by a different route. Compare all callers of a shared query helper rather than treating one safe caller as proof for the helper. A suspicious concatenation is a route to check; it is not an SQL injection Finding without reachable input and a missing effective control.

## Other source-visible in-scope effects

When the Programme Boundary includes them, trace file paths, uploads, includes, deserialization and identity or authentication decisions from the same low-trust position to the first concrete effect. For identity flows, verify which earlier state, code or account a later step is bound to. For files, resolve path normalization and the actual operation. Do not launch a broad multi-step search merely because a class exists. If a chosen route has several steps, prove each prerequisite in order and keep an unproven step as a named gap.

## Cross-checks and exclusion

For each unit, compare a sibling entry that reaches the same helper or resource with a stronger or weaker guard. Check normal failure and fallback paths when the plugin source shows they rejoin the effect. Mark a class excluded from a specific unit only with a source reason, such as no low-trust input path or a source-visible guard that stops that effect. A class excluded from one unit remains available at another entry or read-back mode. Record the exact source location and next read when the reason is uncertain.

## Class-blind and obvious-path passes

The fresh gap critic makes a bounded class-blind pass after focused hunting. Inspect current source for fallback, compatibility, migration or less-used routes; API parameters that normal UI code never sends; and feature combinations that may hand stored or transformed data to a different reader. Ask which low-trust input and in-scope effect the ordinary class units missed. Open a new unit only after naming its registration, boundary and source location. A peculiar feature or comment alone is not a candidate.

The same critic makes a literal obvious-path pass over public and low-privilege handlers and effect calls: missing or weaker guards on a sibling route, direct output of lower-trust stored values, SQL assembled from request fields or keys, file or include operations, and source comments that explicitly flag a missing check. Compare each hit with the map and existing units; create only missing in-scope work. Do not fetch advisories, scan unstaged Git history or infer vulnerability from a keyword. Keep either pass's unread source and exact reason visible in `REGISTRY.md` when the Trial cannot finish it.
