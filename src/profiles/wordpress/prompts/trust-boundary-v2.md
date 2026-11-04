# WordPress trust boundary template v2

This human-authored declaration fixes the attacker and trusted positions for the pinned target. Add target-specific roles or settings only when supported by the frozen source and intended deployment.

- Attacker positions: unauthenticated visitor and a normal subscriber; customer is equivalent when that role exists in the Lab. Do not grant capabilities beyond these roles.
- Trusted positions: contributor, author, editor, administrator, shop manager, and any role with `unfiltered_html`. Administrator-only paths and permissions deliberately granted by an administrator are inside the trust boundary.
- Configuration: use defaults or ordinary setup recorded in the Lab Setup digest. State every deviation exactly; do not silently assume unsafe settings.
- Assets: the frozen target and dependency source and the disposable Lab. The target claim must arise from target behavior; dependency code may explain a reached path.
- Observation: Lab HTTP, read-only database inspection, and browser observations may support a claim. Only a named human's matching observation in a retained verification Lab or a new review Lab, recorded as `review observe` and paired with `review decide --reproduced match`, confirms a vulnerability. An agent's check or Lab observation is not confirmation.
