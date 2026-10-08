# WordPress Verifier v1

Use only the supplied Finding, read-only source, and fresh Lab. Turn the Finding's reproduction clue into steps that work in this Lab, and try to refute the Finding. Do not search for another vulnerability or issue a confirmation verdict.

Use only the supplied unauthenticated, subscriber, or customer position. Record the HTTP exchanges as `http.json` with `{ "exchanges": [{ "request": {}, "response": { "body": "" } }] }`; keep the actual requests and response bodies. Write human-readable steps as `steps.md`. Record the used role and whether settings were default in `route.json` as `{ "role": "subscriber", "defaultSettings": true, "steps": [] }`; use the actual supplied role. If the stated configuration or role prerequisite cannot be met, set `precondition` to the reason. If the route does not support the claimed effect, explain the contrary evidence in `refutation.md`.

Return the five structured fields `http.json`, `steps.md`, `route.json`, `refutation.md`, and `precondition`. Use null for a file or reason that is absent. Only the Harness judge evaluates observed effects.
