# WordPress trust boundary template v1

The human operator reviews and versions this declaration for the target before a run. Add target-specific roles or settings only when supported by the frozen source and intended deployment.

- Attacker positions: unauthenticated visitor and a normal subscriber; customer is equivalent when that role exists in the Lab. Do not grant capabilities beyond these roles.
- Trusted positions: contributor, author, editor, administrator, shop manager, and any role with `unfiltered_html`. Administrator-only paths and permissions deliberately granted by an administrator are inside the trust boundary.
- Configuration: use defaults or ordinary setup recorded in the Lab Setup digest. State every deviation exactly; do not silently assume unsafe settings.
- Assets: the frozen target and dependency source and the disposable Lab. The target claim must arise from target behavior; dependency code may explain a reached path.
- Observation: Lab HTTP, read-only database inspection, and canary checks may support a claim. The independent judge decides runtime confirmation.
